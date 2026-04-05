/**
 * Compute today's kiosk display stats from pilot-log and admin review
 * verdicts. Review verdicts are the single source of truth — kiosk
 * feedback is ignored. Only admin-reviewed items are counted.
 */

import { redis, KEYS } from "./redis";
import type { PilotLogEntry } from "./types";

/** Redis keys for Full Review verdicts (must match review/route.ts) */
const VERDICTS_KEY = "recycling:review-verdicts";

export interface KioskDayStats {
  totalClassifications: number;
  wrongFeedbackCount: number;
  successRate: number;
}

function isToday(isoTimestamp: string): boolean {
  const entryDate = isoTimestamp.slice(0, 10); // "YYYY-MM-DD"
  const todayDate = new Date().toISOString().slice(0, 10);
  return entryDate === todayDate;
}

export async function getTodayKioskStats(
  _siteId?: string
): Promise<KioskDayStats> {
  const [rawLog, verdicts] = await Promise.all([
    redis.lrange(KEYS.pilotLog, 0, -1),
    redis.hgetall(VERDICTS_KEY) as Promise<Record<string, string> | null>,
  ]);

  let correctCount = 0;
  let wrongCount = 0;

  for (const raw of rawLog) {
    const entry: PilotLogEntry = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!entry.timestamp || !isToday(entry.timestamp)) continue;
    if (!entry.requestId) continue;

    const verdict = verdicts?.[entry.requestId];
    if (!verdict || verdict === "false_detection") continue;

    if (verdict === "correct") correctCount++;
    if (verdict === "wrong") wrongCount++;
  }

  const totalClassifications = correctCount + wrongCount;
  const successRate =
    totalClassifications > 0
      ? correctCount / totalClassifications
      : 1.0;

  return { totalClassifications, wrongFeedbackCount: wrongCount, successRate };
}
