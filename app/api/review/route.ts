/**
 * GET  /api/review    — ALL pilot log entries for human review
 * POST /api/review    — save a human review verdict (correct / wrong / false_detection)
 * DELETE /api/review  — remove a single pilot-log entry
 *
 * Verdicts evaluate whether the model's predicted class name matches the image,
 * NOT whether the predicted waste stream is correct (streams are a site-config concern).
 */

import { NextResponse } from "next/server";
import { z } from "zod/v4";
import { redis, KEYS } from "@/lib/redis";
import type { PilotLogEntry } from "@/lib/types";
import { recordCalibrationVerdict } from "@/lib/calibration";

/** Human review verdicts for pilot log entries: requestId → "correct" | "wrong" | "false_detection" */
const VERDICTS_KEY = "recycling:review-verdicts";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const [pilotRaw, verdicts] = await Promise.all([
      redis.lrange(KEYS.pilotLog, 0, -1),
      redis.hgetall(VERDICTS_KEY) as Promise<Record<string, string> | null>,
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
  const { searchParams } = new URL(request.url);
  const requestId = searchParams.get("requestId");
  if (!requestId) {
    return NextResponse.json({ error: "requestId is required." }, { status: 400 });
  }

  try {
    const allRaw: string[] = await redis.lrange(KEYS.pilotLog, 0, -1);
    let removed = false;
    for (const item of allRaw) {
      try {
        const entry = (typeof item === "string" ? JSON.parse(item) : item) as PilotLogEntry;
        if (entry.requestId === requestId) {
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

    // Clean up verdict hash
    await redis.hdel(VERDICTS_KEY, requestId);

    return NextResponse.json({ deleted: removed });
  } catch (err) {
    console.error("[review] DELETE failed:", err);
    return NextResponse.json({ error: "Failed to delete entry." }, { status: 500 });
  }
}

const ReviewSchema = z.object({
  requestId: z.string(),
  verdict: z.enum(["correct", "wrong", "false_detection"]),
});

export async function POST(request: Request) {
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
    const { requestId, verdict } = parsed.data;
    await redis.hset(VERDICTS_KEY, { [requestId]: verdict });

    // Record calibration data — look up original confidence from pilot log
    try {
      const allRaw: string[] = await redis.lrange(KEYS.pilotLog, 0, 200);
      for (const item of allRaw) {
        const entry = (typeof item === "string" ? JSON.parse(item) : item) as PilotLogEntry;
        if (entry.requestId === requestId) {
          await recordCalibrationVerdict(
            entry.confidence,
            verdict === "correct",
          );
          break;
        }
      }
    } catch {
      // Best-effort — don't fail the verdict save
    }

    return NextResponse.json({ saved: true });
  } catch (err) {
    console.error("[review] POST failed:", err);
    return NextResponse.json({ error: "Failed to save verdict." }, { status: 500 });
  }
}
