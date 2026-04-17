/**
 * Legacy authentication guards — NOT WIRED INTO THE CURRENT PIPELINE.
 *
 * Kiosk auth is now handled by `verifyKioskRequest` in lib/kiosk-auth.ts
 * (HMAC-signed `kiosk_session` cookie + `KIOSK_API_TOKEN` bearer token),
 * and admin auth is enforced by middleware.ts (HTTP Basic → 4-hour cookie).
 *
 * The two helpers below are kept only for reference; remove once no caller
 * is reachable from anywhere (currently nothing imports this file).
 */

import { NextResponse } from "next/server";

/**
 * @deprecated Use `verifyKioskRequest` from lib/kiosk-auth.ts instead.
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
 * @deprecated Admin auth runs via middleware.ts (HTTP Basic → session cookie).
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
