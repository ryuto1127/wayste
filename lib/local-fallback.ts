/**
 * On-device needs_review resolution — the DEFAULT kiosk path.
 *
 * When the cloud fallback is disabled (the default), items YOLO can't
 * confidently resolve become `needs_review` entirely on-device: no frame
 * leaves the browser. This module holds that resolution as a pure function
 * so the flagship privacy path is unit-testable outside the component.
 */
import type { ClassificationResponse, SiteConfig } from "./types";
import { buildClassificationResult } from "./waste-rules-core";
import { t, type Locale } from "./i18n";

/**
 * Confidence assigned to on-device needs_review fallbacks. Must be > 0 —
 * confidence 0 collides with the "nothing detected" sentinel filter and the
 * result card would never display. Kept far below any reviewThreshold so the
 * result always renders as needs_review.
 */
export const LOCAL_FALLBACK_CONFIDENCE = 0.01;

/**
 * Build the localized needs_review result shown when the kiosk resolves an
 * uncertain item on-device. Works with or without a loaded site config
 * (config may still be loading during the first seconds after boot).
 */
export function buildLocalNeedsReviewResult(
  locale: Locale,
  siteConfig: SiteConfig | null,
): ClassificationResponse {
  const raw = {
    itemName: t(locale, "uncertain"),
    wasteStream: "needs_review",
    confidence: LOCAL_FALLBACK_CONFIDENCE,
    reasoning: t(locale, "notSureCheck"),
  };
  if (siteConfig) {
    return { ...buildClassificationResult(raw, siteConfig, locale), modelUsed: "T1" };
  }
  return {
    itemName: raw.itemName,
    wasteStream: "needs_review",
    confidence: LOCAL_FALLBACK_CONFIDENCE,
    reasoning: raw.reasoning,
    binColor: "#D97706",
    binLabel: "Needs Verification",
    needsReview: true,
    isCompound: false,
    modelUsed: "T1",
  };
}
