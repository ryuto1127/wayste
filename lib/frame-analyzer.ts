/**
 * Client-side computer vision for local foreground detection,
 * stability analysis, hand-occlusion estimation, and sharpness scoring.
 *
 * Operates on a downscaled grayscale copy of the camera feed.
 * No frames are sent over the network — all processing is local.
 */

import type { FrameAnalysis, ImageQuality } from "./types";

// ── Analysis resolution (small for speed) ──
const AW = 160;
const AH = 120;
const PIXEL_COUNT = AW * AH;

// ── Central ROI: center 60% × 60% of the analysis canvas ──
// Only foreground within this zone is used for idle→object_detected decisions.
// Edge noise, vibration, and peripheral lighting changes are ignored.
const ROI_X0 = Math.round(AW * 0.20); // 32
const ROI_X1 = Math.round(AW * 0.80); // 128
const ROI_Y0 = Math.round(AH * 0.20); // 24
const ROI_Y1 = Math.round(AH * 0.80); // 96
const ROI_PIXEL_COUNT = (ROI_X1 - ROI_X0) * (ROI_Y1 - ROI_Y0); // 6912

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
export const ROI_FG_THRESHOLD = 0.09;
export const MOTION_RATIO_THRESHOLD = 0.08; // <8% inter-frame change → stable (very forgiving of hand tremor)
export const MAX_SKIN_RATIO = 0.70; // >70% skin in foreground → too much hand

const MOTION_PIXEL_THRESHOLD = 35;

export class FrameAnalyzer {
  private bgModel: Float32Array | null = null;
  private prevGray: Uint8Array | null = null;
  private canvas: OffscreenCanvas | null = null;
  private ctx: OffscreenCanvasRenderingContext2D | null = null;
  private frameCount = 0;

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

    // ── Convert to grayscale ──
    const gray = new Uint8Array(PIXEL_COUNT);
    for (let i = 0; i < PIXEL_COUNT; i++) {
      const o = i * 4;
      gray[i] = (0.299 * px[o] + 0.587 * px[o + 1] + 0.114 * px[o + 2]) | 0;
    }

    this.frameCount++;

    // ── Bootstrap background model ──
    if (!this.bgModel) {
      this.bgModel = Float32Array.from(gray);
      this.prevGray = new Uint8Array(gray);
      return {
        foregroundRatio: 0,
        roiForegroundRatio: 0,
        roiLargestBlobRatio: 0,
        roiLargestBlobDiagonalRatio: 0,
        motionScore: 0,
        skinRatio: 0,
        sharpnessScore: 0,
        isSettled: false,
        timestamp: Date.now(),
      };
    }

    const bg = this.bgModel;

    // ── Foreground mask + full-frame ratio ──
    const fgMask = new Uint8Array(PIXEL_COUNT);
    let fgCount = 0;
    for (let i = 0; i < PIXEL_COUNT; i++) {
      if (Math.abs(gray[i] - bg[i]) > FG_PIXEL_THRESHOLD) {
        fgMask[i] = 1;
        fgCount++;
      }
    }
    const foregroundRatio = fgCount / PIXEL_COUNT;

    // ── ROI foreground: 2-neighbor erosion filter → eroded mask ──
    // A foreground pixel in the ROI only survives if ≥2 of its 4 cardinal
    // neighbours are also foreground (morphological erosion). Dense object
    // blobs survive intact; scattered vibration noise is almost entirely removed.
    // The eroded mask is retained for connected-component analysis below.
    const roiErodedMask = new Uint8Array(PIXEL_COUNT);
    let roiFgCount = 0;
    for (let y = ROI_Y0; y < ROI_Y1; y++) {
      for (let x = ROI_X0; x < ROI_X1; x++) {
        const i = y * AW + x;
        if (!fgMask[i]) continue;
        const n =
          (x > 0 ? fgMask[i - 1] : 0) +
          (x < AW - 1 ? fgMask[i + 1] : 0) +
          (y > 0 ? fgMask[i - AW] : 0) +
          (y < AH - 1 ? fgMask[i + AW] : 0);
        if (n >= 2) {
          roiErodedMask[i] = 1;
          roiFgCount++;
        }
      }
    }
    const roiForegroundRatio = roiFgCount / ROI_PIXEL_COUNT;

    // ── Largest connected blob in eroded ROI mask ──
    // DFS over the eroded mask to find the largest single connected component
    // (4-connectivity, bounded to ROI). Used in the state machine to require a
    // coherent blob rather than many scattered patches that happen to sum above
    // the ratio threshold. Scattered noise → tiny blobs; real object → one large blob.
    let roiLargestBlobPixels = 0;
    let largestBlobMinX = ROI_X1;
    let largestBlobMaxX = ROI_X0;
    let largestBlobMinY = ROI_Y1;
    let largestBlobMaxY = ROI_Y0;
    const blobVisited = new Uint8Array(PIXEL_COUNT);
    for (let y = ROI_Y0; y < ROI_Y1; y++) {
      for (let x = ROI_X0; x < ROI_X1; x++) {
        const startIdx = y * AW + x;
        if (!roiErodedMask[startIdx] || blobVisited[startIdx]) continue;
        // DFS flood-fill — stack holds flat pixel indices
        let size = 0;
        let blobMinX = ROI_X1;
        let blobMaxX = ROI_X0;
        let blobMinY = ROI_Y1;
        let blobMaxY = ROI_Y0;
        const stack = [startIdx];
        blobVisited[startIdx] = 1;
        while (stack.length > 0) {
          const idx = stack.pop()!;
          size++;
          const cx = idx % AW;
          const cy = (idx / AW) | 0;
          if (cx < blobMinX) blobMinX = cx;
          if (cx > blobMaxX) blobMaxX = cx;
          if (cy < blobMinY) blobMinY = cy;
          if (cy > blobMaxY) blobMaxY = cy;
          // Left
          if (cx > ROI_X0) {
            const n = idx - 1;
            if (roiErodedMask[n] && !blobVisited[n]) { blobVisited[n] = 1; stack.push(n); }
          }
          // Right
          if (cx < ROI_X1 - 1) {
            const n = idx + 1;
            if (roiErodedMask[n] && !blobVisited[n]) { blobVisited[n] = 1; stack.push(n); }
          }
          // Up
          if (cy > ROI_Y0) {
            const n = idx - AW;
            if (roiErodedMask[n] && !blobVisited[n]) { blobVisited[n] = 1; stack.push(n); }
          }
          // Down
          if (cy < ROI_Y1 - 1) {
            const n = idx + AW;
            if (roiErodedMask[n] && !blobVisited[n]) { blobVisited[n] = 1; stack.push(n); }
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

    // Euclidean diagonal of the largest blob's bounding box
    const largestBlobDiagonal = Math.sqrt(
      (largestBlobMaxX - largestBlobMinX) ** 2 +
      (largestBlobMaxY - largestBlobMinY) ** 2
    );

    // ROI's own diagonal (constant for the fixed ROI dimensions)
    const roiDiagonal = Math.sqrt(
      (ROI_X1 - ROI_X0) ** 2 +
      (ROI_Y1 - ROI_Y0) ** 2
    );

    const roiLargestBlobDiagonalRatio =
      roiDiagonal > 0 ? largestBlobDiagonal / roiDiagonal : 0;

    // ── Inter-frame motion ──
    let motionCount = 0;
    const prev = this.prevGray!;
    for (let i = 0; i < PIXEL_COUNT; i++) {
      if (Math.abs(gray[i] - prev[i]) > MOTION_PIXEL_THRESHOLD) motionCount++;
    }
    const motionScore = motionCount / PIXEL_COUNT;

    // ── Skin-tone ratio (RGB heuristic, foreground pixels only) ──
    let skinCount = 0;
    let fgPixels = 0;
    for (let i = 0; i < PIXEL_COUNT; i++) {
      if (Math.abs(gray[i] - bg[i]) <= FG_PIXEL_THRESHOLD) continue;
      fgPixels++;
      const o = i * 4;
      const r = px[o],
        g = px[o + 1],
        b = px[o + 2];
      if (
        r > 95 &&
        g > 40 &&
        b > 20 &&
        r > g &&
        r > b &&
        r - Math.min(g, b) > 15 &&
        Math.abs(r - g) > 15
      ) {
        skinCount++;
      }
    }
    const skinRatio = fgPixels > 0 ? skinCount / fgPixels : 0;

    // ── Sharpness (Laplacian variance) ──
    let lapSum = 0;
    let lapN = 0;
    for (let y = 1; y < AH - 1; y++) {
      for (let x = 1; x < AW - 1; x++) {
        const idx = y * AW + x;
        const lap =
          4 * gray[idx] -
          gray[idx - 1] -
          gray[idx + 1] -
          gray[idx - AW] -
          gray[idx + AW];
        lapSum += lap * lap;
        lapN++;
      }
    }
    const sharpnessScore = lapN > 0 ? lapSum / lapN : 0;

    // ── Update background model ──
    // Rate is set externally by the pipeline state machine via setBgRate().
    // During init frames, always update fast regardless of the external rate.
    // After init, use exactly the rate the state machine requested:
    //   0     → frozen (object_detected / stabilizing / classifying)
    //   ~0.001 → micro (result — slowly absorbs persistent stuck objects)
    //   ~0.008 → full  (idle / cooldown — normal continuous adaptation)
    const effectiveBgRate = this.frameCount <= BG_INIT_FRAMES
      ? BG_INIT_RATE
      : this.bgRate;
    if (effectiveBgRate > 0) {
      for (let i = 0; i < PIXEL_COUNT; i++) {
        bg[i] = bg[i] * (1 - effectiveBgRate) + gray[i] * effectiveBgRate;
      }
    }

    this.prevGray = new Uint8Array(gray);

    return {
      foregroundRatio,
      roiForegroundRatio,
      roiLargestBlobRatio,
      roiLargestBlobDiagonalRatio,
      motionScore,
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
  }
}

// ── Utility: derive image quality band from analysis ──
export function imageQualityBand(a: FrameAnalysis): ImageQuality {
  if (a.sharpnessScore > 400 && a.skinRatio < 0.35) return "good";
  if (a.sharpnessScore > 150 && a.skinRatio < 0.50) return "fair";
  return "poor";
}
