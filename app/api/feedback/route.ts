import { NextResponse } from "next/server";
import { z } from "zod/v4";
import { redis, KEYS, MAX_ENTRIES } from "@/lib/redis";

const FeedbackSchema = z.object({
  itemName: z.string(),
  predictedStream: z.string(),
  confidence: z.number(),
  feedback: z.enum(["correct", "wrong"]),
  actualStream: z.string().optional(),
  siteId: z.string().optional(),
  imageUrl: z.string().optional(),
});

export async function POST(request: Request) {
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

  return NextResponse.json({ saved: true, id: entry.id });
}
