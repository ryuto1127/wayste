/**
 * Minimal audit log for admin and kiosk session minting events.
 *
 * Only the moments that change who-can-do-what are recorded:
 *   - admin.login          — Basic Auth or x-api-key succeeded
 *   - admin.login_fail     — bad password or bad api key
 *   - kiosk.session_mint   — bearer token exchanged for session cookie
 *
 * This intentionally does NOT log every /review request or every
 * /api/classify call — that would quickly fill the 2000-entry Redis list.
 * What we want for incident response is "who got access, from where, when".
 *
 * Entries are kept for up to 2000 rows (LTRIM) in `audit:events`.
 * Uses `runInBackground` so auth responses never block on Redis.
 */
import { redis } from "@/lib/redis";

const KEY = "audit:events";
const MAX_ENTRIES = 2000;

export type AuditEventType =
  | "admin.login"
  | "admin.login_fail"
  | "kiosk.session_mint";

export interface AuditEvent {
  type: AuditEventType;
  timestamp: string;
  /** Loose identifier — IP, host, or "unknown". Not personally identifying. */
  source?: string;
  /** Path that was being accessed. Helps reconstruct intent. */
  path?: string;
  /** Arbitrary non-sensitive context. Do NOT put secrets here. */
  extra?: Record<string, string | number | boolean>;
}

/**
 * Fire-and-forget audit write — must not slow down auth paths or hold up
 * the response. If Redis is down, auth still works; we just lose the log
 * line (operator will see other errors first).
 *
 * Works in both Node and Edge runtimes since @upstash/redis is HTTP-based.
 * In Edge middleware, the write runs during response streaming; on Node
 * routes, it runs alongside the response. Either way, never awaited.
 */
export function recordAudit(event: Omit<AuditEvent, "timestamp">): void {
  const row: AuditEvent = { ...event, timestamp: new Date().toISOString() };
  const p = (async () => {
    await redis.lpush(KEY, JSON.stringify(row));
    await redis.ltrim(KEY, 0, MAX_ENTRIES - 1);
  })();
  p.catch((err) => console.warn("[audit]", row.type, "write failed:", err));
}

/** Extract a best-effort caller identity for logging. Never personally identifies. */
export function callerSource(request: Request): string {
  return (
    request.headers.get("x-real-ip")
    ?? request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    ?? request.headers.get("host")
    ?? "unknown"
  );
}
