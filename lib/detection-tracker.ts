/**
 * Temporal detection tracker for continuous (always-on) YOLO mode.
 *
 * Raw per-frame YOLO detections flicker: confidence swings ±0.2 between
 * frames, boxes jitter, occlusion drops an item for a few hundred ms, and a
 * passing person can produce a one-frame false positive. This module turns
 * that noisy stream into stable "tracks" via:
 *
 *   - IoU matching frame-to-frame (same place ≈ same object)
 *   - N-of-M confirmation: a track must be seen in `confirmHits` of the last
 *     `confirmWindow` cycles before it is confirmed (kills one-frame ghosts)
 *   - Hysteresis: seeding a NEW track needs `appearConfidence`, but keeping
 *     an existing one only needs the (lower) floor the caller feeds in —
 *     strict entry, lenient hold
 *   - Coasting: a confirmed track survives `coastMs` of total absence
 *     (hand/person briefly occluding the item must not clear the result)
 *   - Class-swap voting: if the same location consistently reads as a
 *     different class for `classSwapCycles` cycles, the object was swapped —
 *     the track changes class instead of flickering between two results
 *   - Parked suppression: a confirmed track that hasn't moved for
 *     `parkedAfterMs` is furniture/leftover trash — suppressed until it moves
 *
 * Pure logic, browser-safe, no side effects — unit-tested without a DOM.
 */

import type { YoloDetection } from "./types";
import { greedyIoUMatch, computeIoU, type Bbox } from "./bbox-utils";

export type TrackState = "tentative" | "confirmed" | "coasting";

export interface Track {
  id: number;
  /** Smoothed bbox in YOLO 640-space [x, y, w, h]. */
  bbox: Bbox;
  className: string;
  classId: number;
  /** EMA-smoothed confidence — judge display on this, never on raw frames. */
  confidence: number;
  state: TrackState;
  /** Ring buffer of the last `confirmWindow` cycles (1 = matched). */
  hitRing: number[];
  missStreak: number;
  firstSeenAt: number;
  confirmedAt: number | null;
  lastMatchedAt: number;
  /** True when stationary past parkedAfterMs — caller should not display. */
  parked: boolean;
  /** Center position the parked-timer is anchored to. */
  anchorCenter: [number, number];
  anchorSince: number;
  /** Candidate class for a swap vote (object replaced at same location). */
  swapClassName: string | null;
  swapClassId: number;
  swapCount: number;
  /** When the current swap-candidate streak started (ms). */
  swapSince: number;
}

export type TrackerEvent =
  | { type: "confirmed"; track: Track }
  | { type: "lost"; trackId: number }
  | { type: "classChanged"; track: Track; previousClassName: string }
  | { type: "parked"; trackId: number }
  | { type: "unparked"; track: Track };

/** Per-cycle thresholds — derived from site sensitivity by the caller. */
export interface TrackerThresholds {
  /** Confidence required for a detection to seed a NEW track (hysteresis high). */
  appearConfidence: number;
  /** Floor the caller already applied to detections (hysteresis low). Informational. */
  keepConfidence: number;
}

export interface TrackerConfig {
  /** Minimum IoU to consider a detection the same object as a track. */
  minIoU: number;
  /** Matched cycles within confirmWindow needed to confirm a track. */
  confirmHits: number;
  confirmWindow: number;
  /** Minimum wall-clock age (ms) before a track can confirm. Frame counts
   *  alone are FPS-dependent — at 30fps a 200ms ghost yields 6 hits, at
   *  10fps only 2 — so confirmation requires BOTH enough hits and enough
   *  real time. Keeps behavior stable across camera/device frame rates. */
  confirmMinAgeMs: number;
  /** Consecutive misses that kill a tentative (unconfirmed) track. */
  tentativeMaxMisses: number;
  /** How long a confirmed track survives with no matching detection (ms). */
  coastMs: number;
  /** Consecutive foreign-class matches before the track swaps class. */
  classSwapCycles: number;
  /** Minimum wall-clock duration (ms) of a consistent foreign-class streak
   *  before swapping — same FPS-invariance rationale as confirmMinAgeMs. */
  classSwapMinMs: number;
  /** Hard cap on simultaneously alive tracks. */
  maxTracks: number;
  /** Stationary time before a confirmed track is suppressed as "parked" (ms). */
  parkedAfterMs: number;
  /** Center movement (640-space px) that counts as "the object moved". */
  parkedMoveTolerance: number;
  /** EMA alpha for confidence smoothing (higher = follows raw values faster). */
  emaAlpha: number;
  /** Blend factor for bbox smoothing (higher = follows raw bbox faster). */
  bboxAlpha: number;
}

export const DEFAULT_TRACKER_CONFIG: TrackerConfig = {
  minIoU: 0.2,
  confirmHits: 3,
  confirmWindow: 5,
  confirmMinAgeMs: 200,
  tentativeMaxMisses: 2,
  coastMs: 1500,
  classSwapCycles: 3,
  classSwapMinMs: 200,
  maxTracks: 8,
  parkedAfterMs: 150_000,
  parkedMoveTolerance: 48,
  emaAlpha: 0.35,
  bboxAlpha: 0.5,
};

function center(b: Bbox): [number, number] {
  return [b[0] + b[2] / 2, b[1] + b[3] / 2];
}

function centerDistance(a: [number, number], b: [number, number]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

export interface TrackerUpdate {
  /** All alive tracks (including tentative and parked). */
  tracks: Track[];
  events: TrackerEvent[];
}

export class DetectionTracker {
  private tracks: Track[] = [];
  private nextId = 1;
  private readonly config: TrackerConfig;

  constructor(config: Partial<TrackerConfig> = {}) {
    this.config = { ...DEFAULT_TRACKER_CONFIG, ...config };
  }

  /** Tracks the caller should display: confirmed or coasting, not parked. */
  static isDisplayable(t: Track): boolean {
    return (t.state === "confirmed" || t.state === "coasting") && !t.parked;
  }

  getTracks(): Track[] {
    return this.tracks;
  }

  reset(): void {
    this.tracks = [];
  }

  /**
   * Feed one YOLO cycle. `detections` must already be floor-filtered at the
   * keep threshold (hysteresis low); only NEW tracks additionally require
   * `thresholds.appearConfidence`.
   */
  update(
    detections: YoloDetection[],
    now: number,
    thresholds: TrackerThresholds,
  ): TrackerUpdate {
    const cfg = this.config;
    const events: TrackerEvent[] = [];

    const match = greedyIoUMatch(
      this.tracks.map((t) => ({ id: t.id, bbox: t.bbox })),
      detections.map((d, i) => ({ bbox: d.bbox as Bbox, index: i })),
      cfg.minIoU,
    );

    const byId = new Map(this.tracks.map((t) => [t.id, t]));

    // ── Matched tracks: absorb the detection ──
    for (const m of match.matched) {
      const track = byId.get(m.trackedId);
      const det = detections[m.detectionIndex];
      if (!track || !det) continue;

      const a = cfg.bboxAlpha;
      track.bbox = [
        track.bbox[0] * (1 - a) + det.bbox[0] * a,
        track.bbox[1] * (1 - a) + det.bbox[1] * a,
        track.bbox[2] * (1 - a) + det.bbox[2] * a,
        track.bbox[3] * (1 - a) + det.bbox[3] * a,
      ];
      track.confidence =
        track.confidence * (1 - cfg.emaAlpha) + det.confidence * cfg.emaAlpha;
      track.hitRing.push(1);
      if (track.hitRing.length > cfg.confirmWindow) track.hitRing.shift();
      track.missStreak = 0;
      track.lastMatchedAt = now;

      // ── Class-swap voting ──
      if (det.className === track.className) {
        track.swapClassName = null;
        track.swapCount = 0;
      } else if (det.className === track.swapClassName) {
        track.swapCount++;
        if (
          track.swapCount >= cfg.classSwapCycles &&
          now - track.swapSince >= cfg.classSwapMinMs
        ) {
          const previousClassName = track.className;
          track.className = det.className;
          track.classId = det.classId;
          // Reset smoothing — the old object's confidence says nothing
          // about the new one.
          track.confidence = det.confidence;
          track.swapClassName = null;
          track.swapCount = 0;
          if (track.state !== "tentative") {
            events.push({ type: "classChanged", track, previousClassName });
          }
        }
      } else {
        track.swapClassName = det.className;
        track.swapClassId = det.classId;
        track.swapCount = 1;
        track.swapSince = now;
      }

      // ── State transitions ──
      if (track.state === "coasting") {
        track.state = "confirmed";
      } else if (track.state === "tentative") {
        const hits = track.hitRing.reduce((s, v) => s + v, 0);
        // Both conditions: enough hits (vote robustness) AND enough
        // wall-clock age (FPS invariance — see confirmMinAgeMs).
        if (hits >= cfg.confirmHits && now - track.firstSeenAt >= cfg.confirmMinAgeMs) {
          track.state = "confirmed";
          track.confirmedAt = now;
          events.push({ type: "confirmed", track });
        }
      }

      // ── Parked bookkeeping ──
      // Movement is judged on the RAW detection center: the smoothed track
      // bbox halves each step of real motion, which would make a genuinely
      // moved object look stationary and keep it suppressed.
      const c = center(det.bbox as Bbox);
      if (centerDistance(c, track.anchorCenter) > cfg.parkedMoveTolerance) {
        track.anchorCenter = c;
        track.anchorSince = now;
        if (track.parked) {
          track.parked = false;
          events.push({ type: "unparked", track });
        }
      } else if (
        !track.parked &&
        track.state === "confirmed" &&
        now - track.anchorSince >= cfg.parkedAfterMs
      ) {
        track.parked = true;
        events.push({ type: "parked", trackId: track.id });
      }
    }

    // ── Unmatched tracks: miss ──
    const removed = new Set<number>();
    for (const trackId of match.unmatchedTracked) {
      const track = byId.get(trackId);
      if (!track) continue;
      track.hitRing.push(0);
      if (track.hitRing.length > cfg.confirmWindow) track.hitRing.shift();
      track.missStreak++;

      if (track.state === "tentative") {
        if (track.missStreak >= cfg.tentativeMaxMisses) removed.add(trackId);
      } else {
        track.state = "coasting";
        if (now - track.lastMatchedAt >= cfg.coastMs) {
          removed.add(trackId);
          events.push({ type: "lost", trackId });
        }
      }
    }
    if (removed.size > 0) {
      this.tracks = this.tracks.filter((t) => !removed.has(t.id));
    }

    // ── Unmatched detections: seed new tracks (hysteresis high bar) ──
    for (const detIdx of match.unmatchedDetections) {
      const det = detections[detIdx];
      if (!det || det.confidence < thresholds.appearConfidence) continue;
      if (this.tracks.length >= cfg.maxTracks) break;
      // A detection heavily overlapping an existing track is a double-box on
      // the same object (greedy matching gave the track to a better box) —
      // seeding a second track would duplicate the result card.
      const dup = this.tracks.some(
        (t) => computeIoU(t.bbox, det.bbox as Bbox) > 0.5,
      );
      if (dup) continue;

      const c = center(det.bbox as Bbox);
      this.tracks.push({
        id: this.nextId++,
        bbox: [...det.bbox] as Bbox,
        className: det.className,
        classId: det.classId,
        confidence: det.confidence,
        state: "tentative",
        hitRing: [1],
        missStreak: 0,
        firstSeenAt: now,
        confirmedAt: null,
        lastMatchedAt: now,
        parked: false,
        anchorCenter: c,
        anchorSince: now,
        swapClassName: null,
        swapClassId: -1,
        swapCount: 0,
        swapSince: now,
      });
    }

    return { tracks: this.tracks, events };
  }
}
