/**
 * Tests for lib/openai-pricing.ts — token-based and fallback cost computations.
 */

import {
  OPENAI_INPUT_PRICE_PER_M_USD_DEFAULT,
  OPENAI_OUTPUT_PRICE_PER_M_USD_DEFAULT,
  FALLBACK_PROMPT_TOKENS,
  FALLBACK_COMPLETION_TOKENS,
  costFromTokenUsage,
  fallbackCostPerCall,
  resolveInputPricePerM,
  resolveOutputPricePerM,
} from "@/lib/openai-pricing";

describe("openai-pricing", () => {
  const ENV_BACKUP = { ...process.env };

  afterEach(() => {
    process.env = { ...ENV_BACKUP };
  });

  describe("costFromTokenUsage", () => {
    it("computes cost using the documented per-M rates", () => {
      // 1,000,000 input tokens @ $0.25 / 1M = $0.25
      expect(costFromTokenUsage(1_000_000, 0, 0.25, 2.0)).toBeCloseTo(0.25, 10);
      // 1,000,000 output tokens @ $2.00 / 1M = $2.00
      expect(costFromTokenUsage(0, 1_000_000, 0.25, 2.0)).toBeCloseTo(2.0, 10);
      // Realistic call: 712 input + 184 output
      const cost = costFromTokenUsage(712, 184, 0.25, 2.0);
      const expected = (712 * 0.25 + 184 * 2.0) / 1_000_000;
      expect(cost).toBeCloseTo(expected, 12);
    });

    it("treats zero usage as zero cost", () => {
      expect(costFromTokenUsage(0, 0, 0.25, 2.0)).toBe(0);
    });

    it("uses env-resolved defaults when no rates passed", () => {
      delete process.env.OPENAI_INPUT_PRICE_PER_M_USD;
      delete process.env.OPENAI_OUTPUT_PRICE_PER_M_USD;
      const cost = costFromTokenUsage(685, 250);
      const expected =
        (685 * OPENAI_INPUT_PRICE_PER_M_USD_DEFAULT
          + 250 * OPENAI_OUTPUT_PRICE_PER_M_USD_DEFAULT) / 1_000_000;
      expect(cost).toBeCloseTo(expected, 12);
    });
  });

  describe("fallbackCostPerCall", () => {
    it("matches the documented default fallback assumptions", () => {
      delete process.env.OPENAI_INPUT_PRICE_PER_M_USD;
      delete process.env.OPENAI_OUTPUT_PRICE_PER_M_USD;
      const cost = fallbackCostPerCall();
      const expected =
        (FALLBACK_PROMPT_TOKENS * OPENAI_INPUT_PRICE_PER_M_USD_DEFAULT
          + FALLBACK_COMPLETION_TOKENS * OPENAI_OUTPUT_PRICE_PER_M_USD_DEFAULT)
        / 1_000_000;
      expect(cost).toBeCloseTo(expected, 12);
      // Sanity check: a single call should be sub-cent.
      expect(cost).toBeGreaterThan(0);
      expect(cost).toBeLessThan(0.01);
    });
  });

  describe("env override resolution", () => {
    it("honours valid positive numeric overrides", () => {
      process.env.OPENAI_INPUT_PRICE_PER_M_USD = "0.5";
      process.env.OPENAI_OUTPUT_PRICE_PER_M_USD = "4";
      expect(resolveInputPricePerM()).toBe(0.5);
      expect(resolveOutputPricePerM()).toBe(4);
    });

    it("falls back when override is missing, non-numeric, zero or negative", () => {
      delete process.env.OPENAI_INPUT_PRICE_PER_M_USD;
      delete process.env.OPENAI_OUTPUT_PRICE_PER_M_USD;
      expect(resolveInputPricePerM()).toBe(OPENAI_INPUT_PRICE_PER_M_USD_DEFAULT);
      expect(resolveOutputPricePerM()).toBe(OPENAI_OUTPUT_PRICE_PER_M_USD_DEFAULT);

      process.env.OPENAI_INPUT_PRICE_PER_M_USD = "not-a-number";
      process.env.OPENAI_OUTPUT_PRICE_PER_M_USD = "0";
      expect(resolveInputPricePerM()).toBe(OPENAI_INPUT_PRICE_PER_M_USD_DEFAULT);
      expect(resolveOutputPricePerM()).toBe(OPENAI_OUTPUT_PRICE_PER_M_USD_DEFAULT);

      process.env.OPENAI_INPUT_PRICE_PER_M_USD = "-1";
      expect(resolveInputPricePerM()).toBe(OPENAI_INPUT_PRICE_PER_M_USD_DEFAULT);
    });
  });
});
