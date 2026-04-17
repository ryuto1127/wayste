/**
 * Tests for the insights dashboard support module:
 *   - lib/insights-helpers.ts: pure helpers used by the dashboard view.
 *   - middleware.ts: confirms /insights is wired into both ADMIN_PATHS and
 *     the matcher (mirrors the Step 3 check for /api/dashboard-metrics).
 *   - lib/i18n.ts: confirms every dashboard-facing key exists for both
 *     English and Japanese (regression guard for missing translations).
 */

import {
  buildDashboardUrl,
  errorMessageKey,
  formatDateLabel,
  formatPercent,
  formatUsd,
  formatUsdCell,
  mapStatusToError,
  PERIOD_OPTIONS,
} from "@/lib/insights-helpers";
import { SUPPORTED_PERIODS } from "@/lib/dashboard-metrics";
import { t, type TranslationKey } from "@/lib/i18n";

// ── mapStatusToError ───────────────────────────────────────────────────────

describe("mapStatusToError", () => {
  it("returns null for any 2xx", () => {
    expect(mapStatusToError(200)).toBeNull();
    expect(mapStatusToError(204)).toBeNull();
    expect(mapStatusToError(299)).toBeNull();
  });

  it("classifies 401 / 403 as auth", () => {
    expect(mapStatusToError(401)).toBe("auth");
    expect(mapStatusToError(403)).toBe("auth");
  });

  it("classifies other non-2xx as server", () => {
    expect(mapStatusToError(400)).toBe("server");
    expect(mapStatusToError(404)).toBe("server");
    expect(mapStatusToError(500)).toBe("server");
    expect(mapStatusToError(502)).toBe("server");
  });
});

// ── buildDashboardUrl ──────────────────────────────────────────────────────

describe("buildDashboardUrl", () => {
  it("targets the dashboard-metrics route for every supported period", () => {
    for (const p of SUPPORTED_PERIODS) {
      expect(buildDashboardUrl(p)).toBe(`/api/dashboard-metrics?period=${p}`);
    }
  });
});

// ── formatUsd ─────────────────────────────────────────────────────────────

describe("formatUsd", () => {
  it("returns 4-dp zero for non-positive / non-finite values", () => {
    expect(formatUsd(0)).toBe("0.0000");
    expect(formatUsd(-1)).toBe("0.0000");
    expect(formatUsd(NaN)).toBe("0.0000");
    expect(formatUsd(Infinity)).toBe("0.0000");
  });

  it("uses 4 decimals for sub-$1 amounts", () => {
    expect(formatUsd(0.00067)).toBe("0.0007");
    expect(formatUsd(0.0083)).toBe("0.0083");
    expect(formatUsd(0.5)).toBe("0.5000");
  });

  it("uses 2 decimals once the value crosses $1", () => {
    expect(formatUsd(1)).toBe("1.00");
    expect(formatUsd(12.345)).toBe("12.35");
    expect(formatUsd(1000)).toBe("1000.00");
  });
});

// ── formatUsdCell ─────────────────────────────────────────────────────────

describe("formatUsdCell", () => {
  it("renders zero/non-finite as a bare $0 (table cell needs to be tight)", () => {
    expect(formatUsdCell(0)).toBe("$0");
    expect(formatUsdCell(-0.5)).toBe("$0");
    expect(formatUsdCell(NaN)).toBe("$0");
  });

  it("includes 4-dp precision below $1 so daily cents are distinguishable", () => {
    expect(formatUsdCell(0.0008)).toBe("$0.0008");
  });

  it("collapses to 2-dp once the value crosses $1", () => {
    expect(formatUsdCell(1.5)).toBe("$1.50");
    expect(formatUsdCell(120.4567)).toBe("$120.46");
  });
});

// ── formatPercent ─────────────────────────────────────────────────────────

describe("formatPercent", () => {
  it("returns an em-dash when there is no denominator to compare against", () => {
    expect(formatPercent(5, 0)).toBe("—");
    expect(formatPercent(5, -1)).toBe("—");
    expect(formatPercent(NaN, 10)).toBe("—");
    expect(formatPercent(5, NaN)).toBe("—");
  });

  it("rounds 99.95+ up to 100% so we never mislead with '99%'", () => {
    expect(formatPercent(99, 100)).toBe("99%");
    expect(formatPercent(99.95, 100)).toBe("100%");
    expect(formatPercent(100, 100)).toBe("100%");
  });

  it("uses whole-percent formatting at 10% and above", () => {
    expect(formatPercent(75, 100)).toBe("75%");
    expect(formatPercent(10, 100)).toBe("10%");
  });

  it("uses 1-dp precision below 10% to keep small shares legible", () => {
    expect(formatPercent(7, 100)).toBe("7.0%");
    expect(formatPercent(1, 100)).toBe("1.0%");
    expect(formatPercent(2, 250)).toBe("0.8%");
  });
});

// ── formatDateLabel ───────────────────────────────────────────────────────

describe("formatDateLabel", () => {
  it("strips the year from a YYYY-MM-DD JST label", () => {
    expect(formatDateLabel("2026-04-16")).toBe("04-16");
    expect(formatDateLabel("2025-12-31")).toBe("12-31");
  });

  it("returns the input unchanged when it doesn't match the expected shape", () => {
    expect(formatDateLabel("garbage")).toBe("garbage");
    expect(formatDateLabel("2026/04/16")).toBe("2026/04/16");
  });
});

// ── errorMessageKey ───────────────────────────────────────────────────────

describe("errorMessageKey", () => {
  it("maps every error category to a translatable key in both locales", () => {
    const cases = [
      ["auth", "insightsErrorAuth"],
      ["network", "insightsErrorNetwork"],
      ["server", "insightsErrorServer"],
    ] as const;
    for (const [err, key] of cases) {
      expect(errorMessageKey(err)).toBe(key);
      expect(t("en", key)).not.toBe(key);
      expect(t("ja", key)).not.toBe(key);
    }
  });
});

// ── PERIOD_OPTIONS ────────────────────────────────────────────────────────

describe("PERIOD_OPTIONS", () => {
  it("declares one option per supported API period, in the same order", () => {
    expect(PERIOD_OPTIONS.map((o) => o.value)).toEqual([...SUPPORTED_PERIODS]);
  });

  it("references i18n keys that exist for both locales", () => {
    for (const opt of PERIOD_OPTIONS) {
      expect(t("en", opt.labelKey)).not.toBe(opt.labelKey);
      expect(t("ja", opt.labelKey)).not.toBe(opt.labelKey);
    }
  });
});

// ── i18n: dashboard keys defined for EN+JA ────────────────────────────────

describe("insights i18n keys", () => {
  // Every label the dashboard surfaces. Touching this list when adding new
  // copy is enough to catch a missing JA translation in CI.
  const REQUIRED_KEYS: TranslationKey[] = [
    "insightsTitle",
    "insightsSubtitle",
    "openInsights",
    "backToReview",
    "periodToday",
    "periodYesterday",
    "period7d",
    "period30d",
    "insightsLoading",
    "insightsRefresh",
    "insightsErrorAuth",
    "insightsErrorServer",
    "insightsErrorNetwork",
    "insightsRetry",
    "insightsLastUpdated",
    "insightsRangeLabel",
    "insightsTimezoneNote",
    "insightsNoData",
    "misclassTopTitle",
    "misclassTopHint",
    "misclassEmpty",
    "misclassRank",
    "misclassItem",
    "misclassCount",
    "funnelTitle",
    "funnelHint",
    "funnelStageDetections",
    "funnelStageYoloRuns",
    "funnelStageYoloInstant",
    "funnelStageGptFallback",
    "funnelStageGptCost",
    "funnelStage",
    "funnelValue",
    "funnelShareOfDetections",
    "funnelCostNote",
    "funnelCostRateInput",
    "funnelCostRateOutput",
    "timeseriesTitle",
    "timeseriesHint",
    "timeseriesDate",
    "timeseriesEmpty",
    "metricDetections",
    "metricYoloRuns",
    "metricYoloInstant",
    "metricGptFallback",
    "metricGptCost",
  ];

  it.each(REQUIRED_KEYS)("`%s` is defined in EN", (key) => {
    expect(t("en", key)).not.toBe(key);
    expect(t("en", key).length).toBeGreaterThan(0);
  });

  it.each(REQUIRED_KEYS)("`%s` is defined in JA", (key) => {
    expect(t("ja", key)).not.toBe(key);
    expect(t("ja", key).length).toBeGreaterThan(0);
  });

  it("EN and JA differ for at least the page title (sanity check)", () => {
    expect(t("en", "insightsTitle")).not.toBe(t("ja", "insightsTitle"));
  });
});

// ── middleware coverage for /insights ─────────────────────────────────────

describe("middleware coverage for /insights", () => {
  it("includes /insights in both ADMIN_PATHS and the matcher", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const src = fs.readFileSync(
      path.join(process.cwd(), "middleware.ts"),
      "utf8",
    );
    // Same pattern used for /api/dashboard-metrics in Step 3:
    // require the literal in two distinct places (runtime check + matcher).
    expect(src).toContain('"/insights"');
    expect(src).toContain('"/insights/:path*"');
    const adminListHit = src.split('"/insights"').length - 1;
    expect(adminListHit).toBeGreaterThanOrEqual(1);
    const matcherHit = src.split('"/insights/:path*"').length - 1;
    expect(matcherHit).toBeGreaterThanOrEqual(1);
  });
});
