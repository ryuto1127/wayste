/**
 * Cron job: daily data maintenance.
 *
 * 1. Export pilot log + feedback data to Vercel Blob as JSONL archive.
 * 2. Clean up Blob images older than RETENTION_DAYS.
 *
 * Triggered by Vercel Cron (see vercel.json). Protected by CRON_SECRET.
 * Schedule: daily at 03:00 UTC.
 */

import { NextResponse } from "next/server";
import { list, del, put } from "@vercel/blob";
import { redis, KEYS } from "@/lib/redis";

const RETENTION_DAYS = parseInt(process.env.BLOB_RETENTION_DAYS || "30");

export async function GET(request: Request) {
  // Verify cron secret (Vercel sets this automatically for cron jobs)
  const authHeader = request.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const results = { exported: false, deletedBlobs: 0, errors: [] as string[] };

  // ── Step 1: Archive data to Blob ──
  try {
    const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

    // Export pilot log
    const pilotRaw = await redis.lrange(KEYS.pilotLog, 0, -1);
    if (pilotRaw.length > 0) {
      const jsonl = pilotRaw
        .map((item) => (typeof item === "string" ? item : JSON.stringify(item)))
        .join("\n");
      await put(`archives/${date}/pilot-log.jsonl`, jsonl, {
        access: "public",
        contentType: "application/jsonl",
        addRandomSuffix: false,
      });
    }

    // Export feedback
    const feedbackRaw = await redis.lrange(KEYS.feedback, 0, -1);
    if (feedbackRaw.length > 0) {
      const jsonl = feedbackRaw
        .map((item) => (typeof item === "string" ? item : JSON.stringify(item)))
        .join("\n");
      await put(`archives/${date}/feedback.jsonl`, jsonl, {
        access: "public",
        contentType: "application/jsonl",
        addRandomSuffix: false,
      });
    }

    results.exported = true;
    console.log(`[cron/cleanup] Archived ${pilotRaw.length} pilot entries + ${feedbackRaw.length} feedback entries`);
  } catch (err) {
    const msg = `Archive failed: ${err}`;
    console.error(`[cron/cleanup] ${msg}`);
    results.errors.push(msg);
  }

  // ── Step 2: Clean up old Blob images ──
  try {
    const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
    let cursor: string | undefined;
    let deleted = 0;

    do {
      const response = await list({
        prefix: "pilot-images/",
        cursor,
        limit: 100,
      });

      const toDelete = response.blobs.filter(
        (blob) => new Date(blob.uploadedAt).getTime() < cutoff
      );

      for (const blob of toDelete) {
        try {
          await del(blob.url);
          deleted++;
        } catch (err) {
          results.errors.push(`Delete failed for ${blob.pathname}: ${err}`);
        }
      }

      cursor = response.hasMore ? response.cursor : undefined;
    } while (cursor);

    results.deletedBlobs = deleted;
    console.log(`[cron/cleanup] Deleted ${deleted} blobs older than ${RETENTION_DAYS} days`);
  } catch (err) {
    const msg = `Blob cleanup failed: ${err}`;
    console.error(`[cron/cleanup] ${msg}`);
    results.errors.push(msg);
  }

  return NextResponse.json(results);
}
