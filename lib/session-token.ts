/**
 * Server-side session tokens for kiosk API protection.
 *
 * Tokens are HMAC-signed with a server secret and contain:
 *   - Creation timestamp (base36)
 *   - Random nonce
 *   - HMAC-SHA256 signature (truncated to 16 hex chars)
 *
 * Each token allows a limited number of classify requests (TOKEN_MAX_REQUESTS)
 * and expires after TOKEN_TTL_MS. This prevents direct API abuse while keeping
 * the main page publicly accessible.
 *
 * Flow:
 *   1. page.tsx (server component) calls generateSessionToken()
 *   2. Token is passed to KioskDisplay as a prop
 *   3. Client sends token in x-session-token header with API requests
 *   4. API routes call validateSessionToken() to verify + rate-limit
 *   5. Client refreshes token via /api/session every few hours
 */

import crypto from "crypto";

// Use OPENAI_API_KEY as HMAC secret — it's already a secret on the server
// and avoids adding yet another env var. Falls back to a dev key.
const SECRET = process.env.OPENAI_API_KEY ?? "dev-session-secret";

/** Token validity period. */
const TOKEN_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours

/** Max classify requests per token. */
export const TOKEN_MAX_REQUESTS = 200;

/**
 * Generate a signed session token (server-side only).
 * Safe to embed in HTML — the signature cannot be forged without the secret.
 */
export function generateSessionToken(): string {
  const timestamp = Date.now().toString(36);
  const nonce = crypto.randomBytes(8).toString("hex");
  const payload = `${timestamp}.${nonce}`;
  const sig = crypto
    .createHmac("sha256", SECRET)
    .update(payload)
    .digest("hex")
    .slice(0, 16);
  return `${payload}.${sig}`;
}

/**
 * Validate a session token's signature and expiry.
 * Returns { valid: true, nonce } on success, or { valid: false, reason } on failure.
 */
export function validateSessionToken(
  token: string
): { valid: true; nonce: string } | { valid: false; reason: string } {
  if (!token || typeof token !== "string") {
    return { valid: false, reason: "missing" };
  }

  const parts = token.split(".");
  if (parts.length !== 3) {
    return { valid: false, reason: "malformed" };
  }

  const [timestamp, nonce, sig] = parts;

  // Verify signature
  const payload = `${timestamp}.${nonce}`;
  const expected = crypto
    .createHmac("sha256", SECRET)
    .update(payload)
    .digest("hex")
    .slice(0, 16);

  if (sig !== expected) {
    return { valid: false, reason: "invalid_signature" };
  }

  // Check expiry
  const ts = parseInt(timestamp, 36);
  if (isNaN(ts) || Date.now() - ts > TOKEN_TTL_MS) {
    return { valid: false, reason: "expired" };
  }

  return { valid: true, nonce };
}
