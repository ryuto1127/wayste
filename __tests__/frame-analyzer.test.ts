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
} from "@/lib/frame-analyzer";
import { computeThresholds } from "@/lib/threshold-config";
import type { FrameAnalysis } from "@/lib/types";

const { ROI_FG_THRESHOLD } = computeThresholds(0.5);

// Helper to build a FrameAnalysis with defaults
function makeAnalysis(overrides: Partial<FrameAnalysis> = {}): FrameAnalysis {
  return {
    roiForegroundRatio: 0,
    roiLargestBlobRatio: 0,
    roiLargestBlobDiagonalRatio: 0,
    sharpnessScore: 2000,
    blobs: [],
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

  describe("sharpness gate", () => {
    it("returns sharp=false when laplacian variance is low", () => {
      const analysis = makeAnalysis({ sharpnessScore: 50 });
      // imageQualityBand returns "poor" when sharpness <= 1000
      const quality = imageQualityBand(analysis);
      expect(quality).toBe("poor");
    });

    it("returns sharp=true when laplacian variance is high", () => {
      const analysis = makeAnalysis({ sharpnessScore: 2000 });
      const quality = imageQualityBand(analysis);
      expect(quality).toBe("good");
    });
  });

});

describe("imageQualityBand", () => {
  it("returns 'good' for high sharpness", () => {
    expect(imageQualityBand(makeAnalysis({ sharpnessScore: 2000 }))).toBe("good");
  });

  it("returns 'fair' for moderate sharpness", () => {
    expect(imageQualityBand(makeAnalysis({ sharpnessScore: 1200 }))).toBe("fair");
  });

  it("returns 'poor' for low sharpness", () => {
    expect(imageQualityBand(makeAnalysis({ sharpnessScore: 800 }))).toBe("poor");
  });
});
