import { NextResponse } from "next/server";
import { redis, KEYS, MAX_ENTRIES } from "@/lib/redis";
import { logPilotEntry } from "@/lib/pilot-log";
import { uploadFrameToBlob } from "@/lib/blob-store";
import { runInBackground } from "@/lib/background-task";
import { generateRequestId } from "@/lib/request-id";
import { del as deleteBlob } from "@vercel/blob";
import type { PilotLogEntry } from "@/lib/types";
import { validateSessionToken } from "@/lib/session-token";

export async function GET(request: Request) {
  // GET is read-only (review page) — no auth required.

  try {
    const raw = await redis.lrange(KEYS.pilotLog, 0, -1);
    const entries: PilotLogEntry[] = raw
      .map((item) => {
        try {
          return (typeof item === "string" ? JSON.parse(item) : item) as PilotLogEntry;
        } catch {
          return null;
        }
      })
      .filter((e): e is PilotLogEntry => e !== null)
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

    return NextResponse.json(entries);
  } catch (err) {
    console.error("[pilot-log] GET failed:", err);
    return NextResponse.json({ error: "Failed to load entries." }, { status: 500 });
  }
}

/**
 * POST /api/pilot-log — Log a YOLO-only classification (no API call was made).
 * Called by the client when YOLO wins the race and the API is aborted.
 */
export async function POST(request: Request) {
  // ── Session token validation ──
  const sessionToken = request.headers.get("x-session-token");
  if (sessionToken) {
    const result = validateSessionToken(sessionToken);
    if (!result.valid) {
      return NextResponse.json(
        { error: "Invalid or expired session.", reason: result.reason },
        { status: 401 }
      );
    }
  } else if (process.env.NODE_ENV === "production") {
    return NextResponse.json(
      { error: "Session token required." },
      { status: 401 }
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }

  const { image, entry } = body as { image?: string; entry?: Partial<PilotLogEntry> };
  if (!entry) {
    return NextResponse.json({ error: "Missing entry." }, { status: 400 });
  }

  const requestId = generateRequestId();
  const timestamp = new Date().toISOString();

  // Upload image and log entry in background
  runInBackground(
    (async () => {
      let imageUrl: string | undefined;
      if (image) {
        imageUrl = await uploadFrameToBlob(
          image,
          entry.itemName ?? "unknown",
          entry.wasteStream ?? "unknown",
          timestamp,
        ) ?? undefined;
      }
      await logPilotEntry({
        timestamp,
        modelUsed: entry.modelUsed ?? "yolo-local",
        escalated: false,
        itemName: entry.itemName ?? "unknown",
        wasteStream: entry.wasteStream ?? "unknown",
        confidence: entry.confidence ?? 0,
        requiresVerification: entry.requiresVerification ?? false,
        latencyMs: entry.latencyMs ?? 0,
        imageUrl,
        blobUploadFailed: image ? !imageUrl : undefined,
        requestId,
        meta: entry.meta,
        yoloDetections: entry.yoloDetections,
      });
    })()
  );

  return NextResponse.json({ logged: true, requestId });
}

/**
 * DELETE /api/pilot-log — Purge log entries and associated Blob images.
 *
 * Protected by middleware.ts (Basic Auth / x-api-key). Supports:
 *   ?before=2026-07-01  — delete entries before July 1 (demo cleanup)
 *   ?from=...&to=...    — delete entries in a date range
 *   ?all=true           — delete ALL entries (full reset)
 *
 * Also deletes associated Blob images and clears feedback + review verdicts
 * for the deleted entries.
 */
export async function DELETE(request: Request) {
  // Auth is handled by middleware.ts (Basic Auth for /api/pilot-log non-POST)

  const { searchParams } = new URL(request.url);
  const deleteAll = searchParams.get("all") === "true";
  const beforeDate = searchParams.get("before");
  const fromDate = searchParams.get("from");
  const toDate = searchParams.get("to");

  if (!deleteAll && !beforeDate && !fromDate) {
    return NextResponse.json(
      { error: "Specify ?all=true, ?before=YYYY-MM-DD, or ?from=...&to=..." },
      { status: 400 },
    );
  }

  try {
    // ── Load all entries ──
    const raw = await redis.lrange(KEYS.pilotLog, 0, -1);
    const allEntries: PilotLogEntry[] = raw
      .map((item) => {
        try {
          return (typeof item === "string" ? JSON.parse(item) : item) as PilotLogEntry;
        } catch { return null; }
      })
      .filter((e): e is PilotLogEntry => e !== null);

    // ── Partition: entries to keep vs delete ──
    const beforeMs = beforeDate ? new Date(beforeDate).getTime() : Infinity;
    const fromMs = fromDate ? new Date(fromDate).getTime() : 0;
    const toMs = toDate ? new Date(toDate + "T23:59:59.999Z").getTime() : Infinity;

    const toDelete: PilotLogEntry[] = [];
    const toKeep: PilotLogEntry[] = [];

    for (const entry of allEntries) {
      const entryMs = new Date(entry.timestamp).getTime();
      const shouldDelete = deleteAll
        || (beforeDate && entryMs < beforeMs)
        || (fromDate && entryMs >= fromMs && entryMs <= toMs);

      if (shouldDelete) {
        toDelete.push(entry);
      } else {
        toKeep.push(entry);
      }
    }

    // ── Delete Blob images (best-effort, non-blocking) ──
    const imageUrls = toDelete
      .map((e) => e.imageUrl)
      .filter((url): url is string => !!url);

    // Run blob deletions in parallel, after the response is sent
    const blobsDeleted = imageUrls.length;
    if (imageUrls.length > 0) {
      runInBackground(
        Promise.allSettled(imageUrls.map((url) => deleteBlob(url))).then((results) => {
          const failed = results.filter((r) => r.status === "rejected").length;
          if (failed > 0) {
            console.warn(`[pilot-log] ${failed}/${imageUrls.length} blob deletions failed`);
          }
        }),
      );
    }

    // ── Clean up feedback entries (by timestamp, not just requestId) ──
    const feedbackRaw = await redis.lrange(KEYS.feedback, 0, -1);
    const feedbackToKeep: string[] = [];
    const deletedFeedbackIds: string[] = [];

    for (const item of feedbackRaw) {
      try {
        const f = (typeof item === "string" ? JSON.parse(item) : item) as { id?: string; timestamp?: string };
        const fMs = f.timestamp ? new Date(f.timestamp).getTime() : 0;
        const shouldDeleteFb = deleteAll
          || (beforeDate && fMs < beforeMs)
          || (fromDate && fMs >= fromMs && fMs <= toMs);

        if (shouldDeleteFb) {
          if (f.id) deletedFeedbackIds.push(f.id);
        } else {
          feedbackToKeep.push(typeof item === "string" ? item : JSON.stringify(item));
        }
      } catch {
        feedbackToKeep.push(typeof item === "string" ? item : JSON.stringify(item));
      }
    }

    // Nothing to delete in either list
    if (toDelete.length === 0 && deletedFeedbackIds.length === 0 && !deleteAll) {
      return NextResponse.json({ deleted: 0, kept: toKeep.length, blobsDeleted: 0 });
    }

    // ── Rebuild Redis lists with remaining entries ──
    const pipeline = redis.pipeline();
    pipeline.del(KEYS.pilotLog);
    if (toKeep.length > 0) {
      for (const entry of toKeep) {
        pipeline.rpush(KEYS.pilotLog, JSON.stringify(entry));
      }
    }

    pipeline.del(KEYS.feedback);
    if (feedbackToKeep.length > 0) {
      for (const item of feedbackToKeep) {
        pipeline.rpush(KEYS.feedback, item);
      }
    }

    // Clean up corrections for deleted feedback entries
    for (const id of deletedFeedbackIds) {
      pipeline.hdel("recycling:corrections", id);
      pipeline.hdel("recycling:corrections:names", id);
    }

    // Clean up review verdicts for deleted pilot log entries
    const deletedRequestIds = toDelete.map((e) => e.requestId).filter(Boolean);
    for (const id of deletedRequestIds) {
      if (id) {
        pipeline.hdel("recycling:review-verdicts", id);
      }
    }

    // If deleting all, wipe the hash keys entirely (faster than per-key hdel)
    if (deleteAll) {
      pipeline.del("recycling:corrections");
      pipeline.del("recycling:corrections:names");
      pipeline.del("recycling:review-verdicts");
      // Clean up legacy keys that are no longer used
      pipeline.del("recycling:review-verdicts:streams");
      pipeline.del("recycling:review-verdicts:names");
    }

    await pipeline.exec();

    const totalDeleted = toDelete.length + deletedFeedbackIds.length;
    console.log(`[pilot-log] Purged ${toDelete.length} log entries, ${deletedFeedbackIds.length} feedback, ${blobsDeleted} blobs`);

    return NextResponse.json({
      deleted: totalDeleted,
      kept: toKeep.length,
      blobsDeleted,
    });
  } catch (err) {
    console.error("[pilot-log] DELETE failed:", err);
    return NextResponse.json({ error: "Purge failed." }, { status: 500 });
  }
}
