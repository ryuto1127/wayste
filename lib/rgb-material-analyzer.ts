/**
 * Post-YOLO RGB material analysis layer.
 *
 * Runs after YOLO detection, before waste-rules matching.
 * Extracts ROI pixels from the detected bounding box and computes
 * color/material hints to refine the YOLO class name.
 *
 * Browser-safe — uses only Canvas/OffscreenCanvas APIs.
 */

import type { MaterialHint } from "./types";

// ── Thresholds ──
/** Fraction of pixels with brightness > 240 that suggests metallic/glass surface. */
const SPECULAR_HIGHLIGHT_RATIO = 0.08;
/** Fraction of low-saturation edge pixels matching the surrounding area to suggest transparency. */
const TRANSPARENCY_EDGE_RATIO = 0.35;
/** Minimum ROI size in pixels to attempt analysis. */
const MIN_ROI_PIXELS = 100;

// ── RGB → HSV conversion ──
function rgbToHsv(r: number, g: number, b: number): [number, number, number] {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
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
  return [h, s, max]; // h: 0-360, s: 0-1, v: 0-1
}

/**
 * Analyze material properties of a detected region.
 *
 * @param source - Video element or OffscreenCanvas containing the frame
 * @param bbox - YOLO bounding box [x, y, width, height] in source pixel coordinates
 * @returns MaterialHint with color/material analysis
 */
export function analyzeMaterial(
  source: HTMLVideoElement | OffscreenCanvas,
  bbox: [number, number, number, number],
): MaterialHint {
  const [bx, by, bw, bh] = bbox;

  // Get source dimensions
  const srcW = source instanceof HTMLVideoElement ? source.videoWidth : source.width;
  const srcH = source instanceof HTMLVideoElement ? source.videoHeight : source.height;

  // Clamp bbox to source bounds
  const x = Math.max(0, Math.round(bx));
  const y = Math.max(0, Math.round(by));
  const w = Math.min(Math.round(bw), srcW - x);
  const h = Math.min(Math.round(bh), srcH - y);

  if (w * h < MIN_ROI_PIXELS) {
    return { dominantHue: 0, saturation: 0, isMetallic: false, isTransparent: false, suggestedMaterial: null };
  }

  // Draw ROI + surrounding margin to a small canvas for analysis
  const margin = Math.round(Math.min(w, h) * 0.15);
  const outerX = Math.max(0, x - margin);
  const outerY = Math.max(0, y - margin);
  const outerW = Math.min(x - outerX + w + margin, srcW - outerX);
  const outerH = Math.min(y - outerY + h + margin, srcH - outerY);

  const canvas = new OffscreenCanvas(outerW, outerH);
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    return { dominantHue: 0, saturation: 0, isMetallic: false, isTransparent: false, suggestedMaterial: null };
  }

  ctx.drawImage(source, outerX, outerY, outerW, outerH, 0, 0, outerW, outerH);

  // ROI coordinates relative to the outer canvas
  const roiX = x - outerX;
  const roiY = y - outerY;

  // Get ROI pixel data
  const roiData = ctx.getImageData(roiX, roiY, w, h).data;
  const pixelCount = w * h;

  // Compute HSV statistics over the ROI
  let hueSum = 0;
  let hueSinSum = 0;
  let hueCosSum = 0;
  let satSum = 0;
  let specularCount = 0;
  let chromaPixels = 0;

  for (let i = 0; i < roiData.length; i += 4) {
    const r = roiData[i];
    const g = roiData[i + 1];
    const b = roiData[i + 2];
    const [hue, sat, val] = rgbToHsv(r, g, b);

    satSum += sat;

    // Specular highlight detection: very bright pixels
    if (val > 0.94 && sat < 0.15) {
      specularCount++;
    }

    // Accumulate hue using circular mean (only for chromatic pixels)
    if (sat > 0.15) {
      const rad = (hue * Math.PI) / 180;
      hueSinSum += Math.sin(rad);
      hueCosSum += Math.cos(rad);
      chromaPixels++;
    }
  }

  const avgSaturation = satSum / pixelCount;
  const specularRatio = specularCount / pixelCount;
  const isMetallic = specularRatio > SPECULAR_HIGHLIGHT_RATIO;

  // Circular mean hue (meaningful only if enough chromatic pixels exist)
  let dominantHue = 0;
  if (chromaPixels > pixelCount * 0.1) {
    dominantHue = Math.round(
      (Math.atan2(hueSinSum / chromaPixels, hueCosSum / chromaPixels) * 180) / Math.PI,
    );
    if (dominantHue < 0) dominantHue += 360;
  }

  // Transparency detection: compare ROI edge pixels with surrounding area
  const isTransparent = detectTransparency(ctx, roiX, roiY, w, h, outerW, outerH);

  const suggestedMaterial = null; // Refinement is applied externally

  return { dominantHue, saturation: avgSaturation, isMetallic, isTransparent, suggestedMaterial };
}

/**
 * Detect transparency by comparing ROI edge pixels with surrounding area.
 * If edge pixels have similar brightness/color to the background, the item is likely transparent.
 */
function detectTransparency(
  ctx: OffscreenCanvasRenderingContext2D,
  roiX: number,
  roiY: number,
  roiW: number,
  roiH: number,
  canvasW: number,
  canvasH: number,
): boolean {
  // Sample edge pixels of the ROI (inner ring)
  const edgePixels = sampleEdgePixels(ctx, roiX, roiY, roiW, roiH);
  if (edgePixels.length < 10) return false;

  // Sample surrounding pixels (outer ring)
  const surroundPixels = sampleSurroundPixels(ctx, roiX, roiY, roiW, roiH, canvasW, canvasH);
  if (surroundPixels.length < 10) return false;

  // Compare average brightness
  const edgeBrightness = avgBrightness(edgePixels);
  const surroundBrightness = avgBrightness(surroundPixels);

  // If edge pixels are very similar to surrounding (low contrast), item may be transparent
  const brightnessDiff = Math.abs(edgeBrightness - surroundBrightness);
  return brightnessDiff < 25; // ~10% of 255
}

function sampleEdgePixels(
  ctx: OffscreenCanvasRenderingContext2D,
  x: number, y: number, w: number, h: number,
): number[][] {
  const pixels: number[][] = [];
  const step = Math.max(1, Math.round(Math.max(w, h) / 20));

  // Top and bottom edges
  for (let dx = 0; dx < w; dx += step) {
    const topData = ctx.getImageData(x + dx, y, 1, 1).data;
    pixels.push([topData[0], topData[1], topData[2]]);
    const botData = ctx.getImageData(x + dx, y + h - 1, 1, 1).data;
    pixels.push([botData[0], botData[1], botData[2]]);
  }
  // Left and right edges
  for (let dy = 0; dy < h; dy += step) {
    const leftData = ctx.getImageData(x, y + dy, 1, 1).data;
    pixels.push([leftData[0], leftData[1], leftData[2]]);
    const rightData = ctx.getImageData(x + w - 1, y + dy, 1, 1).data;
    pixels.push([rightData[0], rightData[1], rightData[2]]);
  }

  return pixels;
}

function sampleSurroundPixels(
  ctx: OffscreenCanvasRenderingContext2D,
  roiX: number, roiY: number, roiW: number, roiH: number,
  canvasW: number, canvasH: number,
): number[][] {
  const pixels: number[][] = [];
  const margin = Math.round(Math.min(roiW, roiH) * 0.1) + 2;
  const step = Math.max(1, Math.round(Math.max(roiW, roiH) / 20));

  // Top surround
  if (roiY - margin >= 0) {
    for (let dx = 0; dx < roiW; dx += step) {
      const px = roiX + dx;
      const py = roiY - margin;
      if (px >= 0 && px < canvasW && py >= 0) {
        const d = ctx.getImageData(px, py, 1, 1).data;
        pixels.push([d[0], d[1], d[2]]);
      }
    }
  }
  // Bottom surround
  if (roiY + roiH + margin < canvasH) {
    for (let dx = 0; dx < roiW; dx += step) {
      const px = roiX + dx;
      const py = roiY + roiH + margin;
      if (px >= 0 && px < canvasW && py < canvasH) {
        const d = ctx.getImageData(px, py, 1, 1).data;
        pixels.push([d[0], d[1], d[2]]);
      }
    }
  }

  return pixels;
}

function avgBrightness(pixels: number[][]): number {
  if (pixels.length === 0) return 0;
  let sum = 0;
  for (const [r, g, b] of pixels) {
    sum += 0.299 * r + 0.587 * g + 0.114 * b;
  }
  return sum / pixels.length;
}

/**
 * Refine a YOLO class name based on material analysis.
 *
 * Returns the original className when no refinement is applicable.
 */
export function refineClassName(className: string, hint: MaterialHint): string {
  const lower = className.toLowerCase();

  // "bottle" + metallic → keep as-is (likely aluminium can misdetection)
  if (lower.includes("bottle") && hint.isMetallic) {
    return className; // Don't refine — let downstream handle it
  }

  // "bottle" + transparent + green hue → "glass bottle"
  if (lower.includes("bottle") && hint.isTransparent && hint.dominantHue >= 80 && hint.dominantHue <= 160) {
    return "glass bottle";
  }

  // "cup" (not "plastic cup") + opaque white + low saturation → "paper cup"
  if (lower.includes("cup") && !lower.includes("plastic") && !hint.isTransparent && hint.saturation < 0.2) {
    return "paper cup";
  }

  // "plastic cup" + transparent → keep "plastic cup"
  if (lower.includes("plastic cup") && hint.isTransparent) {
    return className;
  }

  // No refinement
  return className;
}
