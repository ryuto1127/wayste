/**
 * Lightweight structured logging for pilot evaluation.
 * Appends entries to Upstash Redis (recycling:pilot-log list).
 * Falls back silently — never blocks the classification response.
 */

import { redis, KEYS, MAX_ENTRIES } from "./redis";
import type { PilotLogEntry } from "./types";

export async function logPilotEntry(entry: PilotLogEntry): Promise<void> {
  try {
    await redis.rpush(KEYS.pilotLog, JSON.stringify(entry));
    // Trim to keep only the most recent MAX_ENTRIES
    await redis.ltrim(KEYS.pilotLog, -MAX_ENTRIES, -1);
  } catch {
    // best-effort — never block the response
  }
}
