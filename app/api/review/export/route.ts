/**
 * GET /api/review/export — Export reviewed pilot log entries as JSONL.
 *
 * Date filtering (ISO date strings, inclusive):
 *   ?from=2026-07-01          — entries from July 1 onward
 *   ?to=2026-08-31            — entries up to August 31
 *   ?from=2026-07-01&to=2026-08-31 — entries in July–August only
 *
 * Two export modes:
 *   ?format=finetune (default) — Dataset for YOLO fine-tuning:
 *     Each line: { imageUrl, itemName, correctStream, verdict, yoloDetections[], confidence, modelUsed }
 *     Includes bbox data when available. false_detection entries serve as negative examples.
 *
 *   ?format=threshold — Data for optimal confidence threshold analysis:
 *     Each line: { confidence, verdict, predictedStream, correctStream }
 *     One entry per reviewed classification. Feed into a script that computes
 *     accuracy per confidence bucket to find the optimal escalation threshold.
 */

import { NextResponse } from "next/server";
import { redis, KEYS } from "@/lib/redis";
import { requireApiKey } from "@/lib/auth";
import type { PilotLogEntry } from "@/lib/types";

export async function GET(request: Request) {
  const denied = requireApiKey(request);
  if (denied) return denied;

  const { searchParams } = new URL(request.url);
  const format = searchParams.get("format") ?? "finetune";
  const fromDate = searchParams.get("from");
  const toDate = searchParams.get("to");
  const fromMs = fromDate ? new Date(fromDate).getTime() : 0;
  const toMs = toDate ? new Date(toDate + "T23:59:59.999Z").getTime() : Infinity;

  try {
    const [pilotRaw, verdicts, verdictStreams] = await Promise.all([
      redis.lrange(KEYS.pilotLog, 0, -1),
      redis.hgetall("recycling:review-verdicts") as Promise<Record<string, string> | null>,
      redis.hgetall("recycling:review-verdicts:streams") as Promise<Record<string, string> | null>,
    ]);

    if (!verdicts || Object.keys(verdicts).length === 0) {
      return NextResponse.json(
        { error: "No reviewed entries yet. Review entries at /review?mode=full first." },
        { status: 404 }
      );
    }

    const lines: string[] = [];

    for (const item of pilotRaw) {
      let entry: PilotLogEntry;
      try {
        entry = (typeof item === "string" ? JSON.parse(item) : item) as PilotLogEntry;
      } catch { continue; }

      if (!entry.requestId) continue;

      // Date range filter
      const entryMs = new Date(entry.timestamp).getTime();
      if (entryMs < fromMs || entryMs > toMs) continue;

      const verdict = verdicts[entry.requestId];
      if (!verdict) continue;

      const correctStream = verdict === "wrong"
        ? (verdictStreams?.[entry.requestId] ?? null)
        : verdict === "correct"
          ? entry.wasteStream
          : null;

      if (format === "threshold") {
        // Threshold analysis format: minimal, one per entry
        lines.push(JSON.stringify({
          confidence: entry.confidence,
          verdict,
          predictedStream: entry.wasteStream,
          correctStream,
          modelUsed: entry.modelUsed,
        }));
      } else {
        // Fine-tuning format: full data with bbox
        lines.push(JSON.stringify({
          imageUrl: entry.imageUrl ?? null,
          itemName: entry.itemName,
          predictedStream: entry.wasteStream,
          correctStream,
          confidence: entry.confidence,
          modelUsed: entry.modelUsed,
          verdict,
          overrideApplied: entry.overrideApplied ?? false,
          // YOLO bounding boxes for annotation (when available)
          yoloDetections: entry.yoloDetections ?? null,
          // CV metadata for analysis
          meta: entry.meta ?? null,
          timestamp: entry.timestamp,
        }));
      }
    }

    const filename = format === "threshold"
      ? `threshold-analysis-${new Date().toISOString().slice(0, 10)}.jsonl`
      : `finetune-dataset-${new Date().toISOString().slice(0, 10)}.jsonl`;

    return new Response(lines.join("\n") + "\n", {
      headers: {
        "Content-Type": "application/jsonl",
        "Content-Disposition": `attachment; filename="${filename}"`,
      },
    });
  } catch (err) {
    console.error("[review/export] Failed:", err);
    return NextResponse.json({ error: "Export failed." }, { status: 500 });
  }
}
