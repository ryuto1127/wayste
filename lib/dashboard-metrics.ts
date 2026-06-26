/**
 * Dashboard aggregation primitives — pure functions over pilot-log entries
 * and admin review verdicts.
 *
 * The API route in `app/api/dashboard-metrics/route.ts` is a thin wrapper that
 * (a) authenticates via the existing admin middleware, (b) reads Redis, and
 * (c) hands the raw data to these functions. Splitting the math out keeps the
 * route trivial to test through HTTP and lets the aggregation rules be
 * exercised directly without a Redis stub.
 *
 * ── Definitions (per STEP_1_DATA_MODEL.md) ──────────────────────────────────
 *
 *  - **detections** (検知数): pilot-log entries with `escalated !== true`.
 *  - **yoloRuns** (YOLO推論数): subset where YOLO ran (i.e. `yoloDetections`
 *      or `tierResults.tier1` is present).
 *  - **yoloInstant** (YOLO即決数): subset where `modelUsed === "T1"`.
 *  - **gptFallback** (GPTフォールバック数): subset where `modelUsed === "t2"`.
 *  - **gptCostUsd**: USD spent on OpenAI calls for the bucket. See
 *      `computeGptCostUsd()` for the multi-source cost path.
 *
 * ── Multi-mode 2nd-onward exclusion (Step 2 → Step 3 handoff) ──────────────
 *
 * Multi mode produces N pilot-log entries per single OpenAI call, with only
 * the head entry carrying `tokenUsage` (route.ts:660) — the rest deliberately
 * omit it to avoid double-counting. The non-head entries' `requestId` is
 * `${parent}-${i}` for i >= 1 (route.ts:652).
 *
 * Naive fallback ("no tokenUsage → use fallback") would charge the fallback
 * rate for every non-head entry, dramatically over-estimating cost. We use
 * the requestId suffix to recognise these and exclude them from BOTH the
 * actual and fallback cost paths. The head entry alone carries the real
 * usage for the entire multi call.
 *
 * Batch mode aggregates token usage into the single representative entry
 * already (route.ts:558), so no special handling is needed there.
 */

import { parsePilotLogEntry } from "./pilot-log-schema";
import {
  costFromTokenUsage,
  fallbackCostPerCall,
  resolveInputPricePerM,
  resolveOutputPricePerM,
} from "./openai-pricing";
import type { PilotLogEntry } from "./types";

// ────────────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────────────

export type Period = "today" | "yesterday" | "7d" | "30d";
export const SUPPORTED_PERIODS: readonly Period[] = ["today", "yesterday", "7d", "30d"] as const;

/** Inclusive UTC ISO string range covering the period (Asia/Tokyo day boundaries). */
export interface DateRange {
  /** Inclusive lower bound, UTC ms. */
  startMs: number;
  /** Exclusive upper bound, UTC ms. */
  endMs: number;
  /** Ordered list of JST day strings ("YYYY-MM-DD") covered by this range. */
  days: string[];
}

export interface MisclassificationItem {
  /** Normalised lower-cased item name used as the group key. */
  itemName: string;
  /** Number of `wrong` verdicts for this item in the period. */
  count: number;
}

export interface FunnelTotals {
  detections: number;
  yoloRuns: number;
  yoloInstant: number;
  gptFallback: number;
  gptCostUsd: number;
}

export interface TimeSeriesPoint extends FunnelTotals {
  /** JST day string ("YYYY-MM-DD"). */
  date: string;
}

/** Cloud-vs-local VLM comparison aggregate (pilot shadow mode). */
export interface ModelComparison {
  /** Entries that carried a `localModel` shadow prediction. */
  samples: number;
  /** Of those, how many the local model resolved (no error, non-empty stream). */
  resolved: number;
  /** Of resolved, how many agreed with the cloud model's stream. */
  agree: number;
  /** agree / resolved (0 when resolved is 0). */
  agreementRate: number;
  errors: number;
  /** Median local-model latency (ms) over resolved samples. */
  medianLatencyMs: number;
}

export interface DashboardMetricsResponse {
  period: Period;
  range: { startIso: string; endIso: string; timezone: "Asia/Tokyo" };
  funnel: FunnelTotals;
  topMisclassifications: MisclassificationItem[];
  timeseries: TimeSeriesPoint[];
  /** Cloud-vs-local comparison from pilot shadow mode (samples=0 when unused). */
  modelComparison: ModelComparison;
  /** Cost-calculation provenance — surfaced so the UI can describe the source. */
  pricing: {
    inputPricePerMUsd: number;
    outputPricePerMUsd: number;
    fallbackCostPerCallUsd: number;
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Date / timezone helpers (Asia/Tokyo)
// ────────────────────────────────────────────────────────────────────────────

const JST_TIMEZONE = "Asia/Tokyo";
/**
 * en-CA produces YYYY-MM-DD in any locale; combined with `timeZone: "Asia/Tokyo"`
 * we get the JST calendar day for any UTC instant. This avoids re-implementing
 * timezone arithmetic ourselves and works without intl polyfills.
 */
const jstDayFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: JST_TIMEZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** Convert a Date (or UTC ms) to its JST calendar day, e.g. "2026-04-16". */
export function toJstDay(date: Date | number): string {
  const d = typeof date === "number" ? new Date(date) : date;
  return jstDayFormatter.format(d);
}

/**
 * Return the UTC ms instant that corresponds to JST 00:00:00 on the given
 * JST calendar day. JST is fixed-offset UTC+9, so this is a simple subtraction.
 */
function jstDayStartUtcMs(jstDay: string): number {
  // Parse "YYYY-MM-DD" as if it were a UTC instant, then shift by -9h to land
  // on JST midnight (which equals UTC 15:00 of the previous day).
  const utcMidnight = Date.parse(`${jstDay}T00:00:00Z`);
  if (Number.isNaN(utcMidnight)) {
    throw new Error(`Invalid JST day: ${jstDay}`);
  }
  return utcMidnight - 9 * 60 * 60 * 1000;
}

/** Step a JST day string by N days (signed). */
function addJstDays(jstDay: string, deltaDays: number): string {
  const startMs = jstDayStartUtcMs(jstDay);
  return toJstDay(new Date(startMs + deltaDays * 24 * 60 * 60 * 1000));
}

/** Build the inclusive list of JST days from `start` to `end` (both inclusive). */
function enumerateJstDays(start: string, end: string): string[] {
  const out: string[] = [];
  let cursor = start;
  // Safety bound: 31 days is the largest period we serve. Cap at 366 to be
  // future-proof without risking infinite loops on malformed inputs.
  for (let i = 0; i < 366; i++) {
    out.push(cursor);
    if (cursor === end) return out;
    cursor = addJstDays(cursor, 1);
  }
  return out;
}

/**
 * Compute the date range for the given period, anchored at `nowMs`. Days are
 * JST calendar days. `endMs` is exclusive.
 *
 * - today: JST today 00:00 → now (we expose the next-day midnight as endMs so
 *   late-arriving entries are still bucketed correctly).
 * - yesterday: JST yesterday 00:00 → JST today 00:00.
 * - 7d / 30d: JST today − (N − 1) days 00:00 → tomorrow 00:00 (today inclusive,
 *   N days total).
 */
export function getDateRange(period: Period, nowMs: number = Date.now()): DateRange {
  const todayJst = toJstDay(nowMs);
  const tomorrowJstStartMs = jstDayStartUtcMs(addJstDays(todayJst, 1));
  const todayJstStartMs = jstDayStartUtcMs(todayJst);
  const yesterdayJst = addJstDays(todayJst, -1);
  const yesterdayJstStartMs = jstDayStartUtcMs(yesterdayJst);

  switch (period) {
    case "today":
      return {
        startMs: todayJstStartMs,
        endMs: tomorrowJstStartMs,
        days: [todayJst],
      };
    case "yesterday":
      return {
        startMs: yesterdayJstStartMs,
        endMs: todayJstStartMs,
        days: [yesterdayJst],
      };
    case "7d": {
      const start = addJstDays(todayJst, -6);
      return {
        startMs: jstDayStartUtcMs(start),
        endMs: tomorrowJstStartMs,
        days: enumerateJstDays(start, todayJst),
      };
    }
    case "30d": {
      const start = addJstDays(todayJst, -29);
      return {
        startMs: jstDayStartUtcMs(start),
        endMs: tomorrowJstStartMs,
        days: enumerateJstDays(start, todayJst),
      };
    }
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Pilot-log entry filters / classifiers
// ────────────────────────────────────────────────────────────────────────────

/**
 * Parse + filter pilot-log raw entries down to entries valid for aggregation:
 * - schema-valid PilotLogEntry
 * - timestamp parseable
 * - within [startMs, endMs)
 * - escalated !== true (sweep entries excluded — see STEP_1_DATA_MODEL.md §3)
 */
export function selectEntriesInRange(
  raw: readonly unknown[],
  startMs: number,
  endMs: number,
): PilotLogEntry[] {
  const out: PilotLogEntry[] = [];
  for (const item of raw) {
    const entry = parsePilotLogEntry(item);
    if (!entry) continue;
    if (entry.escalated === true) continue;
    const t = Date.parse(entry.timestamp);
    if (Number.isNaN(t)) continue;
    if (t < startMs || t >= endMs) continue;
    out.push(entry);
  }
  return out;
}

/**
 * `true` when the entry has YOLO output present in the log payload (regardless
 * of which tier ultimately decided the classification).
 */
function hasYoloRun(entry: PilotLogEntry): boolean {
  if (entry.yoloDetections && entry.yoloDetections.length > 0) return true;
  if (entry.tierResults?.tier1 && entry.tierResults.tier1.length > 0) return true;
  return false;
}

/**
 * Identifies the "secondary" entries Multi mode emits for the 2nd-onward item
 * of a single GPT call. The classify route uses `${parentId}-${index}` for
 * index >= 1 (see route.ts:652). Returns true iff the requestId ends with
 * `-` followed by one or more digits.
 *
 * We deliberately match a numeric suffix only — this keeps regular requestIds
 * (which are short alphanumeric tokens, see lib/request-id.ts) safe from
 * accidental classification.
 */
const MULTI_NON_HEAD_SUFFIX_RE = /-\d+$/;
export function isMultiNonHead(entry: PilotLogEntry): boolean {
  if (!entry.requestId) return false;
  return MULTI_NON_HEAD_SUFFIX_RE.test(entry.requestId);
}

// ────────────────────────────────────────────────────────────────────────────
// Funnel + cost
// ────────────────────────────────────────────────────────────────────────────

/**
 * Sum the per-bucket funnel from a list of entries already filtered to a
 * window. Cost handling is described at the top of this file.
 */
export function computeFunnelTotals(entries: readonly PilotLogEntry[]): FunnelTotals {
  let detections = 0;
  let yoloRuns = 0;
  let yoloInstant = 0;
  let gptFallback = 0;

  for (const entry of entries) {
    detections++;
    if (hasYoloRun(entry)) yoloRuns++;
    if (entry.modelUsed === "T1") yoloInstant++;
    if (entry.modelUsed === "t2") gptFallback++;
  }

  const gptCostUsd = computeGptCostUsd(entries);

  return { detections, yoloRuns, yoloInstant, gptFallback, gptCostUsd };
}

/**
 * Sum USD cost across GPT-route entries. Multi-mode 2nd-onward entries are
 * skipped entirely (see top-of-file note). Entries with `tokenUsage` use the
 * actual rate; entries without (legacy logs) charge the fallback per-call.
 */
export function computeGptCostUsd(
  entries: readonly PilotLogEntry[],
  inputPricePerM: number = resolveInputPricePerM(),
  outputPricePerM: number = resolveOutputPricePerM(),
): number {
  const fallback = fallbackCostPerCall(inputPricePerM, outputPricePerM);
  let total = 0;
  for (const entry of entries) {
    if (entry.modelUsed !== "t2") continue;
    if (isMultiNonHead(entry)) continue;
    if (entry.tokenUsage) {
      total += costFromTokenUsage(
        entry.tokenUsage.promptTokens,
        entry.tokenUsage.completionTokens,
        inputPricePerM,
        outputPricePerM,
      );
    } else {
      total += fallback;
    }
  }
  return total;
}

// ────────────────────────────────────────────────────────────────────────────
// Top misclassifications
// ────────────────────────────────────────────────────────────────────────────

/**
 * Aggregate the top N misclassified items in the window. The population is
 * pilot-log entries where the corresponding admin review verdict is "wrong".
 *
 * Item-name normalisation (per STEP_1_DATA_MODEL.md §3) is `.trim().toLowerCase()`.
 * Entries with empty/whitespace itemNames after normalisation are dropped (we
 * cannot meaningfully bucket them).
 */
export function computeTopMisclassifications(
  entries: readonly PilotLogEntry[],
  verdicts: Readonly<Record<string, string>>,
  topN = 10,
): MisclassificationItem[] {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    if (!entry.requestId) continue;
    const verdict = verdicts[entry.requestId];
    if (verdict !== "wrong") continue;
    const key = entry.itemName.trim().toLowerCase();
    if (!key) continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([itemName, count]) => ({ itemName, count }))
    .sort((a, b) => b.count - a.count || a.itemName.localeCompare(b.itemName))
    .slice(0, topN);
}

// ────────────────────────────────────────────────────────────────────────────
// Time series (per JST day)
// ────────────────────────────────────────────────────────────────────────────

/**
 * Return a per-day funnel for every JST day in the supplied list. Days with
 * no entries return zeroed totals so the UI gets a complete, contiguous
 * series without having to fill gaps client-side.
 */
export function computeTimeSeries(
  entries: readonly PilotLogEntry[],
  jstDays: readonly string[],
): TimeSeriesPoint[] {
  const buckets = new Map<string, PilotLogEntry[]>();
  for (const day of jstDays) buckets.set(day, []);
  for (const entry of entries) {
    const day = toJstDay(Date.parse(entry.timestamp));
    const bucket = buckets.get(day);
    if (bucket) bucket.push(entry);
  }
  return jstDays.map((day) => ({
    date: day,
    ...computeFunnelTotals(buckets.get(day) ?? []),
  }));
}

/**
 * Aggregate the cloud-vs-local shadow comparison over the given entries.
 * Pure. Returns all-zero when no entry carries a `localModel` (shadow disabled).
 */
export function computeModelComparison(entries: readonly PilotLogEntry[]): ModelComparison {
  const withLocal = entries.filter((e) => e.localModel);
  const resolved = withLocal.filter((e) => e.localModel!.wasteStream && !e.localModel!.error);
  const agree = resolved.filter((e) => e.localModel!.agreesWithCloud).length;
  const errors = withLocal.filter((e) => !!e.localModel!.error).length;
  const latencies = resolved.map((e) => e.localModel!.latencyMs).sort((a, b) => a - b);
  const medianLatencyMs = latencies.length ? latencies[Math.floor((latencies.length - 1) / 2)] : 0;
  return {
    samples: withLocal.length,
    resolved: resolved.length,
    agree,
    agreementRate: resolved.length ? agree / resolved.length : 0,
    errors,
    medianLatencyMs,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Top-level: assemble the API response
// ────────────────────────────────────────────────────────────────────────────

/**
 * Assemble the full dashboard response from raw Redis payloads. Pure function
 * — no Redis or HTTP calls. The route layer is responsible for fetching.
 */
export function buildDashboardMetrics(
  period: Period,
  rawPilotLog: readonly unknown[],
  verdicts: Readonly<Record<string, string>>,
  nowMs: number = Date.now(),
): DashboardMetricsResponse {
  const range = getDateRange(period, nowMs);
  const entries = selectEntriesInRange(rawPilotLog, range.startMs, range.endMs);

  const funnel = computeFunnelTotals(entries);
  const topMisclassifications = computeTopMisclassifications(entries, verdicts);
  const timeseries = computeTimeSeries(entries, range.days);
  const modelComparison = computeModelComparison(entries);

  const inputPricePerMUsd = resolveInputPricePerM();
  const outputPricePerMUsd = resolveOutputPricePerM();

  return {
    period,
    range: {
      startIso: new Date(range.startMs).toISOString(),
      endIso: new Date(range.endMs).toISOString(),
      timezone: JST_TIMEZONE,
    },
    funnel,
    topMisclassifications,
    timeseries,
    modelComparison,
    pricing: {
      inputPricePerMUsd,
      outputPricePerMUsd,
      fallbackCostPerCallUsd: fallbackCostPerCall(inputPricePerMUsd, outputPricePerMUsd),
    },
  };
}

/** Type guard for the period query param. */
export function isPeriod(value: unknown): value is Period {
  return typeof value === "string" && (SUPPORTED_PERIODS as readonly string[]).includes(value);
}
