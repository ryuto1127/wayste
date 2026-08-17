/**
 * captureSpace on pilot-log entries + the letterbox alignment invariant.
 *
 * Continuous mode runs YOLO on the FULL frame letterboxed into 640×640, so
 * the logged image must be the same letterboxed square (at full resolution)
 * for `yoloDetections[].bboxNorm` to align with the stored pixels. These
 * tests pin down:
 *   1. `captureSpace` survives the Redis read parse (and stays optional for
 *      entries written before the field existed).
 *   2. The geometry: a model-space bbox normalized by 640 lands on the same
 *      video pixels when drawn on a capture square of side max(vw, vh)
 *      letterboxed via the same `computeLetterbox` — i.e. logging the
 *      letterboxed square makes bboxNorm image-aligned by construction.
 */
import { parsePilotLogEntry } from "@/lib/pilot-log-schema";
import { computeLetterbox } from "@/lib/bbox-utils";

const baseEntry = {
  timestamp: "2026-08-17T00:00:00.000Z",
  modelUsed: "T1",
  escalated: false,
  itemName: "pet_bottle",
  wasteStream: "recyclable",
  confidence: 0.9,
  requiresVerification: false,
  latencyMs: 120,
};

describe("captureSpace on PilotLogEntry", () => {
  it.each(["letterbox", "center_square"] as const)(
    "round-trips %s through parsePilotLogEntry",
    (space) => {
      const parsed = parsePilotLogEntry({ ...baseEntry, captureSpace: space });
      expect(parsed).not.toBeNull();
      expect(parsed!.captureSpace).toBe(space);
    },
  );

  it("stays optional — legacy entries without the field still parse", () => {
    const parsed = parsePilotLogEntry(baseEntry);
    expect(parsed).not.toBeNull();
    expect(parsed!.captureSpace).toBeUndefined();
  });

  it("rejects entries with an unknown captureSpace value", () => {
    expect(
      parsePilotLogEntry({ ...baseEntry, captureSpace: "full_frame" }),
    ).toBeNull();
  });
});

describe("letterbox capture aligns bboxNorm with the stored image", () => {
  // Map a point from 640×640 model space back to video pixels.
  function modelToVideo(mx: number, my: number, vw: number, vh: number) {
    const { dx, dy, dw, dh } = computeLetterbox(vw, vh, 640);
    return { x: ((mx - dx) / dw) * vw, y: ((my - dy) / dh) * vh };
  }

  // Map a normalized (0–1) point on the logged capture square (side =
  // max(vw, vh), full frame letterboxed) back to video pixels.
  function captureNormToVideo(nx: number, ny: number, vw: number, vh: number) {
    const side = Math.max(vw, vh);
    const { dx, dy, dw, dh } = computeLetterbox(vw, vh, side);
    return { x: ((nx * side - dx) / dw) * vw, y: ((ny * side - dy) / dh) * vh };
  }

  it.each([
    [1280, 720],  // landscape 16:9
    [720, 1280],  // portrait
    [1920, 1080], // full HD
    [640, 480],   // 4:3
  ])("same video pixel from model space and capture space (%dx%d)", (vw, vh) => {
    // A detection center somewhere off-center in model space.
    const bbox: [number, number, number, number] = [320, 230, 64, 36];
    const cxModel = bbox[0] + bbox[2] / 2;
    const cyModel = bbox[1] + bbox[3] / 2;
    // bboxNorm exactly as toDetectionLogs computes it (÷ 640).
    const norm = [cxModel / 640, cyModel / 640] as const;

    const viaModel = modelToVideo(cxModel, cyModel, vw, vh);
    const viaCapture = captureNormToVideo(norm[0], norm[1], vw, vh);

    // computeLetterbox rounds to whole pixels, so allow ~1px of slack.
    expect(Math.abs(viaCapture.x - viaModel.x)).toBeLessThanOrEqual(1.5);
    expect(Math.abs(viaCapture.y - viaModel.y)).toBeLessThanOrEqual(1.5);
  });

  it("center-square capture does NOT align with letterboxed bboxNorm (the bug being fixed)", () => {
    const vw = 1280, vh = 720;
    const bbox: [number, number, number, number] = [320, 230, 64, 36];
    const cyModel = bbox[1] + bbox[3] / 2;
    const nyNorm = cyModel / 640;

    const viaModel = modelToVideo(320 + 32, cyModel, vw, vh);
    // Drawing the same normalized y onto the old center short-side crop:
    const side = Math.min(vw, vh);
    const cropY = Math.round((vh - side) / 2) + nyNorm * side;

    // The letterboxed detection sits well away from where the center-square
    // interpretation would draw it — this offset is the misalignment.
    expect(Math.abs(cropY - viaModel.y)).toBeGreaterThan(50);
  });
});
