/**
 * Server-side kiosk authentication.
 *
 * Protects kiosk-facing endpoints (/api/classify, /api/pilot-log POST) by
 * requiring either:
 *   1. A `kiosk_session` cookie (set by POST /api/kiosk/session), OR
 *   2. An `Authorization: Bearer <KIOSK_API_TOKEN>` header (programmatic).
 *
 * The kiosk token lives in `KIOSK_API_TOKEN` — a server-only env var.
 * It is NEVER exposed to the browser bundle (no `NEXT_PUBLIC_*` prefix).
 *
 * Dev mode: if `KIOSK_API_TOKEN` is unset AND the request host is localhost,
 * auth is skipped. In production the env var is required.
 *
 * All comparisons use constant-time digest comparison to avoid timing oracles.
 */
import { NextResponse } from "next/server";

export const KIOSK_SESSION_COOKIE = "kiosk_session";
/** 30 days — kiosks are long-lived trusted devices. Rotate KIOSK_API_TOKEN to revoke. */
export const KIOSK_SESSION_MAX_AGE = 60 * 60 * 24 * 30;

const SESSION_INFO = "wayste-kiosk-session-v1";

/**
 * Derive the session-cookie value from the kiosk token using HMAC-SHA256.
 * The cookie value is deterministic, so a leaked cookie is equivalent to a
 * leaked token — compromise requires rotating KIOSK_API_TOKEN.
 */
export async function makeKioskSessionToken(kioskToken: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(kioskToken),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(SESSION_INFO));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Constant-time comparison of two strings via SHA-256 digest equality. */
async function timingSafeEqualStr(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [digA, digB] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  const va = new Uint8Array(digA);
  const vb = new Uint8Array(digB);
  let diff = 0;
  for (let i = 0; i < va.length; i++) diff |= va[i] ^ vb[i];
  return diff === 0;
}

function isLocalhostHost(host: string | null): boolean {
  if (!host) return false;
  // Strip port
  const h = host.split(":")[0];
  return h === "localhost" || h === "127.0.0.1" || h === "::1";
}

/** Derive the effective hostname from either the Host header or request URL. */
function hostnameOf(request: Request): string | null {
  const header = request.headers.get("host");
  if (header) return header;
  try {
    return new URL(request.url).host;
  } catch {
    return null;
  }
}

export type KioskAuthResult =
  | { ok: true; devBypass?: true }
  | { ok: false; response: NextResponse };

/**
 * Verify that an incoming request is an authenticated kiosk.
 * Returns `{ ok: true }` or `{ ok: false, response }` — caller should return
 * the 401 response immediately on failure.
 */
export async function verifyKioskRequest(request: Request): Promise<KioskAuthResult> {
  const kioskToken = process.env.KIOSK_API_TOKEN;
  const host = hostnameOf(request);

  // Dev bypass: no token configured + localhost = allow (seamless `npm run dev`)
  if (!kioskToken) {
    if (isLocalhostHost(host)) return { ok: true, devBypass: true };
    return {
      ok: false,
      response: NextResponse.json(
        { error: "Server misconfiguration: KIOSK_API_TOKEN is not set." },
        { status: 500 },
      ),
    };
  }

  // 1. Session cookie
  const cookieHeader = request.headers.get("cookie") ?? "";
  const cookieMatch = cookieHeader.match(
    new RegExp(`(?:^|;\\s*)${KIOSK_SESSION_COOKIE}=([^;]+)`),
  );
  if (cookieMatch) {
    const presented = decodeURIComponent(cookieMatch[1]);
    const expected = await makeKioskSessionToken(kioskToken);
    if (await timingSafeEqualStr(presented, expected)) {
      return { ok: true };
    }
  }

  // 2. Bearer token (programmatic / unlock)
  const authHeader = request.headers.get("authorization");
  if (authHeader?.startsWith("Bearer ")) {
    const presented = authHeader.slice(7).trim();
    if (await timingSafeEqualStr(presented, kioskToken)) {
      return { ok: true };
    }
  }

  return {
    ok: false,
    response: NextResponse.json(
      { error: "Kiosk authentication required." },
      { status: 401 },
    ),
  };
}
