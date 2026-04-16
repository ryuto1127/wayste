/**
 * Shared cryptographic utilities for auth (admin + kiosk).
 *
 * Uses Web Crypto API so it works in both the Edge runtime (middleware.ts)
 * and Node runtime (API routes). All comparisons are constant-time so we
 * never leak secret bytes through response timing.
 */

/**
 * HMAC-SHA256 → lowercase hex string.
 *
 * Use this to derive a deterministic session token from a long-lived secret.
 * For per-session unique tokens, call `randomToken()` instead and store the
 * result server-side (e.g. in Redis).
 */
export async function hmacHex(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Constant-time string equality check.
 *
 * Both inputs are first hashed with SHA-256 so the per-byte compare always
 * runs over the same 32-byte length, regardless of input length or content.
 * This prevents timing oracles on both the length and the matching prefix.
 */
export async function timingSafeEqualStr(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [da, db] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  const va = new Uint8Array(da);
  const vb = new Uint8Array(db);
  let diff = 0;
  for (let i = 0; i < va.length; i++) diff |= va[i] ^ vb[i];
  return diff === 0;
}
