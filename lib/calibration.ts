/**
 * Confidence calibration tracking.
 *
 * Tracks predicted confidence vs actual accuracy in fine-grained buckets
 * (0.05 increments from 0.00 to 1.00) to reveal if detection thresholds
 * are well-calibrated for the deployment environment.
 *
 * Data is stored in Redis alongside pilot logs. Each classification result
 * is bucketed by confidence; review verdicts later mark them correct/wrong.
 */

import { redis } from "./redis";

/** 0.05-increment buckets from 0.00 to 1.00 (20 buckets). */
const BUCKET_SIZE = 0.05;
const NUM_BUCKETS = 20;

export interface CalibrationBucket {
  /** Lower bound of this bucket (e.g., 0.30). */
  min: number;
  /** Upper bound of this bucket (e.g., 0.35). */
  max: number;
  /** Human-readable label (e.g., "0.30–0.35"). */
  label: string;
  /** Total predictions that fell in this bucket. */
  predictions: number;
  /** Predictions later confirmed correct (via /review verdicts). */
  correct: number;
  /** Actual accuracy for this bucket (correct / predictions, or null if no predictions). */
  accuracy: number | null;
}

/** Redis key for calibration counters. */
const REDIS_KEY = "recycling:calibration";

/** Map a confidence value (0.0–1.0) to its bucket index (0–19). */
function toBucketIndex(confidence: number): number {
  const idx = Math.floor(confidence / BUCKET_SIZE);
  return Math.min(idx, NUM_BUCKETS - 1);
}

/**
 * Record a classification into the calibration tracker.
 * Called from the classify route after each successful classification.
 *
 * @param confidence The model's predicted confidence (0.0–1.0)
 * @param modelUsed Which model produced this result
 */
export async function recordCalibrationPrediction(
  confidence: number,
  modelUsed: string,
): Promise<void> {
  try {
    if (!redis) return;

    const idx = toBucketIndex(confidence);
    // Increment prediction count for this bucket
    await redis.hincrby(REDIS_KEY, `pred:${idx}`, 1);
    // Also track per-model for deeper analysis
    await redis.hincrby(REDIS_KEY, `pred:${idx}:${modelUsed}`, 1);
  } catch {
    // Best-effort — don't fail the request
  }
}

/**
 * Record a review verdict for calibration.
 * Called from the review route when a verdict is submitted.
 *
 * @param confidence The original prediction's confidence
 * @param isCorrect Whether the prediction was correct
 */
export async function recordCalibrationVerdict(
  confidence: number,
  isCorrect: boolean,
): Promise<void> {
  try {
    if (!redis) return;

    const idx = toBucketIndex(confidence);
    if (isCorrect) {
      await redis.hincrby(REDIS_KEY, `correct:${idx}`, 1);
    }
    // Always increment reviewed count (correct or wrong)
    await redis.hincrby(REDIS_KEY, `reviewed:${idx}`, 1);
  } catch {
    // Best-effort
  }
}

/**
 * Retrieve all calibration buckets with their statistics.
 * Used by the /api/calibration endpoint.
 */
export async function getCalibrationData(): Promise<CalibrationBucket[]> {
  if (!redis) return buildEmptyBuckets();

  try {
    const data = await redis.hgetall(REDIS_KEY) as Record<string, string> | null;
    if (!data) return buildEmptyBuckets();

    const buckets: CalibrationBucket[] = [];
    for (let i = 0; i < NUM_BUCKETS; i++) {
      const min = i * BUCKET_SIZE;
      const max = min + BUCKET_SIZE;
      const predictions = parseInt(data[`pred:${i}`] ?? "0", 10);
      const correct = parseInt(data[`correct:${i}`] ?? "0", 10);
      const reviewed = parseInt(data[`reviewed:${i}`] ?? "0", 10);

      buckets.push({
        min: Math.round(min * 100) / 100,
        max: Math.round(max * 100) / 100,
        label: `${min.toFixed(2)}–${max.toFixed(2)}`,
        predictions,
        correct,
        accuracy: reviewed > 0 ? correct / reviewed : null,
      });
    }

    return buckets;
  } catch {
    return buildEmptyBuckets();
  }
}

function buildEmptyBuckets(): CalibrationBucket[] {
  const buckets: CalibrationBucket[] = [];
  for (let i = 0; i < NUM_BUCKETS; i++) {
    const min = i * BUCKET_SIZE;
    const max = min + BUCKET_SIZE;
    buckets.push({
      min: Math.round(min * 100) / 100,
      max: Math.round(max * 100) / 100,
      label: `${min.toFixed(2)}–${max.toFixed(2)}`,
      predictions: 0,
      correct: 0,
      accuracy: null,
    });
  }
  return buckets;
}
