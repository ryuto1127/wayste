/**
 * YOLO26n edge inference using ONNX Runtime Web.
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
export function initYolo(modelUrl = "/models/yolo26n.onnx"): Promise<boolean> {
  if (loading) return loading;

  loading = (async () => {
    try {
      ort = await import("onnxruntime-web");

      // Use WASM backend — universally supported in browsers
      ort.env.wasm.numThreads = 1;

      session = await ort.InferenceSession.create(modelUrl, {
        executionProviders: ["wasm"],
      });

      console.log("[yolo] Model loaded successfully");
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
  roiMargin = 0.15,
  minBoxArea = 5000,
  confidenceThreshold = 0.65,
): Promise<YoloDetection[]> {
  if (!session || !ort) return [];

  try {
    // ── Preprocess: crop ROI, resize to 640×640, normalize ──
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    const roiX = Math.round(vw * roiMargin);
    const roiY = Math.round(vh * roiMargin);
    const roiW = Math.round(vw * (1 - roiMargin * 2));
    const roiH = Math.round(vh * (1 - roiMargin * 2));

    const canvas = new OffscreenCanvas(MODEL_INPUT_SIZE, MODEL_INPUT_SIZE);
    const ctx = canvas.getContext("2d");
    if (!ctx) return [];

    // Draw ROI region scaled to 640×640
    ctx.drawImage(video, roiX, roiY, roiW, roiH, 0, 0, MODEL_INPUT_SIZE, MODEL_INPUT_SIZE);

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
    // YOLO output shape: [1, 84, 8400] — (batch, 4 bbox + 80 classes, detections)
    const output = results[Object.keys(results)[0]];
    if (!output) return [];

    const outputData = output.data as Float32Array;
    const numDetections = 8400;
    const numClasses = 80;

    const detections: YoloDetection[] = [];

    for (let i = 0; i < numDetections; i++) {
      // Extract bbox (cx, cy, w, h) — each value is at stride numDetections
      const cx = outputData[0 * numDetections + i];
      const cy = outputData[1 * numDetections + i];
      const w = outputData[2 * numDetections + i];
      const h = outputData[3 * numDetections + i];

      // Find best class
      let maxScore = 0;
      let maxClassId = 0;
      for (let c = 0; c < numClasses; c++) {
        const score = outputData[(4 + c) * numDetections + i];
        if (score > maxScore) {
          maxScore = score;
          maxClassId = c;
        }
      }

      // Apply filters
      if (maxScore < confidenceThreshold) continue;

      const boxArea = w * h;
      if (boxArea < minBoxArea) continue;

      // Skip "person" detections (class 0)
      if (maxClassId === 0) continue;

      const x = cx - w / 2;
      const y = cy - h / 2;

      detections.push({
        classId: maxClassId,
        className: COCO_CLASSES[maxClassId] ?? `class_${maxClassId}`,
        confidence: maxScore,
        bbox: [x, y, w, h],
      });
    }

    // Sort by confidence descending
    detections.sort((a, b) => b.confidence - a.confidence);

    // Simple NMS: suppress overlapping detections of the same class
    return nms(detections, 0.5);
  } catch (err) {
    console.warn("[yolo] Inference error:", err);
    return [];
  }
}

/** Non-maximum suppression — removes overlapping boxes of the same class. */
function nms(detections: YoloDetection[], iouThreshold: number): YoloDetection[] {
  const kept: YoloDetection[] = [];

  for (const det of detections) {
    let suppressed = false;
    for (const k of kept) {
      if (k.classId === det.classId && iou(k.bbox, det.bbox) > iouThreshold) {
        suppressed = true;
        break;
      }
    }
    if (!suppressed) kept.push(det);
  }

  return kept;
}

/** Intersection-over-Union for [x, y, w, h] boxes. */
function iou(
  a: [number, number, number, number],
  b: [number, number, number, number],
): number {
  const x1 = Math.max(a[0], b[0]);
  const y1 = Math.max(a[1], b[1]);
  const x2 = Math.min(a[0] + a[2], b[0] + b[2]);
  const y2 = Math.min(a[1] + a[3], b[1] + b[3]);

  const intersection = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  if (intersection === 0) return 0;

  const areaA = a[2] * a[3];
  const areaB = b[2] * b[3];
  return intersection / (areaA + areaB - intersection);
}
