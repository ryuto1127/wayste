/**
 * Class-agnostic fallback for continuous mode — the "YOLO saw nothing but
 * something is clearly there" net.
 *
 * YOLO only proposes boxes for shapes resembling its 15 trained classes; a
 * fully out-of-vocabulary item (umbrella, gadget, toy) can produce zero
 * detections, which would leave the kiosk silently unresponsive — the worst
 * production failure mode. The background-subtraction CV pipeline
 * (lib/frame-analyzer.ts) already runs in continuous mode and detects
 * "something entered the scene" without knowing what it is.
 *
 * This module turns persistent, object-like CV blobs that no YOLO detection
 * or known track covers into synthetic `unknown_object` detections. Feeding
 * them into the DetectionTracker gives them the full temporal treatment for
 * free: N-of-M + wall-clock confirmation filters blob noise, the card layer
 * resolves them as needs_review (no YOLO rule exists for the class), and if
 * YOLO later recognizes the object the class-swap vote upgrades the track.
 *
 * Pure logic, browser-safe, unit-tested.
 */

import type { BlobInfo, YoloDetection } from "./types";
import { blobIsObject, ROI_INSET } from "./frame-analyzer";
import { computeLetterbox, type Bbox } from "./bbox-utils";

export const UNKNOWN_OBJECT_CLASS = "unknown_object";
export const UNKNOWN_OBJECT_CLASS_ID = -1;

/** Blobs smaller than this fraction of the ROI are treated as noise. */
const MIN_BLOB_RATIO = 0.008;

/** Overlap (intersection / smaller box) above which a blob is considered
 *  the same object as a YOLO detection or known track — containment-aware,
 *  since CV blobs are typically looser than YOLO boxes. */
const MAX_KNOWN_OVERLAP = 0.3;

function overlapOverMinArea(a: Bbox, b: Bbox): number {
  const ix = Math.max(0, Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0]));
  const iy = Math.max(0, Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]));
  const inter = ix * iy;
  const minArea = Math.min(a[2] * a[3], b[2] * b[3]);
  return minArea > 0 ? inter / minArea : 0;
}

/**
 * Convert a CV blob (ROI-normalized center format) to a model-space bbox
 * in the letterboxed full-frame coordinate system used by continuous mode.
 */
export function blobToModelBbox(
  blob: BlobInfo,
  videoAspect: number,
  modelSize = 640,
): Bbox {
  const { dx, dy, dw, dh } = computeLetterbox(videoAspect, 1, modelSize);
  const [cx, cy, w, h] = blob.bboxNorm;
  // ROI space → full-frame normalized. The analyzer draws the FULL frame
  // into its canvas and the ROI is the centered (1 − 2·inset) region.
  const span = 1 - 2 * ROI_INSET;
  const fx = ROI_INSET + (cx - w / 2) * span;
  const fy = ROI_INSET + (cy - h / 2) * span;
  return [
    dx + fx * dw,
    dy + fy * dh,
    w * span * dw,
    h * span * dh,
  ];
}

/**
 * Build synthetic `unknown_object` detections from CV blobs that:
 *   - look like real objects (sharpness/contrast/skin gates), and
 *   - are big enough to matter, and
 *   - are NOT already covered by a YOLO detection or a known-class track.
 *
 * `knownTrackBboxes` must contain only tracks with a real YOLO class —
 * an unknown track's own bbox must NOT suppress the synthetic detection
 * that sustains it, or the track would starve and coast out.
 *
 * `confidence` should be the tracker's appear threshold so the synthetic
 * detection can both seed and sustain a track.
 */
export function synthesizeUnknownDetections(
  blobs: BlobInfo[],
  realDetections: YoloDetection[],
  knownTrackBboxes: Bbox[],
  videoAspect: number,
  confidence: number,
  modelSize = 640,
): YoloDetection[] {
  const out: YoloDetection[] = [];
  for (const blob of blobs) {
    if (!blobIsObject(blob)) continue;
    if (blob.ratio < MIN_BLOB_RATIO) continue;

    const bbox = blobToModelBbox(blob, videoAspect, modelSize);
    const coveredByKnown =
      realDetections.some((d) => overlapOverMinArea(bbox, d.bbox as Bbox) > MAX_KNOWN_OVERLAP) ||
      knownTrackBboxes.some((tb) => overlapOverMinArea(bbox, tb) > MAX_KNOWN_OVERLAP);
    if (coveredByKnown) continue;

    out.push({
      classId: UNKNOWN_OBJECT_CLASS_ID,
      className: UNKNOWN_OBJECT_CLASS,
      confidence,
      bbox,
    });
  }
  return out;
}
