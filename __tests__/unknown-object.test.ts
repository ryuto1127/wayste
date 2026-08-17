/**
 * Tests for lib/unknown-object.ts — the class-agnostic "YOLO saw nothing
 * but something is there" fallback for continuous mode.
 */

import {
  synthesizeUnknownDetections,
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
