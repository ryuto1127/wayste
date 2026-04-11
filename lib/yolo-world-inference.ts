/**
 * YOLO World open-vocabulary inference using ONNX Runtime Web.
 *
 * Used as a fallback when YOLO26m (COCO-80) has low confidence or the
 * detected class is not waste-relevant. The model is exported with pre-baked
 * recycling-specific class embeddings (36 classes) — no CLIP encoder needed
 * at runtime.
 *
 * Heavier than YOLO26m (~50 MB vs 39 MB), so loaded on-demand and not run
 * continuously. Inference takes ~200-800ms on CPU depending on device.
 */
import type { YoloDetection } from "./types";

type InferenceSession = import("onnxruntime-web").InferenceSession;
type OrtModule = typeof import("onnxruntime-web");

let ort: OrtModule | null = null;
let session: InferenceSession | null = null;
let loading: Promise<boolean> | null = null;
let warmedUp = false;
/** The execution provider that was actually used ("webgpu" | "wasm"). */
let activeProvider: string = "unknown";

const MODEL_INPUT_SIZE = 640;

/**
 * Pre-baked class names matching the YOLO World export.
 * These are recycling-specific items NOT covered by COCO-80.
 * Order must match the class indices frozen into the ONNX model.
 */
export const YOLO_WORLD_CLASSES = [
  "aluminium beverage can",
  "steel food can",
  "plastic bottle",
  "glass bottle",
  "glass jar",
  "cardboard",
  "paper bag",
  "paper cup",
  "paper plate",
  "paper towel",
  "napkin",
  "newspaper",
  "milk carton",
  "juice box",
  "egg carton",
  "pizza box",
  "plastic bag",
  "plastic bottle cap",
  "plastic wrapper",
  "chip bag",
  "styrofoam cup",
  "styrofoam container",
  "plastic straw",
  "plastic food container",
  "plastic cup",
  "yogurt cup",
  "plastic utensil",
  "coffee cup",
  "coffee cup sleeve",
  "aluminum foil",
  "banana peel",
  "apple core",
  "battery",
  "cigarette butt",
  "pen",
  "plastic bottle label",
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
        graphOptimizationLevel: "all",
        logSeverityLevel: 3,
      });

      activeProvider = provider;
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

/** Get the active execution provider ("webgpu" | "wasm" | "unknown"). */
export function getYoloWorldProvider(): string {
  return activeProvider;
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
 * Model output is [1, N, 8400] (channels-first, no NMS):
 *   - 8400 candidate boxes
 *   - N channels = 4 (cx, cy, w, h) + numClasses (36 pre-baked recycling classes)
 *
 * We apply argmax + confidence threshold + greedy NMS here.
 */
export async function runYoloWorldInference(
  video: HTMLVideoElement,
  _roiMargin = 0.15,
  minBoxArea = 1500,
  confidenceThreshold = 0.75,
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
    const numChannels = shape[1] as number; // 4 + numClasses (dynamically read from model)
    const numCandidates = shape[2] as number; // 8400
    const numClasses = numChannels - 4;

    // ── Parse channels-first output ──
    // Data layout: outputData[ channel * numCandidates + candidateIdx ]
    const rawDetections: YoloDetection[] = [];

    for (let i = 0; i < numCandidates; i++) {
      // Find best class score
      let bestScore = -1;
      let bestClassId = -1;
      for (let c = 0; c < numClasses; c++) {
        const score = outputData[(4 + c) * numCandidates + i];
        if (score > bestScore) {
          bestScore = score;
          bestClassId = c;
        }
      }

      if (bestScore < confidenceThreshold) continue;
      if (bestClassId < 0 || bestClassId >= YOLO_WORLD_CLASSES.length) continue;

      // Read box (cx, cy, w, h) in pixel coords (0-640)
      const cx = outputData[0 * numCandidates + i];
      const cy = outputData[1 * numCandidates + i];
      const bw = outputData[2 * numCandidates + i];
      const bh = outputData[3 * numCandidates + i];

      const boxArea = bw * bh;
      if (boxArea < minBoxArea) continue;

      // Convert center format → corner format
      const x1 = cx - bw / 2;
      const y1 = cy - bh / 2;

      rawDetections.push({
        classId: bestClassId,
        className: YOLO_WORLD_CLASSES[bestClassId],
        confidence: bestScore,
        bbox: [x1, y1, bw, bh],
      });
    }

    // Sort by confidence descending
    rawDetections.sort((a, b) => b.confidence - a.confidence);

    // ── Greedy NMS (IoU threshold 0.5) ──
    const NMS_IOU = 0.5;
    const kept: YoloDetection[] = [];

    for (const det of rawDetections) {
      let dominated = false;
      for (const k of kept) {
        if (iou(det.bbox, k.bbox) > NMS_IOU) {
          dominated = true;
          break;
        }
      }
      if (!dominated) kept.push(det);
    }

    if (kept.length > 0) {
      console.log(
        `[yolo-world] ${kept.length} detection(s): ` +
        kept.map(d => `${d.className} ${(d.confidence * 100).toFixed(1)}%`).join(", ")
      );
    }

    return kept;
  } catch (err) {
    console.warn("[yolo-world] Inference error:", err);
    return [];
  }
}

/** Compute Intersection-over-Union for two [x, y, w, h] boxes. */
function iou(a: [number, number, number, number], b: [number, number, number, number]): number {
  const ax2 = a[0] + a[2], ay2 = a[1] + a[3];
  const bx2 = b[0] + b[2], by2 = b[1] + b[3];
  const ix1 = Math.max(a[0], b[0]);
  const iy1 = Math.max(a[1], b[1]);
  const ix2 = Math.min(ax2, bx2);
  const iy2 = Math.min(ay2, by2);
  const inter = Math.max(0, ix2 - ix1) * Math.max(0, iy2 - iy1);
  const union = a[2] * a[3] + b[2] * b[3] - inter;
  return union > 0 ? inter / union : 0;
}
