/**
 * Inference backend abstraction layer — Tiered Detection Pipeline.
 *
 *   1. **Tier 1: YOLO (39-class custom)** — Packaging + granular food waste.
 *      High confidence + rule match → instant result.
 *
 *   2. **Tier 2: OpenAI API (GPT-5.4-mini)** — Handled in KioskDisplay.tsx.
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
// YOLO_FALLBACK_THRESHOLD is derived from the master sensitivity parameter
// via computeThresholds() in threshold-config.ts. This re-export provides
// the default-sensitivity value for consumers that don't have access to
// site config (e.g. tests, scripts).
import { computeThresholds } from "./threshold-config";
export { computeThresholds, type ThresholdConfig, type Calibration } from "./threshold-config";
const _defaults = computeThresholds(0.5);
/** @deprecated Use computeThresholds(sensitivity).YOLO_FALLBACK_THRESHOLD */
export const YOLO_FALLBACK_THRESHOLD: number = _defaults.YOLO_FALLBACK_THRESHOLD;

// ── System status (observable by UI components) ──
export type ModelStatus = "loading" | "ready" | "error";
export type ProviderType = "webgpu" | "wasm" | "http" | "unknown";

export interface SystemStatus {
  yolo26m: ModelStatus;
  provider: ProviderType;
  /** True when yolo26m is "ready". */
  overallReady: boolean;
}

/** Current system status — read by SystemStatusBadge. */
let _systemStatus: SystemStatus = {
  yolo26m: "loading",
  provider: "unknown",
  overallReady: false,
};
/** Subscribers notified when status changes. */
const _statusListeners: Set<(s: SystemStatus) => void> = new Set();

function updateStatus(patch: Partial<SystemStatus>) {
  _systemStatus = { ..._systemStatus, ...patch };
  _systemStatus.overallReady = _systemStatus.yolo26m === "ready";
  for (const fn of _statusListeners) fn(_systemStatus);
}

/** Subscribe to system status changes. Returns an unsubscribe function. */
export function subscribeSystemStatus(fn: (s: SystemStatus) => void): () => void {
  _statusListeners.add(fn);
  fn(_systemStatus); // emit current state immediately
  return () => { _statusListeners.delete(fn); };
}

/** Read current system status (snapshot). */
export function getSystemStatus(): SystemStatus {
  return _systemStatus;
}

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

// ── Browser ONNX backend ──
class OnnxBackend implements InferenceBackend {
  private yolo: typeof import("./yolo-inference") | null = null;

  async init(): Promise<boolean> {
    this.yolo = await import("./yolo-inference");
    const ok = await this.yolo.initYolo();
    if (!ok) {
      updateStatus({ yolo26m: "error" });
      return false;
    }
    await this.yolo.warmUpYolo();
    updateStatus({
      yolo26m: "ready",
      provider: this.yolo.getYoloProvider() as ProviderType,
    });
    return true;
  }

  isReady(): boolean {
    return this.yolo?.isYoloReady() ?? false;
  }

  async detect(
    video: HTMLVideoElement,
    _roiMargin = 0,
    minBoxArea = 1500,
    confidenceThreshold = 0.40,
  ): Promise<YoloDetection[]> {
    if (!this.yolo) return [];
    return this.yolo.runYoloInference(video, _roiMargin, minBoxArea, confidenceThreshold);
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
    minBoxArea = 1500,
    confidenceThreshold = 0.40,
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

/** Reset the cached backend and system status (for testing). */
export function resetInferenceBackend(): void {
  _backend = null;
  _systemStatus = {
    yolo26m: "loading",
    provider: "unknown",
    overallReady: false,
  };
}
