/**
 * Daily classification budget — a hard cap on cloud API calls per UTC day.
 *
 * Defense in depth against cost-exhaustion abuse:
 *   - `/api/classify` already requires kiosk auth and per-IP rate limit.
 *   - If a kiosk session cookie leaks, the rate limit can still be evaded
 *     by rotating IPs. This layer places an absolute ceiling on how many
 *     GPT Vision calls the project can make in one day.
 *
 * Implementation: atomic Redis INCR on a key that expires at end-of-day UTC.
 * The first increment of the day sets a 25-hour TTL (+1h slack for DST).
 *
 * Configure via `OPENAI_DAILY_BUDGET` env var. Leave unset to disable
 * (useful in dev). Consumes 1 slot per OpenAI call, regardless of request
 * size — batch requests that produce N items still count as 1 call, matching
 * what OpenAI actually charges for.
 */
import { redis } from "@/lib/redis";

function todayKey(): string {
  // YYYY-MM-DD in UTC so every serverless instance agrees on "day".
  return `budget:openai:${new Date().toISOString().slice(0, 10)}`;
}

const TTL_SECONDS = 25 * 60 * 60;

export interface BudgetCheckResult {
  allowed: boolean;
  used: number;
  cap: number | null;
}

/**
 * Increment the day's counter and return whether the call is allowed.
 * Intentionally increments BEFORE the check so two parallel requests can't
 * both squeak past the cap — the second request sees the incremented value
 * and is rejected cleanly.
 *
 * If the counter increment itself fails (Redis unavailable), we return
 * `allowed: true` rather than denying everyone — availability is valued
 * over the budget guarantee. Operators should notice via other monitoring.
 */
export async function consumeOpenAICall(): Promise<BudgetCheckResult> {
  const capRaw = process.env.OPENAI_DAILY_BUDGET;
  const cap = capRaw ? parseInt(capRaw, 10) : null;
  if (!cap || Number.isNaN(cap) || cap <= 0) {
    return { allowed: true, used: 0, cap: null };
  }

  try {
    const key = todayKey();
    const used = await redis.incr(key);
    if (used === 1) {
      await redis.expire(key, TTL_SECONDS);
    }
    if (used > cap) {
      return { allowed: false, used, cap };
    }
    return { allowed: true, used, cap };
  } catch (err) {
    console.warn("[daily-budget] Redis unavailable, allowing call:", err);
    return { allowed: true, used: 0, cap };
  }
}

/** For readonly status endpoints — doesn't increment the counter. */
export async function peekOpenAIBudget(): Promise<BudgetCheckResult> {
  const capRaw = process.env.OPENAI_DAILY_BUDGET;
  const cap = capRaw ? parseInt(capRaw, 10) : null;
  if (!cap || Number.isNaN(cap) || cap <= 0) {
    return { allowed: true, used: 0, cap: null };
  }
  try {
    const used = (await redis.get<number>(todayKey())) ?? 0;
    return { allowed: used < cap, used, cap };
  } catch {
    return { allowed: true, used: 0, cap };
  }
}
