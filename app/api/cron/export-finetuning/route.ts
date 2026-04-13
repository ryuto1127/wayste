/**
 * Cron job: weekly fine-tuning image export.
 *
 * Collects all entries that qualify for model retraining:
 *   - "wrong" verdict (model misidentified the object)
 *   - "correct" verdict with confidence ≤ 0.80 (right but uncertain)
 *   - "correct" verdict from T2 (API) at any confidence — YOLO couldn't
 *     classify alone, valuable for fine-tuning
 *
 * Downloads their images from Vercel Blob, packages them as a ZIP,
 * and saves the ZIP to archives/finetuning/YYYY-MM-DD.zip in Vercel Blob.
 * The ZIP URL is logged and returned in the response.
 *
 * Triggered by Vercel Cron (see vercel.json). Protected by CRON_SECRET.
 * Schedule: every Sunday at 02:00 UTC (before the daily cleanup at 03:00).
 *
 * The archives/finetuning/ prefix is intentionally excluded from the daily
 * cleanup, so exported ZIPs accumulate indefinitely for fine-tuning use.
 */

import { NextResponse } from "next/server";
import { put } from "@vercel/blob";
import { redis, KEYS } from "@/lib/redis";
import { Readable } from "node:stream";
import type { PilotLogEntry } from "@/lib/types";

/** Mirror the threshold from /api/review/export */
const CORRECT_CONFIDENCE_THRESHOLD = 0.80;

/** Fetch images in parallel, bounded by batch size to avoid OOM. */
const BATCH_SIZE = 10;

export async function GET(request: Request) {
  const authHeader = request.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const [pilotRaw, verdicts] = await Promise.all([
      redis.lrange(KEYS.pilotLog, 0, -1),
      redis.hgetall("recycling:review-verdicts") as Promise<Record<string, string> | null>,
    ]);

    if (!verdicts || Object.keys(verdicts).length === 0) {
      console.log("[cron/export-finetuning] No reviewed entries yet — skipping.");
      return NextResponse.json({ skipped: true, reason: "no_verdicts" });
    }

    // Collect export candidates
    const toExport: { url: string; filename: string }[] = [];
    const usedNames = new Set<string>();

    const uniqueName = (name: string): string => {
      if (!usedNames.has(name)) { usedNames.add(name); return name; }
      let i = 1;
      const base = name.replace(/\.jpg$/, "");
      while (usedNames.has(`${base}_${i}.jpg`)) i++;
      const deduped = `${base}_${i}.jpg`;
      usedNames.add(deduped);
      return deduped;
    };

    for (const item of pilotRaw) {
      let entry: PilotLogEntry;
      try {
        entry = (typeof item === "string" ? JSON.parse(item) : item) as PilotLogEntry;
      } catch {
        continue;
      }

      if (!entry.requestId || !entry.imageUrl) continue;

      const verdict = verdicts[entry.requestId];
      if (!verdict) continue;

      // Same criteria as /api/review/export:
      //   wrong (all) | correct + low confidence | correct + non-YOLO model
      const shouldExport =
        verdict === "wrong" ||
        (verdict === "correct" &&
          (entry.confidence <= CORRECT_CONFIDENCE_THRESHOLD ||
            entry.modelUsed !== "yolo-local"));

      if (!shouldExport) continue;

      const ts = entry.timestamp
        .replace(/:/g, "-")
        .replace(/\.\d+Z$/, "")
        .replace("Z", "");
      toExport.push({ url: entry.imageUrl, filename: uniqueName(`${ts}.jpg`) });
    }

    if (toExport.length === 0) {
      console.log("[cron/export-finetuning] No exportable images found — skipping.");
      return NextResponse.json({ skipped: true, reason: "no_candidates" });
    }

    // Build ZIP
    const archiver = (await import("archiver")).default;
    const archive = archiver("zip", { zlib: { level: 1 } });

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
          archive.append(buf, { name: filename });
        }
      }
    }

    archive.finalize();

    // Stream ZIP to Vercel Blob
    const nodeStream = archive as unknown as NodeJS.ReadableStream;
    const webStream = Readable.toWeb(Readable.from(nodeStream)) as ReadableStream;

    const date = new Date().toISOString().slice(0, 10);
    const blob = await put(`archives/finetuning/${date}.zip`, webStream, {
      access: "public",
      contentType: "application/zip",
      addRandomSuffix: false,
    });

    console.log(`[cron/export-finetuning] Exported ${toExport.length} images → ${blob.url}`);
    return NextResponse.json({ url: blob.url, count: toExport.length });
  } catch (err) {
    console.error("[cron/export-finetuning] Failed:", err);
    return NextResponse.json({ error: "Export failed." }, { status: 500 });
  }
}
