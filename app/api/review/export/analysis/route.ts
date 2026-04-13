/**
 * GET /api/review/export/analysis — Export pilot log + verdict data for threshold analysis.
 *
 * Returns structured JSON or CSV combining pilot log entries with their
 * human review verdicts, plus summary statistics useful for tuning
 * detection thresholds.
 *
 * Query params (all optional):
 *   verdict       — comma-separated: correct,wrong,false_detection,unreviewed (default: all)
 *   model         — comma-separated: t2,yolo-local (default: all)
 *   confidence_min — minimum confidence inclusive (default: 0)
 *   confidence_max — maximum confidence inclusive (default: 1)
 *   from          — start date inclusive (ISO date, e.g. 2026-01-01)
 *   to            — end date inclusive (ISO date, e.g. 2026-12-31)
 *   item          — filter by item name (substring match, case-insensitive)
 *   stream        — filter by waste stream (exact match)
 *   escalated     — "true" or "false"
 *   format        — "json" (default) or "csv"
 */

import { NextResponse } from "next/server";
import { redis, KEYS } from "@/lib/redis";
import type { PilotLogEntry } from "@/lib/types";

export const dynamic = "force-dynamic";

interface AnalysisEntry {
  requestId: string;
  timestamp: string;
  modelUsed: string;
  itemName: string;
  wasteStream: string;
  confidence: number;
  verdict: string | null;
  escalated: boolean;
  latencyMs: number;
  overrideApplied: boolean;
  imageUrl: string | null;
  sharpnessScore: number | null;
  imageQuality: string | null;
  yoloDetections: PilotLogEntry["yoloDetections"] | null;
}

export async function GET(request: Request) {
  // Auth is handled by middleware (session cookie / Basic Auth / x-api-key)
  const { searchParams } = new URL(request.url);

  // ── Parse filters ──
  const verdictFilter = searchParams.get("verdict")?.split(",").filter(Boolean) ?? null;
  const modelFilter = searchParams.get("model")?.split(",").filter(Boolean) ?? null;
  const confidenceMin = parseFloat(searchParams.get("confidence_min") ?? "0");
  const confidenceMax = parseFloat(searchParams.get("confidence_max") ?? "1");
  const fromDate = searchParams.get("from");
  const toDate = searchParams.get("to");
  const itemFilter = searchParams.get("item")?.toLowerCase() ?? null;
  const streamFilter = searchParams.get("stream") ?? null;
  const escalatedFilter = searchParams.get("escalated");
  const format = searchParams.get("format") ?? "json";

  const fromMs = fromDate ? new Date(fromDate).getTime() : 0;
  const toMs = toDate ? new Date(toDate + "T23:59:59.999Z").getTime() : Infinity;

  try {
    const [pilotRaw, verdicts] = await Promise.all([
      redis.lrange(KEYS.pilotLog, 0, -1),
      redis.hgetall("recycling:review-verdicts") as Promise<Record<string, string> | null>,
    ]);

    const entries: AnalysisEntry[] = [];

    for (const item of pilotRaw) {
      let entry: PilotLogEntry;
      try {
        entry = (typeof item === "string" ? JSON.parse(item) : item) as PilotLogEntry;
      } catch {
        continue;
      }

      if (!entry.requestId) continue;

      const verdict = verdicts?.[entry.requestId] ?? null;

      // ── Apply filters ──
      if (verdictFilter) {
        const hasUnreviewed = verdictFilter.includes("unreviewed");
        const verdictTypes = verdictFilter.filter((v) => v !== "unreviewed");
        const matchesVerdict = (verdict && verdictTypes.includes(verdict)) || (hasUnreviewed && !verdict);
        if (!matchesVerdict) continue;
      }

      if (modelFilter && !modelFilter.includes(entry.modelUsed)) continue;

      if (entry.confidence < confidenceMin || entry.confidence > confidenceMax) continue;

      const entryMs = new Date(entry.timestamp).getTime();
      if (entryMs < fromMs || entryMs > toMs) continue;

      if (itemFilter && !entry.itemName.toLowerCase().includes(itemFilter)) continue;

      if (streamFilter && entry.wasteStream !== streamFilter) continue;

      if (escalatedFilter !== null) {
        const wantEscalated = escalatedFilter === "true";
        if (entry.escalated !== wantEscalated) continue;
      }

      entries.push({
        requestId: entry.requestId,
        timestamp: entry.timestamp,
        modelUsed: entry.modelUsed,
        itemName: entry.itemName,
        wasteStream: entry.wasteStream,
        confidence: entry.confidence,
        verdict,
        escalated: entry.escalated,
        latencyMs: entry.latencyMs,
        overrideApplied: entry.overrideApplied ?? false,
        imageUrl: entry.imageUrl ?? null,
        sharpnessScore: entry.meta?.sharpnessScore ?? null,
        imageQuality: entry.meta?.imageQuality ?? null,
        yoloDetections: entry.yoloDetections ?? null,
      });
    }

    // Sort newest first
    entries.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

    // ── Build summary ──
    const byVerdict: Record<string, number> = {};
    const byModel: Record<string, number> = {};
    const correctByModel: Record<string, number> = {};
    const reviewedByModel: Record<string, number> = {};
    const confidenceBuckets: Record<string, { total: number; correct: number }> = {};

    for (const e of entries) {
      const vKey = e.verdict ?? "unreviewed";
      byVerdict[vKey] = (byVerdict[vKey] ?? 0) + 1;

      byModel[e.modelUsed] = (byModel[e.modelUsed] ?? 0) + 1;

      if (e.verdict) {
        reviewedByModel[e.modelUsed] = (reviewedByModel[e.modelUsed] ?? 0) + 1;
        if (e.verdict === "correct") {
          correctByModel[e.modelUsed] = (correctByModel[e.modelUsed] ?? 0) + 1;
        }
      }

      // 0.10-increment buckets for quick overview
      const bucketKey = (Math.floor(e.confidence * 10) / 10).toFixed(1);
      if (!confidenceBuckets[bucketKey]) {
        confidenceBuckets[bucketKey] = { total: 0, correct: 0 };
      }
      confidenceBuckets[bucketKey].total++;
      if (e.verdict === "correct") {
        confidenceBuckets[bucketKey].correct++;
      }
    }

    const accuracyByModel: Record<string, number | null> = {};
    for (const model of Object.keys(byModel)) {
      const reviewed = reviewedByModel[model] ?? 0;
      accuracyByModel[model] = reviewed > 0 ? (correctByModel[model] ?? 0) / reviewed : null;
    }

    // ── CSV format ──
    if (format === "csv") {
      const headers = [
        "requestId", "timestamp", "modelUsed", "itemName", "wasteStream",
        "confidence", "verdict", "escalated", "latencyMs", "overrideApplied",
        "imageUrl", "sharpnessScore", "imageQuality",
      ];
      const csvRows = [headers.join(",")];
      for (const e of entries) {
        csvRows.push([
          e.requestId,
          e.timestamp,
          e.modelUsed,
          csvEscape(e.itemName),
          e.wasteStream,
          e.confidence,
          e.verdict ?? "",
          e.escalated,
          e.latencyMs,
          e.overrideApplied,
          e.imageUrl ?? "",
          e.sharpnessScore ?? "",
          e.imageQuality ?? "",
        ].join(","));
      }

      const dateStr = new Date().toISOString().slice(0, 10);
      return new Response(csvRows.join("\n"), {
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="analysis-${dateStr}.csv"`,
        },
      });
    }

    // ── JSON format (default) ──
    return NextResponse.json({
      filters: {
        verdict: verdictFilter,
        model: modelFilter,
        confidenceRange: [confidenceMin, confidenceMax],
        dateRange: [fromDate ?? null, toDate ?? null],
        item: itemFilter,
        stream: streamFilter,
        escalated: escalatedFilter,
      },
      summary: {
        total: entries.length,
        byVerdict,
        byModel,
        accuracyByModel,
        confidenceBuckets,
      },
      entries,
    });
  } catch (err) {
    console.error("[review/export/analysis] Failed:", err);
    return NextResponse.json({ error: "Export failed." }, { status: 500 });
  }
}

/** Escape a value for CSV (wrap in quotes if it contains commas or quotes). */
function csvEscape(value: string): string {
  if (value.includes(",") || value.includes('"') || value.includes("\n")) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}
