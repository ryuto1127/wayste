/**
 * Browser-side face detection using MediaPipe Face Detector (BlazeFace).
 *
 * Used to prevent storing images that contain identifiable faces.
 * The kiosk camera points downward at waste items, so faces are rare,
 * but this provides a safety net for privacy compliance.
 *
 * BlazeFace handles angled/tilted/partial faces much better than
 * Chrome's built-in Shape Detection API, which is critical since
 * kiosk users look downward while holding items.
 *
 * Model size: ~200 KB (loaded once from CDN on first call).
 * WASM runtime: ~5 MB (loaded once alongside the model).
 */

import { FaceDetector, FilesetResolver } from "@mediapipe/tasks-vision";

// MediaPipe's TFLite WASM runtime logs "INFO: Created TensorFlow Lite
// XNNPACK delegate for CPU." via stderr → console.error on first inference.
// The WASM module captures console.error at load time (via bind), so the
// filter must be installed BEFORE FilesetResolver.forVisionTasks() runs.
if (typeof window !== "undefined") {
  const _origErr = console.error;
  console.error = (...args: unknown[]) => {
    if (typeof args[0] === "string" && args[0].includes("TensorFlow Lite XNNPACK")) return;
    _origErr.apply(console, args);
  };
}

const WASM_CDN = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm";
const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/latest/blaze_face_short_range.tflite";

/** Minimum confidence to consider a detection as a real face. */
const MIN_CONFIDENCE = 0.5;

let detector: FaceDetector | null = null;
let initPromise: Promise<FaceDetector | null> | null = null;

async function getDetector(): Promise<FaceDetector | null> {
  if (detector) return detector;

  // Prevent parallel initializations
  if (initPromise) return initPromise;

  initPromise = (async () => {
    try {
      const vision = await FilesetResolver.forVisionTasks(WASM_CDN);
      detector = await FaceDetector.createFromOptions(vision, {
        baseOptions: { modelAssetPath: MODEL_URL },
        runningMode: "IMAGE",
        minDetectionConfidence: MIN_CONFIDENCE,
      });
      console.log("[face-detect] MediaPipe Face Detector ready");
      return detector;
    } catch (err) {
      console.warn("[face-detect] Failed to initialize MediaPipe Face Detector:", err);
      return null;
    }
  })();

  return initPromise;
}

/**
 * Returns true if one or more faces are detected in the image source.
 *
 * Accepts HTMLCanvasElement, HTMLImageElement, HTMLVideoElement, or
 * OffscreenCanvas (converted to ImageBitmap internally).
 *
 * Returns false if no faces detected or if the detector is unavailable.
 */
export async function containsFace(
  source: OffscreenCanvas | HTMLCanvasElement | HTMLVideoElement | HTMLImageElement,
): Promise<boolean> {
  const fd = await getDetector();
  if (!fd) return false;

  try {
    // MediaPipe requires HTMLCanvasElement/HTMLImageElement/HTMLVideoElement.
    // OffscreenCanvas is not directly supported — convert via ImageBitmap + canvas.
    let detectSource: HTMLCanvasElement | HTMLImageElement | HTMLVideoElement;

    if (source instanceof OffscreenCanvas) {
      const bitmap = source.transferToImageBitmap();
      const canvas = document.createElement("canvas");
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const ctx = canvas.getContext("2d");
      if (!ctx) return false;
      ctx.drawImage(bitmap, 0, 0);
      bitmap.close();
      detectSource = canvas;
    } else {
      detectSource = source;
    }

    const result = fd.detect(detectSource);
    const faceCount = result.detections.length;

    if (faceCount > 0) {
      const confidences = result.detections
        .map((d) => d.categories[0]?.score?.toFixed(2))
        .join(", ");
      console.log(
        `[face-detect] Blocked: ${faceCount} face(s) detected (confidence: ${confidences}) — image will not be saved`,
      );
      return true;
    }

    return false;
  } catch (err) {
    console.warn("[face-detect] Detection error:", err);
    return false;
  }
}
