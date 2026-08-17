/**
 * Bounding-box utilities for spatial tracking and frame-change detection.
 *
 * Pure functions — no React, no refs, no side effects.
 * All bboxes are in YOLO pixel space: [x, y, width, height] within a
 * MODEL_INPUT_SIZE square (see below).
 */

export type Bbox = [x: number, y: number, w: number, h: number];

/**
 * Square side of the deployed YOLO model's input, and therefore the pixel
 * space every bbox in the pipeline lives in. Single source of truth: the
 * ONNX export size, the letterbox math, the tracker's pixel thresholds and
 * the crop mappings must all agree, or boxes land in the wrong place.
 *
 * 480 (was 640): inference cost scales with area, so 480² cuts it ~44% —
 * the difference between ~13fps and ~25fps for YOLO26m on the demo
 * machine. Demo items fill much of the frame, so the resolution loss
 * costs little; revisit if small/distant items start being missed.
 */
export const MODEL_INPUT_SIZE = 480;

/** Scale a pixel threshold that was tuned in 640-space to the current
 *  model size, preserving its meaning as a fraction of the frame. */
export function scaleFrom640(px: number): number {
  return Math.round(px * (MODEL_INPUT_SIZE / 640) ** 2);
}

// ── IoU ──

/** Compute Intersection-over-Union for two [x, y, w, h] bboxes. */
export function computeIoU(a: Bbox, b: Bbox): number {
  const ax1 = a[0], ay1 = a[1], ax2 = a[0] + a[2], ay2 = a[1] + a[3];
  const bx1 = b[0], by1 = b[1], bx2 = b[0] + b[2], by2 = b[1] + b[3];

  const ix1 = Math.max(ax1, bx1);
  const iy1 = Math.max(ay1, by1);
  const ix2 = Math.min(ax2, bx2);
  const iy2 = Math.min(ay2, by2);

  const iw = Math.max(0, ix2 - ix1);
  const ih = Math.max(0, iy2 - iy1);
  const intersection = iw * ih;

  if (intersection === 0) return 0;

  const aArea = a[2] * a[3];
  const bArea = b[2] * b[3];
  const union = aArea + bArea - intersection;

  return union > 0 ? intersection / union : 0;
}

// ── Greedy IoU Matching ──

export interface TrackableItem {
  id: number;
  bbox: Bbox;
}

export interface DetectionItem {
  bbox: Bbox;
  index: number;
}

export interface MatchResult {
  matched: { trackedId: number; detectionIndex: number; iou: number }[];
  unmatchedTracked: number[];
  unmatchedDetections: number[];
}

/**
 * Greedy IoU matching between tracked items and new detections.
 *
 * Builds an NxM IoU matrix, then greedily assigns pairs in descending
 * IoU order. Both sides can only be assigned once. Pairs below minIoU
 * are left unmatched.
 */
export function greedyIoUMatch(
  tracked: TrackableItem[],
  detections: DetectionItem[],
  minIoU = 0.3,
): MatchResult {
  if (tracked.length === 0 || detections.length === 0) {
    return {
      matched: [],
      unmatchedTracked: tracked.map((t) => t.id),
      unmatchedDetections: detections.map((d) => d.index),
    };
  }

  // Build IoU matrix + flat list for sorting
  const pairs: { ti: number; di: number; iou: number }[] = [];
  for (let ti = 0; ti < tracked.length; ti++) {
    for (let di = 0; di < detections.length; di++) {
      const iou = computeIoU(tracked[ti].bbox, detections[di].bbox);
      if (iou >= minIoU) {
        pairs.push({ ti, di, iou });
      }
    }
  }

  // Sort descending by IoU — greedy best-first
  pairs.sort((a, b) => b.iou - a.iou);

  const usedTracked = new Set<number>();
  const usedDetections = new Set<number>();
  const matched: MatchResult["matched"] = [];

  for (const { ti, di, iou } of pairs) {
    if (usedTracked.has(ti) || usedDetections.has(di)) continue;
    usedTracked.add(ti);
    usedDetections.add(di);
    matched.push({
      trackedId: tracked[ti].id,
      detectionIndex: detections[di].index,
      iou,
    });
  }

  const unmatchedTracked = tracked
    .filter((_, i) => !usedTracked.has(i))
    .map((t) => t.id);
  const unmatchedDetections = detections
    .filter((_, i) => !usedDetections.has(i))
    .map((d) => d.index);

  return { matched, unmatchedTracked, unmatchedDetections };
}

// ── Letterbox (full-frame YOLO coverage) ──

export interface LetterboxParams {
  /** Destination rect of the video content inside the square model input. */
  dx: number;
  dy: number;
  dw: number;
  dh: number;
}

/**
 * Compute where the full video frame lands inside the square model input
 * when letterboxed (aspect preserved, padded on the short axis). Scale
 * invariant — passing (aspectRatio, 1) gives the same normalized result
 * as passing real pixel dimensions.
 */
export function computeLetterbox(vw: number, vh: number, size = MODEL_INPUT_SIZE): LetterboxParams {
  if (vw <= 0 || vh <= 0) return { dx: 0, dy: 0, dw: size, dh: size };
  const scale = size / Math.max(vw, vh);
  const dw = Math.round(vw * scale);
  const dh = Math.round(vh * scale);
  return {
    dx: Math.round((size - dw) / 2),
    dy: Math.round((size - dh) / 2),
    dw,
    dh,
  };
}

/**
 * Map a model-space bbox from a letterboxed inference back to coordinates
 * normalized to the FULL video frame (0–1). Values can fall slightly
 * outside [0, 1] when a box bleeds into the padding — callers clip via
 * overflow rather than clamping, so partial boxes at the edge stay honest.
 */
export function letterboxedBboxToVideoNorm(
  bbox: Bbox,
  vw: number,
  vh: number,
  size = MODEL_INPUT_SIZE,
): Bbox {
  const { dx, dy, dw, dh } = computeLetterbox(vw, vh, size);
  return [
    (bbox[0] - dx) / dw,
    (bbox[1] - dy) / dh,
    bbox[2] / dw,
    bbox[3] / dh,
  ];
}

// ── Frame Fingerprinting ──

/**
 * Compute a 32×32 grayscale fingerprint of the current video frame.
 * Uses the same center-square crop as YOLO (short-side based).
 *
 * @param video Source video element
 * @param canvas Reusable 32×32 OffscreenCanvas (caller owns lifecycle)
 */
export function computeFrameFingerprint(
  video: HTMLVideoElement,
  canvas: OffscreenCanvas,
): Uint8Array {
  const ctx = canvas.getContext("2d") as OffscreenCanvasRenderingContext2D;
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  const side = Math.min(vw, vh);
  const sx = Math.round((vw - side) / 2);
  const sy = Math.round((vh - side) / 2);

  ctx.drawImage(video, sx, sy, side, side, 0, 0, 32, 32);
  const { data } = ctx.getImageData(0, 0, 32, 32);

  const gray = new Uint8Array(1024);
  for (let i = 0; i < 1024; i++) {
    const o = i * 4;
    gray[i] = (0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2]) | 0;
  }
  return gray;
}

/** Mean absolute pixel difference between two fingerprints (0–255 scale). */
export function frameDiff(a: Uint8Array, b: Uint8Array): number {
  if (a.length !== b.length || a.length === 0) return 255;
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    sum += Math.abs(a[i] - b[i]);
  }
  return sum / a.length;
}
