# Local-VLM benchmark harness

Tooling for the privacy roadmap (CLAUDE.md → Project Vision): replace the cloud
`gpt-5.4-mini` fallback with a local VLM. Before changing the live path we must
prove a candidate VLM is good enough on the **real items that currently escalate
to the cloud**. This harness measures exactly that.

Sequencing (decided): build the local VLM first, keep cloud as a safety net,
then remove cloud once a candidate clears the acceptance bars below.

> Lives under `lib/` (not `docs/`, which is gitignored) so the guide is tracked
> next to the code.

## Pieces

- `eval-set.ts` — pure selection of benchmark samples from pilot-log entries +
  review verdicts (`selectEvalSamples`, `summarizeEvalSet`).
- `scoring.ts` — pure metrics (`scoreBenchmark`, `percentile`).
- `vlm-adapter.ts` — the `VlmAdapter` seam + `makeStubAdapter`. The same
  interface is intended to become the Tier-1.5 backend in Phase 2, so a winning
  model promotes into the live path without a rewrite.
- `runner.ts` — `runBenchmark(samples, adapter, opts)` orchestrator.
- `adapters/prompt.ts` — shared, model-agnostic prompt + output parsing.
- `adapters/qwen-http.ts` — on-device OpenAI-compatible HTTP adapter (no new dep).
- `adapters/smolvlm-browser.ts` — in-browser transformers.js adapter (optional dep).
- `../../app/api/benchmark/eval-set/route.ts` — Phase 0 export endpoint.
- `../../__tests__/benchmark.test.ts` — unit tests for the pure logic + adapters.

## Phase 0 — export the eval set

Pull production env locally, then call the gated endpoint (in-route
`CRON_SECRET` bearer, same as the cron export routes):

```bash
vercel env pull .env.local            # gets KV_REST_API_*, CRON_SECRET, BLOB_*
npm run dev
curl -s -H "Authorization: Bearer $CRON_SECRET" \
  'http://localhost:3000/api/benchmark/eval-set' > eval-set.json
# add ?all=1 to also include non-escalated (T1) reviewed entries
```

Local alternative (no `CRON_SECRET`; reads Redis directly with the read-only
token; requires Node ≥ 23.6 to run the `.mts` directly):

```bash
node --env-file=.env.local scripts/bench/export-eval-set.mts
# writes /tmp/wayste-bench/eval-set.json; prints counts + a model/review breakdown
```

`eval-set.json` = `{ summary, count, samples[] }`. Each sample has the
`imageUrl`, the live model's `predictedStream`, the review `verdict`, and
`groundTruthStream`.

**Ground-truth caveat:** the verdict hash is binary. For `correct` verdicts the
true stream = the model's own answer (a human confirmed it). For `wrong`
verdicts we only know the model was wrong, not the right answer, so
`groundTruthStream` is `null` — those samples are excluded from `accuracy` but
feed the `divergedFromWrong` signal (did the VLM avoid the known mistake?).

## Phase 1 — benchmark a candidate

Pick a deployment and run it over the exported samples:

**A) On-device HTTP (recommended for accuracy parity).** Serve a VLM with any
OpenAI-compatible server (vLLM / Ollama / LM Studio), e.g. Qwen2.5-VL:

```ts
import { makeQwenHttpAdapter } from "@/lib/benchmark/adapters/qwen-http";
import { runBenchmark } from "@/lib/benchmark/runner";

const adapter = makeQwenHttpAdapter({
  endpoint: "http://localhost:8000/v1/chat/completions",
  model: "qwen2.5-vl",
  imageAuthHeader: `Bearer ${process.env.BLOB_READ_WRITE_TOKEN}`, // private blob images
});
const { report } = await runBenchmark(samples, adapter, {
  allowedStreams: [/* site streams */], concurrency: 2,
});
```

**B) In-browser / transformers.js (purest privacy, zero infra).** Install the
optional dep first (intentionally not in package.json), then use the SmolVLM
adapter on WebGPU:

```bash
npm i @huggingface/transformers
```
```ts
import { makeSmolVlmAdapter } from "@/lib/benchmark/adapters/smolvlm-browser";
const adapter = makeSmolVlmAdapter({ model: "HuggingFaceTB/SmolVLM-500M-Instruct", device: "webgpu" });
```

`report` = `{ accuracy, gptAgreement, divergedFromWrong, latency{p50,p95,max,mean}, perStream, failures }`.
Also measure model size and WebGPU availability on the **target kiosk hardware**.

## Acceptance bars to remove cloud (tune with real data)

- `accuracy` ≥ ~95% of what GPT resolved correctly on the same labeled set
- `latency.p95` ≤ ~2–3 s on target hardware (hidden behind the optimistic YOLO
  display, but still bounded)
- resulting `needs_review` rate stays within a few % of current

When a candidate clears these: Phase 2 promotes the adapter into a Tier-1.5
backend behind a flag, Phase 3 shadow-compares vs GPT in a pilot via `/review`,
Phase 4 removes the cloud path.
