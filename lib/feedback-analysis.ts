import { redis, KEYS } from "./redis";
import type { FeedbackEntry, WasteStream } from "./types";

export interface FeedbackStats {
  total: number;
  correct: number;
  wrong: number;
  accuracyRate: number;
  mostCorrected: CorrectedItem[];
  suggestedOverrides: SuggestedOverride[];
  recentFeedback: FeedbackEntry[];
  suggestedThreshold: number;
}

export interface CorrectedItem {
  itemName: string;
  wrongCount: number;
  totalCount: number;
  mostCommonActual: WasteStream;
}

export interface SuggestedOverride {
  pattern: string;
  suggestedStream: WasteStream;
  wrongCount: number;
  confidence: number;
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

export async function analyzeFeedback(siteId?: string): Promise<FeedbackStats> {
  let entries = await loadFeedback();

  if (siteId) {
    entries = entries.filter((e) => e.siteId === siteId);
  }

  const total = entries.length;
  const correct = entries.filter((e) => e.feedback === "correct").length;
  const wrong = total - correct;
  const accuracyRate = total > 0 ? correct / total : 0;

  // Find most corrected items
  const itemCounts = new Map<
    string,
    { wrongCount: number; totalCount: number; actuals: Map<string, number> }
  >();

  for (const entry of entries) {
    const key = entry.itemName.toLowerCase();
    const existing = itemCounts.get(key) ?? {
      wrongCount: 0,
      totalCount: 0,
      actuals: new Map(),
    };
    existing.totalCount++;
    if (entry.feedback === "wrong") {
      existing.wrongCount++;
      if (entry.actualStream) {
        existing.actuals.set(
          entry.actualStream,
          (existing.actuals.get(entry.actualStream) ?? 0) + 1
        );
      }
    }
    itemCounts.set(key, existing);
  }

  const mostCorrected: CorrectedItem[] = [...itemCounts.entries()]
    .filter(([, v]) => v.wrongCount >= 2)
    .sort((a, b) => b[1].wrongCount - a[1].wrongCount)
    .slice(0, 10)
    .map(([name, data]) => {
      let mostCommonActual: WasteStream = "landfill";
      let maxCount = 0;
      for (const [stream, count] of data.actuals) {
        if (count > maxCount) {
          maxCount = count;
          mostCommonActual = stream as WasteStream;
        }
      }
      return {
        itemName: name,
        wrongCount: data.wrongCount,
        totalCount: data.totalCount,
        mostCommonActual,
      };
    });

  // Suggest overrides: items corrected 3+ times to the same stream
  const suggestedOverrides: SuggestedOverride[] = mostCorrected
    .filter((item) => item.wrongCount >= 3)
    .map((item) => ({
      pattern: item.itemName,
      suggestedStream: item.mostCommonActual,
      wrongCount: item.wrongCount,
      confidence: item.wrongCount / item.totalCount,
    }));

  // Adaptive threshold suggestion
  let suggestedThreshold = 0.55;
  if (total >= 20) {
    if (accuracyRate > 0.85) {
      suggestedThreshold = 0.45;
    } else if (accuracyRate > 0.75) {
      suggestedThreshold = 0.50;
    } else if (accuracyRate < 0.6) {
      suggestedThreshold = 0.65;
    } else if (accuracyRate < 0.7) {
      suggestedThreshold = 0.60;
    }
  }

  // Recent feedback (last 20, newest first)
  const recentFeedback = entries.slice(-20).reverse();

  return {
    total,
    correct,
    wrong,
    accuracyRate,
    mostCorrected,
    suggestedOverrides,
    recentFeedback,
    suggestedThreshold,
  };
}
