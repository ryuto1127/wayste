/**
 * Inference backend abstraction layer — Tiered Detection Pipeline.
 *
 * Three tiers, each progressively heavier:
 *
 *   1. **YOLO26n (always-on)** — Runs continuously in the background, buffering
 *      the latest detection. When classification triggers, the result is available
 *      instantly (zero latency). Paused during YOLO World inference to free CPU.
 *
 *   2. **YOLO World (on-demand fallback)** — Open-vocabulary detector with
 *      pre-baked recycling classes. Runs when YOLO26n confidence is low or it
 *      detects no waste-relevant class. ~200-800ms on CPU.
 *
 *   3. **OpenAI API (last resort)** — Handled in KioskDisplay.tsx, not here.
 *
 * Two physical backends are supported:
 *   - **Browser ONNX** (default) — YOLO via ONNX Runtime Web/WASM.
 *   - **Local HTTP** (future) — inference server on same device (Raspberry Pi).
 */

import type { YoloDetection } from "./types";

// ── Backend selection ──
const BACKEND = (typeof window !== "undefined"
  ? (globalThis as Record<string, unknown>).NEXT_PUBLIC_INFERENCE_BACKEND
  : undefined) as string | undefined
  ?? process.env.NEXT_PUBLIC_INFERENCE_BACKEND
  ?? "onnx";

const INFERENCE_URL = process.env.NEXT_PUBLIC_INFERENCE_URL ?? "http://localhost:8000/detect";

// ── Confidence thresholds for tiered fallback ──
/** YOLO26n confidence below this triggers YOLO World fallback. */
export const YOLO_FALLBACK_THRESHOLD = 0.65;
/** YOLO26n confidence below this fires API in parallel with YOLO World. */
export const YOLO_API_PARALLEL_THRESHOLD = 0.3;
/** YOLO World confidence below this falls through to API. */
export const YOLO_WORLD_ACCEPT_THRESHOLD = 0.45;

// ── Backend interface ──
export interface InferenceBackend {
  /** Initialize the backend (load model, warm up, etc.). */
  init(): Promise<boolean>;
  /** Check if the backend is ready for inference. */
  isReady(): boolean;
  /** Run inference on a video frame. Returns detections sorted by confidence desc. */
  detect(
    video: HTMLVideoElement,
    roiMargin?: number,
    minBoxArea?: number,
    confidenceThreshold?: number,
  ): Promise<YoloDetection[]>;

  // ── Always-on YOLO loop ──
  /** Start continuous YOLO detection loop, buffering the latest result. */
  startContinuous(video: HTMLVideoElement, roiMargin?: number): void;
  /** Stop the continuous detection loop. */
  stopContinuous(): void;
  /** Pause the continuous loop (e.g., during YOLO World inference). */
  pauseContinuous(): void;
  /** Resume the continuous loop after pause. */
  resumeContinuous(): void;
  /** Get the latest buffered detection from the continuous loop. */
  getLatestDetections(): YoloDetection[];
  /** Whether the continuous loop is currently running (not paused). */
  isContinuousRunning(): boolean;

  // ── YOLO World ──
  /** Initialize YOLO World model (lazy — only loads when first needed). */
  initYoloWorld(): Promise<boolean>;
  /** Check if YOLO World is ready. */
  isYoloWorldReady(): boolean;
  /** Run YOLO World inference (on-demand). */
  detectWorld(
    video: HTMLVideoElement,
    roiMargin?: number,
    minBoxArea?: number,
    confidenceThreshold?: number,
  ): Promise<YoloDetection[]>;
}

// ── Browser ONNX backend ──
class OnnxBackend implements InferenceBackend {
  private yolo: typeof import("./yolo-inference") | null = null;
  private yoloWorld: typeof import("./yolo-world-inference") | null = null;

  // Continuous loop state
  private continuousTimer: ReturnType<typeof setTimeout> | null = null;
  private continuousPaused = false;
  private latestDetections: YoloDetection[] = [];
  private continuousVideo: HTMLVideoElement | null = null;
  private continuousRoiMargin = 0.15;
  /** Continuous loop interval — run YOLO every ~75ms (~13fps). */
  private static readonly CONTINUOUS_INTERVAL_MS = 75;

  async init(): Promise<boolean> {
    this.yolo = await import("./yolo-inference");
    const ok = await this.yolo.initYolo();
    if (ok) await this.yolo.warmUpYolo();
    return ok;
  }

  isReady(): boolean {
    return this.yolo?.isYoloReady() ?? false;
  }

  async detect(
    video: HTMLVideoElement,
    roiMargin = 0.15,
    minBoxArea = 5000,
    confidenceThreshold = 0.65,
  ): Promise<YoloDetection[]> {
    if (!this.yolo) return [];
    return this.yolo.runYoloInference(video, roiMargin, minBoxArea, confidenceThreshold);
  }

  // ── Continuous YOLO loop ──

  startContinuous(video: HTMLVideoElement, roiMargin = 0.15): void {
    if (this.continuousTimer) return; // Already running
    this.continuousVideo = video;
    this.continuousRoiMargin = roiMargin;
    this.continuousPaused = false;
    this.scheduleNext();
    console.log("[inference] Continuous YOLO loop started");
  }

  stopContinuous(): void {
    if (this.continuousTimer) {
      clearTimeout(this.continuousTimer);
      this.continuousTimer = null;
    }
    this.continuousVideo = null;
    this.latestDetections = [];
    console.log("[inference] Continuous YOLO loop stopped");
  }

  pauseContinuous(): void {
    this.continuousPaused = true;
    if (this.continuousTimer) {
      clearTimeout(this.continuousTimer);
      this.continuousTimer = null;
    }
    // Clear buffered detections so stale results from the previous item
    // don't trigger the YOLO fast gate when the loop resumes.
    this.latestDetections = [];
    console.log("[inference] Continuous YOLO loop paused");
  }

  resumeContinuous(): void {
    if (!this.continuousPaused) return;
    this.continuousPaused = false;
    this.scheduleNext();
    console.log("[inference] Continuous YOLO loop resumed");
  }

  getLatestDetections(): YoloDetection[] {
    return this.latestDetections;
  }

  isContinuousRunning(): boolean {
    return this.continuousTimer !== null && !this.continuousPaused;
  }

  private scheduleNext(): void {
    if (this.continuousPaused) return;
    this.continuousTimer = setTimeout(() => this.runContinuousTick(), OnnxBackend.CONTINUOUS_INTERVAL_MS);
  }

  private async runContinuousTick(): Promise<void> {
    if (this.continuousPaused || !this.continuousVideo || !this.yolo) {
      if (!this.continuousPaused) this.scheduleNext();
      return;
    }

    try {
      // Use a lower confidence threshold for buffered detections —
      // the tiered pipeline will decide what to do based on confidence.
      const detections = await this.yolo.runYoloInference(
        this.continuousVideo,
        this.continuousRoiMargin,
        5000,
        0.25, // Low threshold — capture everything, filter later
      );
      this.latestDetections = detections;
    } catch {
      // Non-fatal — next tick will retry
    }

    this.scheduleNext();
  }

  // ── YOLO World ──

  async initYoloWorld(): Promise<boolean> {
    if (this.yoloWorld) return this.yoloWorld.isYoloWorldReady();
    try {
      this.yoloWorld = await import("./yolo-world-inference");
      const ok = await this.yoloWorld.initYoloWorld();
      if (ok) await this.yoloWorld.warmUpYoloWorld();
      return ok;
    } catch (err) {
      console.warn("[inference] YOLO World init failed:", err);
      return false;
    }
  }

  isYoloWorldReady(): boolean {
    return this.yoloWorld?.isYoloWorldReady() ?? false;
  }

  async detectWorld(
    video: HTMLVideoElement,
    roiMargin = 0.15,
    minBoxArea = 5000,
    confidenceThreshold = 0.45,
  ): Promise<YoloDetection[]> {
    if (!this.yoloWorld) return [];
    return this.yoloWorld.runYoloWorldInference(video, roiMargin, minBoxArea, confidenceThreshold);
  }
}

// ── Local HTTP backend ──
class HttpBackend implements InferenceBackend {
  private ready = false;

  async init(): Promise<boolean> {
    try {
      const res = await fetch(INFERENCE_URL.replace("/detect", "/health"), {
        signal: AbortSignal.timeout(3000),
      });
      this.ready = res.ok;
      if (this.ready) console.log("[inference-http] Backend server is healthy");
      return this.ready;
    } catch (err) {
      console.warn("[inference-http] Backend server not available, falling back to ONNX:", err);
      return false;
    }
  }

  isReady(): boolean {
    return this.ready;
  }

  async detect(
    video: HTMLVideoElement,
    roiMargin = 0.15,
    minBoxArea = 5000,
    confidenceThreshold = 0.65,
  ): Promise<YoloDetection[]> {
    if (!this.ready) return [];

    try {
      const vw = video.videoWidth;
      const vh = video.videoHeight;
      const roiX = Math.round(vw * roiMargin);
      const roiY = Math.round(vh * roiMargin);
      const roiW = Math.round(vw * (1 - roiMargin * 2));
      const roiH = Math.round(vh * (1 - roiMargin * 2));

      const canvas = new OffscreenCanvas(640, 640);
      const ctx = canvas.getContext("2d");
      if (!ctx) return [];

      ctx.drawImage(video, roiX, roiY, roiW, roiH, 0, 0, 640, 640);
      const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.85 });

      const formData = new FormData();
      formData.append("image", blob, "frame.jpg");
      formData.append("min_box_area", String(minBoxArea));
      formData.append("confidence_threshold", String(confidenceThreshold));

      const res = await fetch(INFERENCE_URL, {
        method: "POST",
        body: formData,
        signal: AbortSignal.timeout(5000),
      });

      if (!res.ok) return [];

      const data = (await res.json()) as { detections: YoloDetection[] };
      return data.detections ?? [];
    } catch (err) {
      console.warn("[inference-http] Detection failed:", err);
      return [];
    }
  }

  // HTTP backend doesn't support continuous mode or YOLO World
  startContinuous(): void {}
  stopContinuous(): void {}
  pauseContinuous(): void {}
  resumeContinuous(): void {}
  getLatestDetections(): YoloDetection[] { return []; }
  isContinuousRunning(): boolean { return false; }
  async initYoloWorld(): Promise<boolean> { return false; }
  isYoloWorldReady(): boolean { return false; }
  async detectWorld(): Promise<YoloDetection[]> { return []; }
}

// ── Factory ──
let _backend: InferenceBackend | null = null;

export async function getInferenceBackend(): Promise<InferenceBackend> {
  if (_backend) return _backend;

  if (BACKEND === "http") {
    const http = new HttpBackend();
    const ok = await http.init();
    if (ok) {
      _backend = http;
      console.log("[inference] Using HTTP backend:", INFERENCE_URL);
      return _backend;
    }
    console.warn("[inference] HTTP backend unavailable, falling back to ONNX");
  }

  const onnx = new OnnxBackend();
  await onnx.init();
  _backend = onnx;
  console.log("[inference] Using browser ONNX backend");
  return _backend;
}

/** Reset the cached backend (for testing). */
export function resetInferenceBackend(): void {
  _backend = null;
}
