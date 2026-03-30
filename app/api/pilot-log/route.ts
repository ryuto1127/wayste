import { NextResponse } from "next/server";
import { redis, KEYS } from "@/lib/redis";
import type { PilotLogEntry } from "@/lib/types";

export async function GET() {
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
