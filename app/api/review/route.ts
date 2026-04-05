/**
 * GET  /api/review    — ALL pilot log entries for human review
 * POST /api/review    — save a human review verdict
 * DELETE /api/review  — remove a single pilot-log entry
 */

import { NextResponse } from "next/server";
import { z } from "zod/v4";
import { redis, KEYS } from "@/lib/redis";
import type { PilotLogEntry } from "@/lib/types";

/** Human review verdicts for pilot log entries: requestId → "correct" | "wrong" | "false_detection" */
const VERDICTS_KEY    = "recycling:review-verdicts";
/** When verdict is "wrong", the correct stream: requestId → stream */
const VERDICT_STREAMS_KEY = "recycling:review-verdicts:streams";
/** Corrected item names for full review: requestId → correctedItemName */
const VERDICT_NAMES_KEY   = "recycling:review-verdicts:names";

export const dynamic = "force-dynamic";

export async function GET() {
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
    console.error("[review] GET failed:", err);
    return NextResponse.json({ error: "Failed to load entries." }, { status: 500 });
  }
}

// ── DELETE: remove a single pilot-log entry by requestId ──

export async function DELETE(request: Request) {
  // Auth is handled by middleware (session cookie / Basic Auth).

  const { searchParams } = new URL(request.url);
  const requestId = searchParams.get("requestId");
  if (!requestId) {
    return NextResponse.json({ error: "requestId is required." }, { status: 400 });
  }

  try {
    // Find the entry in the pilot log list by scanning for the matching requestId.
    // NOTE: Upstash auto-deserialises JSON, so items come back as objects.
    // redis.lrem needs the EXACT stored string to match, so we must use a
    // raw HTTP call that returns unparsed strings to guarantee the value we
    // pass to LREM is byte-identical to what Redis holds.
    const allRaw: string[] = await redis.lrange(KEYS.pilotLog, 0, -1);
    let removed = false;
    for (const item of allRaw) {
      try {
        const entry = (typeof item === "string" ? JSON.parse(item) : item) as PilotLogEntry;
        if (entry.requestId === requestId) {
          // Re-fetch the index and remove by index atomically using a pipeline:
          // We already know the position, so use LSET + LREM with a sentinel.
          const idx = allRaw.indexOf(item);
          const sentinel = `__DELETED__${Date.now()}`;
          const pipe = redis.pipeline();
          pipe.lset(KEYS.pilotLog, idx, sentinel);
          pipe.lrem(KEYS.pilotLog, 1, sentinel);
          await pipe.exec();
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

const ReviewSchema = z.object({
  id: z.string(),
  requestId: z.string(),
  verdict:   z.enum(["correct", "wrong", "false_detection"]).optional(),
  verdictStream: z.string().optional(),
  correctedItemName: z.string().optional(),
});

export async function POST(request: Request) {
  // Auth is handled by middleware (session cookie / Basic Auth).

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }

  const parsed = ReviewSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid body." }, { status: 400 });
  }

  try {
    const { requestId, verdict, verdictStream, correctedItemName } = parsed.data;
    const ops: Promise<unknown>[] = [];

    if (verdict) {
      ops.push(redis.hset(VERDICTS_KEY, { [requestId]: verdict }));
      if (verdict === "wrong" && verdictStream) {
        ops.push(redis.hset(VERDICT_STREAMS_KEY, { [requestId]: verdictStream }));
      }
    }

    if (correctedItemName !== undefined) {
      ops.push(redis.hset(VERDICT_NAMES_KEY, { [requestId]: correctedItemName }));
    }

    await Promise.all(ops);
    return NextResponse.json({ saved: true });
  } catch (err) {
    console.error("[review] POST failed:", err);
    return NextResponse.json({ error: "Failed to save correction." }, { status: 500 });
  }
}
