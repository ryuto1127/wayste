/**
 * Client-side auth header builder for kiosk API calls.
 *
 * In production kiosk deployments, NEXT_PUBLIC_KIOSK_TOKEN is set as a
 * build-time env var on the kiosk device. The token never leaves the
 * local network. In dev mode, no token is needed (server skips auth).
 */

export function kioskAuthHeaders(): Record<string, string> {
  const token = typeof window !== "undefined"
    ? (window as unknown as Record<string, string>).__KIOSK_TOKEN__
    : undefined;
  const envToken = process.env.NEXT_PUBLIC_KIOSK_TOKEN;
  const t = token ?? envToken;
  if (!t) return {};
  return { Authorization: `Bearer ${t}` };
}
