/**
 * Lightweight API-key guard for admin endpoints.
 *
 * If ADMIN_API_KEY is set in env, requests must include a matching
 * `x-api-key` header. If the env var is unset, auth is skipped
 * (convenient for local development).
 *
 * Usage in an API route:
 *   const denied = requireApiKey(request);
 *   if (denied) return denied;
 */

import { NextResponse } from "next/server";

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
