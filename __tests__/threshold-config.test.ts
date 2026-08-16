/**
 * Tests for lib/threshold-config.ts — master sensitivity → threshold derivation.
 *
 * Verifies correct interpolation at sensitivity 0.0, 0.5, and 1.0,
 * calibration override behavior, and edge-case clamping.
 */

import { computeThresholds, type Calibration } from "@/lib/threshold-config";

describe("computeThresholds", () => {
  describe("sensitivity 0.0 (strict)", () => {
    const th = computeThresholds(0.0);

    it("derives strict ROI_FG_THRESHOLD (high end)", () => {
      expect(th.ROI_FG_THRESHOLD).toBeCloseTo(0.05, 4);
    });

    it("derives ROI_BLOB_THRESHOLD as 33% of ROI_FG", () => {
      expect(th.ROI_BLOB_THRESHOLD).toBeCloseTo(0.05 * 0.33, 4);
    });

    it("derives RESULT_FG_THRESHOLD as 73% of ROI_FG", () => {
      expect(th.RESULT_FG_THRESHOLD).toBeCloseTo(0.05 * 0.73, 4);
    });

    it("derives RESULT_BLOB_THRESHOLD as 80% of ROI_BLOB", () => {
      expect(th.RESULT_BLOB_THRESHOLD).toBeCloseTo(0.05 * 0.33 * 0.8, 4);
    });

    it("derives strict ROI_BLOB_DIAGONAL_THRESHOLD", () => {
      expect(th.ROI_BLOB_DIAGONAL_THRESHOLD).toBeCloseTo(0.45, 4);
    });

    it("derives strict YOLO_FALLBACK_THRESHOLD", () => {
      expect(th.YOLO_FALLBACK_THRESHOLD).toBeCloseTo(0.80, 4);
    });

    it("uses 3 FG_PERSIST_FRAMES for strict sensitivity", () => {
      expect(th.FG_PERSIST_FRAMES).toBe(3);
    });

    it("uses 3 OBJECT_GONE_FRAMES for strict sensitivity", () => {
      expect(th.OBJECT_GONE_FRAMES).toBe(3);
    });
  });

  describe("sensitivity 0.5 (default)", () => {
    const th = computeThresholds(0.5);

    it("derives midpoint ROI_FG_THRESHOLD", () => {
      expect(th.ROI_FG_THRESHOLD).toBeCloseTo(0.035, 4);
    });

    it("derives midpoint ROI_BLOB_DIAGONAL_THRESHOLD", () => {
      expect(th.ROI_BLOB_DIAGONAL_THRESHOLD).toBeCloseTo(0.375, 4);
    });

    it("derives default YOLO_FALLBACK_THRESHOLD (0.725)", () => {
      expect(th.YOLO_FALLBACK_THRESHOLD).toBeCloseTo(0.725, 4);
    });

    it("uses 3 FG_PERSIST_FRAMES at default sensitivity", () => {
      expect(th.FG_PERSIST_FRAMES).toBe(3);
    });

    it("uses 3 OBJECT_GONE_FRAMES at default sensitivity", () => {
      expect(th.OBJECT_GONE_FRAMES).toBe(3);
    });
  });

  describe("sensitivity 1.0 (sensitive)", () => {
    const th = computeThresholds(1.0);

    it("derives sensitive ROI_FG_THRESHOLD (low end)", () => {
      expect(th.ROI_FG_THRESHOLD).toBeCloseTo(0.02, 4);
    });

    it("derives sensitive ROI_BLOB_DIAGONAL_THRESHOLD", () => {
      expect(th.ROI_BLOB_DIAGONAL_THRESHOLD).toBeCloseTo(0.30, 4);
    });

    it("derives sensitive YOLO_FALLBACK_THRESHOLD", () => {
      expect(th.YOLO_FALLBACK_THRESHOLD).toBeCloseTo(0.65, 4);
    });

    it("uses 2 FG_PERSIST_FRAMES for high sensitivity", () => {
      expect(th.FG_PERSIST_FRAMES).toBe(2);
    });

    it("uses 2 OBJECT_GONE_FRAMES for high sensitivity", () => {
      expect(th.OBJECT_GONE_FRAMES).toBe(2);
    });
  });

  describe("continuous-mode tracker thresholds", () => {
    it("derives TRACK_APPEAR_THRESHOLD across the sensitivity range", () => {
      expect(computeThresholds(0.0).TRACK_APPEAR_THRESHOLD).toBeCloseTo(0.60, 4);
      expect(computeThresholds(0.5).TRACK_APPEAR_THRESHOLD).toBeCloseTo(0.525, 4);
      expect(computeThresholds(1.0).TRACK_APPEAR_THRESHOLD).toBeCloseTo(0.45, 4);
    });

    it("keeps TRACK_KEEP_THRESHOLD strictly below TRACK_APPEAR_THRESHOLD (hysteresis)", () => {
      for (const s of [0.0, 0.3, 0.5, 0.7, 1.0]) {
        const th = computeThresholds(s);
        expect(th.TRACK_KEEP_THRESHOLD).toBeLessThan(th.TRACK_APPEAR_THRESHOLD);
        expect(th.TRACK_KEEP_THRESHOLD).toBeCloseTo(th.TRACK_APPEAR_THRESHOLD * 0.65, 4);
      }
    });

    it("keeps the appear bar below the instant-resolve bar so tracks can exist as needs_review", () => {
      for (const s of [0.0, 0.5, 1.0]) {
        const th = computeThresholds(s);
        expect(th.TRACK_APPEAR_THRESHOLD).toBeLessThan(th.YOLO_FALLBACK_THRESHOLD);
      }
    });
  });

  describe("calibration override", () => {
    const calibration: Calibration = {
      noiseFgMean: 0.01,
      noiseFgStd: 0.005,
      noiseBlobMean: 0.002,
    };

    it("overrides ROI_FG_THRESHOLD with calibrated value", () => {
      const th = computeThresholds(0.5, calibration);
      // noiseFgMean + 3 * noiseFgStd = 0.01 + 0.015 = 0.025
      expect(th.ROI_FG_THRESHOLD).toBeCloseTo(0.025, 4);
    });

    it("derives other thresholds from calibrated ROI_FG", () => {
      const th = computeThresholds(0.5, calibration);
      expect(th.ROI_BLOB_THRESHOLD).toBeCloseTo(0.025 * 0.33, 4);
      expect(th.RESULT_FG_THRESHOLD).toBeCloseTo(0.025 * 0.73, 4);
    });

    it("does not affect non-ROI thresholds", () => {
      const th = computeThresholds(0.5, calibration);
      expect(th.YOLO_FALLBACK_THRESHOLD).toBeCloseTo(0.725, 4);
      expect(th.ROI_BLOB_DIAGONAL_THRESHOLD).toBeCloseTo(0.375, 4);
    });

    it("clamps calibrated ROI_FG_THRESHOLD to [0.02, 0.08]", () => {
      const noisy: Calibration = { noiseFgMean: 0.05, noiseFgStd: 0.02, noiseBlobMean: 0.01 };
      const thNoisy = computeThresholds(0.5, noisy);
      expect(thNoisy.ROI_FG_THRESHOLD).toBe(0.08);

      const clean: Calibration = { noiseFgMean: 0.001, noiseFgStd: 0.001, noiseBlobMean: 0.0 };
      const thClean = computeThresholds(0.5, clean);
      expect(thClean.ROI_FG_THRESHOLD).toBe(0.02);
    });
  });

  describe("edge cases", () => {
    it("clamps sensitivity below 0 to 0", () => {
      const th = computeThresholds(-0.5);
      const th0 = computeThresholds(0.0);
      expect(th.ROI_FG_THRESHOLD).toBeCloseTo(th0.ROI_FG_THRESHOLD, 6);
    });

    it("clamps sensitivity above 1 to 1", () => {
      const th = computeThresholds(1.5);
      const th1 = computeThresholds(1.0);
      expect(th.ROI_FG_THRESHOLD).toBeCloseTo(th1.ROI_FG_THRESHOLD, 6);
    });

    it("defaults to 0.5 when called with no arguments", () => {
      const th = computeThresholds();
      const th05 = computeThresholds(0.5);
      expect(th.ROI_FG_THRESHOLD).toBeCloseTo(th05.ROI_FG_THRESHOLD, 6);
    });
  });
});
