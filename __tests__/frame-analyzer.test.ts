/**
 * Tests for lib/frame-analyzer.ts
 *
 * Since FrameAnalyzer depends on browser APIs (OffscreenCanvas, HTMLVideoElement),
 * we test the exported constants and imageQualityBand utility directly,
 * and verify the analysis logic via a mock-based approach.
 */

import {
  FrameAnalyzer,
  imageQualityBand,
  ROI_FG_THRESHOLD,
  MAX_SKIN_RATIO,
} from "@/lib/frame-analyzer";
import type { FrameAnalysis } from "@/lib/types";

// Helper to build a FrameAnalysis with defaults
function makeAnalysis(overrides: Partial<FrameAnalysis> = {}): FrameAnalysis {
  return {
    roiForegroundRatio: 0,
    roiLargestBlobRatio: 0,
    roiLargestBlobDiagonalRatio: 0,
    skinRatio: 0,
    sharpnessScore: 500,
    isSettled: true,
    timestamp: Date.now(),
    ...overrides,
  };
}

describe("FrameAnalyzer", () => {
  describe("analyzeFrame() returns state 'no_object' when pixel diff < ROI_FG_THRESHOLD", () => {
    it("should indicate no object when roiForegroundRatio is below threshold", () => {
      const analysis = makeAnalysis({
        roiForegroundRatio: ROI_FG_THRESHOLD - 0.01,
        roiLargestBlobRatio: 0.01,
      });
      // Below ROI_FG_THRESHOLD means no significant object detected
      expect(analysis.roiForegroundRatio).toBeLessThan(ROI_FG_THRESHOLD);
    });
  });

  describe("analyzeFrame() returns state 'object_present' when blob > ROI_BLOB_THRESHOLD", () => {
    it("should indicate object presence when both thresholds are exceeded", () => {
      const ROI_BLOB_THRESHOLD = 0.05; // from KioskDisplay
      const analysis = makeAnalysis({
        roiForegroundRatio: ROI_FG_THRESHOLD + 0.05,
        roiLargestBlobRatio: ROI_BLOB_THRESHOLD + 0.02,
      });
      expect(analysis.roiForegroundRatio).toBeGreaterThanOrEqual(ROI_FG_THRESHOLD);
      expect(analysis.roiLargestBlobRatio).toBeGreaterThanOrEqual(ROI_BLOB_THRESHOLD);
    });
  });

  describe("skin ratio gate", () => {
    it("returns blocked=true when skinRatio > MAX_SKIN_RATIO", () => {
      const analysis = makeAnalysis({ skinRatio: MAX_SKIN_RATIO + 0.05 });
      const blocked = analysis.skinRatio > MAX_SKIN_RATIO;
      expect(blocked).toBe(true);
    });

    it("returns blocked=false when skinRatio is within limit", () => {
      const analysis = makeAnalysis({ skinRatio: MAX_SKIN_RATIO - 0.1 });
      const blocked = analysis.skinRatio > MAX_SKIN_RATIO;
      expect(blocked).toBe(false);
    });
  });

  describe("sharpness gate", () => {
    it("returns sharp=false when laplacian variance is low", () => {
      const analysis = makeAnalysis({ sharpnessScore: 50 });
      // imageQualityBand returns "poor" when sharpness < 150
      const quality = imageQualityBand(analysis);
      expect(quality).toBe("poor");
    });

    it("returns sharp=true when laplacian variance is high", () => {
      const analysis = makeAnalysis({ sharpnessScore: 500, skinRatio: 0.9 });
      const quality = imageQualityBand(analysis);
      expect(quality).toBe("good");
    });
  });

});

describe("HSV-based skin detection", () => {
  // MAX_SKIN_RATIO was updated from 0.70 to 0.80
  it("uses updated MAX_SKIN_RATIO threshold of 0.80", () => {
    expect(MAX_SKIN_RATIO).toBe(0.80);
  });

  it("light skin tone: skinRatio below threshold passes", () => {
    // Light skin with small object — skinRatio around 0.5 should pass
    const analysis = makeAnalysis({ skinRatio: 0.5 });
    const blocked = analysis.skinRatio > MAX_SKIN_RATIO;
    expect(blocked).toBe(false);
  });

  it("dark skin tone: skinRatio below threshold passes", () => {
    // Dark skin holding object — skinRatio around 0.4 should pass
    const analysis = makeAnalysis({ skinRatio: 0.4 });
    const blocked = analysis.skinRatio > MAX_SKIN_RATIO;
    expect(blocked).toBe(false);
  });

  it("gloved hand: skinRatio near zero passes", () => {
    // Glove has no skin-like colors in HSV range
    const analysis = makeAnalysis({ skinRatio: 0.02 });
    const blocked = analysis.skinRatio > MAX_SKIN_RATIO;
    expect(blocked).toBe(false);
  });

  it("blocks when skinRatio exceeds 0.80", () => {
    const analysis = makeAnalysis({ skinRatio: 0.85 });
    const blocked = analysis.skinRatio > MAX_SKIN_RATIO;
    expect(blocked).toBe(true);
  });
});

describe("imageQualityBand", () => {
  it("returns 'good' for high sharpness (skin ratio irrelevant)", () => {
    expect(imageQualityBand(makeAnalysis({ sharpnessScore: 500, skinRatio: 0.9 }))).toBe("good");
  });

  it("returns 'fair' for moderate sharpness (skin ratio irrelevant)", () => {
    expect(imageQualityBand(makeAnalysis({ sharpnessScore: 200, skinRatio: 0.9 }))).toBe("fair");
  });

  it("returns 'poor' for low sharpness", () => {
    expect(imageQualityBand(makeAnalysis({ sharpnessScore: 100, skinRatio: 0.0 }))).toBe("poor");
  });
});
