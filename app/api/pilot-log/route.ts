import { NextResponse } from "next/server";
import { redis, KEYS, MAX_ENTRIES } from "@/lib/redis";
import { logPilotEntry } from "@/lib/pilot-log";
import { uploadFrameToBlob } from "@/lib/blob-store";
import { runInBackground } from "@/lib/background-task";
import { generateRequestId } from "@/lib/request-id";
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
        yoloDetections: entry.yoloDetections,
      });
    })()
  );

  return NextResponse.json({ logged: true, requestId });
}
