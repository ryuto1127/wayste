/**
 * GET /api/dashboard-metrics?period=today|yesterday|7d|30d
 *
 * Admin-only aggregation endpoint backing the operations dashboard.
 * Returns the three views the dashboard needs:
 *   1. Pipeline funnel totals (5 metrics) for the period.
 *   2. Top misclassified items (up to 10) by admin "wrong" verdict.
 *   3. Per-day time series for the same 5 metrics (Asia/Tokyo day buckets).
 *
 * Auth: gated by the admin middleware (HTTP Basic → 4h session cookie). This
 * route does not perform its own auth check — the matcher in `middleware.ts`
 * is updated to cover this path.
 *
 * Computation: all aggregation runs server-side; the response is already
 * shaped for the dashboard UI. We never return raw pilot-log entries — only
 * the rolled-up numbers — to keep payload size bounded (~30 days × small
 * objects ≈ < 5 KB).
 *
 * Errors:
 *   - Invalid `period` → 400.
 *   - Redis read failure → 500 (logged).
 *   - Empty period → 200 with zeroed totals + empty arrays (NOT 404), so the
 *     client can render an "no data" state without special-casing errors.
 */

import { NextResponse } from "next/server";
import { redis, KEYS } from "@/lib/redis";
import {
  buildDashboardMetrics,
  isPeriod,
  SUPPORTED_PERIODS,
} from "@/lib/dashboard-metrics";

const VERDICTS_KEY = "recycling:review-verdicts";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const periodParam = url.searchParams.get("period");

  if (!isPeriod(periodParam)) {
    return NextResponse.json(
      {
        error: "invalid_period",
        message: `period must be one of ${SUPPORTED_PERIODS.join(", ")}`,
      },
      { status: 400 },
    );
  }

  try {
    const [rawPilotLog, verdicts] = await Promise.all([
      redis.lrange(KEYS.pilotLog, 0, -1),
      redis.hgetall(VERDICTS_KEY) as Promise<Record<string, string> | null>,
    ]);

    const response = buildDashboardMetrics(
      periodParam,
      rawPilotLog,
      verdicts ?? {},
    );
    return NextResponse.json(response);
  } catch (err) {
    console.error("[dashboard-metrics] aggregation failed:", err);
    return NextResponse.json(
      { error: "aggregation_failed" },
      { status: 500 },
    );
  }
}
