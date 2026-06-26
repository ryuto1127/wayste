/**
 * Phase 1 — run a VlmAdapter over an eval set and produce a BenchmarkReport.
 *
 * Pure orchestration: it times each adapter call, tolerates adapter errors
 * (records them as failures), bounds concurrency, and hands the results to
 * scoreBenchmark. The clock is injectable so tests are deterministic.
 *
 * Only the concrete adapter (Phase 1 model choice) and a thin CLI entry remain
 * environment-specific; this orchestrator is unit-tested with the stub adapter.
 */
import type { EvalSample } from "./eval-set";
import type { VlmAdapter } from "./vlm-adapter";
import { scoreBenchmark, type BenchmarkReport, type VlmRunResult } from "./scoring";

export interface RunOptions {
  /** Streams the VLM may choose from (passed to the adapter). */
  allowedStreams: string[];
  /** Max in-flight adapter calls. Default 4. */
  concurrency?: number;
  /** Monotonic clock in ms; defaults to Date.now. Injected for tests. */
  now?: () => number;
  /** Optional per-result callback for progress logging. */
  onResult?: (result: VlmRunResult, index: number, total: number) => void;
}

export async function runBenchmark(
  samples: ReadonlyArray<EvalSample>,
  adapter: VlmAdapter,
  opts: RunOptions,
): Promise<{ report: BenchmarkReport; results: VlmRunResult[] }> {
  const now = opts.now ?? Date.now;
  const concurrency = Math.max(1, opts.concurrency ?? 4);
  const results: VlmRunResult[] = new Array(samples.length);

  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= samples.length) return;
      const sample = samples[i];
      const start = now();
      let result: VlmRunResult;
      try {
        const out = await adapter.classify({
          imageUrl: sample.imageUrl,
          allowedStreams: opts.allowedStreams,
          sample,
        });
        result = {
          requestId: sample.requestId,
          predictedStream: out.stream,
          latencyMs: now() - start,
          ok: true,
        };
      } catch {
        result = {
          requestId: sample.requestId,
          predictedStream: "",
          latencyMs: now() - start,
          ok: false,
        };
      }
      results[i] = result;
      opts.onResult?.(result, i, samples.length);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, samples.length) }, worker),
  );

  return { report: scoreBenchmark(samples, results), results };
}
