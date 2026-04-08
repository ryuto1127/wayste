/**
 * Milestone check helper for pilot-log integration.
 *
 * Reads the total pilot-log count, review verdicts, and item frequency
 * from Redis, then fires a milestone notification when the total
 * crosses a 100-item boundary.
 */

import { redis, KEYS } from "./redis";
import { sendMilestoneNotification, isNotificationConfigured } from "./notifications";
import type { PilotLogEntry } from "./types";

/** Redis key for review verdicts (must match review/route.ts and kiosk-stats.ts). */
const VERDICTS_KEY = "recycling:review-verdicts";

/**
 * Check the total pilot-log count and send a milestone notification
 * when it crosses a 100-item boundary.
 *
 * This is designed to run in the background after a new entry is logged.
 * It never throws — failures are logged and swallowed.
 */
export async function checkAndSendMilestoneNotification(): Promise<void> {
  if (!isNotificationConfigured()) return;

  // Get total count via llen (O(1), no full scan)
  const total = await redis.llen(KEYS.pilotLog);

  // Only notify at 100-item boundaries
  if (total % 100 !== 0 || total === 0) return;

  // Compute accuracy and most common item from the full log.
  // This runs in the background (waitUntil), so the cost is acceptable
  // at milestone boundaries (once every 100 items).
  const [rawLog, verdicts] = await Promise.all([
    redis.lrange(KEYS.pilotLog, 0, -1),
    redis.hgetall(VERDICTS_KEY) as Promise<Record<string, string> | null>,
  ]);

  // ── Accuracy from review verdicts ──
  let correctCount = 0;
  let reviewedCount = 0;

  // ── Most common item ──
  const itemCounts = new Map<string, number>();

  for (const raw of rawLog) {
    const entry: PilotLogEntry =
      typeof raw === "string" ? JSON.parse(raw) : raw;

    // Count item frequency
    if (entry.itemName && entry.itemName !== "unknown") {
      itemCounts.set(
        entry.itemName,
        (itemCounts.get(entry.itemName) ?? 0) + 1,
      );
    }

    // Count review verdicts for accuracy
    if (entry.requestId && verdicts?.[entry.requestId]) {
      const verdict = verdicts[entry.requestId];
      if (verdict === "correct" || verdict === "wrong") {
        reviewedCount++;
        if (verdict === "correct") correctCount++;
      }
    }
  }

  const accuracy =
    reviewedCount > 0 ? correctCount / reviewedCount : undefined;

  let mostCommonItem: string | undefined;
  let maxCount = 0;
  for (const [item, count] of itemCounts) {
    if (count > maxCount) {
      maxCount = count;
      mostCommonItem = item;
    }
  }

  await sendMilestoneNotification({ total, accuracy, mostCommonItem });
}
