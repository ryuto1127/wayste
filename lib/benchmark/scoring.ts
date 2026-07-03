/**
 * Phase 1 — score a candidate VLM's predictions against the eval set.
 *
 * Metrics (all pure, no IO):
 *   - accuracy        : on labeled samples (groundTruthStream != null),
 *                       share where the VLM's stream matches the ground truth.
 *   - gptAgreement    : share of ALL samples where VLM matches what the live
 *                       model predicted (predictedStream).
 *   - divergedFromWrong: among "wrong" verdicts (model was wrong), count where
 *                       the VLM produced a DIFFERENT stream than the wrong model
 *                       answer. Can't confirm correctness without a true label,
 *                       but it's the signal that the VLM avoided a known mistake.
 *   - latency         : p50/p95/max/mean over successful runs.
 *   - perStream       : per ground-truth stream, gt count + correct count.
 */
import type { EvalSample } from "./eval-set";

export interface VlmRunResult {
  requestId: string;
  /** The stream the VLM chose. Empty string when ok=false. */
  predictedStream: string;
  latencyMs: number;
  ok: boolean;
}

export interface BenchmarkReport {
  n: number;
  labeled: number;
  /** Accuracy on labeled samples, or null when there are none. */
  accuracy: number | null;
  gptAgreement: number;
  divergedFromWrong: number;
  wrongVerdicts: number;
  failures: number;
  latency: { p50: number; p95: number; max: number; mean: number };
  perStream: Record<string, { gt: number; correct: number }>;
}

/** Nearest-rank percentile over a numeric array (0..100). */
export function percentile(values: ReadonlyArray<number>, p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  const idx = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  return sorted[idx];
}

export function scoreBenchmark(
  samples: ReadonlyArray<EvalSample>,
  runs: ReadonlyArray<VlmRunResult>,
): BenchmarkReport {
  const byId = new Map<string, VlmRunResult>();
  for (const r of runs) byId.set(r.requestId, r);

  let labeled = 0;
  let labeledCorrect = 0;
  let agree = 0;
  let agreeDenom = 0;
  let wrongVerdicts = 0;
  let divergedFromWrong = 0;
  let failures = 0;
  const latencies: number[] = [];
  const perStream: Record<string, { gt: number; correct: number }> = {};

  for (const s of samples) {
    const run = byId.get(s.requestId);
    if (!run || !run.ok) {
      failures++;
      continue;
    }
    latencies.push(run.latencyMs);

    agreeDenom++;
    if (run.predictedStream === s.predictedStream) agree++;

    if (s.verdict === "wrong") {
      wrongVerdicts++;
      if (run.predictedStream !== s.predictedStream) divergedFromWrong++;
    }

    if (s.groundTruthStream != null) {
      labeled++;
      const bucket = (perStream[s.groundTruthStream] ??= { gt: 0, correct: 0 });
      bucket.gt++;
      if (run.predictedStream === s.groundTruthStream) {
        labeledCorrect++;
        bucket.correct++;
      }
    }
  }

  return {
    n: samples.length,
    labeled,
    accuracy: labeled > 0 ? labeledCorrect / labeled : null,
    gptAgreement: agreeDenom > 0 ? agree / agreeDenom : 0,
    divergedFromWrong,
    wrongVerdicts,
    failures,
    latency: {
      p50: percentile(latencies, 50),
      p95: percentile(latencies, 95),
      max: latencies.length ? Math.max(...latencies) : 0,
      mean: latencies.length
        ? latencies.reduce((a, b) => a + b, 0) / latencies.length
        : 0,
    },
    perStream,
  };
}
