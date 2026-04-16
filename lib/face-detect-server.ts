/**
 * Server-side face detection using UltraFace RFB-320 (ONNX Runtime Node).
 *
 * Why: the kiosk's privacy gate ("no frames with faces are stored to Blob")
 * cannot rely on a client-supplied boolean — an attacker hitting /api/classify
 * directly could always send `faceDetected: false` to force storage. This
 * module re-runs face detection server-side so the truth comes from code the
 * attacker cannot bypass.
 *
 * Model: UltraFace RFB-320 (~1.2 MB ONNX).
 *   - Input "input": float32 [1, 3, 240, 320], NCHW, normalized (x - 127.5) / 128
 *   - Output "scores": float32 [1, 4420, 2] — [:,:,1] is face probability
 *   - Output "boxes": float32 [1, 4420, 4] — not needed for a boolean check
 *
 * Cold start: ~1–2 s to load the ONNX runtime binary + model on Vercel.
 * Warm: ~30–80 ms per image (JPEG decode + resize + inference).
 */

import path from "node:path";
import sharp from "sharp";
import type { InferenceSession, Tensor } from "onnxruntime-node";

const MODEL_PATH = path.join(process.cwd(), "lib/models/face-detector.onnx");
const INPUT_W = 320;
const INPUT_H = 240;
const DEFAULT_CONFIDENCE = 0.7;

let sessionPromise: Promise<InferenceSession> | null = null;

/** Lazy-init the ONNX session exactly once per serverless instance. */
async function getSession(): Promise<InferenceSession> {
  if (!sessionPromise) {
    sessionPromise = (async () => {
      const ort = await import("onnxruntime-node");
      // Silence the ~250 "initializer appears in graph inputs" warnings
      // UltraFace emits during graph load — cosmetic exporter hints.
      // 3 = ERROR only. Must be set on env before Session.create().
      ort.env.logLevel = "error";
      return ort.InferenceSession.create(MODEL_PATH, {
        executionProviders: ["cpu"],
        graphOptimizationLevel: "all",
        logSeverityLevel: 3,
      });
    })();
  }
  return sessionPromise;
}

/**
 * Returns true if the JPEG in `imageBase64` contains at least one face above
 * `minConfidence`. Fails CLOSED: if the detector can't run (e.g. model load
 * failed, image decode failed), returns `true` so the image is NOT stored.
 *
 * The kiosk's privacy promise is the expensive side to violate — false
 * positives only mean a few extra images get dropped.
 */
export async function serverFaceDetected(
  imageBase64: string,
  minConfidence: number = DEFAULT_CONFIDENCE,
): Promise<boolean> {
  try {
    const session = await getSession();

    // Decode base64 JPEG → raw RGB at 320×240, using sharp.
    const buf = Buffer.from(imageBase64, "base64");
    const { data } = await sharp(buf)
      .resize(INPUT_W, INPUT_H, { fit: "fill" })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    // HWC uint8 → NCHW float32, normalized (x - 127.5) / 128.
    const pixelCount = INPUT_W * INPUT_H;
    const tensorData = new Float32Array(3 * pixelCount);
    for (let i = 0; i < pixelCount; i++) {
      const r = data[i * 3] ?? 0;
      const g = data[i * 3 + 1] ?? 0;
      const b = data[i * 3 + 2] ?? 0;
      tensorData[i] = (r - 127.5) / 128;
      tensorData[pixelCount + i] = (g - 127.5) / 128;
      tensorData[2 * pixelCount + i] = (b - 127.5) / 128;
    }

    const ort = await import("onnxruntime-node");
    const input = new ort.Tensor("float32", tensorData, [1, 3, INPUT_H, INPUT_W]);

    const output = await session.run({ input });
    const scoresTensor = output.scores as Tensor;
    const scores = scoresTensor.data as Float32Array;

    // scores layout: [background, face] per anchor. Walk the face channel only.
    // Total anchors = scores.length / 2.
    const anchors = scores.length / 2;
    for (let i = 0; i < anchors; i++) {
      const faceScore = scores[i * 2 + 1];
      if (faceScore >= minConfidence) return true;
    }
    return false;
  } catch (err) {
    console.warn("[face-detect-server] Inference failed, failing CLOSED:", err);
    return true;
  }
}
