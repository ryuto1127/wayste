import type { PilotLogEntry } from "@/lib/types";
import {
  selectEvalSamples,
  summarizeEvalSet,
  toEvalSample,
  type EvalSample,
} from "@/lib/benchmark/eval-set";
import { scoreBenchmark, percentile, type VlmRunResult } from "@/lib/benchmark/scoring";
import { runBenchmark } from "@/lib/benchmark/runner";
import { makeStubAdapter } from "@/lib/benchmark/vlm-adapter";

function makeEntry(o: Partial<PilotLogEntry> = {}): PilotLogEntry {
  return {
    timestamp: "2026-06-01T00:00:00.000Z",
    modelUsed: "t2",
    escalated: true,
    itemName: "cup",
    wasteStream: "recycling",
    confidence: 0.6,
    requiresVerification: false,
    latencyMs: 100,
    requestId: "req-1",
    imageUrl: "https://blob.example.com/a.jpg",
    ...o,
  };
}

function makeSample(o: Partial<EvalSample> = {}): EvalSample {
  return {
    requestId: "req-1",
    imageUrl: "https://blob.example.com/a.jpg",
    timestamp: "2026-06-01T00:00:00.000Z",
    predictedStream: "recycling",
    predictedItemName: "cup",
    confidence: 0.6,
    modelUsed: "t2",
    verdict: "correct",
    groundTruthStream: "recycling",
    yoloCandidates: [],
    ...o,
  };
}

describe("selectEvalSamples", () => {
  it("keeps only escalated (t2) reviewed entries by default", () => {
    const entries = [
      makeEntry({ requestId: "a", modelUsed: "t2" }),
      makeEntry({ requestId: "b", modelUsed: "T1" }),
    ];
    const out = selectEvalSamples(entries, { a: "correct", b: "correct" });
    expect(out.map((s) => s.requestId)).toEqual(["a"]);
  });

  it("includes T1 entries when escalatedOnly=false", () => {
    const entries = [
      makeEntry({ requestId: "a", modelUsed: "t2" }),
      makeEntry({ requestId: "b", modelUsed: "T1" }),
    ];
    const out = selectEvalSamples(entries, { a: "correct", b: "wrong" }, { escalatedOnly: false });
    expect(out.map((s) => s.requestId).sort()).toEqual(["a", "b"]);
  });

  it("drops entries without a recognised verdict", () => {
    const entries = [
      makeEntry({ requestId: "a" }),
      makeEntry({ requestId: "b" }),
    ];
    const out = selectEvalSamples(entries, { a: "correct", b: "unknown-verdict" });
    expect(out.map((s) => s.requestId)).toEqual(["a"]);
  });

  it("drops entries missing requestId or imageUrl, and null entries", () => {
    const entries = [
      makeEntry({ requestId: undefined }),
      makeEntry({ requestId: "c", imageUrl: undefined }),
      null,
      makeEntry({ requestId: "d" }),
    ];
    const out = selectEvalSamples(entries, { c: "correct", d: "correct" });
    expect(out.map((s) => s.requestId)).toEqual(["d"]);
  });

  it("sets groundTruthStream only for correct verdicts", () => {
    const correct = toEvalSample(makeEntry({ wasteStream: "compost" }), "correct");
    const wrong = toEvalSample(makeEntry({ wasteStream: "compost" }), "wrong");
    expect(correct?.groundTruthStream).toBe("compost");
    expect(wrong?.groundTruthStream).toBeNull();
  });

  it("maps YOLO tier1 candidates", () => {
    const s = toEvalSample(
      makeEntry({ tierResults: { tier1: [{ itemName: "can", confidence: 0.4, x: 1 }] } }),
      "correct",
    );
    expect(s?.yoloCandidates).toEqual([{ itemName: "can", confidence: 0.4 }]);
  });
});

describe("summarizeEvalSet", () => {
  it("counts totals, labels, verdicts and streams", () => {
    const samples = [
      makeSample({ requestId: "a", verdict: "correct", groundTruthStream: "recycling" }),
      makeSample({ requestId: "b", verdict: "correct", groundTruthStream: "compost" }),
      makeSample({ requestId: "c", verdict: "wrong", groundTruthStream: null }),
    ];
    expect(summarizeEvalSet(samples)).toEqual({
      total: 3,
      labeled: 2,
      correctVerdicts: 2,
      wrongVerdicts: 1,
      byStream: { recycling: 1, compost: 1 },
    });
  });
});

describe("percentile", () => {
  it("uses nearest-rank and handles edges", () => {
    const v = [10, 20, 30, 40, 50];
    expect(percentile(v, 50)).toBe(30);
    expect(percentile(v, 95)).toBe(50);
    expect(percentile([], 95)).toBe(0);
    expect(percentile([7], 50)).toBe(7);
  });
});

describe("scoreBenchmark", () => {
  const samples = [
    makeSample({ requestId: "a", predictedStream: "recycling", verdict: "correct", groundTruthStream: "recycling" }),
    makeSample({ requestId: "b", predictedStream: "compost", verdict: "correct", groundTruthStream: "compost" }),
    makeSample({ requestId: "c", predictedStream: "landfill", verdict: "wrong", groundTruthStream: null }),
  ];

  it("computes accuracy, agreement, divergence, latency, perStream", () => {
    const runs: VlmRunResult[] = [
      { requestId: "a", predictedStream: "recycling", latencyMs: 100, ok: true }, // GT match + GPT agree
      { requestId: "b", predictedStream: "landfill", latencyMs: 300, ok: true },  // GT miss + GPT disagree
      { requestId: "c", predictedStream: "recycling", latencyMs: 200, ok: true }, // wrong verdict, diverged from GPT
    ];
    const r = scoreBenchmark(samples, runs);
    expect(r.n).toBe(3);
    expect(r.labeled).toBe(2);
    expect(r.accuracy).toBeCloseTo(0.5); // a correct, b wrong of 2 labeled
    expect(r.gptAgreement).toBeCloseTo(1 / 3); // only "a" matches predictedStream
    expect(r.wrongVerdicts).toBe(1);
    expect(r.divergedFromWrong).toBe(1);
    expect(r.failures).toBe(0);
    expect(r.latency.max).toBe(300);
    expect(r.latency.p50).toBe(200);
    expect(r.perStream).toEqual({
      recycling: { gt: 1, correct: 1 },
      compost: { gt: 1, correct: 0 },
    });
  });

  it("counts missing or failed runs as failures and excludes them", () => {
    const runs: VlmRunResult[] = [
      { requestId: "a", predictedStream: "recycling", latencyMs: 100, ok: true },
      { requestId: "b", predictedStream: "", latencyMs: 0, ok: false },
      // c missing entirely
    ];
    const r = scoreBenchmark(samples, runs);
    expect(r.failures).toBe(2);
    expect(r.accuracy).toBe(1); // only "a" scored, and it matches
    expect(r.labeled).toBe(1);
  });
});

describe("runBenchmark", () => {
  const samples = [
    makeSample({ requestId: "a", predictedStream: "recycling", groundTruthStream: "recycling" }),
    makeSample({ requestId: "b", predictedStream: "compost", groundTruthStream: "compost" }),
  ];

  it("runs an adapter over all samples with a deterministic injected clock", async () => {
    let t = 0;
    const adapter = makeStubAdapter("echo"); // echoes predictedStream → perfect agreement
    const { report, results } = await runBenchmark(samples, adapter, {
      allowedStreams: ["recycling", "compost", "landfill"],
      concurrency: 1,
      now: () => t++,
    });
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(report.accuracy).toBe(1);
    expect(report.gptAgreement).toBe(1);
    // each sample consumes two clock ticks (start, end) → latency 1
    expect(report.latency.max).toBe(1);
  });

  it("records adapter errors as failures without throwing", async () => {
    const flaky = {
      name: "flaky",
      async classify({ sample }: { sample: EvalSample }) {
        if (sample.requestId === "b") throw new Error("model oom");
        return { stream: sample.predictedStream };
      },
    };
    const { report } = await runBenchmark(samples, flaky, {
      allowedStreams: ["recycling", "compost"],
      concurrency: 2,
    });
    expect(report.failures).toBe(1);
    expect(report.accuracy).toBe(1); // the one that succeeded matched its GT
  });
});
