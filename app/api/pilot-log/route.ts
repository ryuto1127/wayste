import { NextResponse } from "next/server";
import { z } from "zod/v4";
import { redis, KEYS } from "@/lib/redis";
import { logPilotEntry } from "@/lib/pilot-log";
import { recordCalibrationPrediction } from "@/lib/calibration";
import { uploadFrameToBlob } from "@/lib/blob-store";
import { runInBackground } from "@/lib/background-task";
import { generateRequestId } from "@/lib/request-id";
import { del as deleteBlob } from "@vercel/blob";
import type { PilotLogEntry } from "@/lib/types";
import { verifyKioskRequest } from "@/lib/kiosk-auth";
import { parsePilotLogEntry } from "@/lib/pilot-log-schema";
import { serverFaceDetected } from "@/lib/face-detect-server";

import { checkAndSendMilestoneNotification } from "@/lib/milestone-check";

// ── POST body validation ──
// Size cap matches /api/classify (≈ 3.75 MB base64) to prevent memory DoS.
const IMAGE_MAX_LENGTH = 5_000_000;
// Constrain itemName/wasteStream to letters/digits + a few separators — these
// values are used to build the Blob object path, so path-traversal characters
// (`/`, `\`) must be rejected even though `uploadFrameToBlob` sanitizes them.
// Unicode-aware (`\p{L}\p{N}` + the `u` flag): the kiosk logs localized item
// names ("不明", "ペットボトル"), which the previous ASCII-only pattern
// silently rejected — dropping every Japanese-locale log entry with a 400.
// Commas are allowed for multi-item joined names.
const SAFE_TOKEN = z.string().min(1).max(128).regex(/^[\p{L}\p{N}\p{Zs}\s\-.,()、。・ー〜]+$/u);

const PilotLogPostSchema = z.object({
  image: z.string().min(100).max(IMAGE_MAX_LENGTH).optional(),
  /**
   * Client-side face detection hint. When true, the client already detected
   * a face and chose not to send the image — trust the positive. When false
   * or omitted with an image present, the server re-checks via
   * `serverFaceDetected()` before uploading (defense-in-depth against a
   * compromised kiosk session).
   */
  faceDetected: z.boolean().optional(),
  entry: z.object({
    modelUsed: z.enum(["t2", "T1"]).optional(),
    itemName: SAFE_TOKEN.optional(),
    wasteStream: SAFE_TOKEN.optional(),
    confidence: z.number().min(0).max(1).optional(),
    requiresVerification: z.boolean().optional(),
    latencyMs: z.number().min(0).max(60_000).optional(),
    meta: z.unknown().optional(),
    yoloDetections: z.unknown().optional(),
    /** Which square the image/bboxNorm are in — see PilotLogEntry.captureSpace. */
    captureSpace: z.enum(["center_square", "letterbox"]).optional(),
    rgbAnalysis: z.unknown().optional(),
    tierResults: z.unknown().optional(),
    /** All classified items in this frame — /review renders multi-item
     *  entries from this field, so it must survive the POST. */
    allItems: z
      .array(
        z.object({
          itemName: SAFE_TOKEN,
          wasteStream: SAFE_TOKEN,
          confidence: z.number().min(0).max(1),
          modelUsed: z.string().max(32).optional(),
        }),
      )
      .max(16)
      .optional(),
    blobCount: z.number().min(0).max(64).optional(),
    yoloDetectionCount: z.number().min(0).max(64).optional(),
  }),
});

export async function GET(_request: Request) {
  // Auth is enforced by middleware.ts (admin Basic Auth / x-api-key).
  // /api/pilot-log is in ADMIN_PATHS — do NOT remove that entry.
  try {
    const raw = await redis.lrange(KEYS.pilotLog, 0, -1);
    const entries: PilotLogEntry[] = raw
      .map(parsePilotLogEntry)
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
  // ── Kiosk authentication ──
  const auth = await verifyKioskRequest(request);
  if (!auth.ok) return auth.response;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }

  const parsed = PilotLogPostSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid request.", details: parsed.error.issues },
      { status: 400 },
    );
  }
  // The free-form diagnostic fields (meta/yoloDetections/tierResults/...) are
  // intentionally flexible, but a kiosk-authenticated client must not be able
  // to grow Redis entries without bound — every admin surface loads the whole
  // list. Cap the serialized entry (image excluded; it goes to Blob).
  if (JSON.stringify(parsed.data.entry).length > 64_000) {
    return NextResponse.json(
      { error: "Entry too large." },
      { status: 413 },
    );
  }
  const { image, entry } = parsed.data;
  const clientFaceDetected = parsed.data.faceDetected === true;

  const requestId = generateRequestId();
  const timestamp = new Date().toISOString();

  // Upload image and log entry in background
  runInBackground(
    (async () => {
      let imageUrl: string | undefined;
      let faceBlocked = false;
      if (image) {
        // Privacy gate: symmetric with `/api/classify`. Trust a positive from
        // the client (skip redundant server detection when the client already
        // saw a face), but re-check server-side when the client says "no face"
        // — a compromised kiosk session could otherwise lie to bypass the
        // gate. Fail-closed: any detector error is treated as "face present".
        let blockUpload = clientFaceDetected;
        if (!blockUpload) {
          try {
            blockUpload = await serverFaceDetected(image);
          } catch (err) {
            console.warn(`[${requestId}] server face detection error, failing closed:`, err);
            blockUpload = true;
          }
        }

        if (blockUpload) {
          faceBlocked = true;
        } else {
          imageUrl = await uploadFrameToBlob(
            image,
            entry.itemName ?? "unknown",
            entry.wasteStream ?? "unknown",
            timestamp,
          ) ?? undefined;
        }
      }
      // Confidence calibration: predictions must be recorded where results
      // are actually produced. In the default local-only deployment that is
      // HERE (T1 results log via pilot-log) — /api/classify is 403-gated, so
      // recording only there left /api/calibration with verdicts but zero
      // predictions (accuracy permanently null). t2 entries are excluded:
      // the classify route already records those in cloud pilot mode.
      if (typeof entry.confidence === "number" && (entry.modelUsed ?? "T1") === "T1") {
        await recordCalibrationPrediction(entry.confidence, "T1").catch(() => {});
      }

      await logPilotEntry({
        timestamp,
        modelUsed: entry.modelUsed ?? "T1",
        escalated: false,
        itemName: entry.itemName ?? "unknown",
        wasteStream: entry.wasteStream ?? "unknown",
        confidence: entry.confidence ?? 0,
        requiresVerification: entry.requiresVerification ?? false,
        latencyMs: entry.latencyMs ?? 0,
        imageUrl,
        blobUploadFailed: image && !faceBlocked ? !imageUrl : undefined,
        faceBlocked: image ? faceBlocked : undefined,
        requestId,
        meta: entry.meta as PilotLogEntry["meta"],
        yoloDetections: entry.yoloDetections as PilotLogEntry["yoloDetections"],
        captureSpace: entry.captureSpace,
        rgbAnalysis: entry.rgbAnalysis as PilotLogEntry["rgbAnalysis"],
        tierResults: entry.tierResults as PilotLogEntry["tierResults"],
        allItems: entry.allItems,
        blobCount: entry.blobCount,
        yoloDetectionCount: entry.yoloDetectionCount,
      });

      // Check for milestone notification (non-blocking, best-effort)
      await checkAndSendMilestoneNotification().catch((err) =>
        console.warn("[pilot-log] Milestone check failed:", err)
      );
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
 * Also deletes associated Blob images and clears review verdicts
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
    // Note: corrupted/malformed entries fail parsing and are silently dropped
    // — the rebuild below excludes them from the new list, which is the
    // desired side-effect (cleanup of any stray bad data).
    const raw = await redis.lrange(KEYS.pilotLog, 0, -1);
    const allEntries: PilotLogEntry[] = raw
      .map(parsePilotLogEntry)
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

    // Nothing to delete
    if (toDelete.length === 0 && !deleteAll) {
      return NextResponse.json({ deleted: 0, kept: toKeep.length, blobsDeleted: 0 });
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

    // ── Rebuild Redis list with remaining entries ──
    const pipeline = redis.pipeline();
    pipeline.del(KEYS.pilotLog);
    if (toKeep.length > 0) {
      for (const entry of toKeep) {
        pipeline.rpush(KEYS.pilotLog, JSON.stringify(entry));
      }
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
      pipeline.del("recycling:review-verdicts");
    }

    await pipeline.exec();

    console.log(`[pilot-log] Purged ${toDelete.length} log entries, ${blobsDeleted} blobs`);

    return NextResponse.json({
      deleted: toDelete.length,
      kept: toKeep.length,
      blobsDeleted,
    });
  } catch (err) {
    console.error("[pilot-log] DELETE failed:", err);
    return NextResponse.json({ error: "Purge failed." }, { status: 500 });
  }
}
