/**
 * Phase 0 export endpoint — build the local-VLM benchmark eval set from real
 * pilot data + human review verdicts and return it as JSON.
 *
 * Reuses the same sources as /api/cron/export-finetuning:
 *   - Redis list  `recycling:pilot-log`        (KEYS.pilotLog)
 *   - Redis hash  `recycling:review-verdicts`  (requestId → "correct"|"wrong")
 *
 * Auth: in-route CRON_SECRET bearer (same pattern as the cron export routes).
 * This path is NOT in the middleware matcher, so the in-route check is the gate.
 *
 * Query params:
 *   - all=1   → include non-escalated reviewed entries too (default: t2 only)
 *
 * Returns { summary, count, samples }. Image bytes are NOT fetched here — the
 * Phase 1 runner downloads each `imageUrl` when it runs a candidate VLM.
 */
import { NextResponse } from "next/server";
import { redis, KEYS } from "@/lib/redis";
import { parsePilotLogEntry } from "@/lib/pilot-log-schema";
import { selectEvalSamples, summarizeEvalSet } from "@/lib/benchmark/eval-set";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    console.error("[benchmark/eval-set] CRON_SECRET is not set — refusing to run.");
    return NextResponse.json({ error: "Server misconfiguration" }, { status: 500 });
  }
  if (request.headers.get("authorization") !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const escalatedOnly = new URL(request.url).searchParams.get("all") !== "1";

  try {
    const [pilotRaw, verdicts] = await Promise.all([
      redis.lrange(KEYS.pilotLog, 0, -1),
      redis.hgetall("recycling:review-verdicts") as Promise<Record<string, string> | null>,
    ]);

    if (!verdicts || Object.keys(verdicts).length === 0) {
      return NextResponse.json({ summary: null, count: 0, samples: [], reason: "no_verdicts" });
    }

    const entries = pilotRaw.map(parsePilotLogEntry);
    const samples = selectEvalSamples(entries, verdicts, { escalatedOnly });

    return NextResponse.json({
      summary: summarizeEvalSet(samples),
      count: samples.length,
      samples,
    });
  } catch (err) {
    console.error("[benchmark/eval-set] Failed:", err);
    return NextResponse.json({ error: "Export failed." }, { status: 500 });
  }
}
