/**
 * Authentication guards for API endpoints.
 *
 * Two tiers:
 *   1. Kiosk token — lightweight bearer token for kiosk endpoints (classify, feedback, pilot-log).
 *      Set KIOSK_API_TOKEN in env. If unset, auth is skipped (dev mode).
 *      Kiosk devices send `Authorization: Bearer <token>` header.
 *
 *   2. Admin API key — for admin endpoints (overrides, review).
 *      Set ADMIN_API_KEY in env. If unset, auth is skipped (dev mode).
 *      Admins send `x-api-key: <key>` header.
 */

import { NextResponse } from "next/server";

/**
 * Guard for kiosk-facing endpoints (classify, feedback, pilot-log).
 * Returns null if authorized, otherwise returns a 401 response.
 * Skipped in dev mode when KIOSK_API_TOKEN is not set.
 */
export function requireKioskAuth(request: Request): NextResponse | null {
  const expected = process.env.KIOSK_API_TOKEN;

  // Dev mode: if no token configured, allow all requests
  if (!expected) return null;

  const authHeader = request.headers.get("authorization");
  const provided = authHeader?.startsWith("Bearer ")
    ? authHeader.slice(7)
    : null;

  if (provided === expected) return null;

  return NextResponse.json(
    { error: "Unauthorized. Provide a valid Authorization: Bearer <token> header." },
    { status: 401 }
  );
}

/**
 * Guard for admin endpoints (overrides, review export).
 * Returns null if authorized, otherwise returns a 401 response.
 * Skipped in dev mode when ADMIN_API_KEY is not set.
 */
export function requireApiKey(request: Request): NextResponse | null {
  const expected = process.env.ADMIN_API_KEY;

  // Dev mode: if no key configured, allow all requests
  if (!expected) return null;

  const provided = request.headers.get("x-api-key");
  if (provided === expected) return null;

  return NextResponse.json(
    { error: "Unauthorized. Provide a valid x-api-key header." },
    { status: 401 }
  );
}
