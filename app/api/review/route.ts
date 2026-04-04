/**
 * GET  /api/review              — "wrong" feedback entries (legacy default)
 * GET  /api/review?mode=full    — ALL pilot log entries for full human review
 * POST /api/review              — save a human correction or review verdict
 */

import { NextResponse } from "next/server";
import { z } from "zod/v4";
import { redis, KEYS } from "@/lib/redis";
import { requireApiKey } from "@/lib/auth";
import type { FeedbackEntry, PilotLogEntry } from "@/lib/types";

const CORRECTIONS_KEY = "recycling:corrections";       // Redis hash: id → actualStream
const NAMES_KEY       = "recycling:corrections:names"; // Redis hash: id → actualItemName
/** Human review verdicts for pilot log entries: requestId → "correct" | "wrong" | "false_detection" */
const VERDICTS_KEY    = "recycling:review-verdicts";
/** When verdict is "wrong", the correct stream: requestId → stream */
const VERDICT_STREAMS_KEY = "recycling:review-verdicts:streams";
/** Corrected item names for full review: requestId → correctedItemName */
const VERDICT_NAMES_KEY   = "recycling:review-verdicts:names";

export async function GET(request: Request) {
  // GET is read-only (dashboard/review page) — no auth required.
  // Write operations (POST) still require admin auth below.

  const { searchParams } = new URL(request.url);
  const mode = searchParams.get("mode");

  // ── Full review mode: return ALL pilot log entries with review verdicts ──
  if (mode === "full") {
    try {
      const [pilotRaw, verdicts, verdictStreams, verdictNames] = await Promise.all([
        redis.lrange(KEYS.pilotLog, 0, -1),
        redis.hgetall(VERDICTS_KEY) as Promise<Record<string, string> | null>,
        redis.hgetall(VERDICT_STREAMS_KEY) as Promise<Record<string, string> | null>,
        redis.hgetall(VERDICT_NAMES_KEY) as Promise<Record<string, string> | null>,
      ]);

      const entries = pilotRaw
        .map((item) => {
          try {
            return (typeof item === "string" ? JSON.parse(item) : item) as PilotLogEntry;
          } catch { return null; }
        })
        .filter((e): e is PilotLogEntry => e !== null)
        .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
        .map((entry) => ({
          ...entry,
          verdict: entry.requestId ? (verdicts?.[entry.requestId] ?? null) : null,
          verdictStream: entry.requestId ? (verdictStreams?.[entry.requestId] ?? null) : null,
          correctedItemName: entry.requestId ? (verdictNames?.[entry.requestId] ?? null) : null,
        }));

      const reviewed = entries.filter((e) => e.verdict !== null).length;
      const total = entries.length;

      return NextResponse.json({ entries, reviewed, total });
    } catch (err) {
      console.error("[review] GET full failed:", err);
      return NextResponse.json({ error: "Failed to load entries." }, { status: 500 });
    }
  }

  // ── Legacy mode: only "wrong" feedback entries ──
  try {
    // Load feedback entries and pilot log in parallel
    const [feedbackRaw, pilotRaw] = await Promise.all([
      redis.lrange(KEYS.feedback, 0, -1),
      redis.lrange(KEYS.pilotLog, 0, -1),
    ]);

    // Parse pilot log entries
    const pilotEntries: PilotLogEntry[] = [];
    const imageByRequestId = new Map<string, { imageUrl?: string; blobUploadFailed?: boolean }>();
    for (const item of pilotRaw) {
      try {
        const entry = (typeof item === "string" ? JSON.parse(item) : item) as PilotLogEntry;
        pilotEntries.push(entry);
        if (entry.requestId) {
          imageByRequestId.set(entry.requestId, {
            imageUrl: entry.imageUrl,
            blobUploadFailed: entry.blobUploadFailed,
          });
        }
      } catch {
        // skip malformed
      }
    }

    // Fallback: match by itemName + wasteStream + confidence within a 60s window
    // Used for feedback entries that predate the requestId fix
    const MATCH_WINDOW_MS = 60_000;
    function findByProximity(e: FeedbackEntry) {
      return pilotEntries.find((p) => {
        const tDiff = new Date(e.timestamp).getTime() - new Date(p.timestamp).getTime();
        return (
          tDiff >= 0 &&
          tDiff <= MATCH_WINDOW_MS &&
          p.itemName === e.itemName &&
          p.wasteStream === e.predictedStream &&
          Math.abs(p.confidence - e.confidence) < 0.01
        );
      });
    }

    const entries: FeedbackEntry[] = feedbackRaw
      .map((item) => {
        try {
          return (typeof item === "string" ? JSON.parse(item) : item) as FeedbackEntry;
        } catch {
          return null;
        }
      })
      .filter((e): e is FeedbackEntry => e !== null)
      .filter((e) => e.feedback === "wrong");

    // Merge corrections + image info from pilot log
    const [corrections, names] = await Promise.all([
      redis.hgetall(CORRECTIONS_KEY) as Promise<Record<string, string> | null>,
      redis.hgetall(NAMES_KEY)       as Promise<Record<string, string> | null>,
    ]);

    const merged = entries.map((e) => {
      // Primary: match by requestId; fallback: match by proximity
      const imageInfo =
        (e.requestId ? imageByRequestId.get(e.requestId) : undefined) ??
        (() => { const p = findByProximity(e); return p ? { imageUrl: p.imageUrl, blobUploadFailed: p.blobUploadFailed } : {}; })();
      return {
        ...e,
        actualStream:     corrections?.[e.id] ?? e.actualStream   ?? null,
        actualItemName:   names?.[e.id]        ?? e.actualItemName ?? null,
        imageUrl:         e.imageUrl ?? imageInfo.imageUrl,
        blobUploadFailed: imageInfo.blobUploadFailed,
      };
    });

    // Newest first
    merged.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

    return NextResponse.json(merged);
  } catch (err) {
    console.error("[review] GET failed:", err);
    return NextResponse.json({ error: "Failed to load entries." }, { status: 500 });
  }
}

// ── DELETE: remove a single pilot-log entry by requestId ──

export async function DELETE(request: Request) {
  const denied = requireApiKey(request);
  if (denied) return denied;

  const { searchParams } = new URL(request.url);
  const requestId = searchParams.get("requestId");
  if (!requestId) {
    return NextResponse.json({ error: "requestId is required." }, { status: 400 });
  }

  try {
    // Find the entry in the pilot log list by scanning for the matching requestId
    const allRaw = await redis.lrange(KEYS.pilotLog, 0, -1);
    let removed = false;
    for (const item of allRaw) {
      try {
        const entry = (typeof item === "string" ? JSON.parse(item) : item) as PilotLogEntry;
        if (entry.requestId === requestId) {
          // LREM removes the first occurrence of the exact value
          const raw = typeof item === "string" ? item : JSON.stringify(item);
          await redis.lrem(KEYS.pilotLog, 1, raw);
          removed = true;
          break;
        }
      } catch {
        // skip malformed
      }
    }

    // Also clean up associated verdict/stream/name hashes
    await Promise.all([
      redis.hdel(VERDICTS_KEY, requestId),
      redis.hdel(VERDICT_STREAMS_KEY, requestId),
      redis.hdel(VERDICT_NAMES_KEY, requestId),
    ]);

    return NextResponse.json({ deleted: removed });
  } catch (err) {
    console.error("[review] DELETE failed:", err);
    return NextResponse.json({ error: "Failed to delete entry." }, { status: 500 });
  }
}

const CorrectionSchema = z.object({
  id: z.string(),
  actualStream:   z.string().optional(),
  actualItemName: z.string().optional(),
  // Full-review fields (keyed by requestId, not feedback id)
  requestId: z.string().optional(),
  verdict:   z.enum(["correct", "wrong", "false_detection"]).optional(),
  verdictStream: z.string().optional(), // correct stream when verdict is "wrong"
  correctedItemName: z.string().optional(), // corrected item name for fine-tuning
});

export async function POST(request: Request) {
  const denied = requireApiKey(request);
  if (denied) return denied;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }

  const parsed = CorrectionSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid body." }, { status: 400 });
  }

  try {
    const { id, actualStream, actualItemName, requestId, verdict, verdictStream, correctedItemName } = parsed.data;
    const ops: Promise<unknown>[] = [];

    // Legacy feedback corrections (keyed by feedback entry id)
    if (actualStream   !== undefined) ops.push(redis.hset(CORRECTIONS_KEY, { [id]: actualStream }));
    if (actualItemName !== undefined) ops.push(redis.hset(NAMES_KEY,       { [id]: actualItemName }));

    // Full-review verdicts (keyed by requestId from pilot log)
    if (requestId && verdict) {
      ops.push(redis.hset(VERDICTS_KEY, { [requestId]: verdict }));
      if (verdict === "wrong" && verdictStream) {
        ops.push(redis.hset(VERDICT_STREAMS_KEY, { [requestId]: verdictStream }));
      }
    }

    // Corrected item name (independent of verdict)
    if (requestId && correctedItemName !== undefined) {
      ops.push(redis.hset(VERDICT_NAMES_KEY, { [requestId]: correctedItemName }));
    }

    await Promise.all(ops);
    return NextResponse.json({ saved: true });
  } catch (err) {
    console.error("[review] POST failed:", err);
    return NextResponse.json({ error: "Failed to save correction." }, { status: 500 });
  }
}
