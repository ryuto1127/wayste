/**
 * Phase 0 — build a benchmark evaluation set from real pilot data.
 *
 * Goal of the local-VLM migration (see CLAUDE.md "Roadmap (privacy)"):
 * a local VLM must take over the items that currently escalate to the cloud
 * (`modelUsed === "t2"`). To decide whether a candidate VLM is good enough,
 * we benchmark it against those exact items, using the human review verdicts
 * (`recycling:review-verdicts`: requestId → "correct" | "wrong") as labels.
 *
 * Ground-truth caveat: the verdict hash is binary. For "correct" verdicts the
 * true stream is the model's own `wasteStream` (a human confirmed it). For
 * "wrong" verdicts we only know the model was wrong, NOT the right answer — so
 * `groundTruthStream` is null and those samples are excluded from accuracy but
 * still useful for the "diverged from a known-wrong answer" signal.
 *
 * Pure module — no Redis/IO. The route layer feeds it parsed entries.
 */
import type { PilotLogEntry } from "@/lib/types";

export type ReviewVerdict = "correct" | "wrong";

export interface EvalSample {
  requestId: string;
  imageUrl: string;
  timestamp: string;
  /** Stream the live model predicted (cloud GPT in the escalated case). */
  predictedStream: string;
  predictedItemName: string;
  confidence: number;
  modelUsed: "t2" | "T1";
  verdict: ReviewVerdict;
  /** Human-confirmed stream when verdict==="correct"; null when "wrong". */
  groundTruthStream: string | null;
  /** YOLO Tier-1 candidates available at decision time, if any. */
  yoloCandidates: { itemName: string; confidence: number }[];
}

export interface SelectOptions {
  /**
   * Only include cloud-escalated (`t2`) samples — the ones a local VLM must
   * replace. Default true. Set false to benchmark over every reviewed entry.
   */
  escalatedOnly?: boolean;
}

/** Map a single parsed entry + its verdict to an EvalSample (null if unusable). */
export function toEvalSample(
  entry: PilotLogEntry,
  verdict: ReviewVerdict,
): EvalSample | null {
  if (!entry.requestId || !entry.imageUrl) return null;
  return {
    requestId: entry.requestId,
    imageUrl: entry.imageUrl,
    timestamp: entry.timestamp,
    predictedStream: entry.wasteStream,
    predictedItemName: entry.itemName,
    confidence: entry.confidence,
    modelUsed: entry.modelUsed,
    verdict,
    groundTruthStream: verdict === "correct" ? entry.wasteStream : null,
    yoloCandidates:
      entry.tierResults?.tier1?.map((c) => ({
        itemName: c.itemName,
        confidence: c.confidence,
      })) ?? [],
  };
}

/**
 * Select benchmark samples from parsed pilot-log entries + the verdict hash.
 * Entries without a requestId, imageUrl, or a recognised verdict are dropped.
 */
export function selectEvalSamples(
  entries: ReadonlyArray<PilotLogEntry | null>,
  verdicts: Record<string, string>,
  opts: SelectOptions = {},
): EvalSample[] {
  const escalatedOnly = opts.escalatedOnly ?? true;
  const out: EvalSample[] = [];
  for (const entry of entries) {
    if (!entry || !entry.requestId || !entry.imageUrl) continue;
    const v = verdicts[entry.requestId];
    if (v !== "correct" && v !== "wrong") continue;
    if (escalatedOnly && entry.modelUsed !== "t2") continue;
    const sample = toEvalSample(entry, v);
    if (sample) out.push(sample);
  }
  return out;
}

export interface EvalSetSummary {
  total: number;
  /** Samples with a usable ground-truth label (verdict==="correct"). */
  labeled: number;
  correctVerdicts: number;
  wrongVerdicts: number;
  /** Count of labeled samples per ground-truth stream. */
  byStream: Record<string, number>;
}

export function summarizeEvalSet(samples: ReadonlyArray<EvalSample>): EvalSetSummary {
  const summary: EvalSetSummary = {
    total: samples.length,
    labeled: 0,
    correctVerdicts: 0,
    wrongVerdicts: 0,
    byStream: {},
  };
  for (const s of samples) {
    if (s.verdict === "correct") summary.correctVerdicts++;
    else summary.wrongVerdicts++;
    if (s.groundTruthStream != null) {
      summary.labeled++;
      summary.byStream[s.groundTruthStream] =
        (summary.byStream[s.groundTruthStream] ?? 0) + 1;
    }
  }
  return summary;
}
