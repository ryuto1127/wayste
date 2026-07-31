/**
 * POST /api/kiosk/session — Exchange the kiosk bearer token for a session cookie.
 *
 * Usage (one-time per kiosk device, during setup):
 *   curl -X POST https://kiosk.example/api/kiosk/session \
 *        -H "Authorization: Bearer $KIOSK_API_TOKEN" \
 *        -c cookie.txt
 *
 * After this call, the device's browser holds a HttpOnly `kiosk_session`
 * cookie that is sent automatically on subsequent /api/classify and
 * /api/pilot-log POST requests. The raw token never touches the browser
 * JS heap.
 *
 * Revocation: rotate `KIOSK_API_TOKEN` — all existing session cookies become
 * invalid (the cookie value is a deterministic HMAC of the token).
 */
import { NextResponse } from "next/server";
import {
  KIOSK_SESSION_COOKIE,
  KIOSK_SESSION_MAX_AGE,
  makeKioskSessionToken,
  verifyKioskRequest,
} from "@/lib/kiosk-auth";
import { recordAudit, callerSource } from "@/lib/audit-log";
import { redis } from "@/lib/redis";

/** Max unlock attempts per IP per window — this endpoint verifies a
 *  long-lived bearer secret, so online guessing must be throttled. */
const UNLOCK_RATE_MAX = 10;
const UNLOCK_RATE_TTL_S = 60;

export async function POST(request: Request) {
  const source = callerSource(request);

  // ── Rate limit token-guessing (fail-open if Redis is down) ──
  try {
    const rlKey = `rl:kiosk-session:${source}`;
    const count = await redis.incr(rlKey);
    if (count === 1) {
      await redis.expire(rlKey, UNLOCK_RATE_TTL_S);
    }
    if (count > UNLOCK_RATE_MAX) {
      return NextResponse.json(
        { error: "rate_limited" },
        { status: 429 },
      );
    }
  } catch (err) {
    console.warn("[kiosk/session] rate-limit unavailable, allowing:", err);
  }

  const auth = await verifyKioskRequest(request);
  if (!auth.ok) {
    // Symmetric with admin.login_fail — failed unlock attempts are audited.
    recordAudit({ type: "kiosk.session_fail", source });
    return auth.response;
  }

  const kioskToken = process.env.KIOSK_API_TOKEN;
  // verifyKioskRequest either returned ok=true because token+bearer matched,
  // or because of dev bypass. Only mint a cookie if a real token exists.
  if (!kioskToken) {
    return NextResponse.json({ ok: true, devBypass: true });
  }

  recordAudit({ type: "kiosk.session_mint", source: callerSource(request) });
  const sessionValue = await makeKioskSessionToken(kioskToken);
  const res = NextResponse.json({ ok: true });
  const url = new URL(request.url);
  res.cookies.set(KIOSK_SESSION_COOKIE, sessionValue, {
    httpOnly: true,
    secure: url.protocol === "https:",
    sameSite: "strict",
    maxAge: KIOSK_SESSION_MAX_AGE,
    path: "/",
  });
  return res;
}

export async function DELETE(request: Request) {
  // Allow kiosks to clear their own session without auth (just invalidates the cookie).
  const res = NextResponse.json({ ok: true });
  const url = new URL(request.url);
  res.cookies.set(KIOSK_SESSION_COOKIE, "", {
    httpOnly: true,
    secure: url.protocol === "https:",
    sameSite: "strict",
    maxAge: 0,
    path: "/",
  });
  return res;
}
