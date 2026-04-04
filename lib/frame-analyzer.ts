/**
 * Client-side computer vision for local foreground detection,
 * stability analysis, hand-occlusion estimation, and sharpness scoring.
 *
 * All processing is limited to the central ROI (~4,800 pixels at 160×120)
 * for performance. No frames are sent over the network.
 */

import type { FrameAnalysis, ImageQuality } from "./types";

// ── Analysis resolution (small for speed) ──
const AW = 160;
const AH = 120;
const PIXEL_COUNT = AW * AH;

// ── Central ROI: center 50% × 50% of the analysis canvas ──
// Only foreground within this zone is used for idle→object_detected decisions.
// Edge noise, vibration, and peripheral lighting changes are ignored.
const ROI_X0 = Math.round(AW * 0.25); // 40
const ROI_X1 = Math.round(AW * 0.75); // 120
const ROI_Y0 = Math.round(AH * 0.25); // 30
const ROI_Y1 = Math.round(AH * 0.75); // 90
const ROI_W = ROI_X1 - ROI_X0;        // 80
const ROI_H = ROI_Y1 - ROI_Y0;        // 60
const ROI_PIXEL_COUNT = ROI_W * ROI_H; // 4800

// ── Background subtraction ──
const BG_LEARN_RATE = 0.015; // absorbs camera drift in ~10s; BG continues during confirm window to erode noise
const BG_INIT_RATE = 0.15;
const BG_INIT_FRAMES = 30; // ~4.5s of init at 7fps
const BG_SETTLE_FRAMES = 45; // detection blocked until this many frames
const FG_PIXEL_THRESHOLD = 40; // per-pixel diff threshold for foreground classification

// ── Thresholds (exported for state machine) ──
/**
 * Total ROI foreground threshold (erosion-filtered).
 * ≥9% of the central ROI must be occupied by noise-suppressed foreground.
 * ~760 pixels after the ≥2-neighbor erosion pass.
 * Paired with ROI_BLOB_THRESHOLD in KioskDisplay for coherence gating.
 */
export const ROI_FG_THRESHOLD = 0.06;
export const MOTION_RATIO_THRESHOLD = 0.12; // kept for external consumers
export const MAX_SKIN_RATIO = 0.80; // >80% skin in foreground → too much hand

/** Convert RGB (0-255) to HSV where H is 0-360, S is 0-1, V is 0-1. */
function rgbToHsv(r: number, g: number, b: number): [number, number, number] {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const d = max - min;
  const s = max === 0 ? 0 : d / max;
  const v = max;
  let h = 0;
  if (d !== 0) {
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) * 60;
    else if (max === g) h = ((b - r) / d + 2) * 60;
    else h = ((r - g) / d + 4) * 60;
  }
  return [h, s, v];
}

export class FrameAnalyzer {
  private bgModel: Float32Array | null = null;
  private prevGray: Uint8Array | null = null;
  private canvas: OffscreenCanvas | null = null;
  private ctx: OffscreenCanvasRenderingContext2D | null = null;
  private frameCount = 0;
  /** Mean luminance of the previous frame (0-255), used for adaptive BG rate. */
  private prevMeanLuminance = 128;

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

    // Draw downscaled frame
    ctx.drawImage(video, 0, 0, AW, AH);
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
        skinRatio: 0,
        sharpnessScore: 0,
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

    // ── Largest connected blob in eroded ROI mask ──
    let roiLargestBlobPixels = 0;
    let largestBlobMinX = ROI_W;
    let largestBlobMaxX = 0;
    let largestBlobMinY = ROI_H;
    let largestBlobMaxY = 0;
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
        const stack = [startIdx];
        blobVisited[startIdx] = 1;
        while (stack.length > 0) {
          const idx = stack.pop()!;
          size++;
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
        if (size > roiLargestBlobPixels) {
          roiLargestBlobPixels = size;
          largestBlobMinX = blobMinX;
          largestBlobMaxX = blobMaxX;
          largestBlobMinY = blobMinY;
          largestBlobMaxY = blobMaxY;
        }
      }
    }
    const roiLargestBlobRatio = roiLargestBlobPixels / ROI_PIXEL_COUNT;

    const largestBlobDiagonal = Math.sqrt(
      (largestBlobMaxX - largestBlobMinX) ** 2 +
      (largestBlobMaxY - largestBlobMinY) ** 2
    );
    const roiDiagonal = Math.sqrt(ROI_W ** 2 + ROI_H ** 2);
    const roiLargestBlobDiagonalRatio =
      roiDiagonal > 0 ? largestBlobDiagonal / roiDiagonal : 0;

    // ── Skin-tone ratio (HSV-based, ROI foreground pixels only) ──
    let skinCount = 0;
    let fgPixels = 0;
    for (let ry = 0; ry < ROI_H; ry++) {
      for (let rx = 0; rx < ROI_W; rx++) {
        const ri = ry * ROI_W + rx;
        if (Math.abs(roiGray[ri] - bg[ri]) <= FG_PIXEL_THRESHOLD) continue;
        fgPixels++;
        const o = ((ROI_Y0 + ry) * AW + (ROI_X0 + rx)) * 4;
        const r = px[o],
          g = px[o + 1],
          b = px[o + 2];
        const [h, s, v] = rgbToHsv(r, g, b);
        if (h <= 50 && s >= 0.1 && s <= 0.8 && v >= 0.2) {
          skinCount++;
        }
      }
    }
    const skinRatio = fgPixels > 0 ? skinCount / fgPixels : 0;

    // ── Sharpness (Laplacian variance, foreground pixels only) ──
    // Restricting to erodedMask prevents textured backgrounds from
    // inflating the score and ensures the object itself drives quality.
    let lapSum = 0;
    let lapN = 0;
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
        lapSum += lap * lap;
        lapN++;
      }
    }
    // Guard: too few foreground pixels → unstable variance; report 0.
    const sharpnessScore = lapN >= 50 ? lapSum / lapN : 0;

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

    return {
      roiForegroundRatio,
      roiLargestBlobRatio,
      roiLargestBlobDiagonalRatio,
      skinRatio,
      sharpnessScore,
      /** False during the first BG_SETTLE_FRAMES — detection is blocked until the background model has converged. */
      isSettled: this.frameCount >= BG_SETTLE_FRAMES,
      timestamp: Date.now(),
    };
  }

  /** Reset the background model (e.g. after a long pause). */
  reset(): void {
    this.bgModel = null;
    this.prevGray = null;
    this.frameCount = 0;
    this.prevMeanLuminance = 128;
  }
}

// ── Utility: derive image quality band from analysis ──
// Initial estimates for foreground-only Laplacian variance.
// Recalibrate from pilot-log data.
export function imageQualityBand(a: FrameAnalysis): ImageQuality {
  if (a.sharpnessScore > 1500) return "good";
  if (a.sharpnessScore > 500) return "fair";
  return "poor";
}
