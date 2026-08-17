/**
 * Tests for lib/unknown-object.ts — the class-agnostic "YOLO saw nothing
 * but something is there" fallback for continuous mode.
 */

import {
  synthesizeUnknownDetections,
  buildUnknownDetections,
  blobToModelBbox,
  UNKNOWN_OBJECT_CLASS,
  UNKNOWN_OBJECT_CLASS_ID,
} from "@/lib/unknown-object";
import type { BlobInfo, YoloDetection } from "@/lib/types";
import type { Bbox } from "@/lib/bbox-utils";

const ASPECT_16_9 = 16 / 9;

/** An object-like blob: sharp, high-contrast, not skin. */
function blob(overrides: Partial<BlobInfo> = {}): BlobInfo {
  return {
    bboxNorm: [0.5, 0.5, 0.3, 0.3],
    pixelCount: 500,
    ratio: 0.05,
    sharpness: 2000,
    contrastScore: 40,
    skinRatio: 0.1,
    saturation: 0.3,
    ...overrides,
  };
}

function det(bbox: Bbox, confidence = 0.8): YoloDetection {
  return { classId: 0, className: "plastic_bottle", confidence, bbox };
}

describe("blobToModelBbox", () => {
  it("maps a centered blob to the center of the letterboxed content", () => {
    // 16:9 letterbox: content occupies y 140..500 in 640-space, x 0..640
    const b = blobToModelBbox(blob(), ASPECT_16_9);
    const cx = b[0] + b[2] / 2;
    const cy = b[1] + b[3] / 2;
    expect(cx).toBeCloseTo(320, 0);
    expect(cy).toBeCloseTo(320, 0);
    // Width: 0.3 blob in ROI → 0.24 of full frame → 0.24 * 640
    expect(b[2]).toBeCloseTo(0.3 * 0.8 * 640, 0);
    // Height uses the letterboxed content height (360 for 16:9)
    expect(b[3]).toBeCloseTo(0.3 * 0.8 * 360, 0);
  });

  it("accounts for the ROI inset at the blob's top-left extreme", () => {
    const b = blobToModelBbox(
      blob({ bboxNorm: [0.05, 0.05, 0.1, 0.1] }),
      ASPECT_16_9,
    );
    // ROI x=0 maps to full-frame 0.1, not 0
    expect(b[0]).toBeGreaterThan(0);
  });
});

describe("synthesizeUnknownDetections", () => {
  const APPEAR = 0.5;

  it("synthesizes an unknown_object detection from a clean uncovered blob", () => {
    const out = synthesizeUnknownDetections([blob()], [], [], ASPECT_16_9, APPEAR);
    expect(out).toHaveLength(1);
    expect(out[0].className).toBe(UNKNOWN_OBJECT_CLASS);
    expect(out[0].classId).toBe(UNKNOWN_OBJECT_CLASS_ID);
    expect(out[0].confidence).toBe(APPEAR);
  });

  it("rejects blobs that fail the object-quality gates (skin-heavy hand)", () => {
    const out = synthesizeUnknownDetections(
      [blob({ skinRatio: 0.8 })],
      [], [], ASPECT_16_9, APPEAR,
    );
    expect(out).toHaveLength(0);
  });

  it("rejects blobs that are too small (noise)", () => {
    const out = synthesizeUnknownDetections(
      [blob({ ratio: 0.002 })],
      [], [], ASPECT_16_9, APPEAR,
    );
    expect(out).toHaveLength(0);
  });

  it("suppresses blobs already covered by a YOLO detection", () => {
    // Real detection sits exactly where the centered blob lands
    const covering = det([250, 270, 140, 100]);
    const out = synthesizeUnknownDetections(
      [blob()], [covering], [], ASPECT_16_9, APPEAR,
    );
    expect(out).toHaveLength(0);
  });

  it("suppresses blobs covered by a known-class track", () => {
    const trackBbox: Bbox = [250, 270, 140, 100];
    const out = synthesizeUnknownDetections(
      [blob()], [], [trackBbox], ASPECT_16_9, APPEAR,
    );
    expect(out).toHaveLength(0);
  });

  it("keeps a blob far from any known box (second unknown item)", () => {
    const farDet = det([550, 400, 60, 60]);
    const out = synthesizeUnknownDetections(
      [blob({ bboxNorm: [0.2, 0.5, 0.2, 0.2] })],
      [farDet], [], ASPECT_16_9, APPEAR,
    );
    expect(out).toHaveLength(1);
  });
});

describe("buildUnknownDetections", () => {
  const APPEAR = 0.5;
  /** Frame-wide foreground blob for corroboration only — skin-heavy so it
   *  fails blobIsObject and never becomes a blob-only candidate itself. */
  const FG = blob({ bboxNorm: [0.5, 0.5, 0.9, 0.9], skinRatio: 0.9 });
  const base = {
    blobs: [FG] as BlobInfo[],
    sceneUnstable: false,
    confidentDetections: [] as YoloDetection[],
    knownTrackBboxes: [] as Bbox[],
    videoAspect: ASPECT_16_9,
    confidence: APPEAR,
  };

  it("turns a foreground-corroborated low-confidence YOLO box into unknown evidence", () => {
    const out = buildUnknownDetections({
      ...base,
      lowConfDetections: [det([100, 200, 80, 120], 0.2)],
    });
    expect(out).toHaveLength(1);
    expect(out[0].className).toBe(UNKNOWN_OBJECT_CLASS);
    expect(out[0].confidence).toBe(APPEAR);
    expect(out[0].bbox).toEqual([100, 200, 80, 120]);
  });

  it("suppresses low-confidence boxes with NO foreground overlap (pre-existing background)", () => {
    // The mattress-strap case: YOLO boxes scenery that was there at start —
    // no background-subtraction blob exists, so no candidate may form.
    const out = buildUnknownDetections({
      ...base,
      blobs: [],
      lowConfDetections: [det([100, 200, 80, 120], 0.3)],
    });
    expect(out).toHaveLength(0);
  });

  it("suppresses low-confidence boxes covered by a confident detection", () => {
    const out = buildUnknownDetections({
      ...base,
      lowConfDetections: [det([102, 202, 78, 118], 0.2)],
      confidentDetections: [det([100, 200, 80, 120], 0.8)],
    });
    expect(out).toHaveLength(0);
  });

  it("caps low-confidence candidates and dedupes overlapping ones", () => {
    const out = buildUnknownDetections({
      ...base,
      lowConfDetections: [
        det([100, 200, 80, 120], 0.30),
        det([104, 204, 80, 120], 0.28), // duplicate of the first
        det([300, 200, 80, 120], 0.25),
        det([450, 200, 80, 120], 0.22),
        det([560, 200, 60, 120], 0.20), // over the cap
      ],
    });
    expect(out.length).toBeLessThanOrEqual(3);
    // The duplicate must not appear as a second candidate
    const xs = out.map((d) => Math.round(d.bbox[0] / 50));
    expect(new Set(xs).size).toBe(out.length);
  });

  it("uses blob evidence only while the scene is stable", () => {
    const stable = buildUnknownDetections({ ...base, lowConfDetections: [], blobs: [blob()] });
    expect(stable).toHaveLength(1);
    const unstable = buildUnknownDetections({
      ...base, lowConfDetections: [], blobs: [blob()], sceneUnstable: true,
    });
    expect(unstable).toHaveLength(0);
  });

  it("suppresses candidates inside a suppression zone (background/face veto)", () => {
    const out = buildUnknownDetections({
      ...base,
      lowConfDetections: [det([100, 200, 80, 120], 0.2)],
      suppressZones: [[90, 190, 110, 140]],
    });
    expect(out).toHaveLength(0);
  });

  it("rejects low-confidence boxes below the minimum item size (ring/button)", () => {
    const out = buildUnknownDetections({
      ...base,
      lowConfDetections: [det([100, 200, 25, 25], 0.3)],
    });
    expect(out).toHaveLength(0);
  });

  it("drops a blob duplicating a low-confidence candidate (YOLO box wins)", () => {
    // Centered blob lands around [250, 270, 154, 86] in model space
    const out = buildUnknownDetections({
      ...base,
      lowConfDetections: [det([250, 270, 150, 90], 0.2)],
      blobs: [blob()],
    });
    expect(out).toHaveLength(1);
    expect(out[0].bbox).toEqual([250, 270, 150, 90]);
  });
});
