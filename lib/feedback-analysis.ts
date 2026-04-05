import { redis, KEYS } from "./redis";
import type { FeedbackEntry, PilotLogEntry, WasteStream } from "./types";

/** Redis key for review verdicts (must match review/route.ts) */
const VERDICTS_KEY = "recycling:review-verdicts";

export interface HourlyDataPoint {
  hour: string; // "HH:00"
  total: number;
  correct: number;
}

export interface FeedbackStats {
  total: number;
  correct: number;
  wrong: number;
  accuracyRate: number;
  recentFeedback: FeedbackEntry[];
  hourlyTrend: HourlyDataPoint[];
}

export async function loadFeedback(): Promise<FeedbackEntry[]> {
  try {
    const raw = await redis.lrange(KEYS.feedback, 0, -1);
    return raw
      .map((item) => {
        try {
          return (typeof item === "string" ? JSON.parse(item) : item) as FeedbackEntry;
        } catch {
          return null;
        }
      })
      .filter((e): e is FeedbackEntry => e !== null);
  } catch {
    return [];
  }
}

/**
 * Build feedback entries from admin review verdicts only.
 * Verdicts evaluate whether the model's class name matches the image,
 * NOT whether the waste stream is correct.
 */
async function loadAllFeedback(): Promise<FeedbackEntry[]> {
  const [pilotRaw, verdicts] = await Promise.all([
    redis.lrange(KEYS.pilotLog, 0, -1),
    redis.hgetall(VERDICTS_KEY) as Promise<Record<string, string> | null>,
  ]);

  const pilotEntries = pilotRaw
    .map((item) => {
      try {
        return (typeof item === "string" ? JSON.parse(item) : item) as PilotLogEntry;
      } catch {
        return null;
      }
    })
    .filter((e): e is PilotLogEntry => e !== null);

  const entries: FeedbackEntry[] = [];
  for (const entry of pilotEntries) {
    if (!entry.requestId) continue;

    const verdict = verdicts?.[entry.requestId];
    if (!verdict || verdict === "false_detection") continue;

    entries.push({
      id: entry.requestId,
      timestamp: entry.timestamp,
      itemName: entry.itemName,
      predictedStream: entry.wasteStream as WasteStream,
      confidence: entry.confidence,
      feedback: verdict === "wrong" ? "wrong" : "correct",
      siteId: "default",
      imageUrl: entry.imageUrl,
      requestId: entry.requestId,
    });
  }

  return entries;
}

export async function analyzeFeedback(siteId?: string): Promise<FeedbackStats> {
  let entries = await loadAllFeedback();

  if (siteId) {
    entries = entries.filter((e) => e.siteId === siteId);
  }

  const total = entries.length;
  const correct = entries.filter((e) => e.feedback === "correct").length;
  const wrong = total - correct;
  const accuracyRate = total > 0 ? correct / total : 0;

  // Recent feedback (last 20, newest first)
  const recentFeedback = entries.slice(-20).reverse();

  // ── Hourly trend (last 24 hours) ──
  const now = Date.now();
  const hourMs = 60 * 60 * 1000;
  const hourlyMap = new Map<string, { total: number; correct: number }>();
  // Initialize all 24 hours
  for (let i = 23; i >= 0; i--) {
    const d = new Date(now - i * hourMs);
    const label = `${String(d.getHours()).padStart(2, "0")}:00`;
    hourlyMap.set(label, { total: 0, correct: 0 });
  }
  for (const entry of entries) {
    const entryTime = new Date(entry.timestamp).getTime();
    if (now - entryTime > 24 * hourMs) continue;
    const hour = `${String(new Date(entryTime).getHours()).padStart(2, "0")}:00`;
    const bucket = hourlyMap.get(hour);
    if (bucket) {
      bucket.total++;
      if (entry.feedback === "correct") bucket.correct++;
    }
  }
  const hourlyTrend: HourlyDataPoint[] = [...hourlyMap.entries()].map(
    ([hour, data]) => ({ hour, ...data }),
  );

  return {
    total,
    correct,
    wrong,
    accuracyRate,
    recentFeedback,
    hourlyTrend,
  };
}
