/**
 * YOLO edge inference using ONNX Runtime Web (FP16).
 *
 * Custom 39-class waste detection model trained on clean open data.
 * Covers packaging (bottles, cans, cups, bags) and granular food waste
 * (fruit peels, bones, vegetables, cooked items). All classes are waste
 * items — no not_waste filtering needed. Each detection maps directly
 * to a disposal stream.
 *
 * The model uses YOLO's one-to-one head which produces end-to-end
 * detections without NMS — output shape (1, 300, 6) = [x1, y1, x2, y2,
 * confidence, class_id]. This eliminates an entire post-processing stage.
 *
 * Runs entirely in the browser — no server calls required.
 * Falls back gracefully (returns empty array) if the model fails to load.
 */
import type { YoloDetection } from "./types";

// Lazy-loaded ONNX Runtime — only imported when initYolo() is called.
type InferenceSession = import("onnxruntime-web").InferenceSession;
type OrtModule = typeof import("onnxruntime-web");

let ort: OrtModule | null = null;
let session: InferenceSession | null = null;
let loading: Promise<boolean> | null = null;
/** The execution provider that was actually used ("webgpu" | "wasm"). */
let activeProvider: string = "unknown";

/** Input size expected by the YOLO model. */
const MODEL_INPUT_SIZE = 640;

/** Custom 39-class waste detection model. */
const WASTE_CLASSES = [
  "plastic_bottle",  // 0
  "can",             // 1
  "paper_cup",       // 2
  "plastic_cup",     // 3
  "glass_bottle",    // 4
  "cardboard",       // 5
  "paper",           // 6
  "plastic_bag",     // 7
  "paper_bag",       // 8
  "battery",         // 9
  "styrofoam",       // 10
  "tetra_pak",       // 11
  "bone",            // 12
  "vegetable",       // 13
  "egg_shell",       // 14
  "orange",          // 15
  "orange_peel",     // 16
  "apple_peel",      // 17
  "apple",           // 18
  "pear",            // 19
  "meat",            // 20
  "bread",           // 21
  "rice",            // 22
  "egg_yolk",        // 23
  "apple_core",      // 24
  "bone_fish",       // 25
  "noodle",          // 26
  "pear_peel",       // 27
  "pastry",          // 28
  "tomato",          // 29
  "fish",            // 30
  "cucumber",        // 31
  "carrot",          // 32
  "banana",          // 33
  "chicken",         // 34
  "potato",          // 35
  "pizza",           // 36
  "cake",            // 37
  "hamburger",       // 38
];

/**
 * Initialize the YOLO model. Safe to call multiple times — subsequent calls
 * return the same promise. If the model file is missing or ONNX fails to load,
 * resolves to `false` and all subsequent `runYoloInference()` calls return [].
 */
export function initYolo(modelUrl = "/models/39class-v1.onnx"): Promise<boolean> {
  if (loading) return loading;

  loading = (async () => {
    try {
      ort = await import("onnxruntime-web");

      // Use up to 4 WASM threads for parallel inference (capped to avoid
      // over-subscription on low-core devices like Raspberry Pi).
      const cores = typeof navigator !== "undefined" ? navigator.hardwareConcurrency ?? 1 : 1;
      ort.env.wasm.numThreads = Math.min(cores, 4);

      // Try WebGPU first (fastest on GPU-equipped devices), fall back to WASM.
      let provider: string = "wasm";
      try {
        if (typeof navigator !== "undefined" && "gpu" in navigator) {
          const gpu = await (navigator as { gpu: { requestAdapter(): Promise<unknown> } }).gpu.requestAdapter();
          if (gpu) provider = "webgpu";
        }
      } catch {
        // WebGPU not available — use WASM
      }

      session = await ort.InferenceSession.create(modelUrl, {
        executionProviders: [provider],
        graphOptimizationLevel: "all",
        logSeverityLevel: 3,
      });

      activeProvider = provider;
      console.log(`[yolo] Model loaded (${provider}, ${ort.env.wasm.numThreads} threads)`);
      return true;
    } catch (err) {
      console.warn("[yolo] Model load failed — API fallback will be used:", err);
      session = null;
      return false;
    }
  })();

  return loading;
}

/** Check if YOLO model is ready for inference. */
export function isYoloReady(): boolean {
  return session !== null;
}

/** Get the active execution provider ("webgpu" | "wasm" | "unknown"). */
export function getYoloProvider(): string {
  return activeProvider;
}

/**
 * Run a warm-up inference with a blank tensor to prime WASM JIT compilation.
 * The first real inference after a cold start can be 2-5x slower; this
 * eliminates that penalty so the first user-facing classification is fast.
 */
export async function warmUpYolo(): Promise<void> {
  if (!session || !ort) return;
  try {
    const dummy = new Float32Array(3 * MODEL_INPUT_SIZE * MODEL_INPUT_SIZE);
    const tensor = new ort.Tensor("float32", dummy, [1, 3, MODEL_INPUT_SIZE, MODEL_INPUT_SIZE]);
    await session.run({ images: tensor });
    console.log("[yolo] Warm-up inference complete");
  } catch (err) {
    console.warn("[yolo] Warm-up failed (non-fatal):", err);
  }
}

/**
 * Run YOLO inference on a video frame.
 *
 * @param video - The HTMLVideoElement to capture a frame from
 * @param roiMargin - Fraction of frame to exclude on each side (matches CAPTURE_ROI_MARGIN)
 * @param minBoxArea - Minimum bounding box area in model-space pixels
 * @param confidenceThreshold - Minimum detection confidence
 * @returns Array of detections, sorted by confidence descending. Empty on error.
 */
export async function runYoloInference(
  video: HTMLVideoElement,
  _roiMargin = 0.15,
  minBoxArea = 1500,
  confidenceThreshold = 0.50,
): Promise<YoloDetection[]> {
  if (!session || !ort) return [];

  try {
    // ── Preprocess: crop center 640×640 at 1:1 pixels (no scaling) ──
    // Crop a MODEL_INPUT_SIZE square from the center of the frame without any
    // resize, so YOLO sees native-resolution pixels. Falls back to short-side
    // resize only when the video is smaller than 640 in either dimension.
    const vw = video.videoWidth;
    const vh = video.videoHeight;

    const canvas = new OffscreenCanvas(MODEL_INPUT_SIZE, MODEL_INPUT_SIZE);
    const ctx = canvas.getContext("2d");
    if (!ctx) return [];

    if (vw >= MODEL_INPUT_SIZE && vh >= MODEL_INPUT_SIZE) {
      // 1:1 pixel crop — no scaling
      const cropX = Math.round((vw - MODEL_INPUT_SIZE) / 2);
      const cropY = Math.round((vh - MODEL_INPUT_SIZE) / 2);
      ctx.drawImage(video, cropX, cropY, MODEL_INPUT_SIZE, MODEL_INPUT_SIZE, 0, 0, MODEL_INPUT_SIZE, MODEL_INPUT_SIZE);
    } else {
      // Fallback for small video: crop center square and resize
      const side = Math.min(vw, vh);
      const roiX = Math.round((vw - side) / 2);
      const roiY = Math.round((vh - side) / 2);
      ctx.drawImage(video, roiX, roiY, side, side, 0, 0, MODEL_INPUT_SIZE, MODEL_INPUT_SIZE);
    }

    const imageData = ctx.getImageData(0, 0, MODEL_INPUT_SIZE, MODEL_INPUT_SIZE);
    const { data } = imageData;

    // Convert to NCHW Float32Array (normalized 0-1)
    const numPixels = MODEL_INPUT_SIZE * MODEL_INPUT_SIZE;
    const float32 = new Float32Array(3 * numPixels);
    for (let i = 0; i < numPixels; i++) {
      const offset = i * 4;
      float32[i] = data[offset] / 255;                    // R
      float32[numPixels + i] = data[offset + 1] / 255;    // G
      float32[2 * numPixels + i] = data[offset + 2] / 255; // B
    }

    const inputTensor = new ort.Tensor("float32", float32, [1, 3, MODEL_INPUT_SIZE, MODEL_INPUT_SIZE]);

    // ── Run inference ──
    const results = await session.run({ images: inputTensor });

    // ── Postprocess ──
    // One-to-one head output shape: [1, 300, 6]
    //   300 = max detections (NMS-free, already deduplicated by model)
    //   6 = [x1, y1, x2, y2, confidence, class_id]
    const output = results[Object.keys(results)[0]];
    if (!output) return [];

    const outputData = output.data as Float32Array;
    const numDetections = output.dims[1] as number; // 300
    const detections: YoloDetection[] = [];

    // DEBUG: track what the model actually outputs before filtering
    let debugBestConf = 0;
    let debugBestClass = "";
    let debugBestArea = 0;
    let debugDroppedByArea = 0;

    for (let i = 0; i < numDetections; i++) {
      const offset = i * 6;
      const x1 = outputData[offset];
      const y1 = outputData[offset + 1];
      const x2 = outputData[offset + 2];
      const y2 = outputData[offset + 3];
      const confidence = outputData[offset + 4];
      const classId = Math.round(outputData[offset + 5]);

      if (confidence < confidenceThreshold) continue;
      if (classId < 0 || classId >= WASTE_CLASSES.length) continue;

      const bw = x2 - x1;
      const bh = y2 - y1;
      const area = bw * bh;

      if (confidence > debugBestConf) {
        debugBestConf = confidence;
        debugBestClass = WASTE_CLASSES[classId];
        debugBestArea = area;
      }

      if (area < minBoxArea) {
        debugDroppedByArea++;
        continue;
      }

      detections.push({
        classId,
        className: WASTE_CLASSES[classId],
        confidence,
        bbox: [x1, y1, bw, bh],
      });
    }

    if (debugBestConf > 0 || debugDroppedByArea > 0) {
      console.log(
        `[yolo-debug] best: ${debugBestClass} ${(debugBestConf * 100).toFixed(1)}% area=${Math.round(debugBestArea)}, droppedByArea=${debugDroppedByArea}, kept=${detections.length}`
      );
    }

    // Sort by confidence descending
    detections.sort((a, b) => b.confidence - a.confidence);

    return detections;
  } catch (err) {
    console.warn("[yolo] Inference error:", err);
    return [];
  }
}
