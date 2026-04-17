/**
 * Tests for lib/dashboard-metrics.ts — pure aggregation functions covering:
 *   - Asia/Tokyo date-range computation for each supported period.
 *   - Range filtering: timestamps, escalated exclusion, schema rejection.
 *   - Funnel totals: detections / yoloRuns / yoloInstant / gptFallback.
 *   - GPT cost: actual (tokenUsage) + fallback (legacy entries) hybrid,
 *     with multi-mode 2nd-onward exclusion.
 *   - Top misclassifications: verdict join, normalisation, ordering, top-N.
 *   - Time series: per-day buckets, gap-filling for empty days.
 *   - Empty data: returns zeroed totals + empty arrays, not an error.
 */

import {
  buildDashboardMetrics,
  computeFunnelTotals,
  computeGptCostUsd,
  computeTimeSeries,
  computeTopMisclassifications,
  getDateRange,
  isMultiNonHead,
  isPeriod,
  selectEntriesInRange,
  toJstDay,
} from "@/lib/dashboard-metrics";
import {
  FALLBACK_COMPLETION_TOKENS,
  FALLBACK_PROMPT_TOKENS,
  OPENAI_INPUT_PRICE_PER_M_USD_DEFAULT,
  OPENAI_OUTPUT_PRICE_PER_M_USD_DEFAULT,
} from "@/lib/openai-pricing";
import type { PilotLogEntry } from "@/lib/types";

// ── Helpers ────────────────────────────────────────────────────────────────

function makeEntry(over: Partial<PilotLogEntry> = {}): PilotLogEntry {
  return {
    timestamp: "2026-04-15T03:00:00.000Z",
    modelUsed: "T1",
    escalated: false,
    itemName: "plastic bottle",
    wasteStream: "recyclable",
    confidence: 0.9,
    requiresVerification: false,
    latencyMs: 100,
    requestId: "req-base",
    ...over,
  };
}

/** Cost of one fallback (legacy) GPT call at default rates. */
const FALLBACK_DEFAULT =
  (FALLBACK_PROMPT_TOKENS * OPENAI_INPUT_PRICE_PER_M_USD_DEFAULT
    + FALLBACK_COMPLETION_TOKENS * OPENAI_OUTPUT_PRICE_PER_M_USD_DEFAULT)
  / 1_000_000;

// ── isPeriod ───────────────────────────────────────────────────────────────

describe("isPeriod", () => {
  it("accepts the four supported values", () => {
    expect(isPeriod("today")).toBe(true);
    expect(isPeriod("yesterday")).toBe(true);
    expect(isPeriod("7d")).toBe(true);
    expect(isPeriod("30d")).toBe(true);
  });

  it("rejects everything else", () => {
    expect(isPeriod(null)).toBe(false);
    expect(isPeriod(undefined)).toBe(false);
    expect(isPeriod("")).toBe(false);
    expect(isPeriod("week")).toBe(false);
    expect(isPeriod("90d")).toBe(false);
    expect(isPeriod(7)).toBe(false);
  });
});

// ── toJstDay ───────────────────────────────────────────────────────────────

describe("toJstDay", () => {
  it("returns the JST calendar day for a UTC instant", () => {
    // 2026-04-15 14:00 UTC = 2026-04-15 23:00 JST
    expect(toJstDay(Date.parse("2026-04-15T14:00:00Z"))).toBe("2026-04-15");
    // 2026-04-15 15:00 UTC = 2026-04-16 00:00 JST → next day
    expect(toJstDay(Date.parse("2026-04-15T15:00:00Z"))).toBe("2026-04-16");
    // 2026-04-15 23:59 UTC = 2026-04-16 08:59 JST → next day
    expect(toJstDay(Date.parse("2026-04-15T23:59:00Z"))).toBe("2026-04-16");
  });
});

// ── getDateRange ───────────────────────────────────────────────────────────

describe("getDateRange", () => {
  // Anchor: 2026-04-16 06:00 UTC = 2026-04-16 15:00 JST. Today's JST day is 2026-04-16.
  const NOW = Date.parse("2026-04-16T06:00:00Z");

  it("today: covers JST 2026-04-16 00:00 → 04-17 00:00", () => {
    const r = getDateRange("today", NOW);
    expect(r.days).toEqual(["2026-04-16"]);
    // JST 04-16 00:00 = UTC 04-15 15:00
    expect(new Date(r.startMs).toISOString()).toBe("2026-04-15T15:00:00.000Z");
    expect(new Date(r.endMs).toISOString()).toBe("2026-04-16T15:00:00.000Z");
  });

  it("yesterday: covers JST 2026-04-15 00:00 → 04-16 00:00", () => {
    const r = getDateRange("yesterday", NOW);
    expect(r.days).toEqual(["2026-04-15"]);
    expect(new Date(r.startMs).toISOString()).toBe("2026-04-14T15:00:00.000Z");
    expect(new Date(r.endMs).toISOString()).toBe("2026-04-15T15:00:00.000Z");
  });

  it("7d: produces 7 contiguous JST days inclusive of today", () => {
    const r = getDateRange("7d", NOW);
    expect(r.days).toHaveLength(7);
    expect(r.days[0]).toBe("2026-04-10");
    expect(r.days[6]).toBe("2026-04-16");
    expect(new Date(r.startMs).toISOString()).toBe("2026-04-09T15:00:00.000Z");
    expect(new Date(r.endMs).toISOString()).toBe("2026-04-16T15:00:00.000Z");
  });

  it("30d: produces 30 contiguous JST days inclusive of today", () => {
    const r = getDateRange("30d", NOW);
    expect(r.days).toHaveLength(30);
    expect(r.days[0]).toBe("2026-03-18");
    expect(r.days[29]).toBe("2026-04-16");
  });

  it("handles month boundaries safely (today = JST first of month)", () => {
    // 2026-05-01 00:00 JST = 2026-04-30 15:00 UTC
    const NOW2 = Date.parse("2026-04-30T16:00:00Z"); // 2026-05-01 01:00 JST
    const r = getDateRange("7d", NOW2);
    expect(r.days[0]).toBe("2026-04-25");
    expect(r.days[6]).toBe("2026-05-01");
  });
});

// ── selectEntriesInRange ───────────────────────────────────────────────────

describe("selectEntriesInRange", () => {
  const start = Date.parse("2026-04-15T15:00:00Z"); // JST 04-16 00:00
  const end = Date.parse("2026-04-16T15:00:00Z"); // JST 04-17 00:00

  it("includes entries with timestamps within [start, end)", () => {
    const e = makeEntry({ timestamp: "2026-04-16T03:00:00Z" });
    const out = selectEntriesInRange([JSON.stringify(e)], start, end);
    expect(out).toHaveLength(1);
  });

  it("rejects entries outside the range", () => {
    const before = makeEntry({ timestamp: "2026-04-14T03:00:00Z" });
    const after = makeEntry({ timestamp: "2026-04-17T03:00:00Z" });
    const out = selectEntriesInRange(
      [JSON.stringify(before), JSON.stringify(after)],
      start,
      end,
    );
    expect(out).toHaveLength(0);
  });

  it("treats the upper bound as exclusive", () => {
    // Exactly endMs → excluded
    const exact = makeEntry({ timestamp: new Date(end).toISOString() });
    expect(selectEntriesInRange([JSON.stringify(exact)], start, end)).toHaveLength(0);
    // 1 ms before endMs → included
    const justBefore = makeEntry({ timestamp: new Date(end - 1).toISOString() });
    expect(selectEntriesInRange([JSON.stringify(justBefore)], start, end)).toHaveLength(1);
  });

  it("excludes escalated sweep entries (per STEP_1_DATA_MODEL.md §3)", () => {
    const escalated = makeEntry({
      timestamp: "2026-04-16T03:00:00Z",
      escalated: true,
    });
    const out = selectEntriesInRange([JSON.stringify(escalated)], start, end);
    expect(out).toHaveLength(0);
  });

  it("drops malformed / unparseable / undated entries silently", () => {
    const out = selectEntriesInRange(
      [
        "not-json",
        JSON.stringify({ totally: "wrong" }),
        JSON.stringify(makeEntry({ timestamp: "garbage" })),
        null,
        undefined,
      ],
      start,
      end,
    );
    expect(out).toHaveLength(0);
  });

  it("accepts entries that were already deserialised by the Redis client", () => {
    const e = makeEntry({ timestamp: "2026-04-16T03:00:00Z" });
    // Upstash sometimes returns parsed objects rather than strings
    const out = selectEntriesInRange([e], start, end);
    expect(out).toHaveLength(1);
  });
});

// ── isMultiNonHead ─────────────────────────────────────────────────────────

describe("isMultiNonHead", () => {
  it("matches `${parent}-${i}` for i >= 1", () => {
    expect(isMultiNonHead(makeEntry({ requestId: "abc123-1" }))).toBe(true);
    expect(isMultiNonHead(makeEntry({ requestId: "abc123-9" }))).toBe(true);
    expect(isMultiNonHead(makeEntry({ requestId: "abc123-15" }))).toBe(true);
  });

  it("does not match the head requestId or normal IDs", () => {
    expect(isMultiNonHead(makeEntry({ requestId: "abc123" }))).toBe(false);
    expect(isMultiNonHead(makeEntry({ requestId: "req_abc" }))).toBe(false);
  });

  it("does not match when requestId is missing", () => {
    expect(isMultiNonHead(makeEntry({ requestId: undefined }))).toBe(false);
  });
});

// ── computeFunnelTotals + computeGptCostUsd ────────────────────────────────

describe("computeFunnelTotals", () => {
  it("counts detections / yoloRuns / yoloInstant / gptFallback correctly", () => {
    const entries: PilotLogEntry[] = [
      // T1 with YOLO detections → counted in detections, yoloRuns, yoloInstant
      makeEntry({
        modelUsed: "T1",
        yoloDetections: [
          { classId: 1, className: "bottle", confidence: 0.9, bbox: [0, 0, 10, 10], bboxNorm: [0, 0, 0.1, 0.1] },
        ],
      }),
      // t2 with tier1 results (YOLO ran but escalated to GPT) → detections, yoloRuns, gptFallback
      makeEntry({
        modelUsed: "t2",
        requestId: "abc-only-head",
        tierResults: { tier1: [{ itemName: "cup", confidence: 0.6 }] },
      }),
      // t2 with no YOLO output (offline / failed init) → detections, gptFallback
      makeEntry({ modelUsed: "t2", requestId: "x-only" }),
    ];
    const totals = computeFunnelTotals(entries);
    expect(totals.detections).toBe(3);
    expect(totals.yoloRuns).toBe(2);
    expect(totals.yoloInstant).toBe(1);
    expect(totals.gptFallback).toBe(2);
    expect(totals.gptCostUsd).toBeGreaterThan(0);
  });

  it("returns zeroed totals for empty input", () => {
    expect(computeFunnelTotals([])).toEqual({
      detections: 0,
      yoloRuns: 0,
      yoloInstant: 0,
      gptFallback: 0,
      gptCostUsd: 0,
    });
  });
});

describe("computeGptCostUsd", () => {
  it("uses tokenUsage when present", () => {
    const entries: PilotLogEntry[] = [
      makeEntry({
        modelUsed: "t2",
        requestId: "abc12345",
        tokenUsage: { promptTokens: 1_000_000, completionTokens: 0 },
      }),
    ];
    // 1M input @ $0.25/M = $0.25
    expect(computeGptCostUsd(entries, 0.25, 2.0)).toBeCloseTo(0.25, 10);
  });

  it("uses the fallback rate for legacy t2 entries without tokenUsage", () => {
    const entries: PilotLogEntry[] = [makeEntry({ modelUsed: "t2", requestId: "legacy" })];
    expect(computeGptCostUsd(entries)).toBeCloseTo(FALLBACK_DEFAULT, 12);
  });

  it("excludes T1 entries from cost entirely", () => {
    const entries: PilotLogEntry[] = [makeEntry({ modelUsed: "T1", requestId: "yolo" })];
    expect(computeGptCostUsd(entries)).toBe(0);
  });

  it("excludes Multi 2nd-onward entries from BOTH actual and fallback paths", () => {
    // One head entry (tokenUsage) + two non-head entries (no tokenUsage).
    // If we naively used fallback for the non-heads, total would balloon.
    const entries: PilotLogEntry[] = [
      makeEntry({
        modelUsed: "t2",
        requestId: "abc",
        tokenUsage: { promptTokens: 800, completionTokens: 300 },
      }),
      makeEntry({ modelUsed: "t2", requestId: "abc-1" }),
      makeEntry({ modelUsed: "t2", requestId: "abc-2" }),
    ];
    const expected = (800 * 0.25 + 300 * 2.0) / 1_000_000;
    expect(computeGptCostUsd(entries, 0.25, 2.0)).toBeCloseTo(expected, 12);
  });

  it("hybrid: actual + fallback for a mix of new + legacy entries", () => {
    const entries: PilotLogEntry[] = [
      // Actual (head of multi)
      makeEntry({
        modelUsed: "t2",
        requestId: "new-head",
        tokenUsage: { promptTokens: 600, completionTokens: 200 },
      }),
      // Legacy fallback
      makeEntry({ modelUsed: "t2", requestId: "legacy-a" }),
      makeEntry({ modelUsed: "t2", requestId: "legacy-b" }),
      // Multi non-head — must NOT be counted
      makeEntry({ modelUsed: "t2", requestId: "new-head-1" }),
    ];
    const actual = (600 * 0.25 + 200 * 2.0) / 1_000_000;
    const expected = actual + 2 * FALLBACK_DEFAULT;
    expect(computeGptCostUsd(entries)).toBeCloseTo(expected, 12);
  });

  it("never counts an entry with both tokenUsage and a multi-non-head requestId", () => {
    // Defence-in-depth: if some future code path produces both a tokenUsage
    // and a `-N` suffix (e.g. retry / sweep), prefer exclusion.
    const entries: PilotLogEntry[] = [
      makeEntry({
        modelUsed: "t2",
        requestId: "abc-1",
        tokenUsage: { promptTokens: 1_000_000, completionTokens: 1_000_000 },
      }),
    ];
    expect(computeGptCostUsd(entries)).toBe(0);
  });
});

// ── computeTopMisclassifications ───────────────────────────────────────────

describe("computeTopMisclassifications", () => {
  it("counts only entries whose verdict is `wrong`", () => {
    const entries: PilotLogEntry[] = [
      makeEntry({ requestId: "r1", itemName: "Plastic Bottle" }),
      makeEntry({ requestId: "r2", itemName: "paper cup" }),
      makeEntry({ requestId: "r3", itemName: "plastic bottle" }),
    ];
    const verdicts = { r1: "wrong", r2: "correct", r3: "wrong" };
    const out = computeTopMisclassifications(entries, verdicts);
    // r1 + r3 normalise to the same key
    expect(out).toEqual([{ itemName: "plastic bottle", count: 2 }]);
  });

  it("normalises with .trim().toLowerCase()", () => {
    const entries: PilotLogEntry[] = [
      makeEntry({ requestId: "r1", itemName: "  Coffee Cup  " }),
      makeEntry({ requestId: "r2", itemName: "coffee cup" }),
    ];
    const verdicts = { r1: "wrong", r2: "wrong" };
    expect(computeTopMisclassifications(entries, verdicts)).toEqual([
      { itemName: "coffee cup", count: 2 },
    ]);
  });

  it("orders by count descending then by itemName for stability", () => {
    const entries: PilotLogEntry[] = [
      makeEntry({ requestId: "a1", itemName: "alpha" }),
      makeEntry({ requestId: "a2", itemName: "alpha" }),
      makeEntry({ requestId: "b1", itemName: "bravo" }),
      makeEntry({ requestId: "b2", itemName: "bravo" }),
      makeEntry({ requestId: "c1", itemName: "charlie" }),
    ];
    const verdicts = { a1: "wrong", a2: "wrong", b1: "wrong", b2: "wrong", c1: "wrong" };
    expect(computeTopMisclassifications(entries, verdicts)).toEqual([
      { itemName: "alpha", count: 2 },
      { itemName: "bravo", count: 2 },
      { itemName: "charlie", count: 1 },
    ]);
  });

  it("returns at most topN items", () => {
    const entries: PilotLogEntry[] = Array.from({ length: 15 }, (_, i) =>
      makeEntry({ requestId: `r${i}`, itemName: `item-${String(i).padStart(2, "0")}` }),
    );
    const verdicts = Object.fromEntries(entries.map((e) => [e.requestId!, "wrong"]));
    const out = computeTopMisclassifications(entries, verdicts, 10);
    expect(out).toHaveLength(10);
  });

  it("ignores entries with empty / whitespace-only itemName after normalisation", () => {
    const entries: PilotLogEntry[] = [
      makeEntry({ requestId: "r1", itemName: "   " }),
      makeEntry({ requestId: "r2", itemName: "" }),
      makeEntry({ requestId: "r3", itemName: "valid" }),
    ];
    const verdicts = { r1: "wrong", r2: "wrong", r3: "wrong" };
    expect(computeTopMisclassifications(entries, verdicts)).toEqual([
      { itemName: "valid", count: 1 },
    ]);
  });

  it("returns [] when no verdicts are `wrong`", () => {
    const entries: PilotLogEntry[] = [makeEntry({ requestId: "r1" })];
    expect(computeTopMisclassifications(entries, { r1: "correct" })).toEqual([]);
    expect(computeTopMisclassifications(entries, {})).toEqual([]);
  });
});

// ── computeTimeSeries ──────────────────────────────────────────────────────

describe("computeTimeSeries", () => {
  it("buckets entries by JST day and zero-fills empty days", () => {
    const days = ["2026-04-14", "2026-04-15", "2026-04-16"];
    const entries: PilotLogEntry[] = [
      // 2026-04-15 03:00 UTC = 2026-04-15 12:00 JST
      makeEntry({ timestamp: "2026-04-15T03:00:00Z", modelUsed: "T1" }),
      // 2026-04-15 23:59 UTC = 2026-04-16 08:59 JST → bucketed under 04-16
      makeEntry({ timestamp: "2026-04-15T23:59:00Z", modelUsed: "t2", requestId: "x" }),
    ];
    const out = computeTimeSeries(entries, days);
    expect(out).toHaveLength(3);
    expect(out[0]).toEqual({
      date: "2026-04-14",
      detections: 0,
      yoloRuns: 0,
      yoloInstant: 0,
      gptFallback: 0,
      gptCostUsd: 0,
    });
    expect(out[1].date).toBe("2026-04-15");
    expect(out[1].detections).toBe(1);
    expect(out[1].yoloInstant).toBe(1);
    expect(out[2].date).toBe("2026-04-16");
    expect(out[2].detections).toBe(1);
    expect(out[2].gptFallback).toBe(1);
  });

  it("returns one zeroed point per day even if no entries match any day", () => {
    const days = ["2026-04-14", "2026-04-15"];
    const out = computeTimeSeries([], days);
    expect(out).toEqual([
      { date: "2026-04-14", detections: 0, yoloRuns: 0, yoloInstant: 0, gptFallback: 0, gptCostUsd: 0 },
      { date: "2026-04-15", detections: 0, yoloRuns: 0, yoloInstant: 0, gptFallback: 0, gptCostUsd: 0 },
    ]);
  });

  it("ignores entries falling on days outside the requested list", () => {
    const days = ["2026-04-15"];
    const entries: PilotLogEntry[] = [
      makeEntry({ timestamp: "2026-04-12T05:00:00Z" }),
    ];
    const out = computeTimeSeries(entries, days);
    expect(out[0].detections).toBe(0);
  });
});

// ── buildDashboardMetrics (end-to-end pure function) ───────────────────────

describe("buildDashboardMetrics", () => {
  // Anchor at 2026-04-16 06:00 UTC (= JST 15:00).
  const NOW = Date.parse("2026-04-16T06:00:00Z");

  it("returns a fully zeroed shape for empty data", () => {
    const out = buildDashboardMetrics("today", [], {}, NOW);
    expect(out.period).toBe("today");
    expect(out.range.timezone).toBe("Asia/Tokyo");
    expect(out.funnel).toEqual({
      detections: 0,
      yoloRuns: 0,
      yoloInstant: 0,
      gptFallback: 0,
      gptCostUsd: 0,
    });
    expect(out.topMisclassifications).toEqual([]);
    expect(out.timeseries).toHaveLength(1);
    expect(out.timeseries[0].date).toBe("2026-04-16");
    expect(out.pricing.inputPricePerMUsd).toBeGreaterThan(0);
    expect(out.pricing.outputPricePerMUsd).toBeGreaterThan(0);
    expect(out.pricing.fallbackCostPerCallUsd).toBeGreaterThan(0);
  });

  it("end-to-end aggregation hits the funnel + top + timeseries + cost paths", () => {
    const todayJst03Z = "2026-04-16T03:00:00Z"; // JST today 12:00
    const yesterdayJst03Z = "2026-04-15T03:00:00Z"; // JST yesterday 12:00
    const entries: PilotLogEntry[] = [
      makeEntry({
        timestamp: todayJst03Z,
        modelUsed: "T1",
        requestId: "today-yolo",
        itemName: "plastic bottle",
        yoloDetections: [
          { classId: 1, className: "bottle", confidence: 0.9, bbox: [0, 0, 10, 10], bboxNorm: [0, 0, 0.1, 0.1] },
        ],
      }),
      makeEntry({
        timestamp: todayJst03Z,
        modelUsed: "t2",
        requestId: "today-gpt-head",
        itemName: "paper cup",
        tokenUsage: { promptTokens: 700, completionTokens: 200 },
      }),
      // multi non-head — same call, no extra cost
      makeEntry({
        timestamp: todayJst03Z,
        modelUsed: "t2",
        requestId: "today-gpt-head-1",
        itemName: "spoon",
      }),
      // yesterday → not in 7d window? Yes it is (7d covers today + 6 prior days).
      makeEntry({
        timestamp: yesterdayJst03Z,
        modelUsed: "t2",
        requestId: "yest-gpt",
        itemName: "Plastic Bottle",
      }),
      // out of even 30d window
      makeEntry({
        timestamp: "2026-01-01T00:00:00Z",
        modelUsed: "t2",
        requestId: "ancient",
      }),
      // escalated sweep — never counted
      makeEntry({
        timestamp: todayJst03Z,
        modelUsed: "t2",
        requestId: "sweep",
        escalated: true,
      }),
    ];
    const verdicts: Record<string, string> = {
      "today-gpt-head": "wrong",
      "yest-gpt": "wrong",
      "today-yolo": "correct",
    };

    // ── period: today ──
    const today = buildDashboardMetrics(
      "today",
      entries.map((e) => JSON.stringify(e)),
      verdicts,
      NOW,
    );
    expect(today.funnel.detections).toBe(3); // T1 + 2 t2 (head + non-head); sweep excluded
    expect(today.funnel.yoloInstant).toBe(1);
    expect(today.funnel.gptFallback).toBe(2);
    expect(today.funnel.yoloRuns).toBe(1);
    // Cost = 1 head * actual; non-head excluded; legacy yest entry not in window.
    const expectedCost =
      (700 * OPENAI_INPUT_PRICE_PER_M_USD_DEFAULT
        + 200 * OPENAI_OUTPUT_PRICE_PER_M_USD_DEFAULT)
      / 1_000_000;
    expect(today.funnel.gptCostUsd).toBeCloseTo(expectedCost, 12);
    expect(today.topMisclassifications).toEqual([{ itemName: "paper cup", count: 1 }]);
    expect(today.timeseries).toHaveLength(1);
    expect(today.timeseries[0].date).toBe("2026-04-16");
    expect(today.timeseries[0].detections).toBe(3);

    // ── period: yesterday ──
    const yest = buildDashboardMetrics(
      "yesterday",
      entries.map((e) => JSON.stringify(e)),
      verdicts,
      NOW,
    );
    expect(yest.funnel.detections).toBe(1);
    expect(yest.funnel.gptFallback).toBe(1);
    // yest-gpt has no tokenUsage → fallback rate
    expect(yest.funnel.gptCostUsd).toBeCloseTo(FALLBACK_DEFAULT, 12);
    expect(yest.topMisclassifications).toEqual([{ itemName: "plastic bottle", count: 1 }]);

    // ── period: 7d ──
    const week = buildDashboardMetrics(
      "7d",
      entries.map((e) => JSON.stringify(e)),
      verdicts,
      NOW,
    );
    expect(week.timeseries).toHaveLength(7);
    expect(week.funnel.detections).toBe(4); // today's 3 + yesterday's 1
    expect(week.topMisclassifications).toEqual([
      // both wrongs normalise to "plastic bottle" (today's "paper cup" + yest's "Plastic Bottle"
      // → wait: today's wrong is "paper cup", yest is "plastic bottle"). Let's re-derive:
      // today-gpt-head → wrong → "paper cup"
      // yest-gpt → wrong → "plastic bottle"
      // count is 1 each, sorted alpha: paper cup, plastic bottle.
      { itemName: "paper cup", count: 1 },
      { itemName: "plastic bottle", count: 1 },
    ]);

    // ── period: 30d ──
    const month = buildDashboardMetrics(
      "30d",
      entries.map((e) => JSON.stringify(e)),
      verdicts,
      NOW,
    );
    expect(month.timeseries).toHaveLength(30);
    expect(month.funnel.detections).toBe(4); // ancient still excluded (out of 30d)
  });

  it("monotonicity: today.detections <= 7d.detections <= 30d.detections", () => {
    // Synthesise 35 days of data — one entry per JST day at noon.
    // requestIds avoid `-N` suffix because that would mark them as
    // multi-non-head (which has no effect here since modelUsed === "T1",
    // but keep the convention so any future cost path stays valid).
    const entries: PilotLogEntry[] = Array.from({ length: 35 }, (_, dayBack) => {
      const dayMs = NOW - dayBack * 24 * 60 * 60 * 1000;
      return makeEntry({
        timestamp: new Date(dayMs).toISOString(),
        requestId: `r${String(dayBack).padStart(3, "0")}x`,
      });
    });
    const raw = entries.map((e) => JSON.stringify(e));
    const today = buildDashboardMetrics("today", raw, {}, NOW).funnel.detections;
    const week = buildDashboardMetrics("7d", raw, {}, NOW).funnel.detections;
    const month = buildDashboardMetrics("30d", raw, {}, NOW).funnel.detections;
    expect(today).toBeLessThanOrEqual(week);
    expect(week).toBeLessThanOrEqual(month);
    expect(today).toBe(1);
    expect(week).toBe(7);
    expect(month).toBe(30);
  });
});
