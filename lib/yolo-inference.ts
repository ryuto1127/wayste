/**
 * YOLO edge inference using ONNX Runtime Web (FP16).
 *
 * Custom 15-class waste detection model trained on clean open data.
 * Covers packaging (bottles, cans, cups, bags, caps, labels),
 * special waste (batteries), and a unified food_waste class.
 * All classes are waste items — no not_waste filtering needed.
 * Each detection maps directly to a disposal stream.
 *
 * The model uses YOLO's one-to-one head which produces end-to-end
 * detections without NMS — output shape (1, 300, 6) = [x1, y1, x2, y2,
 * confidence, class_id]. This eliminates an entire post-processing stage.
 *
 * Runs entirely in the browser — no server calls required.
 * Falls back gracefully (returns empty array) if the model fails to load.
 */
import type { YoloDetection } from "./types";
import { computeLetterbox, MODEL_INPUT_SIZE, scaleFrom640 } from "./bbox-utils";

// Lazy-loaded ONNX Runtime — only imported when initYolo() is called.
type InferenceSession = import("onnxruntime-web").InferenceSession;
type OrtModule = typeof import("onnxruntime-web");

let ort: OrtModule | null = null;
let session: InferenceSession | null = null;
let loading: Promise<boolean> | null = null;
/** The execution provider that was actually used ("webgpu" | "wasm"). */
let activeProvider: string = "unknown";
/** Reusable preprocess canvas — continuous mode runs up to ~30 inferences/s,
 *  and allocating a fresh OffscreenCanvas per call churns GC on long runs.
 *  Inference calls are sequential (callers await), so sharing is safe. */
let preprocessCanvas: OffscreenCanvas | null = null;


/** Custom 15-class waste detection model. */
/** Class ids of the DEPLOYED model, in model order. Must stay in lockstep
 *  with `public/models/yolo-rules.json` — a mismatch silently mislabels
 *  every detection (id 4 meaning "battery" in one place and "glass_bottle"
 *  in the other). `__tests__/yolo-rules.test.ts` enforces the pairing. */
export const WASTE_CLASSES = [
  "plastic_bottle",       // 0
  "can",                  // 1
  "paper_cup",            // 2
  "plastic_cup",          // 3
  "battery",              // 4
];

/** Class list of the previous 15-class model, kept so `15class_v1.onnx`
 *  still decodes correctly if `initYolo` is pointed back at it. */
export const WASTE_CLASSES_15 = [
  "plastic_bottle", "can", "paper_cup", "plastic_cup", "glass_bottle",
  "cardboard", "paper", "plastic_bag", "paper_bag", "battery",
  "styrofoam", "tetra_pak", "plastic_bottle_cap", "plastic_bottle_label",
  "food_waste",
];

/** COCO-80 class list, in the official Ultralytics order — the vocabulary of
 *  `coco80_v1.onnx` (pretrained `yolo26s.pt` re-exported at 480px). COCO's
 *  annotations are professionally produced and QA'd, which makes this the
 *  highest-quality "is something there, and where" detector we can ship
 *  without collecting data ourselves. Waste-stream precision comes from
 *  yolo-rules.json mappings + the VLM tier, not from the class list. */
export const COCO_CLASSES = [
  "person", "bicycle", "car", "motorcycle", "airplane", "bus", "train",
  "truck", "boat", "traffic light", "fire hydrant", "stop sign",
  "parking meter", "bench", "bird", "cat", "dog", "horse", "sheep", "cow",
  "elephant", "bear", "zebra", "giraffe", "backpack", "umbrella", "handbag",
  "tie", "suitcase", "frisbee", "skis", "snowboard", "sports ball", "kite",
  "baseball bat", "baseball glove", "skateboard", "surfboard",
  "tennis racket", "bottle", "wine glass", "cup", "fork", "knife", "spoon",
  "bowl", "banana", "apple", "sandwich", "orange", "broccoli", "carrot",
  "hot dog", "pizza", "donut", "cake", "chair", "couch", "potted plant",
  "bed", "dining table", "toilet", "tv", "laptop", "mouse", "remote",
  "keyboard", "cell phone", "microwave", "oven", "toaster", "sink",
  "refrigerator", "book", "clock", "vase", "scissors", "teddy bear",
  "hair drier", "toothbrush",
];

export interface YoloModelSpec {
  url: string;
  classes: readonly string[];
}

/** Deployable models. `demo5` is the custom-trained waste detector; `coco80`
 *  is the COCO-pretrained general-object detector (smaller + faster, and its
 *  boxes are backed by professional annotation quality). */
export const YOLO_MODELS: Record<string, YoloModelSpec> = {
  demo5: { url: "/models/demo5_v1.onnx", classes: WASTE_CLASSES },
  coco80: { url: "/models/coco80_v1.onnx", classes: COCO_CLASSES },
};

let activeSpec: YoloModelSpec = YOLO_MODELS.demo5;

/** Select which deployed model `initYolo` loads and decodes against.
 *  Site-config driven; must run BEFORE the first initYolo() — the ONNX
 *  session loads once per page, so a later switch is ignored with a warning
 *  (decoding with the wrong class table would mislabel every detection). */
export function setActiveYoloModel(id: string): void {
  const spec = YOLO_MODELS[id];
  if (!spec) {
    console.warn(`[yolo] Unknown model id "${id}" — keeping ${activeSpec.url}`);
    return;
  }
  if (loading) {
    if (spec !== activeSpec) {
      console.warn(`[yolo] Model already loading — switch to "${id}" ignored`);
    }
    return;
  }
  activeSpec = spec;
}

/** The class table of the currently selected model. */
export function getActiveYoloClasses(): readonly string[] {
  return activeSpec.classes;
}

/**
 * Initialize the YOLO model. Safe to call multiple times — subsequent calls
 * return the same promise. If the model file is missing or ONNX fails to load,
 * resolves to `false` and all subsequent `runYoloInference()` calls return [].
 */
export function initYolo(modelUrl = activeSpec.url): Promise<boolean> {
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
 * @param fullFrame - When true, letterbox the ENTIRE video frame into the
 *   model input (aspect preserved, gray padding) instead of center-cropping.
 *   Detection coverage becomes the full camera view at the cost of smaller
 *   effective object resolution. Bboxes stay in model space — map back with
 *   `letterboxedBboxToVideoNorm()`.
 * @returns Array of detections, sorted by confidence descending. Empty on error.
 */
export async function runYoloInference(
  video: HTMLVideoElement,
  _roiMargin = 0.15,
  minBoxArea = scaleFrom640(1500),
  confidenceThreshold = 0.40,
  fullFrame = false,
): Promise<YoloDetection[]> {
  if (!session || !ort) return [];

  try {
    // ── Preprocess ──
    // Default: short-side square crop → resize to 640×640. Crops the same
    // center square as the review image so YOLO sees the field of view shown
    // in the review page.
    // fullFrame: the whole frame letterboxed into 640×640 (Ultralytics-style
    // gray padding) — used by continuous mode for edge-to-edge coverage.
    const vw = video.videoWidth;
    const vh = video.videoHeight;

    if (!preprocessCanvas) {
      preprocessCanvas = new OffscreenCanvas(MODEL_INPUT_SIZE, MODEL_INPUT_SIZE);
    }
    const canvas = preprocessCanvas;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return [];

    if (fullFrame) {
      const { dx, dy, dw, dh } = computeLetterbox(vw, vh, MODEL_INPUT_SIZE);
      ctx.fillStyle = "#727272"; // rgb(114,114,114) — YOLO letterbox convention
      ctx.fillRect(0, 0, MODEL_INPUT_SIZE, MODEL_INPUT_SIZE);
      ctx.drawImage(video, 0, 0, vw, vh, dx, dy, dw, dh);
    } else {
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

    for (let i = 0; i < numDetections; i++) {
      const offset = i * 6;
      const x1 = outputData[offset];
      const y1 = outputData[offset + 1];
      const x2 = outputData[offset + 2];
      const y2 = outputData[offset + 3];
      const confidence = outputData[offset + 4];
      const classId = Math.round(outputData[offset + 5]);

      if (confidence < confidenceThreshold) continue;
      if (classId < 0 || classId >= activeSpec.classes.length) continue;

      const bw = x2 - x1;
      const bh = y2 - y1;
      const area = bw * bh;

      if (area < minBoxArea) continue;

      const className = activeSpec.classes[classId];

      detections.push({
        classId,
        className,
        confidence,
        bbox: [x1, y1, bw, bh],
      });
    }

    // Sort by confidence descending
    detections.sort((a, b) => b.confidence - a.confidence);

    return detections;
  } catch (err) {
    console.warn("[yolo] Inference error:", err);
    return [];
  }
}
