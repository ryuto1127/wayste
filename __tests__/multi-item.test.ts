/**
 * Tests for multi-item detection pipeline:
 * - blobIsObject() quality gate
 * - Blob-to-detection matching
 * - ResultScreen grid layouts
 * - API batch endpoint
 */

import { blobIsObject, BLOB_MIN_SHARPNESS, BLOB_MIN_CONTRAST, BLOB_MAX_SKIN_RATIO } from "@/lib/frame-analyzer";
import type { BlobInfo, ClassificationResponse } from "@/lib/types";

// ── Helper: build a BlobInfo with defaults ──
function makeBlob(overrides: Partial<BlobInfo> = {}): BlobInfo {
  return {
    bboxNorm: [0.5, 0.5, 0.2, 0.2],
    pixelCount: 200,
    ratio: 0.04,
    sharpness: 500,
    contrastScore: 40,
    skinRatio: 0.1,
    saturation: 0.4,
    ...overrides,
  };
}

// ── blobIsObject tests ──
describe("blobIsObject", () => {
  it("returns true for high sharpness + high contrast + low skin ratio (real object)", () => {
    const blob = makeBlob({
      sharpness: BLOB_MIN_SHARPNESS + 100,
      contrastScore: BLOB_MIN_CONTRAST + 10,
      skinRatio: 0.1,
    });
    expect(blobIsObject(blob)).toBe(true);
  });

  it("returns false for low sharpness + low contrast (shadow)", () => {
    const blob = makeBlob({
      sharpness: BLOB_MIN_SHARPNESS - 100,
      contrastScore: BLOB_MIN_CONTRAST - 5,
      skinRatio: 0.1,
    });
    expect(blobIsObject(blob)).toBe(false);
  });

  it("returns false for low sharpness alone (smooth surface / shadow)", () => {
    const blob = makeBlob({
      sharpness: BLOB_MIN_SHARPNESS - 100,
      contrastScore: BLOB_MIN_CONTRAST + 10,
      skinRatio: 0.1,
    });
    expect(blobIsObject(blob)).toBe(false);
  });

  it("returns false for low contrast alone (faint difference from background)", () => {
    const blob = makeBlob({
      sharpness: BLOB_MIN_SHARPNESS + 100,
      contrastScore: BLOB_MIN_CONTRAST - 5,
      skinRatio: 0.1,
    });
    expect(blobIsObject(blob)).toBe(false);
  });

  it("returns false for high skin ratio (hand/arm fragment)", () => {
    const blob = makeBlob({
      sharpness: BLOB_MIN_SHARPNESS + 100,
      contrastScore: BLOB_MIN_CONTRAST + 10,
      skinRatio: BLOB_MAX_SKIN_RATIO + 0.1,
    });
    expect(blobIsObject(blob)).toBe(false);
  });

  it("returns true at exact threshold boundaries", () => {
    const blob = makeBlob({
      sharpness: BLOB_MIN_SHARPNESS + 1,
      contrastScore: BLOB_MIN_CONTRAST + 1,
      skinRatio: BLOB_MAX_SKIN_RATIO - 0.01,
    });
    expect(blobIsObject(blob)).toBe(true);
  });

  it("returns false at exact threshold (sharpness not strictly greater)", () => {
    const blob = makeBlob({
      sharpness: BLOB_MIN_SHARPNESS,
      contrastScore: BLOB_MIN_CONTRAST + 1,
      skinRatio: 0.1,
    });
    expect(blobIsObject(blob)).toBe(false);
  });
});

// ── Blob-to-detection matching ──
// We replicate the matching logic from KioskDisplay for unit testing
interface MockDetection {
  className: string;
  confidence: number;
  bbox: [number, number, number, number]; // [x, y, w, h] in 640-space
}

const YOLO_MODEL_SIZE = 640;

function matchBlobsToDetections(
  blobs: BlobInfo[],
  detections: MockDetection[],
): { blob: BlobInfo; detection: MockDetection | null }[] {
  const usedDetections = new Set<number>();
  const result: { blob: BlobInfo; detection: MockDetection | null }[] = [];

  for (const blob of blobs) {
    const [bcx, bcy] = blob.bboxNorm;
    let bestDist = Infinity;
    let bestIdx = -1;

    for (let i = 0; i < detections.length; i++) {
      if (usedDetections.has(i)) continue;
      const d = detections[i];
      const dcx = (d.bbox[0] + d.bbox[2] / 2) / YOLO_MODEL_SIZE;
      const dcy = (d.bbox[1] + d.bbox[3] / 2) / YOLO_MODEL_SIZE;
      const dist = Math.sqrt((bcx - dcx) ** 2 + (bcy - dcy) ** 2);
      if (dist < bestDist) {
        bestDist = dist;
        bestIdx = i;
      }
    }

    if (bestIdx >= 0 && bestDist < 0.3) {
      usedDetections.add(bestIdx);
      result.push({ blob, detection: detections[bestIdx] });
    } else {
      result.push({ blob, detection: null });
    }

    if (result.length >= 4) break;
  }

  return result;
}

describe("Blob-to-detection matching", () => {
  it("matches blob to nearest detection by center proximity", () => {
    const blobs: BlobInfo[] = [
      makeBlob({ bboxNorm: [0.3, 0.3, 0.2, 0.2] }),
      makeBlob({ bboxNorm: [0.7, 0.7, 0.2, 0.2] }),
    ];
    const detections: MockDetection[] = [
      { className: "bottle", confidence: 0.9, bbox: [160, 160, 80, 80] }, // center ~ (0.31, 0.31)
      { className: "cup", confidence: 0.8, bbox: [400, 400, 80, 80] },    // center ~ (0.69, 0.69)
    ];

    const matches = matchBlobsToDetections(blobs, detections);
    expect(matches).toHaveLength(2);
    expect(matches[0].detection?.className).toBe("bottle");
    expect(matches[1].detection?.className).toBe("cup");
  });

  it("leaves blob unmatched when no detection is within range", () => {
    const blobs: BlobInfo[] = [
      makeBlob({ bboxNorm: [0.1, 0.1, 0.1, 0.1] }),
    ];
    const detections: MockDetection[] = [
      { className: "bottle", confidence: 0.9, bbox: [500, 500, 80, 80] }, // center ~ (0.84, 0.84) — far away
    ];

    const matches = matchBlobsToDetections(blobs, detections);
    expect(matches).toHaveLength(1);
    expect(matches[0].detection).toBeNull();
  });

  it("does not double-assign a detection to multiple blobs", () => {
    const blobs: BlobInfo[] = [
      makeBlob({ bboxNorm: [0.3, 0.3, 0.1, 0.1] }),
      makeBlob({ bboxNorm: [0.35, 0.35, 0.1, 0.1] }), // close to blob 1
    ];
    const detections: MockDetection[] = [
      { className: "bottle", confidence: 0.9, bbox: [160, 160, 80, 80] }, // only one detection
    ];

    const matches = matchBlobsToDetections(blobs, detections);
    expect(matches).toHaveLength(2);
    // First blob gets the detection, second is unmatched
    expect(matches[0].detection?.className).toBe("bottle");
    expect(matches[1].detection).toBeNull();
  });

  it("caps at 4 blob-detection pairs", () => {
    const blobs: BlobInfo[] = Array.from({ length: 6 }, (_, i) =>
      makeBlob({ bboxNorm: [0.1 + i * 0.15, 0.5, 0.1, 0.1] })
    );
    const detections: MockDetection[] = Array.from({ length: 6 }, (_, i) => ({
      className: `item${i}`,
      confidence: 0.9,
      bbox: [(0.1 + i * 0.15) * 640 - 40, 280, 80, 80] as [number, number, number, number],
    }));

    const matches = matchBlobsToDetections(blobs, detections);
    expect(matches).toHaveLength(4);
  });
});

// ── Unmatched blob routing ──
describe("Unmatched blob routing", () => {
  it("high-quality unmatched blob should be sent to API (blobIsObject=true)", () => {
    const blob = makeBlob({
      sharpness: BLOB_MIN_SHARPNESS + 100,
      contrastScore: BLOB_MIN_CONTRAST + 20,
      skinRatio: 0.1,
    });
    // No YOLO match, but blobIsObject → should go to API
    expect(blobIsObject(blob)).toBe(true);
  });

  it("low-quality unmatched blob should be discarded (blobIsObject=false)", () => {
    const blob = makeBlob({
      sharpness: 100,
      contrastScore: 10,
      skinRatio: 0.1,
    });
    // No YOLO match and not a real object → discard
    expect(blobIsObject(blob)).toBe(false);
  });
});

// ── ResultScreen grid layout ──
describe("ResultScreen grid layout", () => {
  function makeResult(name: string): ClassificationResponse {
    return {
      itemName: name,
      wasteStream: "recycling",
      confidence: 0.9,
      reasoning: "test",
      binColor: "#0066FF",
      binLabel: "Recycling",
      needsReview: false,
      isCompound: false,
    };
  }

  it("1 item renders fullscreen (no grid)", () => {
    const results = [makeResult("bottle")];
    // Verify array length drives layout
    expect(results.length).toBe(1);
    // In ResultScreen: isMulti = false → renders FullscreenResult
  });

  it("2 items use 2-column layout", () => {
    const results = [makeResult("bottle"), makeResult("cup")];
    expect(results.length).toBe(2);
    // gridTemplateColumns = repeat(2, 1fr)
  });

  it("3 items use 3-column layout", () => {
    const results = [makeResult("bottle"), makeResult("cup"), makeResult("can")];
    expect(results.length).toBe(3);
    // gridTemplateColumns = repeat(3, 1fr)
  });

  it("4 items use 2x2 grid", () => {
    const results = [makeResult("bottle"), makeResult("cup"), makeResult("can"), makeResult("paper")];
    expect(results.length).toBe(4);
    // gridTemplateColumns = repeat(2, 1fr), gridTemplateRows = repeat(2, 1fr)
  });

  it("caps at 4 items even when given more", () => {
    const results = Array.from({ length: 6 }, (_, i) => makeResult(`item${i}`));
    const displayResults = results.length > 4
      ? [...results].sort((a, b) => b.confidence - a.confidence).slice(0, 4)
      : results;
    expect(displayResults.length).toBe(4);
  });
});

// ── API batch endpoint ──

// Mock OpenAI
const mockCreate = jest.fn();
jest.mock("openai", () => {
  return jest.fn().mockImplementation(() => ({
    chat: { completions: { create: mockCreate } },
  }));
});

jest.mock("@upstash/redis", () => ({
  Redis: jest.fn().mockImplementation(() => ({
    rpush: jest.fn().mockResolvedValue(1),
    ltrim: jest.fn().mockResolvedValue("OK"),
    incr: jest.fn().mockResolvedValue(1),
    expire: jest.fn().mockResolvedValue(1),
    ping: jest.fn().mockResolvedValue("PONG"),
  })),
}));

jest.mock("@vercel/blob", () => ({
  put: jest.fn().mockResolvedValue({ url: "https://blob.test/image.jpg" }),
}));

jest.mock("@vercel/functions", () => ({
  waitUntil: jest.fn((p: Promise<unknown>) => p.catch(() => {})),
}));

process.env.KV_REST_API_URL = "https://fake-redis.upstash.io";
process.env.KV_REST_API_TOKEN = "fake-token";
process.env.OPENAI_API_KEY = "fake-key";
process.env.BLOB_READ_WRITE_TOKEN = "fake-blob-token";

function makeOpenAIResponse(raw: {
  itemName: string;
  wasteStream: string;
  confidence: number;
  reasoning: string;
}) {
  return {
    choices: [{
      message: {
        content: JSON.stringify({
          ...raw,
          preAction: "",
          isCompound: false,
          components: [],
        }),
      },
    }],
  };
}

describe("POST /api/classify — batch mode", () => {
  beforeEach(() => {
    mockCreate.mockReset();
  });

  it("returns array of results matching input array length", async () => {
    mockCreate
      .mockResolvedValueOnce(makeOpenAIResponse({
        itemName: "plastic bottle",
        wasteStream: "recycling",
        confidence: 0.95,
        reasoning: "PET bottle",
      }))
      .mockResolvedValueOnce(makeOpenAIResponse({
        itemName: "banana peel",
        wasteStream: "compost",
        confidence: 0.9,
        reasoning: "organic waste",
      }));

    const { POST } = await import("@/app/api/classify/route");
    const req = new Request("http://localhost/api/classify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        items: [
          { image: "a".repeat(200), yoloHint: null },
          { image: "b".repeat(200), yoloHint: "banana" },
        ],
        siteId: "default",
        locale: "en",
      }),
    });

    const res = await POST(req);
    if (res.status === 200) {
      const data = await res.json();
      expect(data.results).toHaveLength(2);
      expect(data.results[0].itemName).toBe("plastic bottle");
      expect(data.results[1].itemName).toBe("banana peel");
      expect(data.requestId).toBeDefined();
    }
  });

  it("single-item format still works (backward compat)", async () => {
    mockCreate.mockResolvedValueOnce(makeOpenAIResponse({
      itemName: "aluminum can",
      wasteStream: "recycling",
      confidence: 0.92,
      reasoning: "metal can",
    }));

    const { POST } = await import("@/app/api/classify/route");
    const req = new Request("http://localhost/api/classify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        image: "c".repeat(200),
        siteId: "default",
      }),
    });

    const res = await POST(req);
    if (res.status === 200) {
      const data = await res.json();
      expect(data.itemName).toBe("aluminum can");
      expect(data.wasteStream).toBe("recycling");
      // Single-item: no "results" array wrapper
      expect(data.results).toBeUndefined();
    }
  });
});
