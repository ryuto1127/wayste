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
 * Auth method: HTTP Basic Auth
 *   Username: admin (or anything)
 *   Password: value of ADMIN_API_KEY env var
 *
 * If ADMIN_API_KEY is not set (dev mode), all requests pass through.
 *
 * The kiosk main page (/) and kiosk POST endpoints (/api/classify,
 * /api/feedback, /api/pilot-log POST) are NOT affected — they use
 * their own kiosk token auth.
 */

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

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
  // NOTE: /api/kiosk-stats is intentionally NOT here — it's fetched by the
  // public kiosk IdleScreen and only returns aggregate counts (no images/PII).
  // Protecting it triggers the browser's Basic Auth dialog on the main page.
];

function isAdminPath(pathname: string): boolean {
  return ADMIN_PATHS.some(
    (p) => pathname === p || pathname.startsWith(p + "/")
  );
}

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Only protect admin paths
  if (!isAdminPath(pathname)) return NextResponse.next();

  // /api/pilot-log POST is a kiosk endpoint — let it through to route-level kiosk auth
  if (pathname === "/api/pilot-log" && request.method === "POST") {
    return NextResponse.next();
  }

  // /api/feedback POST goes through kiosk auth, not admin auth
  // (feedback-stats GET is protected below)

  const adminKey = process.env.ADMIN_API_KEY;

  // Dev mode: no key configured → allow everything
  if (!adminKey) return NextResponse.next();

  // Check HTTP Basic Auth
  const authHeader = request.headers.get("authorization");
  if (authHeader?.startsWith("Basic ")) {
    try {
      const decoded = atob(authHeader.slice(6));
      // Accept any username, password must match ADMIN_API_KEY
      const password = decoded.includes(":") ? decoded.split(":").slice(1).join(":") : decoded;
      if (password === adminKey) {
        return NextResponse.next();
      }
    } catch {
      // Invalid base64 — fall through to 401
    }
  }

  // Also accept x-api-key header (for programmatic access / curl)
  const apiKey = request.headers.get("x-api-key");
  if (apiKey === adminKey) {
    return NextResponse.next();
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
