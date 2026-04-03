/**
 * Auto-apply dynamic overrides when feedback consistently corrects an item.
 *
 * Safety conditions (ALL must be true):
 *   1. The item has been corrected to the SAME stream >= AUTO_APPLY_THRESHOLD times
 *   2. The error rate for that item is >= MIN_ERROR_RATE (majority of feedback is "wrong")
 *   3. There are enough total feedback entries for the item (>= MIN_TOTAL_FEEDBACK)
 *
 * This prevents overriding items that are usually classified correctly but
 * occasionally get confused with something else. For example, if "ペットボトル"
 * has 97 correct + 3 wrong, the error rate is 3% — far below the threshold.
 */

import { redis, KEYS } from "./redis";
import type { FeedbackEntry, ItemOverride, WasteStream } from "./types";

/** Minimum "wrong → same stream" corrections before auto-override is considered. */
const AUTO_APPLY_THRESHOLD = 3;
/** Minimum fraction of total feedback that must be "wrong" for this item. */
const MIN_ERROR_RATE = 0.5;
/** Minimum total feedback entries (correct + wrong) for the item. */
const MIN_TOTAL_FEEDBACK = 4;

export async function checkAndApplyAutoOverride(
  siteId: string,
  itemName: string,
  actualStream: string,
): Promise<boolean> {
  try {
    const raw = await redis.lrange(KEYS.feedback, 0, -1);

    // Count ALL feedback for this item (correct + wrong)
    let totalForItem = 0;
    let wrongToSameStream = 0;
    let wrongTotal = 0;

    for (const item of raw) {
      const entry = (typeof item === "string" ? JSON.parse(item) : item) as FeedbackEntry;
      if (entry.itemName.toLowerCase() !== itemName.toLowerCase()) continue;

      totalForItem++;

      if (entry.feedback === "wrong") {
        wrongTotal++;
        if (entry.actualStream === actualStream) {
          wrongToSameStream++;
        }
      }
    }

    // Gate 1: enough corrections to the same stream
    if (wrongToSameStream < AUTO_APPLY_THRESHOLD) return false;

    // Gate 2: enough total feedback to make a reliable decision
    if (totalForItem < MIN_TOTAL_FEEDBACK) return false;

    // Gate 3: error rate is high enough — the model is consistently wrong for this item
    // (prevents overriding items that are usually correct but occasionally confused)
    const errorRate = wrongTotal / totalForItem;
    if (errorRate < MIN_ERROR_RATE) {
      console.log(
        `[auto-override] Skipped "${itemName}": error rate ${(errorRate * 100).toFixed(0)}% < ${MIN_ERROR_RATE * 100}% threshold ` +
        `(${wrongTotal} wrong / ${totalForItem} total)`
      );
      return false;
    }

    // All gates passed — auto-apply
    const overrideKey = `recycling:dynamic-overrides:${siteId}`;
    const existingRaw = await redis.get(overrideKey);
    const existing: ItemOverride[] = existingRaw
      ? (typeof existingRaw === "string" ? JSON.parse(existingRaw) : existingRaw) as ItemOverride[]
      : [];

    // Don't duplicate
    const alreadyExists = existing.some(
      (o) => o.pattern.toLowerCase() === itemName.toLowerCase()
    );
    if (alreadyExists) return false;

    existing.push({
      pattern: itemName,
      stream: actualStream as WasteStream,
      note: `Auto-applied: ${wrongToSameStream}/${totalForItem} corrections (${Math.round(errorRate * 100)}% error rate)`,
    });

    await redis.set(overrideKey, JSON.stringify(existing));
    console.log(
      `[auto-override] Applied: "${itemName}" → ${actualStream} ` +
      `(${wrongToSameStream} corrections, ${Math.round(errorRate * 100)}% error rate)`
    );
    return true;
  } catch (err) {
    console.warn("[auto-override] Failed:", err);
    return false;
  }
}
