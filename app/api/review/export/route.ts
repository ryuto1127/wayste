/**
 * GET /api/review/export — Export reviewed images as a ZIP file for annotation tools.
 *
 * Exports images for entries that need retraining:
 *   - All "wrong" verdicts (model misidentified the object)
 *   - "correct" verdicts with confidence ≤ 0.80 (model was right but unsure)
 *   - "correct" verdicts from T2 (API) at any confidence — YOLO couldn't
 *     classify alone, so these fill training gaps
 *
 * Images are named by timestamp (e.g. 2026-04-04T10-23-15.jpg) and delivered
 * as a ZIP file compatible with CVAT, Roboflow, and Label Studio.
 *
 * Date filtering (ISO date strings, inclusive):
 *   ?from=2026-07-01&to=2026-08-31
 */

import { NextResponse } from "next/server";
import { redis, KEYS } from "@/lib/redis";
import type { PilotLogEntry } from "@/lib/types";
// Dynamic import: archiver is CommonJS, avoid top-level ESM issues
import { Readable } from "node:stream";

/** Confidence threshold: correct entries at or below this value are exported */
const CORRECT_CONFIDENCE_THRESHOLD = 0.80;

export async function GET(request: Request) {
  // Auth is handled by middleware (session cookie / Basic Auth / x-api-key)
  const { searchParams } = new URL(request.url);
  const fromDate = searchParams.get("from");
  const toDate = searchParams.get("to");
  const fromMs = fromDate ? new Date(fromDate).getTime() : 0;
  const toMs = toDate ? new Date(toDate + "T23:59:59.999Z").getTime() : Infinity;

  try {
    const [pilotRaw, verdicts] = await Promise.all([
      redis.lrange(KEYS.pilotLog, 0, -1),
      redis.hgetall("recycling:review-verdicts") as Promise<Record<string, string> | null>,
    ]);

    if (!verdicts || Object.keys(verdicts).length === 0) {
      return NextResponse.json(
        { error: "No reviewed entries yet. Review entries at /review first." },
        { status: 404 },
      );
    }

    // Collect entries that qualify for export
    const toExport: { url: string; filename: string; entry: PilotLogEntry; verdict: string }[] = [];

    for (const item of pilotRaw) {
      let entry: PilotLogEntry;
      try {
        entry = (typeof item === "string" ? JSON.parse(item) : item) as PilotLogEntry;
      } catch {
        continue;
      }

      if (!entry.requestId || !entry.imageUrl) continue;

      // Date range filter
      const entryMs = new Date(entry.timestamp).getTime();
      if (entryMs < fromMs || entryMs > toMs) continue;

      const verdict = verdicts[entry.requestId];
      if (!verdict) continue;

      // Export criteria:
      //   - All "wrong" verdicts
      //   - "correct" with low confidence (model was right but unsure)
      //   - "correct" from T2 (API) at any confidence
      //     → YOLO couldn't handle it alone, valuable for fine-tuning
      const shouldExport =
        verdict === "wrong" ||
        (verdict === "correct" &&
          (entry.confidence <= CORRECT_CONFIDENCE_THRESHOLD ||
            entry.modelUsed !== "T1"));

      if (!shouldExport) continue;

      // Timestamp-based filename: 2026-04-04T10-23-15.jpg
      const ts = entry.timestamp.replace(/:/g, "-").replace(/\.\d+Z$/, "").replace("Z", "");
      toExport.push({ url: entry.imageUrl, filename: `${ts}.jpg`, entry, verdict });
    }

    if (toExport.length === 0) {
      return NextResponse.json(
        { error: "No exportable images found (need wrong verdicts, low-confidence correct, or non-YOLO correct verdicts)." },
        { status: 404 },
      );
    }

    // Build ZIP using archiver
    const archiver = (await import("archiver")).default;
    const archive = archiver("zip", { zlib: { level: 1 } }); // fast compression for images

    // Deduplicate filenames in case of collisions
    const usedNames = new Set<string>();
    const uniqueName = (name: string): string => {
      if (!usedNames.has(name)) {
        usedNames.add(name);
        return name;
      }
      let i = 1;
      const base = name.replace(/\.jpg$/, "");
      while (usedNames.has(`${base}_${i}.jpg`)) i++;
      const deduped = `${base}_${i}.jpg`;
      usedNames.add(deduped);
      return deduped;
    };

    // Fetch images in parallel (batches of 10) and append to archive
    const BATCH_SIZE = 10;
    for (let i = 0; i < toExport.length; i += BATCH_SIZE) {
      const batch = toExport.slice(i, i + BATCH_SIZE);
      const results = await Promise.allSettled(
        batch.map(async ({ url, filename }) => {
          const res = await fetch(url);
          if (!res.ok) return null;
          const buf = Buffer.from(await res.arrayBuffer());
          return { filename, buf };
        }),
      );
      for (const result of results) {
        if (result.status === "fulfilled" && result.value) {
          const { filename, buf } = result.value;
          archive.append(buf, { name: uniqueName(filename) });
        }
      }
    }

    // Include metadata JSONL for training pipeline (prepare_pilot_data.py)
    const jsonlLines = toExport.map(({ filename, entry, verdict }) =>
      JSON.stringify({
        requestId: entry.requestId,
        timestamp: entry.timestamp,
        modelUsed: entry.modelUsed,
        itemName: entry.itemName,
        wasteStream: entry.wasteStream,
        confidence: entry.confidence,
        verdict,
        imageFile: filename,
        imageUrl: entry.imageUrl,
        yoloDetections: entry.yoloDetections ?? null,
        correctStream: (entry as unknown as Record<string, unknown>).correctStream ?? null,
      }),
    );
    archive.append(jsonlLines.join("\n") + "\n", { name: "metadata.jsonl" });

    archive.finalize();

    // Convert Node stream to Web ReadableStream
    const nodeStream = archive as unknown as NodeJS.ReadableStream;
    const webStream = Readable.toWeb(Readable.from(nodeStream)) as ReadableStream;

    const dateStr = new Date().toISOString().slice(0, 10);
    return new Response(webStream, {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="review-images-${dateStr}.zip"`,
      },
    });
  } catch (err) {
    console.error("[review/export] Failed:", err);
    return NextResponse.json({ error: "Export failed." }, { status: 500 });
  }
}
