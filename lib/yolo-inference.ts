/**
 * YOLO26m edge inference using ONNX Runtime Web (FP16).
 *
 * Uses COCO-80 pre-trained YOLO26m with a rules file that maps all 80
 * classes to disposal streams. Non-waste detections (furniture, vehicles,
 * animals, etc.) resolve to "not_waste" for instant rejection.
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

/** COCO-80 class names (standard YOLO training set). */
const COCO_CLASSES = [
  "person", "bicycle", "car", "motorcycle", "airplane", "bus", "train", "truck",
  "boat", "traffic light", "fire hydrant", "stop sign", "parking meter", "bench",
  "bird", "cat", "dog", "horse", "sheep", "cow", "elephant", "bear", "zebra",
  "giraffe", "backpack", "umbrella", "handbag", "tie", "suitcase", "frisbee",
  "skis", "snowboard", "sports ball", "kite", "baseball bat", "baseball glove",
  "skateboard", "surfboard", "tennis racket", "bottle", "wine glass", "cup",
  "fork", "knife", "spoon", "bowl", "banana", "apple", "sandwich", "orange",
  "broccoli", "carrot", "hot dog", "pizza", "donut", "cake", "chair", "couch",
  "potted plant", "bed", "dining table", "toilet", "tv", "laptop", "mouse",
  "remote", "keyboard", "cell phone", "microwave", "oven", "toaster", "sink",
  "refrigerator", "book", "clock", "vase", "scissors", "teddy bear",
  "hair drier", "toothbrush",
];

/**
 * Initialize the YOLO model. Safe to call multiple times — subsequent calls
 * return the same promise. If the model file is missing or ONNX fails to load,
 * resolves to `false` and all subsequent `runYoloInference()` calls return [].
 */
export function initYolo(modelUrl = "/models/yolo26m.onnx"): Promise<boolean> {
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
  confidenceThreshold = 0.65,
): Promise<YoloDetection[]> {
  if (!session || !ort) return [];

  try {
    // ── Preprocess: crop center short-side square, resize to 640×640 ──
    // Crop the largest centered square (short-side based, e.g. 720×720 from
    // 1280×720) and resize into the model's 640×640 input. This maximises
    // the field of view while keeping the aspect ratio square.
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
    // NMS-free output shape: [1, 84, 8400] (channels-first) or [1, 8400, 84] (rows-first)
    //   84 = 4 (cx, cy, w, h) + 80 (COCO class scores)
    //   8400 = candidate boxes (no NMS applied)
    const output = results[Object.keys(results)[0]];
    if (!output) return [];

    const outputData = output.data as Float32Array;
    const shape = output.dims;

    const rawDetections: YoloDetection[] = [];
    const numClasses = COCO_CLASSES.length; // 80

    // Detect layout: channels-first [1, 84, 8400] vs rows-first [1, 8400, 84]
    const channelsFirst = (shape[1] as number) === numClasses + 4;
    const numCandidates = channelsFirst ? (shape[2] as number) : (shape[1] as number);

    for (let i = 0; i < numCandidates; i++) {
      // Find best class score via argmax
      let bestScore = -1;
      let bestClassId = -1;
      for (let c = 0; c < numClasses; c++) {
        const score = channelsFirst
          ? outputData[(4 + c) * numCandidates + i]
          : outputData[i * (numClasses + 4) + 4 + c];
        if (score > bestScore) {
          bestScore = score;
          bestClassId = c;
        }
      }

      if (bestScore < confidenceThreshold) continue;
      if (bestClassId < 0 || bestClassId >= numClasses) continue;

      // Read box (cx, cy, w, h) in pixel coords (0-640)
      const cx = channelsFirst ? outputData[0 * numCandidates + i] : outputData[i * (numClasses + 4) + 0];
      const cy = channelsFirst ? outputData[1 * numCandidates + i] : outputData[i * (numClasses + 4) + 1];
      const bw = channelsFirst ? outputData[2 * numCandidates + i] : outputData[i * (numClasses + 4) + 2];
      const bh = channelsFirst ? outputData[3 * numCandidates + i] : outputData[i * (numClasses + 4) + 3];

      const boxArea = bw * bh;
      if (boxArea < minBoxArea) continue;

      // Convert center format → corner format
      const x1 = cx - bw / 2;
      const y1 = cy - bh / 2;

      rawDetections.push({
        classId: bestClassId,
        className: COCO_CLASSES[bestClassId],
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

    return kept;
  } catch (err) {
    console.warn("[yolo] Inference error:", err);
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
