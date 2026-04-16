/**
 * Next.js middleware — protects admin pages and their backing API routes.
 *
 * Protected paths:
 *   /review                        — admin review UI
 *   /api/review, /api/review/*     — review data + export
 *   /api/pilot-log GET / DELETE    — pilot log viewer + purge
 *   /api/pilot-image               — captured frame images
 *   /api/health                    — service health check
 *   /api/calibration               — model calibration data
 *
 * Kiosk-facing endpoints (/api/classify, /api/pilot-log POST,
 * /api/kiosk/session) are NOT gated here — they use kiosk-auth at route level
 * (see lib/kiosk-auth.ts).
 *
 * Auth method: HTTP Basic Auth (first login) → session cookie (subsequent)
 *   Username: admin (or anything)
 *   Password: value of ADMIN_API_KEY env var
 *
 * After successful Basic Auth, a session cookie (admin_session) is set so the
 * browser won't prompt for credentials again until the cookie expires (7 days).
 *
 * Dev mode: ADMIN_API_KEY not set → auth skipped ONLY on localhost.
 * In production (Vercel), missing ADMIN_API_KEY returns 500.
 */

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { hmacHex, timingSafeEqualStr } from "@/lib/crypto-utils";

const SESSION_COOKIE = "admin_session";
const SESSION_MAX_AGE = 60 * 60 * 4; // 4 hours
const SESSION_INFO = "wayste-admin-session-v1";

/** Paths that require admin Basic Auth. */
const ADMIN_PATHS = [
  "/review",
  "/api/review",
  "/api/pilot-log",
  "/api/pilot-image",
  "/api/health",
  "/api/calibration",
];

function isAdminPath(pathname: string): boolean {
  return ADMIN_PATHS.some(
    (p) => pathname === p || pathname.startsWith(p + "/")
  );
}

/**
 * Proper HMAC-SHA256 session token. The cookie value is deterministic
 * (HMAC of a fixed label keyed by ADMIN_API_KEY), so rotating
 * ADMIN_API_KEY invalidates every existing admin session at once.
 *
 * For per-session revocation in the future, replace this with a random
 * token + Redis-backed session table.
 */
async function makeSessionToken(adminKey: string): Promise<string> {
  return hmacHex(adminKey, SESSION_INFO);
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Only protect admin paths
  if (!isAdminPath(pathname)) return NextResponse.next();

  // /api/pilot-log POST is a kiosk endpoint — let it through to route-level kiosk auth
  if (pathname === "/api/pilot-log" && request.method === "POST") {
    return NextResponse.next();
  }

  const adminKey = process.env.ADMIN_API_KEY;

  if (!adminKey) {
    // Only skip auth on localhost (dev mode). In production, refuse to run unprotected.
    const host = request.headers.get("host") ?? "";
    if (host.startsWith("localhost") || host.startsWith("127.0.0.1")) {
      return NextResponse.next();
    }
    return new NextResponse(
      "Server misconfiguration: ADMIN_API_KEY is not set.",
      { status: 500 }
    );
  }

  const expectedToken = await makeSessionToken(adminKey);

  // 1. Check session cookie first (no password prompt)
  const sessionCookie = request.cookies.get(SESSION_COOKIE)?.value;
  if (sessionCookie && (await timingSafeEqualStr(sessionCookie, expectedToken))) {
    return NextResponse.next();
  }

  // 2. Check x-api-key header (for programmatic access / curl)
  const apiKey = request.headers.get("x-api-key");
  if (apiKey && (await timingSafeEqualStr(apiKey, adminKey))) {
    const res = NextResponse.next();
    res.cookies.set(SESSION_COOKIE, expectedToken, {
      httpOnly: true,
      secure: request.nextUrl.protocol === "https:",
      sameSite: "lax",
      maxAge: SESSION_MAX_AGE,
      path: "/",
    });
    return res;
  }

  // 3. Check HTTP Basic Auth — set session cookie on success
  const authHeader = request.headers.get("authorization");
  if (authHeader?.startsWith("Basic ")) {
    try {
      const decoded = atob(authHeader.slice(6));
      const password = decoded.includes(":") ? decoded.split(":").slice(1).join(":") : decoded;
      if (await timingSafeEqualStr(password, adminKey)) {
        const res = NextResponse.next();
        res.cookies.set(SESSION_COOKIE, expectedToken, {
          httpOnly: true,
          secure: request.nextUrl.protocol === "https:",
          sameSite: "lax",
          maxAge: SESSION_MAX_AGE,
          path: "/",
        });
        return res;
      }
    } catch {
      // Invalid base64 — fall through to 401
    }
  }

  // Deny: return 401 with WWW-Authenticate to trigger browser login dialog
  return new NextResponse("Authentication required", {
    status: 401,
    headers: {
      "WWW-Authenticate": 'Basic realm="Wayste Admin"',
    },
  });
}

export const config = {
  // Only run middleware on admin paths (skip static files, images, etc.)
  matcher: [
    "/review/:path*",
    "/api/review/:path*",
    "/api/pilot-log",
    "/api/pilot-image/:path*",
    "/api/health",
    "/api/calibration",
  ],
};
