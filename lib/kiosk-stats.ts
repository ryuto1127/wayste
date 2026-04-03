/**
 * Compute today's kiosk display stats from pilot-log and feedback data.
 *
 * Success-rate formula:
 *   success = (totalClassifications - wrongFeedbackCount) / totalClassifications
 *
 * Items without explicit "wrong" feedback are treated as correct.
 */

import { redis, KEYS } from "./redis";

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
  siteId?: string
): Promise<KioskDayStats> {
  const [rawLog, rawFeedback] = await Promise.all([
    redis.lrange(KEYS.pilotLog, 0, -1),
    redis.lrange(KEYS.feedback, 0, -1),
  ]);

  // Count today's classifications from pilot-log
  let totalClassifications = 0;
  for (const raw of rawLog) {
    const entry = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!entry.timestamp || !isToday(entry.timestamp)) continue;
    totalClassifications++;
  }

  // Count today's "wrong" feedback
  let wrongFeedbackCount = 0;
  for (const raw of rawFeedback) {
    const entry = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!entry.timestamp || !isToday(entry.timestamp)) continue;
    if (siteId && entry.siteId && entry.siteId !== siteId) continue;
    if (entry.feedback === "wrong") {
      wrongFeedbackCount++;
    }
  }

  const successRate =
    totalClassifications > 0
      ? (totalClassifications - wrongFeedbackCount) / totalClassifications
      : 1.0;

  return { totalClassifications, wrongFeedbackCount, successRate };
}
