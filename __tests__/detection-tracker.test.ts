/**
 * Tests for lib/detection-tracker.ts — temporal smoothing for continuous
 * (always-on) YOLO mode.
 *
 * Each scenario simulates a sequence of YOLO cycles and asserts the tracker
 * turns flickery raw detections into stable display decisions:
 * confirmation, hysteresis, occlusion coasting, class swap, parked
 * suppression.
 */

import {
  DetectionTracker,
  DEFAULT_TRACKER_CONFIG,
  type TrackerThresholds,
} from "@/lib/detection-tracker";
import type { YoloDetection } from "@/lib/types";

const TH: TrackerThresholds = { appearConfidence: 0.5, keepConfidence: 0.3 };

/** ~100ms per cycle, like the real continuous loop. */
const CYCLE_MS = 100;

function det(
  className: string,
  confidence: number,
  bbox: [number, number, number, number] = [100, 100, 120, 200],
  classId = 0,
): YoloDetection {
  return { classId, className, confidence, bbox };
}

/** Run N cycles with the same detections. Returns the final track list plus
 *  ALL events emitted across the cycles (events fire once, on the cycle where
 *  the transition happens). */
function runCycles(
  tracker: DetectionTracker,
  detections: YoloDetection[],
  n: number,
  startAt = 0,
) {
  const events = [];
  let last = tracker.update(detections, startAt, TH);
  events.push(...last.events);
  for (let i = 1; i < n; i++) {
    last = tracker.update(detections, startAt + i * CYCLE_MS, TH);
    events.push(...last.events);
  }
  return { tracks: last.tracks, events };
}

describe("DetectionTracker", () => {
  describe("confirmation (N-of-M)", () => {
    it("confirms a stable detection after confirmHits cycles", () => {
      const tracker = new DetectionTracker();
      let update = runCycles(tracker, [det("plastic_bottle", 0.8)], 2);
      expect(update.tracks[0].state).toBe("tentative");

      update = tracker.update([det("plastic_bottle", 0.8)], 2 * CYCLE_MS, TH);
      expect(update.tracks[0].state).toBe("confirmed");
      expect(update.events).toContainEqual(
        expect.objectContaining({ type: "confirmed" }),
      );
    });

    it("never confirms a one-frame ghost (passing person)", () => {
      const tracker = new DetectionTracker();
      tracker.update([det("plastic_bag", 0.7)], 0, TH);
      // Ghost vanishes; two empty cycles kill the tentative track.
      runCycles(tracker, [], DEFAULT_TRACKER_CONFIG.tentativeMaxMisses, CYCLE_MS);
      expect(tracker.getTracks()).toHaveLength(0);
    });

    it("does not confirm a short burst even at high FPS (wall-clock gate)", () => {
      const tracker = new DetectionTracker();
      // 30fps: a ~165ms ghost produces 6 hits — plenty of hit-count, but
      // below confirmMinAgeMs. Frame-count alone would confirm; time must not.
      for (let i = 0; i < 6; i++) {
        tracker.update([det("plastic_bag", 0.8)], i * 33, TH);
      }
      expect(tracker.getTracks()[0]?.state).toBe("tentative");
    });

    it("confirms at high FPS once both hits and age are sufficient", () => {
      const tracker = new DetectionTracker();
      for (let i = 0; i < 8; i++) {
        tracker.update([det("plastic_bottle", 0.8)], i * 33, TH); // ~231ms
      }
      expect(tracker.getTracks()[0].state).toBe("confirmed");
    });

    it("does not confirm intermittent 1-in-3 flicker", () => {
      const tracker = new DetectionTracker();
      // hit, miss, miss, hit, miss, miss — tentative dies on each double miss
      for (let i = 0; i < 3; i++) {
        tracker.update([det("can", 0.9)], i * 3 * CYCLE_MS, TH);
        tracker.update([], (i * 3 + 1) * CYCLE_MS, TH);
        tracker.update([], (i * 3 + 2) * CYCLE_MS, TH);
      }
      expect(
        tracker.getTracks().filter((t) => t.state !== "tentative"),
      ).toHaveLength(0);
    });
  });

  describe("hysteresis", () => {
    it("does not seed a new track below appearConfidence", () => {
      const tracker = new DetectionTracker();
      const update = tracker.update([det("can", 0.45)], 0, TH);
      expect(update.tracks).toHaveLength(0);
    });

    it("keeps an existing track alive on low-confidence matches", () => {
      const tracker = new DetectionTracker();
      runCycles(tracker, [det("can", 0.8)], 3);
      // Confidence drops below appearConfidence but above the keep floor —
      // the track must survive (strict entry, lenient hold).
      const update = runCycles(tracker, [det("can", 0.35)], 3, 3 * CYCLE_MS);
      expect(update.tracks).toHaveLength(1);
      expect(update.tracks[0].state).toBe("confirmed");
    });

    it("smooths confidence with EMA instead of following raw swings", () => {
      const tracker = new DetectionTracker();
      runCycles(tracker, [det("can", 0.9)], 3);
      const update = tracker.update([det("can", 0.4)], 3 * CYCLE_MS, TH);
      // One low frame must not drag smoothed confidence to the raw value.
      expect(update.tracks[0].confidence).toBeGreaterThan(0.6);
    });
  });

  describe("occlusion coasting", () => {
    it("keeps a confirmed track through a brief occlusion and reacquires it", () => {
      const tracker = new DetectionTracker();
      runCycles(tracker, [det("plastic_bottle", 0.85)], 4);
      let at = 4 * CYCLE_MS;

      // Occluded for 1s (< coastMs 1.5s)
      for (let i = 0; i < 10; i++) {
        const update = tracker.update([], at, TH);
        expect(update.tracks).toHaveLength(1);
        expect(update.tracks[0].state).toBe("coasting");
        at += CYCLE_MS;
      }

      // Reappears → same track id, confirmed again
      const before = tracker.getTracks()[0].id;
      const update = tracker.update([det("plastic_bottle", 0.85)], at, TH);
      expect(update.tracks[0].id).toBe(before);
      expect(update.tracks[0].state).toBe("confirmed");
    });

    it("drops a confirmed track after coastMs of absence", () => {
      const tracker = new DetectionTracker();
      runCycles(tracker, [det("plastic_bottle", 0.85)], 4);
      const gone = runCycles(
        tracker,
        [],
        Math.ceil(DEFAULT_TRACKER_CONFIG.coastMs / CYCLE_MS) + 1,
        4 * CYCLE_MS,
      );
      expect(gone.tracks).toHaveLength(0);
      expect(gone.events).toContainEqual(
        expect.objectContaining({ type: "lost" }),
      );
    });
  });

  describe("edge exit vs mid-frame occlusion", () => {
    // 16:9 letterbox content bounds in 640-space
    const BOUNDS = { x0: 0, y0: 140, x1: 640, y1: 500 };
    const TH_B = { ...TH, contentBounds: BOUNDS };

    it("drops an edge-exited track after edgeCoastMs, not coastMs", () => {
      const tracker = new DetectionTracker();
      // Item at the left content edge
      const edgeDet = det("can", 0.9, [2, 250, 80, 120]);
      for (let i = 0; i < 4; i++) tracker.update([edgeDet], i * CYCLE_MS, TH_B);
      // Vanishes — 300ms later (>= edgeCoastMs 250, << coastMs 1500) it's gone
      tracker.update([], 400, TH_B);
      const gone = tracker.update([], 700, TH_B);
      expect(gone.tracks).toHaveLength(0);
    });

    it("still coasts a mid-frame disappearance through the full coastMs", () => {
      const tracker = new DetectionTracker();
      const midDet = det("can", 0.9, [280, 280, 80, 120]);
      for (let i = 0; i < 4; i++) tracker.update([midDet], i * CYCLE_MS, TH_B);
      // 700ms of absence — an edge track would be gone; mid-frame coasts
      let at = 400;
      let update = tracker.update([], at, TH_B);
      for (let i = 0; i < 6; i++) {
        at += CYCLE_MS;
        update = tracker.update([], at, TH_B);
      }
      expect(update.tracks).toHaveLength(1);
      expect(update.tracks[0].state).toBe("coasting");
    });

    it("keeps full coastMs everywhere when no contentBounds are provided", () => {
      const tracker = new DetectionTracker();
      const edgeDet = det("can", 0.9, [2, 250, 80, 120]);
      for (let i = 0; i < 4; i++) tracker.update([edgeDet], i * CYCLE_MS, TH);
      tracker.update([], 400, TH);
      const still = tracker.update([], 900, TH);
      expect(still.tracks).toHaveLength(1);
    });
  });

  describe("multi-item", () => {
    it("tracks a second item entering while the first is displayed", () => {
      const tracker = new DetectionTracker();
      const bottle = det("plastic_bottle", 0.85, [50, 100, 100, 200]);
      runCycles(tracker, [bottle], 4);

      const canDet = det("can", 0.8, [400, 120, 90, 150], 1);
      const update = runCycles(tracker, [bottle, canDet], 3, 4 * CYCLE_MS);

      expect(update.tracks).toHaveLength(2);
      const states = update.tracks.map((t) => t.state);
      expect(states.filter((s) => s === "confirmed")).toHaveLength(2);
      // First track untouched by the newcomer
      expect(update.tracks[0].className).toBe("plastic_bottle");
    });

    it("ignores a duplicate box on an already-tracked object", () => {
      const tracker = new DetectionTracker();
      const a = det("plastic_bottle", 0.85, [100, 100, 120, 200]);
      // Nearly identical second box (double detection)
      const b = det("plastic_bottle", 0.6, [104, 102, 118, 198]);
      const update = runCycles(tracker, [a, b], 3);
      expect(update.tracks).toHaveLength(1);
    });

    it("caps simultaneous tracks at maxTracks", () => {
      const tracker = new DetectionTracker({ maxTracks: 4 });
      const many = Array.from({ length: 6 }, (_, i) =>
        det("can", 0.9, [i * 100, 50, 80, 80], 1),
      );
      const update = runCycles(tracker, many, 2);
      expect(update.tracks.length).toBeLessThanOrEqual(4);
    });
  });

  describe("class swap (item replaced at same location)", () => {
    it("swaps class after classSwapCycles consistent foreign reads", () => {
      const tracker = new DetectionTracker();
      runCycles(tracker, [det("can", 0.85)], 4);

      // Same location now reads as paper_cup for 3 cycles
      const cup = det("paper_cup", 0.8, [102, 98, 118, 202], 2);
      let update = runCycles(tracker, [cup], 2, 4 * CYCLE_MS);
      expect(update.tracks[0].className).toBe("can"); // not yet

      update = tracker.update([cup], 6 * CYCLE_MS, TH);
      expect(update.tracks[0].className).toBe("paper_cup");
      expect(update.events).toContainEqual(
        expect.objectContaining({ type: "classChanged", previousClassName: "can" }),
      );
    });

    it("does not swap on a single-frame misread", () => {
      const tracker = new DetectionTracker();
      runCycles(tracker, [det("can", 0.85)], 4);
      tracker.update([det("paper_cup", 0.8, [102, 98, 118, 202], 2)], 4 * CYCLE_MS, TH);
      const update = tracker.update([det("can", 0.85)], 5 * CYCLE_MS, TH);
      expect(update.tracks[0].className).toBe("can");
    });
  });

  describe("parked suppression (leftover trash)", () => {
    const fastPark = { parkedAfterMs: 1000 };

    it("suppresses a stationary confirmed track after parkedAfterMs", () => {
      const tracker = new DetectionTracker(fastPark);
      const update = runCycles(tracker, [det("can", 0.9)], 12); // 1.1s stationary
      expect(update.tracks[0].parked).toBe(true);
      expect(DetectionTracker.isDisplayable(update.tracks[0])).toBe(false);
    });

    it("unparks when the object moves again", () => {
      const tracker = new DetectionTracker(fastPark);
      runCycles(tracker, [det("can", 0.9)], 12);
      const moved = det("can", 0.9, [300, 260, 120, 200]);
      // First moved cycle may not match (IoU 0) — walk the box over instead
      const half = det("can", 0.9, [160, 150, 120, 200]);
      tracker.update([half], 1300, TH);
      const update = tracker.update([moved], 1400, TH);
      const track = update.tracks.find((t) => t.className === "can")!;
      expect(track.parked).toBe(false);
    });
  });

  describe("displayability", () => {
    it("exposes confirmed and coasting tracks, hides tentative and parked", () => {
      const tracker = new DetectionTracker();
      tracker.update([det("can", 0.9)], 0, TH);
      expect(DetectionTracker.isDisplayable(tracker.getTracks()[0])).toBe(false);
      runCycles(tracker, [det("can", 0.9)], 3, CYCLE_MS);
      expect(DetectionTracker.isDisplayable(tracker.getTracks()[0])).toBe(true);
      tracker.update([], 500, TH);
      expect(tracker.getTracks()[0].state).toBe("coasting");
      expect(DetectionTracker.isDisplayable(tracker.getTracks()[0])).toBe(true);
    });
  });
});
