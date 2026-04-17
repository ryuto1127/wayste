/**
 * Pure helpers used by the insights dashboard UI.
 *
 * The dashboard view (`components/insights/*`) is a React client component
 * so it can't be unit-tested without a DOM runner. By keeping the formatting
 * and request-shaping logic in this module — pure functions over plain
 * arguments — we get the same coverage with the project's standard
 * Jest + ts-jest setup (no @testing-library dependency).
 *
 * Each helper is small and intentionally not abstracted further: the
 * dashboard has exactly one set of axes (counts vs USD cost) and exactly one
 * date format (Asia/Tokyo "YYYY-MM-DD") so a generic formatter would be
 * overkill.
 */

import type { Period } from "./dashboard-metrics";
import type { TranslationKey } from "./i18n";

/**
 * Categorise a fetch outcome so the UI can show a useful, locale-aware
 * message. We deliberately split `auth` from generic `server` errors because
 * the recovery action differs (reload-to-reauth vs retry the same call).
 */
export type InsightsLoadError = "auth" | "network" | "server";

/**
 * Map an HTTP status code from `/api/dashboard-metrics` to a UI error
 * category. Returns `null` when the response is OK and no error should be
 * shown.
 */
export function mapStatusToError(status: number): InsightsLoadError | null {
  if (status >= 200 && status < 300) return null;
  if (status === 401 || status === 403) return "auth";
  return "server";
}

/**
 * Build the relative URL the dashboard uses to fetch metrics. Centralising
 * this avoids subtle drift between the page (which fetches) and the test
 * suite (which asserts the route is wired correctly).
 */
export function buildDashboardUrl(period: Period): string {
  return `/api/dashboard-metrics?period=${period}`;
}

/**
 * Format a USD cost for the funnel "value" column.
 * - 4 dp for sub-$1 values (so admins can tell $0.0008 from $0.0083),
 * - 2 dp once we cross $1 (the extra precision stops being meaningful).
 */
export function formatUsd(v: number): string {
  if (!Number.isFinite(v) || v <= 0) return "0.0000";
  if (v < 1) return v.toFixed(4);
  return v.toFixed(2);
}

/**
 * Compact USD format used inside the timeseries table cell. The leading
 * `$` is included so the cell is self-describing without needing a column
 * header for context.
 */
export function formatUsdCell(v: number): string {
  if (!Number.isFinite(v) || v <= 0) return "$0";
  if (v < 1) return `$${v.toFixed(4)}`;
  return `$${v.toFixed(2)}`;
}

/**
 * Format `value / denom` as a human-friendly percentage.
 * - Returns "—" when denom is zero (no detections to compare against).
 * - Avoids the misleading "100%" for values that are 99.9× rounded up.
 */
export function formatPercent(value: number, denom: number): string {
  if (!Number.isFinite(value) || !Number.isFinite(denom) || denom <= 0) {
    return "—";
  }
  const pct = (value / denom) * 100;
  if (pct >= 99.95) return "100%";
  if (pct >= 10) return `${pct.toFixed(0)}%`;
  return `${pct.toFixed(1)}%`;
}

/**
 * Strip the year from a JST `YYYY-MM-DD` label so x-axis ticks fit a 30-day
 * range without overlapping. Falls back to the original string when the
 * input doesn't match the expected shape (defensive: should never happen in
 * practice because `dashboard-metrics.ts` always emits this format).
 */
export function formatDateLabel(jstDay: string): string {
  if (jstDay.length === 10 && jstDay[4] === "-" && jstDay[7] === "-") {
    return jstDay.slice(5);
  }
  return jstDay;
}

/**
 * The labels used in the period selector. Co-locating the (period, i18n key)
 * pairs here gives the test a single source of truth and prevents the page
 * from declaring its own set that drifts out of sync with the UI.
 */
export const PERIOD_OPTIONS: readonly { value: Period; labelKey: TranslationKey }[] = [
  { value: "today", labelKey: "periodToday" },
  { value: "yesterday", labelKey: "periodYesterday" },
  { value: "7d", labelKey: "period7d" },
  { value: "30d", labelKey: "period30d" },
] as const;

/**
 * Map a `LoadError` to the i18n key that describes it.  Done as a function
 * (not a record) so unknown values default safely to the generic server
 * message rather than throwing.
 */
export function errorMessageKey(err: InsightsLoadError): TranslationKey {
  switch (err) {
    case "auth":
      return "insightsErrorAuth";
    case "network":
      return "insightsErrorNetwork";
    case "server":
      return "insightsErrorServer";
  }
}
