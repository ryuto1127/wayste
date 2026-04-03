/**
 * Inference backend abstraction layer.
 *
 * Decouples the kiosk pipeline from the specific YOLO runtime.
 * Two backends are planned:
 *
 *   1. **Browser ONNX** (default) — runs YOLO26n via ONNX Runtime Web/WASM.
 *      Works on any device with a modern browser. Used for Vercel-hosted demo
 *      and desktop/laptop kiosks.
 *
 *   2. **Local HTTP** (future) — calls a lightweight inference server running
 *      on the same device (e.g. FastAPI + NCNN on Raspberry Pi 5).
 *      Set NEXT_PUBLIC_INFERENCE_BACKEND=http and NEXT_PUBLIC_INFERENCE_URL
 *      to enable.
 *
 * Both backends return the same YoloDetection[] array, so the rest of the
 * pipeline (yolo-rules.ts, KioskDisplay.tsx) is unaffected by the swap.
 */

import type { YoloDetection } from "./types";

// ── Backend selection ──
// Checked at module load time (client-side env vars via NEXT_PUBLIC_ prefix).
const BACKEND = (typeof window !== "undefined"
  ? (globalThis as Record<string, unknown>).NEXT_PUBLIC_INFERENCE_BACKEND
  : undefined) as string | undefined
  ?? process.env.NEXT_PUBLIC_INFERENCE_BACKEND
  ?? "onnx";

const INFERENCE_URL = process.env.NEXT_PUBLIC_INFERENCE_URL ?? "http://localhost:8000/detect";

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
}

// ── Browser ONNX backend (delegates to existing yolo-inference.ts) ──
class OnnxBackend implements InferenceBackend {
  private yolo: typeof import("./yolo-inference") | null = null;

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
}

// ── Local HTTP backend (for Raspberry Pi + NCNN / FastAPI) ──
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
      // Capture ROI from video and send as JPEG to the inference server
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
}

// ── Factory: create the configured backend with ONNX fallback ──
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
