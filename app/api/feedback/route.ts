import { NextResponse } from "next/server";
import { appendFileSync, existsSync, writeFileSync } from "fs";
import { join } from "path";
import { z } from "zod/v4";

const FeedbackSchema = z.object({
  itemName: z.string(),
  predictedStream: z.string(),
  confidence: z.number(),
  feedback: z.enum(["correct", "wrong"]),
  actualStream: z.string().optional(),
  siteId: z.string().optional(),
});

const FEEDBACK_PATH = join(process.cwd(), "data", "feedback.jsonl");

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
    if (!existsSync(FEEDBACK_PATH)) {
      writeFileSync(FEEDBACK_PATH, "");
    }
    appendFileSync(FEEDBACK_PATH, JSON.stringify(entry) + "\n");
  } catch (err) {
    console.error("Failed to write feedback:", err);
    return NextResponse.json(
      { error: "Failed to save feedback." },
      { status: 500 }
    );
  }

  return NextResponse.json({ saved: true, id: entry.id });
}
