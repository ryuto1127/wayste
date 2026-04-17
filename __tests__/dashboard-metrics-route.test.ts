/**
 * Tests for app/api/dashboard-metrics/route.ts.
 *
 * Auth itself is enforced by `middleware.ts`, which runs in front of the
 * route handler. We assume the matcher covers the path (asserted in a
 * separate test below) and exercise the route as if auth has already
 * passed — i.e. the same trust boundary the real handler inherits.
 */

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

import type { PilotLogEntry } from "@/lib/types";

function makeEntry(over: Partial<PilotLogEntry> = {}): PilotLogEntry {
  return {
    timestamp: new Date().toISOString(),
    modelUsed: "T1",
    escalated: false,
    itemName: "plastic bottle",
    wasteStream: "recyclable",
    confidence: 0.9,
    requiresVerification: false,
    latencyMs: 50,
    requestId: "r1",
    ...over,
  };
}

function makeRequest(qs: string) {
  return new Request(`http://localhost/api/dashboard-metrics${qs}`);
}

describe("GET /api/dashboard-metrics", () => {
  beforeEach(() => {
    mockLrange.mockReset();
    mockHgetall.mockReset();
  });

  it("rejects requests with missing period (400)", async () => {
    const { GET } = await import("@/app/api/dashboard-metrics/route");
    const res = await GET(makeRequest(""));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("invalid_period");
  });

  it("rejects requests with invalid period (400)", async () => {
    const { GET } = await import("@/app/api/dashboard-metrics/route");
    const res = await GET(makeRequest("?period=quarter"));
    expect(res.status).toBe(400);
  });

  it.each(["today", "yesterday", "7d", "30d"] as const)(
    "accepts the supported period `%s` and returns the expected shape",
    async (period) => {
      mockLrange.mockResolvedValueOnce([]);
      mockHgetall.mockResolvedValueOnce({});
      const { GET } = await import("@/app/api/dashboard-metrics/route");
      const res = await GET(makeRequest(`?period=${period}`));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.period).toBe(period);
      expect(body.range.timezone).toBe("Asia/Tokyo");
      expect(body.funnel).toEqual({
        detections: 0,
        yoloRuns: 0,
        yoloInstant: 0,
        gptFallback: 0,
        gptCostUsd: 0,
      });
      expect(body.topMisclassifications).toEqual([]);
      expect(Array.isArray(body.timeseries)).toBe(true);
      expect(body.pricing.inputPricePerMUsd).toBeGreaterThan(0);
    },
  );

  it("returns a 200 with non-zero counts when data exists", async () => {
    mockLrange.mockResolvedValueOnce([
      JSON.stringify(
        makeEntry({
          timestamp: new Date().toISOString(),
          modelUsed: "t2",
          requestId: "abc",
          tokenUsage: { promptTokens: 700, completionTokens: 200 },
        }),
      ),
    ]);
    mockHgetall.mockResolvedValueOnce({ abc: "wrong" });
    const { GET } = await import("@/app/api/dashboard-metrics/route");
    const res = await GET(makeRequest("?period=today"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.funnel.detections).toBe(1);
    expect(body.funnel.gptFallback).toBe(1);
    expect(body.funnel.gptCostUsd).toBeGreaterThan(0);
    expect(body.topMisclassifications).toEqual([
      { itemName: "plastic bottle", count: 1 },
    ]);
  });

  it("treats null verdicts hash from Redis as empty (no error)", async () => {
    mockLrange.mockResolvedValueOnce([]);
    mockHgetall.mockResolvedValueOnce(null);
    const { GET } = await import("@/app/api/dashboard-metrics/route");
    const res = await GET(makeRequest("?period=today"));
    expect(res.status).toBe(200);
  });

  it("returns 500 when Redis throws", async () => {
    mockLrange.mockRejectedValueOnce(new Error("redis offline"));
    mockHgetall.mockResolvedValueOnce({});
    const errSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    const { GET } = await import("@/app/api/dashboard-metrics/route");
    const res = await GET(makeRequest("?period=today"));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("aggregation_failed");
    errSpy.mockRestore();
  });
});

describe("middleware coverage for /api/dashboard-metrics", () => {
  it("includes the path in the admin-protected list and matcher", async () => {
    // We import the source as a string rather than executing the middleware
    // (which needs a NextRequest). This is enough to assert the path is wired
    // into both the runtime check (`ADMIN_PATHS`) and the matcher config.
    const fs = await import("node:fs");
    const path = await import("node:path");
    const src = fs.readFileSync(
      path.join(process.cwd(), "middleware.ts"),
      "utf8",
    );
    expect(src).toContain('"/api/dashboard-metrics"');
    // It should appear in BOTH ADMIN_PATHS and the `matcher:` array. The
    // simplest assertion is that the literal occurs at least twice.
    const occurrences = src.split('"/api/dashboard-metrics"').length - 1;
    expect(occurrences).toBeGreaterThanOrEqual(2);
  });
});
