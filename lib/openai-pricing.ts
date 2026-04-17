/**
 * OpenAI gpt-5.4-mini pricing constants and per-call cost computation.
 *
 * Values are USD per 1,000,000 tokens, sourced from the public OpenAI
 * `gpt-5.4-mini` rate card as of 2026-04. These are kept here so the dashboard
 * cost figure has a single, auditable source of truth.
 *
 * The dashboard supports two cost paths:
 *   1. **Actual** — when `tokenUsage` is recorded on the pilot-log entry,
 *      we compute (`promptTokens * INPUT_RATE + completionTokens * OUTPUT_RATE`).
 *   2. **Fallback** — for legacy entries written before `tokenUsage` was
 *      added, we charge `FALLBACK_COST_USD_PER_CALL` per call. The fallback
 *      assumes the typical `low-detail` Vision request: ~85 image tokens +
 *      ~600 prompt tokens + ~250 completion tokens, which yields the
 *      constant defined below at the listed rates.
 *
 * Override via env (optional): `OPENAI_INPUT_PRICE_PER_M_USD`,
 * `OPENAI_OUTPUT_PRICE_PER_M_USD`. Both must be valid finite numbers > 0;
 * any invalid override falls back to the constant default. We expose the
 * resolution as a function rather than a top-level constant so tests can
 * exercise the env path deterministically.
 */

/** Default input rate (USD per 1M tokens) — gpt-5.4-mini, 2026-04. */
export const OPENAI_INPUT_PRICE_PER_M_USD_DEFAULT = 0.25;
/** Default output rate (USD per 1M tokens) — gpt-5.4-mini, 2026-04. */
export const OPENAI_OUTPUT_PRICE_PER_M_USD_DEFAULT = 2.0;

/**
 * Tokens assumed for a typical classify call when actual usage is unknown.
 * - `image (low-detail)` → 85 tokens (OpenAI fixed)
 * - `prompt`            → ~600 tokens (system + few-shot, observed average)
 * - `completion`        → ~250 tokens (single JSON object, observed average)
 *
 * These are deliberately conservative-but-not-pessimistic estimates so the
 * fallback path neither dramatically over- nor under-states past spend.
 */
export const FALLBACK_PROMPT_TOKENS = 685; // 85 (image) + 600 (text)
export const FALLBACK_COMPLETION_TOKENS = 250;

function parsePositiveFiniteNumber(raw: string | undefined): number | null {
  if (!raw) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

/** Resolve the input price (USD / 1M tokens). Reads env, then falls back. */
export function resolveInputPricePerM(): number {
  return parsePositiveFiniteNumber(process.env.OPENAI_INPUT_PRICE_PER_M_USD)
    ?? OPENAI_INPUT_PRICE_PER_M_USD_DEFAULT;
}

/** Resolve the output price (USD / 1M tokens). Reads env, then falls back. */
export function resolveOutputPricePerM(): number {
  return parsePositiveFiniteNumber(process.env.OPENAI_OUTPUT_PRICE_PER_M_USD)
    ?? OPENAI_OUTPUT_PRICE_PER_M_USD_DEFAULT;
}

/** Compute USD cost from actual token counts and the configured per-M rates. */
export function costFromTokenUsage(
  promptTokens: number,
  completionTokens: number,
  inputPricePerM: number = resolveInputPricePerM(),
  outputPricePerM: number = resolveOutputPricePerM(),
): number {
  const promptCost = (promptTokens * inputPricePerM) / 1_000_000;
  const completionCost = (completionTokens * outputPricePerM) / 1_000_000;
  return promptCost + completionCost;
}

/** USD cost charged for a fallback call (no token usage recorded). */
export function fallbackCostPerCall(
  inputPricePerM: number = resolveInputPricePerM(),
  outputPricePerM: number = resolveOutputPricePerM(),
): number {
  return costFromTokenUsage(
    FALLBACK_PROMPT_TOKENS,
    FALLBACK_COMPLETION_TOKENS,
    inputPricePerM,
    outputPricePerM,
  );
}
