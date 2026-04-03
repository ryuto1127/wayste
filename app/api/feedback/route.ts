import { NextResponse } from "next/server";
import { z } from "zod/v4";
import { redis, KEYS, MAX_ENTRIES } from "@/lib/redis";
import { runInBackground } from "@/lib/background-task";
import { checkAndApplyAutoOverride } from "@/lib/auto-override";
import { requireKioskAuth } from "@/lib/auth";

const FeedbackSchema = z.object({
  itemName: z.string(),
  predictedStream: z.string(),
  confidence: z.number(),
  feedback: z.enum(["correct", "wrong"]),
  actualStream: z.string().optional(),
  siteId: z.string().optional(),
  imageUrl: z.string().optional(),
  requestId: z.string().optional(),
});

// ── Feedback rate limiting ──
// Prevents feedback spam/gaming: max 3 feedback entries per item per 5-minute window per client.
const FEEDBACK_RL_MAX = 3;
const FEEDBACK_RL_TTL_S = 300; // 5 minutes

export async function POST(request: Request) {
  // ── Kiosk token auth ──
  const authDenied = requireKioskAuth(request);
  if (authDenied) return authDenied;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }

  const parsed = FeedbackSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid feedback.", details: parsed.error.issues },
      { status: 400 }
    );
  }

  // ── Per-item feedback rate limiting ──
  const clientIp =
    request.headers.get("x-real-ip")
    ?? request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    ?? "unknown";
  const fbRlKey = `rl:feedback:${clientIp}:${parsed.data.itemName.toLowerCase().replace(/\s+/g, "-")}`;
  try {
    const count = await redis.incr(fbRlKey);
    if (count === 1) await redis.expire(fbRlKey, FEEDBACK_RL_TTL_S);
    if (count > FEEDBACK_RL_MAX) {
      return NextResponse.json(
        { error: "Too many feedback submissions for this item. Please wait." },
        { status: 429 }
      );
    }
  } catch {
    // Redis unavailable — allow through
  }

  const entry = {
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    ...parsed.data,
    siteId: parsed.data.siteId ?? process.env.SITE_ID ?? "default",
  };

  try {
    await redis.rpush(KEYS.feedback, JSON.stringify(entry));
    await redis.ltrim(KEYS.feedback, -MAX_ENTRIES, -1);
  } catch (err) {
    console.error("Failed to write feedback:", err);
    return NextResponse.json(
      { error: "Failed to save feedback." },
      { status: 500 }
    );
  }

  // Auto-apply override if enough consistent corrections exist (fire-and-forget)
  if (parsed.data.feedback === "wrong" && parsed.data.actualStream) {
    runInBackground(
      checkAndApplyAutoOverride(entry.siteId, entry.itemName, parsed.data.actualStream)
    );
  }

  return NextResponse.json({ saved: true, id: entry.id });
}
