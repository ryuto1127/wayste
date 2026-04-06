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
  /** All pilot log entries (matches review page total) */
  totalClassifications: number;
  /** Entries with admin verdicts (correct or wrong) */
  total: number;
  correct: number;
  wrong: number;
  falseDetections: number;
  pending: number;
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
 * Load all pilot log entries and build reviewed FeedbackEntry list.
 * Returns both the full pilot list and the reviewed-only subset.
 */
async function loadAllFeedback(): Promise<{
  pilotEntries: PilotLogEntry[];
  reviewedEntries: FeedbackEntry[];
  verdicts: Record<string, string>;
}> {
  const [pilotRaw, verdictsRaw] = await Promise.all([
    redis.lrange(KEYS.pilotLog, 0, -1),
    redis.hgetall(VERDICTS_KEY) as Promise<Record<string, string> | null>,
  ]);

  const verdicts = verdictsRaw ?? {};

  const pilotEntries = pilotRaw
    .map((item) => {
      try {
        return (typeof item === "string" ? JSON.parse(item) : item) as PilotLogEntry;
      } catch {
        return null;
      }
    })
    .filter((e): e is PilotLogEntry => e !== null);

  const reviewedEntries: FeedbackEntry[] = [];
  for (const entry of pilotEntries) {
    if (!entry.requestId) continue;
    const verdict = verdicts[entry.requestId];
    if (!verdict || verdict === "false_detection") continue;
    reviewedEntries.push({
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

  return { pilotEntries, reviewedEntries, verdicts };
}

export async function analyzeFeedback(siteId?: string): Promise<FeedbackStats> {
  const { pilotEntries, reviewedEntries, verdicts } = await loadAllFeedback();

  let entries = reviewedEntries;
  if (siteId) {
    entries = entries.filter((e) => e.siteId === siteId);
  }

  const totalClassifications = siteId ? pilotEntries.length : pilotEntries.length;
  const falseDetections = pilotEntries.filter(
    (e) => e.requestId && verdicts[e.requestId] === "false_detection",
  ).length;
  const pending = pilotEntries.filter(
    (e) => !e.requestId || !verdicts[e.requestId],
  ).length;

  const total = entries.length;
  const correct = entries.filter((e) => e.feedback === "correct").length;
  const wrong = total - correct;
  const accuracyRate = total > 0 ? correct / total : 0;

  // Recent feedback: last 20 pilot log entries (all, not just reviewed), newest first
  const recentFeedback = pilotEntries
    .slice()
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
    .slice(0, 20)
    .map((e) => ({
      id: e.requestId ?? e.timestamp,
      timestamp: e.timestamp,
      itemName: e.itemName,
      predictedStream: e.wasteStream as WasteStream,
      confidence: e.confidence,
      feedback: (e.requestId && verdicts[e.requestId] && verdicts[e.requestId] !== "false_detection"
        ? verdicts[e.requestId] === "wrong" ? "wrong" : "correct"
        : null) as "correct" | "wrong" | null,
      siteId: "default",
      imageUrl: e.imageUrl,
      requestId: e.requestId,
    })) as FeedbackEntry[];

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
    totalClassifications,
    total,
    correct,
    wrong,
    falseDetections,
    pending,
    accuracyRate,
    recentFeedback,
    hourlyTrend,
  };
}
