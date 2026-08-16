import {
  computeIoU,
  greedyIoUMatch,
  frameDiff,
  computeLetterbox,
  letterboxedBboxToVideoNorm,
  type Bbox,
} from "@/lib/bbox-utils";

describe("computeIoU", () => {
  it("returns 1.0 for identical boxes", () => {
    const box: Bbox = [100, 100, 200, 200];
    expect(computeIoU(box, box)).toBeCloseTo(1.0);
  });

  it("returns 0.0 for non-overlapping boxes", () => {
    const a: Bbox = [0, 0, 100, 100];
    const b: Bbox = [200, 200, 100, 100];
    expect(computeIoU(a, b)).toBe(0);
  });

  it("computes correct IoU for 50% overlap", () => {
    // Box A: [0,0] to [100,100]  area=10000
    // Box B: [50,0] to [150,100] area=10000
    // Intersection: [50,0] to [100,100] = 50*100 = 5000
    // Union: 10000+10000-5000 = 15000
    // IoU = 5000/15000 = 0.333...
    const a: Bbox = [0, 0, 100, 100];
    const b: Bbox = [50, 0, 100, 100];
    expect(computeIoU(a, b)).toBeCloseTo(1 / 3);
  });

  it("handles contained box", () => {
    // Small box inside big box
    const big: Bbox = [0, 0, 200, 200];    // area=40000
    const small: Bbox = [50, 50, 50, 50];   // area=2500
    // Intersection = 2500, Union = 40000
    expect(computeIoU(big, small)).toBeCloseTo(2500 / 40000);
  });

  it("handles zero-area boxes", () => {
    const a: Bbox = [100, 100, 0, 0];
    const b: Bbox = [100, 100, 50, 50];
    expect(computeIoU(a, b)).toBe(0);
  });
});

describe("greedyIoUMatch", () => {
  it("returns all unmatched when arrays are empty", () => {
    const result = greedyIoUMatch([], []);
    expect(result.matched).toEqual([]);
    expect(result.unmatchedTracked).toEqual([]);
    expect(result.unmatchedDetections).toEqual([]);
  });

  it("returns all tracked as unmatched when no detections", () => {
    const tracked = [
      { id: 1, bbox: [100, 100, 50, 50] as Bbox },
      { id: 2, bbox: [300, 100, 50, 50] as Bbox },
    ];
    const result = greedyIoUMatch(tracked, []);
    expect(result.matched).toEqual([]);
    expect(result.unmatchedTracked).toEqual([1, 2]);
  });

  it("correctly matches 2 tracked to 2 detections", () => {
    const tracked = [
      { id: 1, bbox: [100, 100, 80, 80] as Bbox },
      { id: 2, bbox: [400, 100, 80, 80] as Bbox },
    ];
    const detections = [
      { bbox: [105, 105, 80, 80] as Bbox, index: 0 }, // close to tracked 1
      { bbox: [395, 105, 80, 80] as Bbox, index: 1 }, // close to tracked 2
    ];
    const result = greedyIoUMatch(tracked, detections);
    expect(result.matched).toHaveLength(2);
    expect(result.matched.find(m => m.trackedId === 1)?.detectionIndex).toBe(0);
    expect(result.matched.find(m => m.trackedId === 2)?.detectionIndex).toBe(1);
    expect(result.unmatchedTracked).toEqual([]);
    expect(result.unmatchedDetections).toEqual([]);
  });

  it("leaves both unmatched below minIoU", () => {
    const tracked = [
      { id: 1, bbox: [0, 0, 50, 50] as Bbox },
    ];
    const detections = [
      { bbox: [500, 500, 50, 50] as Bbox, index: 0 }, // far away
    ];
    const result = greedyIoUMatch(tracked, detections);
    expect(result.matched).toEqual([]);
    expect(result.unmatchedTracked).toEqual([1]);
    expect(result.unmatchedDetections).toEqual([0]);
  });

  it("handles 3 tracked + 2 detections (1 unmatched tracked)", () => {
    const tracked = [
      { id: 1, bbox: [100, 100, 80, 80] as Bbox },
      { id: 2, bbox: [300, 100, 80, 80] as Bbox },
      { id: 3, bbox: [500, 100, 80, 80] as Bbox },
    ];
    const detections = [
      { bbox: [103, 103, 80, 80] as Bbox, index: 0 }, // matches tracked 1
      { bbox: [503, 103, 80, 80] as Bbox, index: 1 }, // matches tracked 3
    ];
    const result = greedyIoUMatch(tracked, detections);
    expect(result.matched).toHaveLength(2);
    expect(result.unmatchedTracked).toEqual([2]);
    expect(result.unmatchedDetections).toEqual([]);
  });

  it("respects custom minIoU threshold", () => {
    const tracked = [{ id: 1, bbox: [0, 0, 100, 100] as Bbox }];
    // Slight overlap — IoU ~0.33
    const detections = [{ bbox: [50, 0, 100, 100] as Bbox, index: 0 }];

    // Default minIoU=0.3 should match
    const r1 = greedyIoUMatch(tracked, detections, 0.3);
    expect(r1.matched).toHaveLength(1);

    // Higher minIoU=0.5 should not match
    const r2 = greedyIoUMatch(tracked, detections, 0.5);
    expect(r2.matched).toHaveLength(0);
  });
});

describe("frameDiff", () => {
  it("returns 0 for identical fingerprints", () => {
    const fp = new Uint8Array(1024).fill(128);
    expect(frameDiff(fp, fp)).toBe(0);
  });

  it("returns 255 for maximally different fingerprints", () => {
    const a = new Uint8Array(1024).fill(0);
    const b = new Uint8Array(1024).fill(255);
    expect(frameDiff(a, b)).toBe(255);
  });

  it("returns correct mean for partial diff", () => {
    const a = new Uint8Array(1024).fill(100);
    const b = new Uint8Array(1024).fill(110);
    expect(frameDiff(a, b)).toBe(10);
  });

  it("returns 255 for mismatched lengths", () => {
    const a = new Uint8Array(1024);
    const b = new Uint8Array(512);
    expect(frameDiff(a, b)).toBe(255);
  });

  it("returns 255 for empty arrays", () => {
    expect(frameDiff(new Uint8Array(0), new Uint8Array(0))).toBe(255);
  });
});

describe("computeLetterbox", () => {
  it("letterboxes a 16:9 landscape frame with vertical padding", () => {
    expect(computeLetterbox(1280, 720)).toEqual({ dx: 0, dy: 140, dw: 640, dh: 360 });
  });

  it("letterboxes a portrait frame with horizontal padding", () => {
    expect(computeLetterbox(720, 1280)).toEqual({ dx: 140, dy: 0, dw: 360, dh: 640 });
  });

  it("fills the input exactly for a square frame", () => {
    expect(computeLetterbox(720, 720)).toEqual({ dx: 0, dy: 0, dw: 640, dh: 640 });
  });

  it("is scale invariant — aspect ratio gives the same layout as pixel dims", () => {
    expect(computeLetterbox(16 / 9, 1)).toEqual(computeLetterbox(1280, 720));
  });

  it("degrades safely on invalid dimensions", () => {
    expect(computeLetterbox(0, 720)).toEqual({ dx: 0, dy: 0, dw: 640, dh: 640 });
  });
});

describe("letterboxedBboxToVideoNorm", () => {
  it("maps the full content area to the full frame", () => {
    const norm = letterboxedBboxToVideoNorm([0, 140, 640, 360], 1280, 720);
    expect(norm[0]).toBeCloseTo(0);
    expect(norm[1]).toBeCloseTo(0);
    expect(norm[2]).toBeCloseTo(1);
    expect(norm[3]).toBeCloseTo(1);
  });

  it("maps a centered box to centered normalized coords", () => {
    // 64×36 model-space box centered in the 640×360 content area
    const norm = letterboxedBboxToVideoNorm([288, 302, 64, 36], 1280, 720);
    expect(norm[0]).toBeCloseTo(0.45);
    expect(norm[1]).toBeCloseTo(0.45);
    expect(norm[2]).toBeCloseTo(0.1);
    expect(norm[3]).toBeCloseTo(0.1);
  });

  it("lets edge boxes bleed slightly outside [0,1] instead of clamping", () => {
    // Box overlapping the top padding boundary
    const norm = letterboxedBboxToVideoNorm([0, 120, 100, 100], 1280, 720);
    expect(norm[1]).toBeLessThan(0);
  });
});
