/**
 * GET  /api/review         — all "wrong" feedback entries, merged with saved corrections
 * POST /api/review         — save a human correction { id, actualStream }
 */

import { NextResponse } from "next/server";
import { z } from "zod/v4";
import { redis, KEYS } from "@/lib/redis";
import type { FeedbackEntry } from "@/lib/types";

const CORRECTIONS_KEY = "recycling:corrections";       // Redis hash: id → actualStream
const NAMES_KEY       = "recycling:corrections:names"; // Redis hash: id → actualItemName

export async function GET() {
  try {
    // Load all feedback entries
    const raw = await redis.lrange(KEYS.feedback, 0, -1);
    const entries: FeedbackEntry[] = raw
      .map((item) => {
        try {
          return (typeof item === "string" ? JSON.parse(item) : item) as FeedbackEntry;
        } catch {
          return null;
        }
      })
      .filter((e): e is FeedbackEntry => e !== null)
      .filter((e) => e.feedback === "wrong");

    // Merge any saved corrections
    const [corrections, names] = await Promise.all([
      redis.hgetall(CORRECTIONS_KEY) as Promise<Record<string, string> | null>,
      redis.hgetall(NAMES_KEY)       as Promise<Record<string, string> | null>,
    ]);
    const merged = entries.map((e) => ({
      ...e,
      actualStream:   corrections?.[e.id] ?? e.actualStream   ?? null,
      actualItemName: names?.[e.id]        ?? e.actualItemName ?? null,
    }));

    // Newest first
    merged.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

    return NextResponse.json(merged);
  } catch (err) {
    console.error("[review] GET failed:", err);
    return NextResponse.json({ error: "Failed to load entries." }, { status: 500 });
  }
}

const CorrectionSchema = z.object({
  id: z.string(),
  actualStream:   z.string().optional(),
  actualItemName: z.string().optional(),
});

export async function POST(request: Request) {
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
    const { id, actualStream, actualItemName } = parsed.data;
    const ops: Promise<unknown>[] = [];
    if (actualStream   !== undefined) ops.push(redis.hset(CORRECTIONS_KEY, { [id]: actualStream }));
    if (actualItemName !== undefined) ops.push(redis.hset(NAMES_KEY,       { [id]: actualItemName }));
    await Promise.all(ops);
    return NextResponse.json({ saved: true });
  } catch (err) {
    console.error("[review] POST failed:", err);
    return NextResponse.json({ error: "Failed to save correction." }, { status: 500 });
  }
}
