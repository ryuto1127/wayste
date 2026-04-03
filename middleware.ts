/**
 * Next.js middleware — protects admin pages and their backing API routes.
 *
 * Protected paths:
 *   /dashboard, /review            — admin UI pages
 *   /api/stats-stream              — SSE for dashboard
 *   /api/feedback-stats            — dashboard stats
 *   /api/review, /api/review/*     — review data + export
 *   /api/pilot-log GET             — pilot log viewer
 *   /api/overrides                 — override management
 *   /api/pilot-image               — captured frame images
 *
 * Auth method: HTTP Basic Auth (first login) → session cookie (subsequent)
 *   Username: admin (or anything)
 *   Password: value of ADMIN_API_KEY env var
 *
 * After successful Basic Auth, a session cookie (admin_session) is set so the
 * browser won't prompt for credentials again until the cookie expires (7 days).
 *
 * If ADMIN_API_KEY is not set (dev mode), all requests pass through.
 */

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

const SESSION_COOKIE = "admin_session";
const SESSION_MAX_AGE = 60 * 60 * 24 * 7; // 7 days

/** Paths that require admin Basic Auth. */
const ADMIN_PATHS = [
  "/dashboard",
  "/review",
  "/api/stats-stream",
  "/api/feedback-stats",
  "/api/review",
  "/api/pilot-log",
  "/api/overrides",
  "/api/pilot-image",
];

function isAdminPath(pathname: string): boolean {
  return ADMIN_PATHS.some(
    (p) => pathname === p || pathname.startsWith(p + "/")
  );
}

/**
 * Simple HMAC-like session token using Web Crypto.
 * Token = hex(SHA-256(adminKey + ":admin-session-salt"))
 */
async function makeSessionToken(adminKey: string): Promise<string> {
  const data = new TextEncoder().encode(adminKey + ":admin-session-salt");
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, "0")).join("");
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

  // Dev mode: no key configured → allow everything
  if (!adminKey) return NextResponse.next();

  const expectedToken = await makeSessionToken(adminKey);

  // 1. Check session cookie first (no password prompt)
  const sessionCookie = request.cookies.get(SESSION_COOKIE)?.value;
  if (sessionCookie === expectedToken) {
    return NextResponse.next();
  }

  // 2. Check x-api-key header (for programmatic access / curl)
  const apiKey = request.headers.get("x-api-key");
  if (apiKey === adminKey) {
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
      if (password === adminKey) {
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
      "WWW-Authenticate": 'Basic realm="Recycling Buddy Admin"',
    },
  });
}

export const config = {
  // Only run middleware on admin paths (skip static files, images, etc.)
  matcher: [
    "/dashboard/:path*",
    "/review/:path*",
    "/api/stats-stream",
    "/api/feedback-stats",
    "/api/review/:path*",
    "/api/pilot-log",
    "/api/overrides/:path*",
    "/api/pilot-image/:path*",
  ],
};
