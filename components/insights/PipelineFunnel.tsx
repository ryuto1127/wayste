"use client";

import type {
  DashboardMetricsResponse,
  FunnelTotals,
} from "@/lib/dashboard-metrics";
import { t, type Locale, type TranslationKey } from "@/lib/i18n";
import { formatPercent, formatUsd } from "@/lib/insights-helpers";

interface Props {
  funnel: FunnelTotals;
  pricing: DashboardMetricsResponse["pricing"];
  locale: Locale;
}

interface Stage {
  /** i18n key for the stage label. */
  labelKey: TranslationKey;
  /** Stage value (count or USD cost). */
  value: number;
  /** Color of the bar — varies down the pipeline so eyes can follow flow. */
  color: string;
  /** Format hint: "count" → integer, "usd" → 4 dp dollar amount. */
  kind: "count" | "usd";
}

/**
 * 5-stage pipeline funnel: detections → YOLO ran → YOLO instant
 *                                       → GPT fallback → GPT cost.
 *
 * Why a horizontal bar rather than a literal trapezoid funnel: a funnel-shape
 * SVG would imply that lower stages are *always* a subset of upper stages.
 * The "GPT cost" bar is in USD so a strict subset relationship doesn't hold
 * (and even count-only stages can have YOLO instant + GPT fallback ≈
 * YOLO ran but not exactly equal). Bar widths sized to a shared "% of
 * detections" scale convey the funnel shape while staying honest about what
 * each row measures.
 *
 * Cost shows the absolute dollar value because dividing it by detections
 * doesn't give a meaningful percentage — it gets a "—" in the share column.
 */
export function PipelineFunnel({ funnel, pricing, locale }: Props) {
  const T = (key: TranslationKey) => t(locale, key);

  const stages: Stage[] = [
    {
      labelKey: "funnelStageDetections",
      value: funnel.detections,
      color: "bg-sky-500/80",
      kind: "count",
    },
    {
      labelKey: "funnelStageYoloRuns",
      value: funnel.yoloRuns,
      color: "bg-cyan-500/80",
      kind: "count",
    },
    {
      labelKey: "funnelStageYoloInstant",
      value: funnel.yoloInstant,
      color: "bg-emerald-500/80",
      kind: "count",
    },
    {
      labelKey: "funnelStageGptFallback",
      value: funnel.gptFallback,
      color: "bg-orange-500/80",
      kind: "count",
    },
    {
      labelKey: "funnelStageGptCost",
      value: funnel.gptCostUsd,
      color: "bg-purple-500/80",
      kind: "usd",
    },
  ];

  // Bar widths are normalised to detections so the visual funnel shape is
  // grounded in the same denominator everyone reads first ("of all detections,
  // how many made it to this stage?"). For the cost row, we still need a bar,
  // so we use its share of detection count as a proxy width — but we don't
  // *display* a percent for it, since cost / count isn't meaningful.
  const denominator = Math.max(funnel.detections, 1);

  return (
    <section
      aria-labelledby="funnel-heading"
      className="rounded-xl border border-neutral-800 bg-neutral-900 p-5"
    >
      <header className="mb-4">
        <h2 id="funnel-heading" className="text-lg font-semibold text-white">
          {T("funnelTitle")}
        </h2>
        <p className="text-xs text-neutral-500 mt-0.5">{T("funnelHint")}</p>
      </header>

      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs uppercase tracking-wide text-neutral-500 border-b border-neutral-800">
            <th scope="col" className="py-2 pr-3 w-44">
              {T("funnelStage")}
            </th>
            <th scope="col" className="py-2 pr-3">
              {/* Bar column has no separate header — it visualises the share. */}
            </th>
            <th scope="col" className="py-2 pl-3 text-right w-28">
              {T("funnelValue")}
            </th>
            <th scope="col" className="py-2 pl-3 text-right w-32">
              {T("funnelShareOfDetections")}
            </th>
          </tr>
        </thead>
        <tbody>
          {stages.map((stage) => {
            // For "count" stages the bar reflects share of detections.
            // For the USD cost row we still want a bar (so the funnel reads
            // visually as 5 rows), but we use its share of detection count as
            // the width proxy — capped at 100% — since it isn't dimensionally
            // a count.
            const widthSource =
              stage.kind === "count"
                ? stage.value
                : Math.min(stage.value, denominator);
            const widthPct = (widthSource / denominator) * 100;

            return (
              <tr
                key={stage.labelKey}
                className="border-b border-neutral-800/60 last:border-b-0"
              >
                <td className="py-2.5 pr-3 text-neutral-300">
                  {T(stage.labelKey)}
                </td>
                <td className="py-2.5 pr-3">
                  <div
                    className="h-2 rounded-full bg-neutral-800 overflow-hidden"
                    aria-hidden="true"
                  >
                    <div
                      className={`h-full rounded-full ${stage.color}`}
                      style={{ width: `${Math.min(widthPct, 100)}%` }}
                    />
                  </div>
                </td>
                <td className="py-2.5 pl-3 text-right text-white font-semibold tabular-nums">
                  {formatStageValue(stage)}
                </td>
                <td className="py-2.5 pl-3 text-right text-neutral-400 tabular-nums">
                  {stage.kind === "count"
                    ? formatPercent(stage.value, funnel.detections)
                    : "—"}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <p className="text-[11px] text-neutral-600 mt-3">
        {T("funnelCostNote")}
        {" "}
        <span className="text-neutral-700">
          (${formatPriceRate(pricing.inputPricePerMUsd)} / M{" "}
          {T("funnelCostRateInput")},
          {" "}${formatPriceRate(pricing.outputPricePerMUsd)} / M{" "}
          {T("funnelCostRateOutput")})
        </span>
      </p>
    </section>
  );
}

// ── Formatting helpers ─────────────────────────────────────────────────────

function formatStageValue(stage: Stage): string {
  if (stage.kind === "usd") return `$${formatUsd(stage.value)}`;
  return stage.value.toLocaleString("en-US");
}

function formatPriceRate(v: number): string {
  // Per-1M token rate — typically a small dollar value with up to 2 dp.
  return v.toFixed(2);
}
