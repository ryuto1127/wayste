/**
 * GET /api/session — Issue a fresh session token.
 *
 * Rate limited: 6 tokens per IP per 10 minutes.
 * Used by the kiosk client to refresh expired tokens without a full page reload.
 */

import { NextResponse } from "next/server";
import { generateSessionToken } from "@/lib/session-token";
import { redis } from "@/lib/redis";

const SESSION_RL_MAX = 6;
const SESSION_RL_TTL_S = 600; // 10 minutes

export async function GET(request: Request) {
  // Rate limit session creation per IP
  const clientIp =
    request.headers.get("x-real-ip")
    ?? request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    ?? "unknown";
  const rlKey = `rl:session:${clientIp}`;

  try {
    const count = await redis.incr(rlKey);
    if (count === 1) await redis.expire(rlKey, SESSION_RL_TTL_S);
    if (count > SESSION_RL_MAX) {
      return NextResponse.json(
        { error: "Too many session requests. Please wait." },
        { status: 429 }
      );
    }
  } catch {
    // Redis unavailable — allow through
  }

  const token = generateSessionToken();
  return NextResponse.json({ token });
}
