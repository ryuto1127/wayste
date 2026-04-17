/**
 * Step 5 — integration tests for the operations dashboard.
 *
 * What this file verifies (one suite per Success Criterion):
 *
 *   1. **3 data patterns × 4 periods**: empty / 1-day-only / 30-day-continuous
 *      pilot-log inputs each produce a non-throwing dashboard response that
 *      the page-level renderer (helpers + DashboardBody shape) can read.
 *
 *   2. **Period monotonicity**: for the same dataset,
 *      `today.X ≤ 7d.X ≤ 30d.X` holds for every count metric *and* for
 *      `gptCostUsd`, plus the same monotonic relation for the misclass top
 *      list (today's count for a given itemName ≤ 7d's ≤ 30d's).
 *
 *   3. **classify → pilot-log → dashboard reflection**: a single classify
 *      POST writes an entry containing the new `tokenUsage` field, and that
 *      entry shows up in the very next `today` aggregation.
 *
 * Why integration-level (not pure-function-only): Step 3 already exhaustively
 * tests `lib/dashboard-metrics.ts` in isolation. Step 5's job is to verify the
 * pipeline holds together end-to-end — schema → aggregation → API contract
 * the page consumes. We mock Redis and OpenAI but exercise the actual route
 * code path.
 */

// ── Mocks shared by all suites ─────────────────────────────────────────────

const mockLrange = jest.fn();
const mockHgetall = jest.fn();
const mockRpush = jest.fn().mockResolvedValue(1);
const mockLtrim = jest.fn().mockResolvedValue("OK");
const mockIncr = jest.fn().mockResolvedValue(1);
const mockExpire = jest.fn().mockResolvedValue(1);

jest.mock("@upstash/redis", () => ({
  Redis: jest.fn().mockImplementation(() => ({
    lrange: mockLrange,
    hgetall: mockHgetall,
    rpush: mockRpush,
    ltrim: mockLtrim,
    incr: mockIncr,
    expire: mockExpire,
    ping: jest.fn().mockResolvedValue("PONG"),
  })),
}));

// Mock OpenAI for the classify → dashboard E2E test
const mockCreate = jest.fn();
jest.mock("openai", () => {
  return jest.fn().mockImplementation(() => ({
    chat: {
      completions: {
        create: mockCreate,
      },
    },
  }));
});

jest.mock("@vercel/blob", () => ({
  put: jest.fn().mockResolvedValue({ url: "https://blob.test/image.jpg" }),
}));

jest.mock("@vercel/functions", () => ({
  waitUntil: jest.fn((p: Promise<unknown>) => p.catch(() => {})),
}));

jest.mock("@/lib/face-detect-server", () => ({
  serverFaceDetected: jest.fn().mockResolvedValue(false),
}));

// Capture every promise handed to runInBackground so we can drain them and
// assert on side-effects after the response was returned.
const bgPromises: Promise<unknown>[] = [];
jest.mock("@/lib/background-task", () => {
  const actual = jest.requireActual("@/lib/background-task");
  return {
    ...actual,
    runInBackground: (p: Promise<unknown>) => {
      bgPromises.push(p.catch(() => {}));
    },
  };
});

async function flushBackground(): Promise<void> {
  while (bgPromises.length > 0) {
    const pending = bgPromises.splice(0, bgPromises.length);
    await Promise.allSettled(pending);
  }
}

// Required env for both routes
process.env.KV_REST_API_URL = "https://fake-redis.upstash.io";
process.env.KV_REST_API_TOKEN = "fake-token";
process.env.OPENAI_API_KEY = "fake-key";
process.env.BLOB_READ_WRITE_TOKEN = "fake-blob-token";

// Imports must come after the mocks above
import {
  buildDashboardMetrics,
  SUPPORTED_PERIODS,
  type DashboardMetricsResponse,
  type Period,
} from "@/lib/dashboard-metrics";
import { parsePilotLogEntry } from "@/lib/pilot-log-schema";
import type { PilotLogEntry } from "@/lib/types";

// ── Test fixtures ──────────────────────────────────────────────────────────

/**
 * Anchor at JST 2026-04-16 15:00 (= 06:00 UTC). All synthesized timestamps
 * are derived from this anchor so the JST day buckets line up with the
 * dashboard's own day arithmetic.
 */
const NOW_MS = Date.parse("2026-04-16T06:00:00Z");
const TODAY_JST = "2026-04-16";

function jstDayMidnightUtc(jstDay: string): number {
  // JST is UTC+9; the midnight of a JST day is `Date.parse(...Z) - 9h`.
  return Date.parse(`${jstDay}T00:00:00Z`) - 9 * 60 * 60 * 1000;
}

/**
 * Pick a UTC timestamp that falls *inside* the given JST calendar day —
 * specifically JST 12:00 (noon). Avoids the 14:59/15:00 UTC boundary that
 * otherwise pushes entries into the next JST day.
 */
function utcAtJstNoon(jstDay: string): string {
  return new Date(jstDayMidnightUtc(jstDay) + 12 * 60 * 60 * 1000).toISOString();
}

function makeEntry(over: Partial<PilotLogEntry> = {}): PilotLogEntry {
  return {
    timestamp: utcAtJstNoon(TODAY_JST),
    modelUsed: "T1",
    escalated: false,
    itemName: "plastic bottle",
    wasteStream: "recyclable",
    confidence: 0.9,
    requiresVerification: false,
    latencyMs: 100,
    requestId: `rid-${Math.random().toString(36).slice(2, 10)}`,
    ...over,
  };
}

/**
 * IMPORTANT: requestIds for these tests must NOT end with `-<digits>`.
 * The dashboard treats `parent-<n>` as a Multi-mode 2nd-onward entry and
 * excludes it from cost aggregation (see `isMultiNonHead` in
 * `lib/dashboard-metrics.ts`). A `gpt-2026-04-16` requestId would naively
 * end with `-16` and silently drop from cost — `xid` suffix is plain alpha
 * to dodge the regex unambiguously.
 */
function safeRequestId(prefix: string, dayStr: string): string {
  return `${prefix}-${dayStr.replace(/-/g, "")}xid`;
}

/** Return one entry per JST day for the last `nDays` days inclusive of today. */
function seedNDaysOfEntries(nDays: number): PilotLogEntry[] {
  const out: PilotLogEntry[] = [];
  for (let back = 0; back < nDays; back++) {
    const dayMs = NOW_MS - back * 24 * 60 * 60 * 1000;
    const dayStr = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Tokyo",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(dayMs);
    // Each day gets two entries:
    //   - one T1 (counts toward yoloRuns + yoloInstant + detections)
    //   - one t2 with tokenUsage (counts toward gptFallback + gptCostUsd)
    // This way every metric is exercised on every day and we can check
    // monotonicity meaningfully across periods.
    out.push(
      makeEntry({
        timestamp: utcAtJstNoon(dayStr),
        modelUsed: "T1",
        requestId: safeRequestId("t1", dayStr),
        itemName: "yolo bottle",
        yoloDetections: [
          {
            classId: 1,
            className: "bottle",
            confidence: 0.92,
            bbox: [0, 0, 10, 10],
            bboxNorm: [0, 0, 0.1, 0.1],
          },
        ],
      }),
      makeEntry({
        timestamp: utcAtJstNoon(dayStr),
        modelUsed: "t2",
        requestId: safeRequestId("gpt", dayStr),
        itemName: "paper cup",
        tokenUsage: { promptTokens: 700, completionTokens: 200 },
      }),
    );
  }
  return out;
}

/** Wrap entries the way Upstash hands them back: JSON strings in a list. */
function asRedisList(entries: PilotLogEntry[]): string[] {
  return entries.map((e) => JSON.stringify(e));
}

// ── Suite 1: 3 data patterns × every period ────────────────────────────────

describe("dashboard renders for 3 data patterns × every period", () => {
  /**
   * For each pattern × each period, we drive the *pure* `buildDashboardMetrics`
   * (the same function the route layer uses) and then push the response
   * through the page-level helpers (`mapStatusToError`, `formatPercent`,
   * `formatUsd`, `formatUsdCell`, `formatDateLabel`) the same way the React
   * components do. If the response shape is wrong, those helpers will throw
   * or return a sentinel like "—" / "$0" — both observable here.
   */

  // We import the helpers lazily so the test file body isn't imported until
  // after env vars are set. This mirrors how the API route is constructed.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const helpers = require("@/lib/insights-helpers") as typeof import("@/lib/insights-helpers");

  function assertResponseIsRenderable(res: DashboardMetricsResponse, expectDays: number) {
    // Shape sanity — these are exactly the props the React components consume
    expect(res.range.timezone).toBe("Asia/Tokyo");
    expect(typeof res.range.startIso).toBe("string");
    expect(typeof res.range.endIso).toBe("string");
    expect(res.timeseries).toHaveLength(expectDays);
    expect(Array.isArray(res.topMisclassifications)).toBe(true);
    expect(res.topMisclassifications.length).toBeLessThanOrEqual(10);

    // Helpers should never throw on real values returned by the API
    for (const point of res.timeseries) {
      expect(helpers.formatDateLabel(point.date)).toBeTruthy();
      expect(helpers.formatUsdCell(point.gptCostUsd)).toBeTruthy();
      expect(typeof point.detections).toBe("number");
    }
    expect(helpers.formatUsd(res.funnel.gptCostUsd)).toBeTruthy();
    expect(helpers.formatPercent(res.funnel.yoloInstant, res.funnel.detections))
      .toBeTruthy();
    // The pricing block must be present so the funnel rate footnote can render
    expect(res.pricing.inputPricePerMUsd).toBeGreaterThan(0);
    expect(res.pricing.outputPricePerMUsd).toBeGreaterThan(0);
    expect(res.pricing.fallbackCostPerCallUsd).toBeGreaterThan(0);
  }

  const expectedDays: Record<Period, number> = {
    today: 1,
    yesterday: 1,
    "7d": 7,
    "30d": 30,
  };

  describe("Pattern A — pilot-log completely empty + verdicts empty", () => {
    it.each(SUPPORTED_PERIODS)("renders an all-zero dashboard for `%s`", (period) => {
      const res = buildDashboardMetrics(period, [], {}, NOW_MS);
      assertResponseIsRenderable(res, expectedDays[period]);
      expect(res.funnel).toEqual({
        detections: 0,
        yoloRuns: 0,
        yoloInstant: 0,
        gptFallback: 0,
        gptCostUsd: 0,
      });
      expect(res.topMisclassifications).toEqual([]);
      // Every datapoint zeroed — the chart can render an empty trend line.
      for (const point of res.timeseries) {
        expect(point.detections).toBe(0);
        expect(point.gptCostUsd).toBe(0);
      }
    });
  });

  describe("Pattern B — only one day of data (today only)", () => {
    // 4 entries on today: 1 T1 (yoloInstant), 2 t2 heads with tokenUsage
    // (real cost), and 1 multi-non-head (cost attributed to its head only).
    // Note: requestIds for the heads must NOT end with `-<digits>` because
    // the dashboard treats that as a Multi 2nd-onward marker. The "head-2"
    // / "head-2-1" pair below is the canonical Multi shape:
    //   - "headtwoxid" is a stand-alone head
    //   - "headtwoxid-1" is the matching non-head (excluded from cost)
    const todayEntries: PilotLogEntry[] = [
      makeEntry({
        modelUsed: "T1",
        requestId: "t1todayxid",
        itemName: "plastic bottle",
        yoloDetections: [
          { classId: 1, className: "bottle", confidence: 0.95, bbox: [0, 0, 10, 10], bboxNorm: [0, 0, 0.1, 0.1] },
        ],
      }),
      makeEntry({
        modelUsed: "t2",
        requestId: "gpttodayonexid",
        itemName: "coffee cup",
        tokenUsage: { promptTokens: 700, completionTokens: 200 },
      }),
      makeEntry({
        modelUsed: "t2",
        requestId: "headtwoxid",
        itemName: "Coffee Cup",
        tokenUsage: { promptTokens: 800, completionTokens: 250 },
      }),
      makeEntry({
        modelUsed: "t2",
        requestId: "headtwoxid-1",
        itemName: "spoon",
      }),
    ];
    const verdicts = {
      gpttodayonexid: "wrong",
      headtwoxid: "wrong",
    };

    it.each(SUPPORTED_PERIODS)("renders correctly for `%s`", (period) => {
      const res = buildDashboardMetrics(
        period,
        asRedisList(todayEntries),
        verdicts,
        NOW_MS,
      );
      assertResponseIsRenderable(res, expectedDays[period]);

      if (period === "today") {
        expect(res.funnel.detections).toBe(4);
        expect(res.funnel.yoloInstant).toBe(1);
        expect(res.funnel.gptFallback).toBe(3);
        // Cost = 2 head entries (real) + 0 for non-head; legacy fallback never used here
        expect(res.funnel.gptCostUsd).toBeGreaterThan(0);
        // After case-insensitive normalisation both "wrong" verdicts collapse
        expect(res.topMisclassifications).toEqual([
          { itemName: "coffee cup", count: 2 },
        ]);
        // Single-day series: one bucket, populated
        expect(res.timeseries).toHaveLength(1);
        expect(res.timeseries[0].detections).toBe(4);
      } else if (period === "yesterday") {
        // No entries dated yesterday → fully zero
        expect(res.funnel.detections).toBe(0);
        expect(res.topMisclassifications).toEqual([]);
      } else {
        // 7d / 30d window includes today, so totals should match today's
        expect(res.funnel.detections).toBe(4);
        expect(res.funnel.yoloInstant).toBe(1);
        expect(res.funnel.gptFallback).toBe(3);
        // Other days in the window must be zero-filled
        const totalNonZeroDays = res.timeseries.filter((p) => p.detections > 0).length;
        expect(totalNonZeroDays).toBe(1);
      }
    });
  });

  describe("Pattern C — 30 continuous days of data", () => {
    const continuousEntries = seedNDaysOfEntries(30);
    // Mark 5 of the GPT entries as wrong, all on different days with mixed names
    const verdicts: Record<string, string> = {};
    for (let back = 0; back < 5; back++) {
      const dayMs = NOW_MS - back * 24 * 60 * 60 * 1000;
      const dayStr = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Tokyo",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(dayMs);
      verdicts[safeRequestId("gpt", dayStr)] = "wrong";
    }

    it.each(SUPPORTED_PERIODS)("renders correctly for `%s`", (period) => {
      const res = buildDashboardMetrics(
        period,
        asRedisList(continuousEntries),
        verdicts,
        NOW_MS,
      );
      assertResponseIsRenderable(res, expectedDays[period]);

      const expectedTotalEntries: Record<Period, number> = {
        today: 2,
        yesterday: 2,
        "7d": 14,
        "30d": 60,
      };
      expect(res.funnel.detections).toBe(expectedTotalEntries[period]);
      // Each day has one T1 + one t2, so the ratios are exact
      expect(res.funnel.yoloInstant).toBe(expectedTotalEntries[period] / 2);
      expect(res.funnel.gptFallback).toBe(expectedTotalEntries[period] / 2);
      expect(res.funnel.yoloRuns).toBe(expectedTotalEntries[period] / 2);
      expect(res.funnel.gptCostUsd).toBeGreaterThan(0);

      // Time series must be contiguous — no gaps from the bucketing logic
      const dates = res.timeseries.map((p) => p.date);
      const uniqueDates = new Set(dates);
      expect(uniqueDates.size).toBe(dates.length);
      expect(dates).toEqual([...dates].sort()); // chronological order

      // Within the 7d / 30d window every day has data, so detections>0 for all
      if (period === "7d" || period === "30d") {
        for (const point of res.timeseries) {
          expect(point.detections).toBeGreaterThan(0);
        }
      }
    });
  });
});

// ── Suite 2: Period monotonicity (today ≤ 7d ≤ 30d) ────────────────────────

describe("metric monotonicity across periods (today ≤ 7d ≤ 30d)", () => {
  // Same dataset Pattern C uses: 30 days of T1 + t2 entries
  const entries = seedNDaysOfEntries(30);
  // Mark every other day's GPT entry as wrong so the misclass top list has
  // enough variation to verify monotonicity per item, not just in aggregate
  const verdicts: Record<string, string> = {};
  for (let back = 0; back < 30; back++) {
    if (back % 2 === 0) {
      const dayMs = NOW_MS - back * 24 * 60 * 60 * 1000;
      const dayStr = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Tokyo",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(dayMs);
      verdicts[safeRequestId("gpt", dayStr)] = "wrong";
    }
  }

  const raw = asRedisList(entries);

  const today = buildDashboardMetrics("today", raw, verdicts, NOW_MS);
  const week = buildDashboardMetrics("7d", raw, verdicts, NOW_MS);
  const month = buildDashboardMetrics("30d", raw, verdicts, NOW_MS);

  it("detections", () => {
    expect(today.funnel.detections).toBeLessThanOrEqual(week.funnel.detections);
    expect(week.funnel.detections).toBeLessThanOrEqual(month.funnel.detections);
  });

  it("yoloRuns", () => {
    expect(today.funnel.yoloRuns).toBeLessThanOrEqual(week.funnel.yoloRuns);
    expect(week.funnel.yoloRuns).toBeLessThanOrEqual(month.funnel.yoloRuns);
  });

  it("yoloInstant", () => {
    expect(today.funnel.yoloInstant).toBeLessThanOrEqual(week.funnel.yoloInstant);
    expect(week.funnel.yoloInstant).toBeLessThanOrEqual(month.funnel.yoloInstant);
  });

  it("gptFallback", () => {
    expect(today.funnel.gptFallback).toBeLessThanOrEqual(week.funnel.gptFallback);
    expect(week.funnel.gptFallback).toBeLessThanOrEqual(month.funnel.gptFallback);
  });

  it("gptCostUsd", () => {
    expect(today.funnel.gptCostUsd).toBeLessThanOrEqual(week.funnel.gptCostUsd);
    expect(week.funnel.gptCostUsd).toBeLessThanOrEqual(month.funnel.gptCostUsd);
  });

  it("misclass count per itemName", () => {
    // Build a per-item count for each period and assert today ≤ week ≤ month
    // for every itemName that appears in at least one of them.
    const allItems = new Set<string>([
      ...today.topMisclassifications.map((m) => m.itemName),
      ...week.topMisclassifications.map((m) => m.itemName),
      ...month.topMisclassifications.map((m) => m.itemName),
    ]);

    function countFor(res: DashboardMetricsResponse, name: string): number {
      return res.topMisclassifications.find((m) => m.itemName === name)?.count ?? 0;
    }

    // Sanity: there's at least one wrong-verdict item in the 30-day window
    expect(allItems.size).toBeGreaterThan(0);

    for (const item of allItems) {
      const t = countFor(today, item);
      const w = countFor(week, item);
      const m = countFor(month, item);
      expect(t).toBeLessThanOrEqual(w);
      expect(w).toBeLessThanOrEqual(m);
    }
  });

  it("misclass total count (sum across items)", () => {
    function sum(res: DashboardMetricsResponse): number {
      return res.topMisclassifications.reduce((a, m) => a + m.count, 0);
    }
    expect(sum(today)).toBeLessThanOrEqual(sum(week));
    expect(sum(week)).toBeLessThanOrEqual(sum(month));
  });

  it("timeseries lengths match the expected day counts", () => {
    // A small but important contract: the chart needs the right number of points
    expect(today.timeseries).toHaveLength(1);
    expect(week.timeseries).toHaveLength(7);
    expect(month.timeseries).toHaveLength(30);
  });
});

// ── Suite 3: classify → pilot-log → dashboard E2E reflection ───────────────

describe("classify → pilot-log → dashboard reflects the new entry", () => {
  beforeEach(() => {
    mockCreate.mockReset();
    mockLrange.mockReset();
    mockHgetall.mockReset();
    mockRpush.mockReset();
    mockLtrim.mockReset();
    mockRpush.mockResolvedValue(1);
    mockLtrim.mockResolvedValue("OK");
    bgPromises.length = 0;
  });

  it("a single classify call produces a pilot-log entry with tokenUsage that the dashboard 'today' bucket counts", async () => {
    // 1. Stub the OpenAI response with explicit token usage so we can verify
    //    the pricing math end-to-end.
    mockCreate.mockResolvedValueOnce({
      choices: [
        {
          message: {
            content: JSON.stringify({
              itemName: "plastic bottle",
              wasteStream: "recyclable",
              confidence: 0.9,
              reasoning: "PET",
              isCompound: false,
              components: [],
            }),
          },
        },
      ],
      usage: { prompt_tokens: 712, completion_tokens: 184 },
    });

    // 2. Run the actual classify route.
    const { POST } = await import("@/app/api/classify/route");
    const req = new Request("http://localhost/api/classify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        image: "x".repeat(200),
        siteId: "japan-office",
      }),
    });
    const res = await POST(req);
    expect(res.status).toBe(200);

    // 3. Drain background tasks so the pilot-log entry has been written.
    await flushBackground();

    // 4. Inspect what was actually pushed to Redis.
    expect(mockRpush).toHaveBeenCalled();
    const [redisKey, payload] = mockRpush.mock.calls[0] as [string, string];
    expect(redisKey).toBe("recycling:pilot-log");
    const parsed = parsePilotLogEntry(payload);
    if (!parsed) throw new Error("Could not parse pilot-log payload");
    // The new field exists with the values OpenAI returned
    expect(parsed.tokenUsage).toEqual({ promptTokens: 712, completionTokens: 184 });
    expect(parsed.modelUsed).toBe("t2");
    expect(parsed.requestId).toBeTruthy();

    // 5. Now feed that exact entry back to the dashboard "today" aggregation —
    //    just like /api/dashboard-metrics would, but with `nowMs` snapped to
    //    the entry's own timestamp so it lands on today no matter when the
    //    test actually runs.
    const entryMs = Date.parse(parsed.timestamp);
    const dash = buildDashboardMetrics("today", [payload], {}, entryMs);
    expect(dash.funnel.detections).toBe(1);
    expect(dash.funnel.gptFallback).toBe(1);
    // Cost is computed from the recorded tokenUsage (NOT the legacy fallback)
    const expectedCost =
      (712 * dash.pricing.inputPricePerMUsd
        + 184 * dash.pricing.outputPricePerMUsd)
      / 1_000_000;
    expect(dash.funnel.gptCostUsd).toBeCloseTo(expectedCost, 12);
    expect(dash.timeseries).toHaveLength(1);
    expect(dash.timeseries[0].detections).toBe(1);
  });

  it("dashboard route does not cache between calls, so a refresh sees fresh data", async () => {
    // First call: empty Redis → zero dashboard
    mockLrange.mockResolvedValueOnce([]);
    mockHgetall.mockResolvedValueOnce({});
    const { GET } = await import("@/app/api/dashboard-metrics/route");

    const r1 = await GET(
      new Request("http://localhost/api/dashboard-metrics?period=today"),
    );
    expect(r1.status).toBe(200);
    expect((await r1.json()).funnel.detections).toBe(0);

    // Second call: simulate that one new entry just landed.
    // Use the real "now" timestamp so the entry lands inside the route's
    // own JST "today" window (the route uses Date.now() for the anchor).
    const newEntry = makeEntry({
      timestamp: new Date().toISOString(),
      modelUsed: "t2",
      requestId: "freshxid",
      itemName: "freshly-classified-thing",
      tokenUsage: { promptTokens: 600, completionTokens: 200 },
    });
    mockLrange.mockResolvedValueOnce([JSON.stringify(newEntry)]);
    mockHgetall.mockResolvedValueOnce({});

    const r2 = await GET(
      new Request("http://localhost/api/dashboard-metrics?period=today"),
    );
    expect(r2.status).toBe(200);
    const body2 = await r2.json();
    // No HTTP-level caching — the second response reflects the new entry
    expect(body2.funnel.detections).toBeGreaterThanOrEqual(1);
    expect(body2.funnel.gptFallback).toBeGreaterThanOrEqual(1);
    expect(body2.funnel.gptCostUsd).toBeGreaterThan(0);
  });

  it("dashboard route is declared force-dynamic (no Next.js page-level cache)", async () => {
    // Source-level guard: if someone removes `dynamic = "force-dynamic"`, the
    // route would default to ISR/static and admins could see stale dashboards.
    const fs = await import("node:fs");
    const path = await import("node:path");
    const src = fs.readFileSync(
      path.join(process.cwd(), "app/api/dashboard-metrics/route.ts"),
      "utf8",
    );
    expect(src).toContain('export const dynamic = "force-dynamic"');
  });
});
