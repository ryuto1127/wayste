"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AdminNav } from "@/components/AdminNav";
import { t, type Locale, type TranslationKey } from "@/lib/i18n";
import type {
  DashboardMetricsResponse,
  Period,
} from "@/lib/dashboard-metrics";
import {
  buildDashboardUrl,
  errorMessageKey,
  mapStatusToError,
  PERIOD_OPTIONS,
  type InsightsLoadError,
} from "@/lib/insights-helpers";
import { MisclassTopChart } from "./MisclassTopChart";
import { PipelineFunnel } from "./PipelineFunnel";
import { MetricsTimeseries } from "./MetricsTimeseries";

// ── State types ────────────────────────────────────────────────────────────

interface FetchState {
  status: "idle" | "loading" | "ready" | "error";
  data?: DashboardMetricsResponse;
  error?: InsightsLoadError;
  /** When the last successful fetch completed (ms epoch). */
  fetchedAt?: number;
}

// ── Component ───────────────────────────────────────────────────────────────

/**
 * Top-level dashboard view. State machine:
 *   period change OR Refresh click → fetch → updates state.
 *
 * Layout principle (per project memory): the *three primary views* (top
 * misclassifications, funnel, timeseries) live in the central content column.
 * Period switcher, locale toggle, refresh button, and "last updated" timestamp
 * are pushed to the top bar so they don't compete with the data for attention.
 */
export function InsightsView() {
  const [locale, setLocale] = useState<Locale>("en");
  const [period, setPeriod] = useState<Period>("today");
  const [state, setState] = useState<FetchState>({ status: "loading" });
  // Track the in-flight request so a fast period switch (or unmount) can
  // cancel the previous fetch and prevent the older response from racing
  // with the newer one and overwriting the UI with stale data.
  const inflightRef = useRef<AbortController | null>(null);

  const T = useCallback(
    (key: TranslationKey) => t(locale, key),
    [locale],
  );

  const load = useCallback(async (p: Period) => {
    inflightRef.current?.abort();
    const ctrl = new AbortController();
    inflightRef.current = ctrl;

    setState({ status: "loading" });
    try {
      const res = await fetch(buildDashboardUrl(p), {
        // Avoid stale cached responses when admins switch periods or refresh.
        cache: "no-store",
        signal: ctrl.signal,
      });
      // Ref-equality check: a newer load() would have replaced inflightRef.
      // Aborted via cleanup (Strict Mode dev double-effect, HMR) won't satisfy
      // this check because no newer call ran — so we still apply the result.
      if (inflightRef.current !== ctrl) return;
      const errKind = mapStatusToError(res.status);
      if (errKind) {
        setState({ status: "error", error: errKind });
        return;
      }
      const data = (await res.json()) as DashboardMetricsResponse;
      if (inflightRef.current !== ctrl) return;
      setState({ status: "ready", data, fetchedAt: Date.now() });
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      if (inflightRef.current !== ctrl) return;
      setState({ status: "error", error: "network" });
    }
  }, []);

  // Initial load + reload on period change. We deliberately do NOT abort in
  // cleanup: in Strict Mode dev the cleanup fires between the two effect
  // invocations, and aborting there would orphan the only fetch (the second
  // effect run finds the ref already pointing at an aborted controller and
  // races with the first response). The ref-equality check inside `load`
  // already neutralises stale responses from superseded fetches.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load(period);
  }, [load, period]);

  return (
    <div className="h-full bg-neutral-950 text-white p-6 sm:p-8 overflow-y-auto">
      <div className="max-w-6xl mx-auto">
        {/* ── Top bar: title + nav (right-aligned secondary controls) ── */}
        <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
          <div>
            <h1 className="text-3xl font-bold">{T("insightsTitle")}</h1>
            <p className="text-neutral-400 text-sm mt-1">
              {T("insightsSubtitle")}
            </p>
          </div>
          <AdminNav
            locale={locale}
            onToggleLocale={() => setLocale(locale === "en" ? "ja" : "en")}
          />
        </div>

        {/* ── Period selector + meta strip ── */}
        <div
          role="group"
          aria-label={T("insightsRangeLabel")}
          className="flex items-center gap-2 flex-wrap mb-3"
        >
          {PERIOD_OPTIONS.map((p) => (
            <button
              key={p.value}
              onClick={() => setPeriod(p.value)}
              aria-pressed={period === p.value}
              className={`px-3.5 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                period === p.value
                  ? "bg-neutral-700 text-white"
                  : "bg-neutral-900 text-neutral-400 hover:bg-neutral-800"
              }`}
            >
              {T(p.labelKey)}
            </button>
          ))}

          <button
            onClick={() => void load(period)}
            disabled={state.status === "loading"}
            className="ml-auto px-3 py-1.5 rounded-lg text-xs font-medium bg-neutral-900 text-neutral-400 hover:bg-neutral-800 disabled:opacity-40 transition-colors"
          >
            {T("insightsRefresh")}
          </button>
        </div>

        <p className="text-[11px] text-neutral-600 mb-6">
          {T("insightsTimezoneNote")}
          {state.status === "ready" && state.fetchedAt && (
            <>
              {" · "}
              {T("insightsLastUpdated")}
              {": "}
              {new Date(state.fetchedAt).toLocaleTimeString(
                locale === "ja" ? "ja-JP" : "en-US",
                { hour: "2-digit", minute: "2-digit", second: "2-digit" },
              )}
            </>
          )}
        </p>

        {/* ── Body ── */}
        {state.status === "loading" && <LoadingState locale={locale} />}

        {state.status === "error" && (
          <ErrorState
            locale={locale}
            error={state.error ?? "server"}
            onRetry={() => void load(period)}
          />
        )}

        {state.status === "ready" && state.data && (
          <DashboardBody data={state.data} locale={locale} />
        )}
      </div>
    </div>
  );
}

// ── Body / state subviews ───────────────────────────────────────────────────

function DashboardBody({
  data,
  locale,
}: {
  data: DashboardMetricsResponse;
  locale: Locale;
}) {
  const T = (key: TranslationKey) => t(locale, key);

  // Empty banner for the all-zero case — we still render every section so the
  // admin sees the *shape* of the dashboard, but they get a clear "no data"
  // hint at the top instead of having to deduce it from "0" everywhere.
  const isEmpty =
    data.funnel.detections === 0 &&
    data.topMisclassifications.length === 0;

  return (
    <div className="flex flex-col gap-6">
      {isEmpty && (
        <div
          role="status"
          className="rounded-xl border border-neutral-800 bg-neutral-900/50 p-6 text-center text-neutral-400 text-sm"
        >
          {T("insightsNoData")}
        </div>
      )}

      {/* Top misclassifications — the most actionable view, placed first. */}
      <MisclassTopChart items={data.topMisclassifications} locale={locale} />

      {/* Funnel: detections → ... → GPT cost. Two-column on wider screens. */}
      <PipelineFunnel
        funnel={data.funnel}
        pricing={data.pricing}
        locale={locale}
      />

      {/* Daily trend across the whole period. */}
      <MetricsTimeseries timeseries={data.timeseries} locale={locale} />
    </div>
  );
}

function LoadingState({ locale }: { locale: Locale }) {
  const T = (key: TranslationKey) => t(locale, key);
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex flex-col gap-4"
    >
      <SkeletonBlock height="180px" />
      <SkeletonBlock height="220px" />
      <SkeletonBlock height="260px" />
      <p className="sr-only">{T("insightsLoading")}</p>
    </div>
  );
}

function SkeletonBlock({ height }: { height: string }) {
  return (
    <div
      aria-hidden="true"
      className="rounded-xl bg-neutral-900 border border-neutral-800 animate-pulse"
      style={{ height }}
    />
  );
}

function ErrorState({
  locale,
  error,
  onRetry,
}: {
  locale: Locale;
  error: InsightsLoadError;
  onRetry: () => void;
}) {
  const T = (key: TranslationKey) => t(locale, key);
  const messageKey = errorMessageKey(error);

  return (
    <div
      role="alert"
      className="rounded-xl border border-red-900/60 bg-red-950/20 p-6 flex flex-col items-start gap-3"
    >
      <p className="text-sm text-red-300">{T(messageKey)}</p>
      <button
        onClick={onRetry}
        className="px-3 py-1.5 rounded-lg text-xs font-medium bg-red-800 hover:bg-red-700 text-white transition-colors"
      >
        {T("insightsRetry")}
      </button>
    </div>
  );
}
