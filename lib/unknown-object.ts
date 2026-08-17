/**
 * Class-agnostic fallback for continuous mode — the "YOLO can't NAME it but
 * something is clearly there" net.
 *
 * A fully out-of-vocabulary item (umbrella, gadget, toy) may produce no
 * confident YOLO detection, which would leave the kiosk silently
 * unresponsive — the worst production failure mode. Two evidence sources
 * fill the gap, both funneled into synthetic `unknown_object` detections
 * that the DetectionTracker treats like any other: temporal confirmation
 * filters the noise, the card layer answers needs_review, and if YOLO later
 * recognizes the object the class-swap vote upgrades the track.
 *
 * 1. LOW-CONFIDENCE YOLO BOXES, corroborated by foreground. Below the keep
 *    threshold YOLO's class guess is unreliable, but the box still says
 *    "object-shaped thing here". Crucially, YOLO sees background furniture
 *    (mattress straps, window handles) exactly as well as presented items —
 *    so every candidate must ALSO overlap a background-subtraction blob,
 *    which proves the region CHANGED after detection started. Things that
 *    were already in the scene never qualify, however often YOLO boxes them.
 *
 * 2. CV BLOBS ALONE (net for objects YOLO gives ZERO boxes), with strict
 *    object-quality gates (sharpness/contrast/skin).
 *
 * Both sources depend on the background model, which is meaningless while
 * the camera or the whole scene moves — the caller flags that via
 * `sceneUnstable` and NO unknown candidates are produced until the model
 * re-converges (seconds). Novelty simply cannot be judged mid-motion.
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

/** Cap on low-confidence candidates per cycle — the tracker's maxTracks
 *  also guards, but flooding it with weak boxes wastes matching work, and
 *  more than two simultaneous "確認が必要" cards is noise, not guidance. */
const MAX_LOW_CONF_CANDIDATES = 2;

/** Minimum bbox area (model-space px²) for a low-confidence candidate.
 *  Weak evidence must at least be item-sized — this excludes rings,
 *  buttons, badges, and other small features riding on a person. */
const MIN_LOW_CONF_AREA = 1200;

/** Overlap (intersection / smaller box) with a suppression zone —
 *  background baseline regions or detected faces — that kills a candidate. */
const MAX_ZONE_OVERLAP = 0.35;

/** Minimum overlap with a foreground blob for a low-confidence candidate to
 *  count as "appeared after detection started" rather than scenery. */
const MIN_FOREGROUND_OVERLAP = 0.2;

/**
 * Build all unknown_object candidates for one cycle.
 *
 * `lowConfDetections` are YOLO boxes below the keep threshold (class guess
 * unreliable → treated as class-agnostic evidence) — each must be
 * corroborated by foreground (overlap with ANY blob, no quality gate: the
 * YOLO box supplies objectness, the blob supplies novelty). Candidates
 * overlapping a confident detection or a known-class track are suppressed,
 * and blob candidates duplicating a low-confidence box are dropped (the
 * YOLO box is the tighter of the two). While `sceneUnstable`, no candidates
 * are produced at all.
 */
export function buildUnknownDetections(params: {
  lowConfDetections: YoloDetection[];
  blobs: BlobInfo[];
  sceneUnstable: boolean;
  confidentDetections: YoloDetection[];
  knownTrackBboxes: Bbox[];
  /** Regions that must never spawn unknown candidates: the startup
   *  background baseline (window handles, furniture) and detected faces. */
  suppressZones?: Bbox[];
  videoAspect: number;
  /** Confidence stamped on synthetic detections — the tracker's appear
   *  threshold, so candidates can seed tracks (temporal filtering then
   *  decides whether they were real). */
  confidence: number;
  modelSize?: number;
}): YoloDetection[] {
  const {
    lowConfDetections, blobs, sceneUnstable, confidentDetections,
    knownTrackBboxes, suppressZones = [], videoAspect, confidence, modelSize = 640,
  } = params;

  // Novelty cannot be judged while the whole scene is changing.
  if (sceneUnstable) return [];

  const coveredByKnown = (bbox: Bbox) =>
    confidentDetections.some((d) => overlapOverMinArea(bbox, d.bbox as Bbox) > MAX_KNOWN_OVERLAP) ||
    knownTrackBboxes.some((tb) => overlapOverMinArea(bbox, tb) > MAX_KNOWN_OVERLAP);
  const inSuppressedZone = (bbox: Bbox) =>
    suppressZones.some((z) => overlapOverMinArea(bbox, z) > MAX_ZONE_OVERLAP);

  // Foreground regions (ALL blobs, no quality gate) — the novelty proof.
  const foreground = blobs.map((b) => blobToModelBbox(b, videoAspect, modelSize));
  const isForeground = (bbox: Bbox) =>
    foreground.some((f) => overlapOverMinArea(bbox, f) > MIN_FOREGROUND_OVERLAP);

  // Primary: low-confidence YOLO boxes, strongest first — foreground only.
  const fromYolo: YoloDetection[] = [];
  for (const d of [...lowConfDetections].sort((a, b) => b.confidence - a.confidence)) {
    if (fromYolo.length >= MAX_LOW_CONF_CANDIDATES) break;
    if (d.bbox[2] * d.bbox[3] < MIN_LOW_CONF_AREA) continue;
    if (!isForeground(d.bbox as Bbox)) continue; // scenery — was already there
    if (coveredByKnown(d.bbox as Bbox)) continue;
    if (inSuppressedZone(d.bbox as Bbox)) continue;
    if (fromYolo.some((u) => overlapOverMinArea(u.bbox as Bbox, d.bbox as Bbox) > MAX_KNOWN_OVERLAP)) continue;
    fromYolo.push({
      classId: UNKNOWN_OBJECT_CLASS_ID,
      className: UNKNOWN_OBJECT_CLASS,
      confidence,
      bbox: [...d.bbox] as Bbox,
    });
  }

  // Secondary: quality-gated blobs alone (objects YOLO gives zero boxes),
  // never duplicating a low-confidence candidate covering the same region.
  const fromBlobs = synthesizeUnknownDetections(
    blobs, confidentDetections, knownTrackBboxes, videoAspect, confidence, modelSize,
  ).filter(
    (b) =>
      !inSuppressedZone(b.bbox as Bbox) &&
      !fromYolo.some((u) => overlapOverMinArea(u.bbox as Bbox, b.bbox as Bbox) > MAX_KNOWN_OVERLAP),
  );

  return [...fromYolo, ...fromBlobs];
}
