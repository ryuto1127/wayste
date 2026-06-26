/**
 * Shared, model-agnostic prompt construction + output parsing for VLM adapters.
 *
 * Pure (no IO, no model deps) so it is unit-tested directly. Concrete adapters
 * (qwen-http, smolvlm-browser) reuse these so prompt wording and stream parsing
 * stay identical across candidates — otherwise benchmark numbers wouldn't be
 * comparable.
 */
import type { EvalSample } from "../eval-set";

/**
 * Build the classification instruction. The model must pick exactly one of the
 * site's disposal streams and answer as JSON so parsing is deterministic.
 */
export function buildVlmPrompt(allowedStreams: string[], sample?: EvalSample): string {
  const streams = allowedStreams.join(", ");
  const hints =
    sample?.yoloCandidates && sample.yoloCandidates.length > 0
      ? `\nDetector hints (not authoritative): ${sample.yoloCandidates
          .map((c) => `${c.itemName} (${c.confidence.toFixed(2)})`)
          .join(", ")}.`
      : "";
  return (
    `You are a waste-sorting assistant. Look at the single item in the image and ` +
    `decide which disposal stream it belongs to.\n` +
    `Choose exactly one of these streams: ${streams}.${hints}\n` +
    `Respond with only JSON: {"stream": "<one of the allowed streams>"}.`
  );
}

/**
 * Extract the chosen stream from raw model text. Strategy:
 *   1. parse JSON and read `.stream` (case-insensitive match to an allowed value)
 *   2. otherwise scan the text for any allowed stream name (case-insensitive)
 * Returns the canonical allowed-stream string, or null if none is found.
 */
export function parseStreamFromOutput(raw: string, allowedStreams: string[]): string | null {
  const canonical = (value: string): string | null => {
    const lower = value.trim().toLowerCase();
    return allowedStreams.find((s) => s.toLowerCase() === lower) ?? null;
  };

  // 1) JSON object anywhere in the text.
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const obj = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
      if (typeof obj.stream === "string") {
        const hit = canonical(obj.stream);
        if (hit) return hit;
      }
    } catch {
      // fall through to text scan
    }
  }

  // 2) First allowed stream mentioned in the text.
  const lowerRaw = raw.toLowerCase();
  let best: { stream: string; idx: number } | null = null;
  for (const s of allowedStreams) {
    const idx = lowerRaw.indexOf(s.toLowerCase());
    if (idx >= 0 && (best === null || idx < best.idx)) best = { stream: s, idx };
  }
  return best?.stream ?? null;
}
