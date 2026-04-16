/**
 * Client-side computer vision for local foreground detection,
 * stability analysis, hand-occlusion estimation, and sharpness scoring.
 *
 * All processing is limited to the central ROI (~5,184 pixels in a 120×120
 * square canvas) for performance. No frames are sent over the network.
 */

import type { FrameAnalysis, ImageQuality, BlobInfo } from "./types";
import type { Calibration } from "./threshold-config";

// ── Multi-blob quality thresholds (exported for tuning + tests) ──
/** Minimum Laplacian variance for a blob to be considered a real object. */
export const BLOB_MIN_SHARPNESS = 1000;
/** Minimum mean |gray - bg| contrast for a blob to be considered a real object. */
export const BLOB_MIN_CONTRAST = 20;
/** Maximum skin-tone pixel ratio — above this the blob is likely a hand/arm. */
export const BLOB_MAX_SKIN_RATIO = 0.6;
/** Minimum blob size as fraction of ROI pixels to be collected. */
const BLOB_MIN_SIZE_RATIO = 0.005; // 0.5% of ROI
/** Maximum blobs to return per frame. */
const MAX_BLOBS = 4;

/**
 * Returns true when a blob is likely a real physical object (not shadow, stain, or hand).
 */
export function blobIsObject(blob: BlobInfo): boolean {
  return blob.sharpness > BLOB_MIN_SHARPNESS &&
    blob.contrastScore > BLOB_MIN_CONTRAST &&
    blob.skinRatio < BLOB_MAX_SKIN_RATIO;
}

// ── Analysis resolution ──
// Draws the FULL video frame (e.g. 1280×720) into 120×120, covering a wider
// area than YOLO's short-side square crop. This ensures foreground detection
// triggers BEFORE items enter YOLO's analysis zone — early warning for the
// inference pipeline.
const AW = 120;
const AH = 120;
const PIXEL_COUNT = AW * AH;

// ── Central ROI: center 80% × 80% of the analysis canvas ──
// 10% edge margin filters out camera edge noise, furniture, and
// vibration while still providing early detection before items reach
// YOLO's 640×640 analysis zone.
const ROI_INSET = 0.10;
const ROI_X0 = Math.round(AW * ROI_INSET);        // 12
const ROI_X1 = Math.round(AW * (1 - ROI_INSET));  // 108
const ROI_Y0 = Math.round(AH * ROI_INSET);        // 12
const ROI_Y1 = Math.round(AH * (1 - ROI_INSET));  // 108
const ROI_W = ROI_X1 - ROI_X0;        // 96
const ROI_H = ROI_Y1 - ROI_Y0;        // 96
const ROI_PIXEL_COUNT = ROI_W * ROI_H; // 9216

// ── Background subtraction ──
const BG_LEARN_RATE = 0.015; // absorbs camera drift in ~10s; BG continues during confirm window to erode noise
const BG_INIT_RATE = 0.15;
const BG_INIT_FRAMES = 30; // ~4.5s of init at 7fps
const FG_PIXEL_THRESHOLD = 25; // per-pixel diff threshold for foreground classification

export const MOTION_RATIO_THRESHOLD = 0.12; // kept for external consumers

export class FrameAnalyzer {
  private bgModel: Float32Array | null = null;
  private prevGray: Uint8Array | null = null;
  private canvas: OffscreenCanvas | null = null;
  private ctx: OffscreenCanvasRenderingContext2D | null = null;
  private frameCount = 0;
  /** Mean luminance of the previous frame (0-255), used for adaptive BG rate. */
  private prevMeanLuminance = 128;

  // ── Rolling noise floor calibration ──
  private calibration: Calibration | null = null;
  private rollingCalBuffer: { fg: number; blob: number }[] = [];
  private rollingCalFrameCounter = 0;
  private idleFgThreshold = 0.035; // default from computeThresholds(0.5)
  private static readonly ROLLING_CAL_BUFFER_SIZE = 30;
  private static readonly ROLLING_CAL_INTERVAL = 150; // ~5s at 30fps

  /** Returns rolling calibration data, or null if not yet computed. */
  getCalibration(): Calibration | null {
    return this.calibration;
  }

  /** Set the current ROI foreground threshold (used to filter calibration samples). */
  setIdleFgThreshold(threshold: number): void {
    this.idleFgThreshold = threshold;
  }

  /**
   * Controls how fast the background model adapts on this frame.
   *   0           → frozen (active presentation — never absorb the held object)
   *   0 < r < 1   → adapt at rate r (pipeline sets this externally)
   * The pipeline state machine calls setBgRate() before each analyze() call so
   * the update policy is driven by the state machine, not by the CV signal alone.
   */
  private bgRate = BG_LEARN_RATE;

  setBgRate(rate: number): void {
    this.bgRate = rate;
  }

  /**
   * Boost the BG adaptation rate for N upcoming frames so the model
   * rapidly absorbs the current scene. Used after classification when
   * the BG model was frozen and may be stale.
   */
  private bgBoostFrames = 0;
  private static readonly BG_BOOST_RATE = 0.15; // same as BG_INIT_RATE — fast absorption
  private static readonly BG_BOOST_DURATION = 10; // ~500ms at 50ms intervals

  boostBackgroundAdaptation(): void {
    this.bgBoostFrames = FrameAnalyzer.BG_BOOST_DURATION;
  }

  /** Analyse a single video frame. Returns null if video isn't ready. */
  analyze(video: HTMLVideoElement): FrameAnalysis | null {
    if (video.readyState < 2) return null;

    // Lazy-init canvas (avoids SSR issues)
    if (!this.canvas) {
      this.canvas = new OffscreenCanvas(AW, AH);
      this.ctx = this.canvas.getContext("2d", {
        willReadFrequently: true,
      }) as OffscreenCanvasRenderingContext2D;
    }
    const ctx = this.ctx!;

    // Draw the FULL video frame into 120×120 — wider than YOLO's short-side
    // square crop so foreground is detected before items reach the YOLO zone.
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    ctx.drawImage(video, 0, 0, vw, vh, 0, 0, AW, AH);
    const { data: px } = ctx.getImageData(0, 0, AW, AH);

    // ── Compute full-frame mean luminance (cheap — needed for adaptive BG rate) ──
    let lumSum = 0;
    for (let i = 0; i < PIXEL_COUNT; i++) {
      const o = i * 4;
      lumSum += 0.299 * px[o] + 0.587 * px[o + 1] + 0.114 * px[o + 2];
    }
    const meanLuminance = lumSum / PIXEL_COUNT;

    // ── Convert ROI pixels to grayscale ──
    // Only ROI pixels are needed for BG subtraction, skin, and sharpness.
    // Use a flat ROI buffer indexed as (ry * ROI_W + rx).
    const roiGray = new Uint8Array(ROI_PIXEL_COUNT);
    for (let y = ROI_Y0; y < ROI_Y1; y++) {
      for (let x = ROI_X0; x < ROI_X1; x++) {
        const o = (y * AW + x) * 4;
        roiGray[(y - ROI_Y0) * ROI_W + (x - ROI_X0)] =
          (0.299 * px[o] + 0.587 * px[o + 1] + 0.114 * px[o + 2]) | 0;
      }
    }

    this.frameCount++;

    // ── Bootstrap background model ──
    if (!this.bgModel) {
      this.bgModel = Float32Array.from(roiGray);
      this.prevGray = new Uint8Array(roiGray);
      return {
        roiForegroundRatio: 0,
        roiLargestBlobRatio: 0,
        roiLargestBlobDiagonalRatio: 0,
        sharpnessScore: 0,
        blobs: [],
        isSettled: false,
        timestamp: Date.now(),
      };
    }

    const bg = this.bgModel;

    // ── ROI foreground mask + erosion filter ──
    // Background subtraction directly in ROI space.
    const fgMask = new Uint8Array(ROI_PIXEL_COUNT);
    for (let i = 0; i < ROI_PIXEL_COUNT; i++) {
      if (Math.abs(roiGray[i] - bg[i]) > FG_PIXEL_THRESHOLD) {
        fgMask[i] = 1;
      }
    }

    // 2-neighbor erosion: a foreground pixel survives only if ≥2 of its
    // 4 cardinal neighbours are also foreground.
    const erodedMask = new Uint8Array(ROI_PIXEL_COUNT);
    let roiFgCount = 0;
    for (let ry = 0; ry < ROI_H; ry++) {
      for (let rx = 0; rx < ROI_W; rx++) {
        const i = ry * ROI_W + rx;
        if (!fgMask[i]) continue;
        const n =
          (rx > 0 ? fgMask[i - 1] : 0) +
          (rx < ROI_W - 1 ? fgMask[i + 1] : 0) +
          (ry > 0 ? fgMask[i - ROI_W] : 0) +
          (ry < ROI_H - 1 ? fgMask[i + ROI_W] : 0);
        if (n >= 2) {
          erodedMask[i] = 1;
          roiFgCount++;
        }
      }
    }
    const roiForegroundRatio = roiFgCount / ROI_PIXEL_COUNT;

    // ── Connected-component scan: collect ALL blobs ──
    const minBlobPixels = Math.max(1, Math.floor(ROI_PIXEL_COUNT * BLOB_MIN_SIZE_RATIO));
    interface RawBlob {
      size: number;
      minX: number; maxX: number; minY: number; maxY: number;
      pixels: number[]; // indices into ROI space
    }
    const allBlobs: RawBlob[] = [];
    const blobVisited = new Uint8Array(ROI_PIXEL_COUNT);
    for (let ry = 0; ry < ROI_H; ry++) {
      for (let rx = 0; rx < ROI_W; rx++) {
        const startIdx = ry * ROI_W + rx;
        if (!erodedMask[startIdx] || blobVisited[startIdx]) continue;
        let size = 0;
        let blobMinX = ROI_W;
        let blobMaxX = 0;
        let blobMinY = ROI_H;
        let blobMaxY = 0;
        const blobPixels: number[] = [];
        const stack = [startIdx];
        blobVisited[startIdx] = 1;
        while (stack.length > 0) {
          const idx = stack.pop()!;
          size++;
          blobPixels.push(idx);
          const cx = idx % ROI_W;
          const cy = (idx / ROI_W) | 0;
          if (cx < blobMinX) blobMinX = cx;
          if (cx > blobMaxX) blobMaxX = cx;
          if (cy < blobMinY) blobMinY = cy;
          if (cy > blobMaxY) blobMaxY = cy;
          if (cx > 0) {
            const n = idx - 1;
            if (erodedMask[n] && !blobVisited[n]) { blobVisited[n] = 1; stack.push(n); }
          }
          if (cx < ROI_W - 1) {
            const n = idx + 1;
            if (erodedMask[n] && !blobVisited[n]) { blobVisited[n] = 1; stack.push(n); }
          }
          if (cy > 0) {
            const n = idx - ROI_W;
            if (erodedMask[n] && !blobVisited[n]) { blobVisited[n] = 1; stack.push(n); }
          }
          if (cy < ROI_H - 1) {
            const n = idx + ROI_W;
            if (erodedMask[n] && !blobVisited[n]) { blobVisited[n] = 1; stack.push(n); }
          }
        }
        if (size >= minBlobPixels) {
          allBlobs.push({ size, minX: blobMinX, maxX: blobMaxX, minY: blobMinY, maxY: blobMaxY, pixels: blobPixels });
        }
      }
    }

    // Sort by size descending, keep top MAX_BLOBS
    allBlobs.sort((a, b) => b.size - a.size);
    const topBlobs = allBlobs.slice(0, MAX_BLOBS);

    // Backward-compat: largest blob stats
    const roiLargestBlobPixels = topBlobs.length > 0 ? topBlobs[0].size : 0;
    const roiLargestBlobRatio = roiLargestBlobPixels / ROI_PIXEL_COUNT;
    const largestBlobMinX = topBlobs.length > 0 ? topBlobs[0].minX : ROI_W;
    const largestBlobMaxX = topBlobs.length > 0 ? topBlobs[0].maxX : 0;
    const largestBlobMinY = topBlobs.length > 0 ? topBlobs[0].minY : ROI_H;
    const largestBlobMaxY = topBlobs.length > 0 ? topBlobs[0].maxY : 0;

    const largestBlobDiagonal = Math.sqrt(
      (largestBlobMaxX - largestBlobMinX) ** 2 +
      (largestBlobMaxY - largestBlobMinY) ** 2
    );
    const roiDiagonal = Math.sqrt(ROI_W ** 2 + ROI_H ** 2);
    const roiLargestBlobDiagonalRatio =
      roiDiagonal > 0 ? largestBlobDiagonal / roiDiagonal : 0;

    // ── Compute per-blob quality metrics ──
    const blobInfos: BlobInfo[] = topBlobs.map((blob) => {
      // Sharpness: Laplacian variance restricted to this blob's pixels
      let lapSum = 0;
      let lapN = 0;
      for (const idx of blob.pixels) {
        const bx = idx % ROI_W;
        const by = (idx / ROI_W) | 0;
        if (bx < 1 || bx >= ROI_W - 1 || by < 1 || by >= ROI_H - 1) continue;
        const lap =
          4 * roiGray[idx] -
          roiGray[idx - 1] -
          roiGray[idx + 1] -
          roiGray[idx - ROI_W] -
          roiGray[idx + ROI_W];
        lapSum += lap * lap;
        lapN++;
      }
      const sharpness = lapN >= 10 ? lapSum / lapN : 0;

      // Contrast: mean |gray - bg| over blob pixels
      let contrastSum = 0;
      for (const idx of blob.pixels) {
        contrastSum += Math.abs(roiGray[idx] - bg[idx]);
      }
      const contrastScore = blob.size > 0 ? contrastSum / blob.size : 0;

      // Skin ratio + saturation: compute from original RGB pixel data
      let skinCount = 0;
      let satSum = 0;
      for (const idx of blob.pixels) {
        const ry = (idx / ROI_W) | 0;
        const rx = idx % ROI_W;
        const globalX = ROI_X0 + rx;
        const globalY = ROI_Y0 + ry;
        const o = (globalY * AW + globalX) * 4;
        const r = px[o];
        const g = px[o + 1];
        const b2 = px[o + 2];
        // Inline RGB→HSV
        const rn = r / 255;
        const gn = g / 255;
        const bn = b2 / 255;
        const max = Math.max(rn, gn, bn);
        const min = Math.min(rn, gn, bn);
        const d = max - min;
        let h = 0;
        if (d !== 0) {
          if (max === rn) h = ((gn - bn) / d) % 6;
          else if (max === gn) h = (bn - rn) / d + 2;
          else h = (rn - gn) / d + 4;
          h = Math.round(h * 60);
          if (h < 0) h += 360;
        }
        const s = max === 0 ? 0 : d / max;
        const v = max;
        satSum += s;
        // Skin-tone HSV range: H 0-50, S 0.15-0.75, V 0.2-0.85
        if (h >= 0 && h <= 50 && s >= 0.15 && s <= 0.75 && v >= 0.2 && v <= 0.85) {
          skinCount++;
        }
      }
      const skinRatio = blob.size > 0 ? skinCount / blob.size : 0;
      const saturation = blob.size > 0 ? satSum / blob.size : 0;

      // Normalized bbox within ROI (0–1)
      const bw = blob.maxX - blob.minX + 1;
      const bh = blob.maxY - blob.minY + 1;
      const cx = (blob.minX + bw / 2) / ROI_W;
      const cy = (blob.minY + bh / 2) / ROI_H;
      const nw = bw / ROI_W;
      const nh = bh / ROI_H;

      return {
        bboxNorm: [cx, cy, nw, nh] as [number, number, number, number],
        pixelCount: blob.size,
        ratio: blob.size / ROI_PIXEL_COUNT,
        sharpness,
        contrastScore,
        skinRatio,
        saturation,
      };
    });

    // ── Whole-frame sharpness (Laplacian variance, all foreground pixels) ──
    let globalLapSum = 0;
    let globalLapN = 0;
    for (let ry = 1; ry < ROI_H - 1; ry++) {
      for (let rx = 1; rx < ROI_W - 1; rx++) {
        const idx = ry * ROI_W + rx;
        if (!erodedMask[idx]) continue;
        const lap =
          4 * roiGray[idx] -
          roiGray[idx - 1] -
          roiGray[idx + 1] -
          roiGray[idx - ROI_W] -
          roiGray[idx + ROI_W];
        globalLapSum += lap * lap;
        globalLapN++;
      }
    }
    const sharpnessScore = globalLapN >= 50 ? globalLapSum / globalLapN : 0;

    // ── Update background model (ROI only) ──
    const lumDelta = Math.abs(meanLuminance - this.prevMeanLuminance);
    this.prevMeanLuminance = meanLuminance;

    let effectiveBgRate = this.frameCount <= BG_INIT_FRAMES
      ? BG_INIT_RATE
      : this.bgBoostFrames > 0
        ? (this.bgBoostFrames--, FrameAnalyzer.BG_BOOST_RATE)
        : this.bgRate;
    if (this.frameCount > BG_INIT_FRAMES && effectiveBgRate > 0 && lumDelta > 5) {
      const boost = Math.min(3.0, 1.0 + (lumDelta - 5) / 10);
      effectiveBgRate = Math.min(effectiveBgRate * boost, BG_INIT_RATE);
    }

    if (effectiveBgRate > 0) {
      for (let i = 0; i < ROI_PIXEL_COUNT; i++) {
        bg[i] = bg[i] * (1 - effectiveBgRate) + roiGray[i] * effectiveBgRate;
      }
    }

    this.prevGray = new Uint8Array(roiGray);

    // ── Rolling noise floor calibration (idle samples only) ──
    // Collect samples when BG is adapting (idle/cooldown) and no object is present.
    if (this.bgRate > 0 && this.frameCount > BG_INIT_FRAMES &&
        roiForegroundRatio < this.idleFgThreshold) {
      this.rollingCalBuffer.push({ fg: roiForegroundRatio, blob: roiLargestBlobRatio });
      if (this.rollingCalBuffer.length > FrameAnalyzer.ROLLING_CAL_BUFFER_SIZE) {
        this.rollingCalBuffer.shift();
      }
    }

    // Recompute calibration every ~5 seconds
    this.rollingCalFrameCounter++;
    if (this.rollingCalFrameCounter >= FrameAnalyzer.ROLLING_CAL_INTERVAL) {
      this.rollingCalFrameCounter = 0;
      if (this.rollingCalBuffer.length >= 10) {
        const n = this.rollingCalBuffer.length;
        const fgValues = this.rollingCalBuffer.map((s) => s.fg);
        const blobValues = this.rollingCalBuffer.map((s) => s.blob);
        const noiseFgMean = fgValues.reduce((a, b) => a + b, 0) / n;
        const noiseFgStd = Math.sqrt(
          fgValues.reduce((sum, v) => sum + (v - noiseFgMean) ** 2, 0) / n,
        );
        const noiseBlobMean = blobValues.reduce((a, b) => a + b, 0) / n;
        this.calibration = { noiseFgMean, noiseFgStd, noiseBlobMean };
      }
    }

    return {
      roiForegroundRatio,
      roiLargestBlobRatio,
      roiLargestBlobDiagonalRatio,
      sharpnessScore,
      blobs: blobInfos,
      isSettled: true,
      timestamp: Date.now(),
    };
  }

  /** Reset the background model (e.g. after a long pause). */
  reset(): void {
    this.bgModel = null;
    this.prevGray = null;
    this.frameCount = 0;
    this.prevMeanLuminance = 128;
    this.calibration = null;
    this.rollingCalBuffer = [];
    this.rollingCalFrameCounter = 0;
  }
}

// ── Utility: derive image quality band from analysis ──
// Initial estimates for foreground-only Laplacian variance.
// Recalibrate from pilot-log data.
export function imageQualityBand(a: FrameAnalysis): ImageQuality {
  if (a.sharpnessScore > 1500) return "good";
  if (a.sharpnessScore > 1000) return "fair";
  return "poor";
}
