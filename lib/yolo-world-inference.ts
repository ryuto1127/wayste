/**
 * YOLO World open-vocabulary inference using ONNX Runtime Web.
 *
 * Used as a fallback when YOLO26n (COCO-80) has low confidence or no matching
 * waste-stream rule. The model is exported with pre-baked recycling-specific
 * class embeddings — no CLIP encoder needed at runtime.
 *
 * Heavier than YOLO26n (~50 MB vs 9.5 MB), so loaded on-demand and not run
 * continuously. Inference takes ~200-800ms on CPU depending on device.
 */
import type { YoloDetection } from "./types";

type InferenceSession = import("onnxruntime-web").InferenceSession;
type OrtModule = typeof import("onnxruntime-web");

let ort: OrtModule | null = null;
let session: InferenceSession | null = null;
let loading: Promise<boolean> | null = null;
let warmedUp = false;

const MODEL_INPUT_SIZE = 640;

/**
 * Pre-baked class names matching the YOLO World export.
 * These are recycling-specific items NOT covered by COCO-80.
 * Order must match the class indices frozen into the ONNX model.
 */
export const YOLO_WORLD_CLASSES = [
  "aluminum can",
  "tin can",
  "cardboard box",
  "cardboard",
  "paper bag",
  "plastic bag",
  "napkin",
  "tissue paper",
  "food wrapper",
  "candy wrapper",
  "drinking straw",
  "plastic straw",
  "styrofoam container",
  "styrofoam cup",
  "plastic food container",
  "takeout container",
  "milk carton",
  "juice box",
  "paper plate",
  "paper cup",
  "aluminum foil",
  "paper towel",
  "egg carton",
  "coffee cup sleeve",
  "plastic bottle cap",
  "glass jar",
  "yogurt cup",
  "chip bag",
  "cigarette butt",
  "battery",
];

/**
 * Initialize the YOLO World model. Safe to call multiple times.
 * Returns false if model fails to load (e.g., model file not present yet).
 */
export function initYoloWorld(modelUrl = "/models/yolo-world-s.onnx"): Promise<boolean> {
  if (loading) return loading;

  loading = (async () => {
    try {
      ort = await import("onnxruntime-web");

      const cores = typeof navigator !== "undefined" ? navigator.hardwareConcurrency ?? 1 : 1;
      ort.env.wasm.numThreads = Math.min(cores, 4);

      let provider: string = "wasm";
      try {
        if (typeof navigator !== "undefined" && "gpu" in navigator) {
          const gpu = await (navigator as { gpu: { requestAdapter(): Promise<unknown> } }).gpu.requestAdapter();
          if (gpu) provider = "webgpu";
        }
      } catch {
        // WebGPU not available
      }

      session = await ort.InferenceSession.create(modelUrl, {
        executionProviders: [provider],
      });

      console.log(`[yolo-world] Model loaded (${provider}, ${ort.env.wasm.numThreads} threads)`);
      return true;
    } catch (err) {
      console.warn("[yolo-world] Model load failed — will skip YOLO World tier:", err);
      session = null;
      return false;
    }
  })();

  return loading;
}

export function isYoloWorldReady(): boolean {
  return session !== null;
}

/**
 * Warm up YOLO World with a blank tensor to prime JIT compilation.
 * Only runs once — subsequent calls are no-ops.
 */
export async function warmUpYoloWorld(): Promise<void> {
  if (!session || !ort || warmedUp) return;
  try {
    const dummy = new Float32Array(3 * MODEL_INPUT_SIZE * MODEL_INPUT_SIZE);
    const tensor = new ort.Tensor("float32", dummy, [1, 3, MODEL_INPUT_SIZE, MODEL_INPUT_SIZE]);
    await session.run({ images: tensor });
    warmedUp = true;
    console.log("[yolo-world] Warm-up inference complete");
  } catch (err) {
    console.warn("[yolo-world] Warm-up failed (non-fatal):", err);
  }
}

/**
 * Run YOLO World inference on a video frame.
 *
 * Output format matches YOLO26n: [1, N, 6] where each row is
 * [x1, y1, x2, y2, confidence, classId].
 */
export async function runYoloWorldInference(
  video: HTMLVideoElement,
  roiMargin = 0.15,
  minBoxArea = 5000,
  confidenceThreshold = 0.45,
): Promise<YoloDetection[]> {
  if (!session || !ort) return [];

  try {
    // Crop center short-side square (e.g. 720×720 from 1280×720),
    // resize into the model's 640×640 input.
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    const side = Math.min(vw, vh);
    const roiX = Math.round((vw - side) / 2);
    const roiY = Math.round((vh - side) / 2);

    const canvas = new OffscreenCanvas(MODEL_INPUT_SIZE, MODEL_INPUT_SIZE);
    const ctx = canvas.getContext("2d");
    if (!ctx) return [];

    ctx.drawImage(video, roiX, roiY, side, side, 0, 0, MODEL_INPUT_SIZE, MODEL_INPUT_SIZE);

    const imageData = ctx.getImageData(0, 0, MODEL_INPUT_SIZE, MODEL_INPUT_SIZE);
    const { data } = imageData;

    const numPixels = MODEL_INPUT_SIZE * MODEL_INPUT_SIZE;
    const float32 = new Float32Array(3 * numPixels);
    for (let i = 0; i < numPixels; i++) {
      const offset = i * 4;
      float32[i] = data[offset] / 255;
      float32[numPixels + i] = data[offset + 1] / 255;
      float32[2 * numPixels + i] = data[offset + 2] / 255;
    }

    const inputTensor = new ort.Tensor("float32", float32, [1, 3, MODEL_INPUT_SIZE, MODEL_INPUT_SIZE]);
    const results = await session.run({ images: inputTensor });

    const output = results[Object.keys(results)[0]];
    if (!output) return [];

    const outputData = output.data as Float32Array;
    const shape = output.dims;

    const detections: YoloDetection[] = [];

    const numDetections = shape[1] as number;
    const stride = shape[2] as number;

    for (let i = 0; i < numDetections; i++) {
      const base = i * stride;
      const x1 = outputData[base + 0];
      const y1 = outputData[base + 1];
      const x2 = outputData[base + 2];
      const y2 = outputData[base + 3];
      const confidence = outputData[base + 4];
      const classId = Math.round(outputData[base + 5]);

      if (confidence < confidenceThreshold) continue;
      if (classId < 0 || classId >= YOLO_WORLD_CLASSES.length) continue;

      const w = x2 - x1;
      const h = y2 - y1;
      const boxArea = w * h;
      if (boxArea < minBoxArea) continue;

      detections.push({
        classId,
        className: YOLO_WORLD_CLASSES[classId],
        confidence,
        bbox: [x1, y1, w, h],
      });
    }

    detections.sort((a, b) => b.confidence - a.confidence);
    return detections;
  } catch (err) {
    console.warn("[yolo-world] Inference error:", err);
    return [];
  }
}
