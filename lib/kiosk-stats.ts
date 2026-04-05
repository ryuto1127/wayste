/**
 * Compute today's kiosk display stats from pilot-log, feedback, and
 * admin review data.
 *
 * Only items with explicit human feedback (kiosk correct/wrong button
 * OR admin review verdict) are included. Unreviewed items are excluded
 * so stats reflect confirmed data only.
 */

import { redis, KEYS } from "./redis";
import type { PilotLogEntry, FeedbackEntry } from "./types";

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
  siteId?: string
): Promise<KioskDayStats> {
  const [rawLog, rawFeedback, verdicts] = await Promise.all([
    redis.lrange(KEYS.pilotLog, 0, -1),
    redis.lrange(KEYS.feedback, 0, -1),
    redis.hgetall(VERDICTS_KEY) as Promise<Record<string, string> | null>,
  ]);

  // Parse today's kiosk feedback entries and track their requestIds
  const feedbackByRequestId = new Map<string, "correct" | "wrong">();
  let kioskWrongCount = 0;
  let kioskTotalCount = 0;

  for (const raw of rawFeedback) {
    const entry: FeedbackEntry = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!entry.timestamp || !isToday(entry.timestamp)) continue;
    if (siteId && entry.siteId && entry.siteId !== siteId) continue;
    kioskTotalCount++;
    if (entry.feedback === "wrong") kioskWrongCount++;
    if (entry.requestId) {
      feedbackByRequestId.set(entry.requestId, entry.feedback as "correct" | "wrong");
    }
  }

  // Count today's pilot log entries that have admin review verdicts
  // (and are not already covered by kiosk feedback)
  let reviewedCorrectCount = 0;
  let reviewedWrongCount = 0;

  for (const raw of rawLog) {
    const entry: PilotLogEntry = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!entry.timestamp || !isToday(entry.timestamp)) continue;
    if (!entry.requestId) continue;
    // Skip if already counted via kiosk feedback
    if (feedbackByRequestId.has(entry.requestId)) continue;

    const verdict = verdicts?.[entry.requestId];
    // Only count entries with an admin verdict
    if (!verdict || verdict === "false_detection") continue;

    if (verdict === "correct") reviewedCorrectCount++;
    if (verdict === "wrong") reviewedWrongCount++;
  }

  const totalClassifications = kioskTotalCount + reviewedCorrectCount + reviewedWrongCount;
  const wrongFeedbackCount = kioskWrongCount + reviewedWrongCount;
  const successRate =
    totalClassifications > 0
      ? (totalClassifications - wrongFeedbackCount) / totalClassifications
      : 1.0;

  return { totalClassifications, wrongFeedbackCount, successRate };
}
