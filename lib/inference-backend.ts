/**
 * Inference backend abstraction layer — Tiered Detection Pipeline.
 *
 * Three tiers, each progressively heavier (all on-demand):
 *
 *   1. **YOLO26n (on-demand)** — Runs when classification triggers.
 *      High confidence + rule match → instant result (Tier 1).
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
    _roiMargin = 0,
    minBoxArea = 5000,
    confidenceThreshold = 0.65,
  ): Promise<YoloDetection[]> {
    if (!this.yolo) return [];
    return this.yolo.runYoloInference(video, _roiMargin, minBoxArea, confidenceThreshold);
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
    _roiMargin = 0,
    minBoxArea = 5000,
    confidenceThreshold = 0.45,
  ): Promise<YoloDetection[]> {
    if (!this.yoloWorld) return [];
    return this.yoloWorld.runYoloWorldInference(video, _roiMargin, minBoxArea, confidenceThreshold);
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
    _roiMargin = 0,
    minBoxArea = 5000,
    confidenceThreshold = 0.65,
  ): Promise<YoloDetection[]> {
    if (!this.ready) return [];

    try {
      const vw = video.videoWidth;
      const vh = video.videoHeight;
      // Crop the largest centered square (short-side based, e.g. 720×720
      // from 1280×720) — matches ONNX backend and OpenAI classification.
      const side = Math.min(vw, vh);
      const roiX = Math.round((vw - side) / 2);
      const roiY = Math.round((vh - side) / 2);

      const canvas = new OffscreenCanvas(640, 640);
      const ctx = canvas.getContext("2d");
      if (!ctx) return [];

      ctx.drawImage(video, roiX, roiY, side, side, 0, 0, 640, 640);
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

  // HTTP backend doesn't support YOLO World
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
