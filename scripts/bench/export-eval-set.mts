/**
 * Phase 0 runner (local) — export the benchmark eval set from production Redis.
 *
 * Run:
 *   node --env-file=.env.local scripts/bench/export-eval-set.mts
 *
 * Reuses the tested selection logic in lib/benchmark/eval-set.ts. Reads only
 * (read-only token). Writes the full set to /tmp (NOT into the repo) and prints
 * only counts + summary — production image URLs stay out of stdout.
 */
import { Redis } from "@upstash/redis";
import { writeFileSync, mkdirSync } from "node:fs";
import { selectEvalSamples, summarizeEvalSet } from "../../lib/benchmark/eval-set.ts";

const redis = new Redis({
  url: process.env.KV_REST_API_URL!,
  token: process.env.KV_REST_API_READ_ONLY_TOKEN ?? process.env.KV_REST_API_TOKEN!,
});

const raw = await redis.lrange("recycling:pilot-log", 0, -1);
const verdicts =
  ((await redis.hgetall("recycling:review-verdicts")) as Record<string, string> | null) ?? {};

const entries = raw.map((r) => {
  if (r == null) return null;
  if (typeof r === "string") {
    try {
      return JSON.parse(r);
    } catch {
      return null;
    }
  }
  return r;
});

const escalated = selectEvalSamples(entries, verdicts); // t2 only
const allReviewed = selectEvalSamples(entries, verdicts, { escalatedOnly: false });

const outDir = "/tmp/wayste-bench";
mkdirSync(outDir, { recursive: true });
writeFileSync(
  `${outDir}/eval-set.json`,
  JSON.stringify(
    { summary: summarizeEvalSet(escalated), count: escalated.length, samples: escalated },
    null,
    2,
  ),
);

const parsed = entries.filter(Boolean) as Array<{ modelUsed?: string; imageUrl?: string; requestId?: string }>;
const t2 = parsed.filter((e) => e.modelUsed === "t2");
const t1 = parsed.filter((e) => e.modelUsed === "T1");
const t2WithImage = t2.filter((e) => e.imageUrl);
const t2Reviewed = t2.filter((e) => e.requestId && verdicts[e.requestId]);

console.log("pilot-log entries (raw):", raw.length);
console.log("by model -> t2(cloud):", t2.length, " T1(local):", t1.length);
console.log("t2 with image (reviewable):", t2WithImage.length);
console.log("review verdicts total:", Object.keys(verdicts).length);
console.log("t2 reviewed (= benchmark-usable):", t2Reviewed.length);
console.log("escalated(t2)+reviewed samples:", escalated.length);
console.log("all reviewed (incl T1):", allReviewed.length);
console.log("escalated summary:", JSON.stringify(summarizeEvalSet(escalated)));
console.log(`wrote ${outDir}/eval-set.json (local only)`);
