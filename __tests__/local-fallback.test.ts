/**
 * Tests for lib/local-fallback.ts — the DEFAULT kiosk path.
 *
 * When the cloud fallback is off (default), uncertain items resolve to
 * needs_review entirely on-device. This is the flagship privacy behavior;
 * it must work in both locales, with and without a loaded site config,
 * and must never carry confidence 0 (the nothing-detected sentinel).
 */
import { buildLocalNeedsReviewResult, LOCAL_FALLBACK_CONFIDENCE } from "@/lib/local-fallback";
import { loadSiteConfig } from "@/lib/waste-rules";
import { t } from "@/lib/i18n";

const config = loadSiteConfig("japan-office");

describe("buildLocalNeedsReviewResult", () => {
  it.each(["en", "ja"] as const)("returns a localized needs_review result (%s)", (locale) => {
    const r = buildLocalNeedsReviewResult(locale, config);
    expect(r.wasteStream).toBe("needs_review");
    expect(r.needsReview).toBe(true);
    expect(r.modelUsed).toBe("T1");
    expect(r.itemName).toBe(t(locale, "uncertain"));
    // The reasoning is the user-facing next-step guidance — must exist.
    expect(r.reasoning).toBe(t(locale, "notSureCheck"));
    // Bin color comes from the site's needs_review stream definition.
    const reviewStream = config.streams.find((s) => s.id === "needs_review");
    expect(r.binColor).toBe(reviewStream?.color);
  });

  it("works before the site config has loaded", () => {
    const r = buildLocalNeedsReviewResult("ja", null);
    expect(r.wasteStream).toBe("needs_review");
    expect(r.needsReview).toBe(true);
    expect(r.binColor).toBe("#D97706");
  });

  it("never uses the nothing-detected sentinel confidence", () => {
    expect(LOCAL_FALLBACK_CONFIDENCE).toBeGreaterThan(0);
    const withConfig = buildLocalNeedsReviewResult("en", config);
    const withoutConfig = buildLocalNeedsReviewResult("en", null);
    expect(withConfig.confidence).toBeGreaterThan(0);
    expect(withoutConfig.confidence).toBeGreaterThan(0);
  });
});
