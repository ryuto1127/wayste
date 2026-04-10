/**
 * Tests for app/api/review/export/analysis/route.ts
 */

// ── Mock Redis ──
const mockLrange = jest.fn();
const mockHgetall = jest.fn();

jest.mock("@upstash/redis", () => ({
  Redis: jest.fn().mockImplementation(() => ({
    lrange: mockLrange,
    hgetall: mockHgetall,
  })),
}));

process.env.KV_REST_API_URL = "https://fake-redis.upstash.io";
process.env.KV_REST_API_TOKEN = "fake-token";

import { GET } from "@/app/api/review/export/analysis/route";
import type { PilotLogEntry } from "@/lib/types";

function makeEntry(overrides: Partial<PilotLogEntry> = {}): PilotLogEntry {
  return {
    timestamp: "2026-04-05T10:00:00.000Z",
    modelUsed: "yolo-local",
    escalated: false,
    itemName: "plastic bottle",
    wasteStream: "recycling",
    confidence: 0.85,
    requiresVerification: false,
    latencyMs: 50,
    requestId: "abc12345",
    imageUrl: "https://blob.test/image.jpg",
    ...overrides,
  };
}

function makeRequest(params: Record<string, string> = {}): Request {
  const url = new URL("http://localhost/api/review/export/analysis");
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }
  return new Request(url.toString());
}

const pilotEntries: PilotLogEntry[] = [
  makeEntry({ requestId: "aaa11111", modelUsed: "yolo-local", confidence: 0.90, itemName: "plastic bottle", wasteStream: "recycling" }),
  makeEntry({ requestId: "bbb22222", modelUsed: "nano", confidence: 0.70, itemName: "coffee cup", wasteStream: "landfill", escalated: true }),
  makeEntry({ requestId: "ccc33333", modelUsed: "yolo-local", confidence: 0.45, itemName: "banana peel", wasteStream: "compost" }),
  makeEntry({ requestId: "ddd44444", modelUsed: "yolo-world", confidence: 0.55, itemName: "aluminum can", wasteStream: "recycling", timestamp: "2026-03-01T08:00:00.000Z" }),
  makeEntry({ requestId: "eee55555", modelUsed: "mini", confidence: 0.30, itemName: "styrofoam box", wasteStream: "landfill" }),
];

const verdicts: Record<string, string> = {
  aaa11111: "correct",
  bbb22222: "wrong",
  ccc33333: "correct",
  ddd44444: "false_detection",
  // eee55555 has no verdict (unreviewed)
};

beforeEach(() => {
  mockLrange.mockResolvedValue(pilotEntries.map((e) => JSON.stringify(e)));
  mockHgetall.mockResolvedValue(verdicts);
});

describe("GET /api/review/export/analysis", () => {
  it("returns all entries with summary when no filters", async () => {
    const res = await GET(makeRequest());
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.entries).toHaveLength(5);
    expect(data.summary.total).toBe(5);
    expect(data.summary.byVerdict).toEqual({
      correct: 2,
      wrong: 1,
      false_detection: 1,
      unreviewed: 1,
    });
  });

  it("filters by verdict", async () => {
    const res = await GET(makeRequest({ verdict: "wrong" }));
    const data = await res.json();

    expect(data.entries).toHaveLength(1);
    expect(data.entries[0].requestId).toBe("bbb22222");
  });

  it("filters by multiple verdicts", async () => {
    const res = await GET(makeRequest({ verdict: "correct,wrong" }));
    const data = await res.json();

    expect(data.entries).toHaveLength(3);
  });

  it("filters unreviewed entries", async () => {
    const res = await GET(makeRequest({ verdict: "unreviewed" }));
    const data = await res.json();

    expect(data.entries).toHaveLength(1);
    expect(data.entries[0].requestId).toBe("eee55555");
  });

  it("filters by model", async () => {
    const res = await GET(makeRequest({ model: "yolo-local" }));
    const data = await res.json();

    expect(data.entries).toHaveLength(2);
    expect(data.entries.every((e: { modelUsed: string }) => e.modelUsed === "yolo-local")).toBe(true);
  });

  it("filters by confidence range", async () => {
    const res = await GET(makeRequest({ confidence_min: "0.50", confidence_max: "0.80" }));
    const data = await res.json();

    expect(data.entries).toHaveLength(2);
    expect(data.entries.every((e: { confidence: number }) => e.confidence >= 0.50 && e.confidence <= 0.80)).toBe(true);
  });

  it("filters by date range", async () => {
    const res = await GET(makeRequest({ from: "2026-04-01", to: "2026-04-30" }));
    const data = await res.json();

    // ddd44444 is from March, should be excluded
    expect(data.entries).toHaveLength(4);
    expect(data.entries.find((e: { requestId: string }) => e.requestId === "ddd44444")).toBeUndefined();
  });

  it("filters by item name substring", async () => {
    const res = await GET(makeRequest({ item: "cup" }));
    const data = await res.json();

    expect(data.entries).toHaveLength(1);
    expect(data.entries[0].itemName).toBe("coffee cup");
  });

  it("filters by waste stream", async () => {
    const res = await GET(makeRequest({ stream: "recycling" }));
    const data = await res.json();

    expect(data.entries).toHaveLength(2);
  });

  it("filters by escalated", async () => {
    const res = await GET(makeRequest({ escalated: "true" }));
    const data = await res.json();

    expect(data.entries).toHaveLength(1);
    expect(data.entries[0].escalated).toBe(true);
  });

  it("combines multiple filters", async () => {
    const res = await GET(makeRequest({ verdict: "correct", model: "yolo-local" }));
    const data = await res.json();

    expect(data.entries).toHaveLength(2);
  });

  it("computes accuracy by model", async () => {
    const res = await GET(makeRequest());
    const data = await res.json();

    // yolo-local: 2 reviewed (aaa correct, ccc correct) → 1.0
    expect(data.summary.accuracyByModel["yolo-local"]).toBe(1.0);
    // nano: 1 reviewed (bbb wrong) → 0.0
    expect(data.summary.accuracyByModel["nano"]).toBe(0);
  });

  it("returns CSV format", async () => {
    const res = await GET(makeRequest({ format: "csv" }));

    expect(res.headers.get("Content-Type")).toContain("text/csv");
    expect(res.headers.get("Content-Disposition")).toContain("analysis-");

    const text = await res.text();
    const lines = text.split("\n");
    // header + 5 data rows
    expect(lines).toHaveLength(6);
    expect(lines[0]).toBe(
      "requestId,timestamp,modelUsed,itemName,wasteStream,confidence,verdict,escalated,latencyMs,overrideApplied,imageUrl,sharpnessScore,imageQuality"
    );
  });

  it("CSV escapes values with commas", async () => {
    mockLrange.mockResolvedValue([
      JSON.stringify(makeEntry({ requestId: "zzz99999", itemName: "cup, paper" })),
    ]);
    mockHgetall.mockResolvedValue({ zzz99999: "correct" });

    const res = await GET(makeRequest({ format: "csv" }));
    const text = await res.text();

    expect(text).toContain('"cup, paper"');
  });

  it("returns empty result when no entries match filters", async () => {
    const res = await GET(makeRequest({ model: "nonexistent" }));
    const data = await res.json();

    expect(data.entries).toHaveLength(0);
    expect(data.summary.total).toBe(0);
  });

  it("includes confidence bucket distribution", async () => {
    const res = await GET(makeRequest());
    const data = await res.json();

    expect(data.summary.confidenceBuckets).toBeDefined();
    // aaa11111 (0.90) → "0.9", bbb22222 (0.70) → "0.7"
    expect(data.summary.confidenceBuckets["0.9"]?.total).toBe(1);
    expect(data.summary.confidenceBuckets["0.7"]?.total).toBe(1);
  });

  it("echoes applied filters in response", async () => {
    const res = await GET(makeRequest({ verdict: "correct", confidence_min: "0.5" }));
    const data = await res.json();

    expect(data.filters.verdict).toEqual(["correct"]);
    expect(data.filters.confidenceRange).toEqual([0.5, 1]);
  });
});
