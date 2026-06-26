/**
 * Live demo of the cloud-vs-local shadow path against a REAL local VLM.
 *
 * Uses the SAME shared prompt + parser that lib/vlm-shadow.ts uses in
 * production (buildVlmPrompt / parseStreamFromOutput) and the SAME
 * OpenAI-compatible request shape, pointed at a local ollama-hosted VLM, on a
 * REAL escalated pilot frame. Proves a local model actually produces a stream
 * prediction end-to-end.
 *
 * Prereqs: ollama serve running + `ollama pull <model>`; .env.local has
 * BLOB_READ_WRITE_TOKEN (to fetch the private pilot image).
 *
 * Run:
 *   node --env-file=.env.local scripts/bench/shadow-demo.mts
 */
import { readFileSync } from "node:fs";
import { buildVlmPrompt, parseStreamFromOutput } from "../../lib/benchmark/adapters/prompt.ts";

const ENDPOINT = process.env.LOCAL_VLM_ENDPOINT ?? "http://localhost:11434/v1/chat/completions";
const MODEL = process.env.LOCAL_VLM_MODEL ?? "qwen2.5vl:3b";
const ALLOWED = ["burnable", "recyclable", "plastic", "non-burnable", "special", "needs_review"];

const evalSet = JSON.parse(readFileSync("/tmp/wayste-bench/eval-set.json", "utf8"));
const sample = evalSet.samples?.[0];
if (!sample?.imageUrl) {
  console.error("No sample image in /tmp/wayste-bench/eval-set.json — run export-eval-set first.");
  process.exit(1);
}

// Fetch the real escalated frame (private Vercel Blob → needs the RW token).
const imgRes = await fetch(sample.imageUrl, {
  headers: { Authorization: `Bearer ${process.env.BLOB_READ_WRITE_TOKEN}` },
});
if (!imgRes.ok) {
  console.error("Image fetch failed:", imgRes.status);
  process.exit(1);
}
const b64 = Buffer.from(await imgRes.arrayBuffer()).toString("base64");

// Same as runLocalVlmShadow: build prompt → POST OpenAI-compat → parse stream.
const prompt = buildVlmPrompt(ALLOWED, { yoloCandidates: sample.yoloCandidates });
const start = Date.now();
const res = await fetch(ENDPOINT, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    model: MODEL,
    temperature: 0,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: prompt },
          { type: "image_url", image_url: { url: `data:image/jpeg;base64,${b64}` } },
        ],
      },
    ],
  }),
});
const latencyMs = Date.now() - start;
if (!res.ok) {
  console.error("Model server error:", res.status, (await res.text()).slice(0, 200));
  process.exit(1);
}
const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
const text = data.choices?.[0]?.message?.content ?? "";
const stream = parseStreamFromOutput(text, ALLOWED);

console.log("── cloud-vs-local shadow demo (real local VLM) ──");
console.log("model:           ", MODEL);
console.log("cloud (GPT) said:", sample.predictedStream);
console.log("LOCAL VLM said:  ", stream ?? "(unparseable)");
console.log("agrees w/ cloud: ", stream === sample.predictedStream);
console.log("local latency:   ", latencyMs, "ms");
console.log("raw model text:  ", JSON.stringify(text).slice(0, 240));
