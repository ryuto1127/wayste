"use client";

import type { TimeSeriesPoint } from "@/lib/dashboard-metrics";
import { t, type Locale, type TranslationKey } from "@/lib/i18n";
import { formatDateLabel, formatUsdCell } from "@/lib/insights-helpers";

interface Props {
  timeseries: readonly TimeSeriesPoint[];
  locale: Locale;
}

interface Series {
  /** i18n label key. */
  labelKey: TranslationKey;
  /** Stroke colour for the polyline. */
  color: string;
  /** Pull the raw value from a TimeSeriesPoint. */
  pick: (p: TimeSeriesPoint) => number;
  /** Which y-axis: counts vs cost. */
  axis: "count" | "usd";
}

const SERIES: Series[] = [
  { labelKey: "metricDetections", color: "#38bdf8", pick: (p) => p.detections, axis: "count" },
  { labelKey: "metricYoloRuns", color: "#22d3ee", pick: (p) => p.yoloRuns, axis: "count" },
  { labelKey: "metricYoloInstant", color: "#34d399", pick: (p) => p.yoloInstant, axis: "count" },
  { labelKey: "metricGptFallback", color: "#fb923c", pick: (p) => p.gptFallback, axis: "count" },
  { labelKey: "metricGptCost", color: "#a78bfa", pick: (p) => p.gptCostUsd, axis: "usd" },
];

// ── Chart geometry ────────────────────────────────────────────────────────
// Pixel-space layout for the inline SVG. We size the SVG with a viewBox so it
// scales fluidly inside its container, but the tick math needs absolute pixel
// dimensions to be predictable.
const CHART_W = 800;
const CHART_H = 220;
const PADDING = { top: 16, right: 56, bottom: 24, left: 44 };
const PLOT_W = CHART_W - PADDING.left - PADDING.right;
const PLOT_H = CHART_H - PADDING.top - PADDING.bottom;

/**
 * Daily trend chart for the 5 funnel metrics.
 *
 * Two-axis chart drawn with raw SVG (no chart library — see
 * `PerformancePanel.tsx` for the precedent pattern).  Counts share the left
 * axis; the cost line is on the right axis so that a $1 cost spike is still
 * visible alongside hundreds of detections.
 *
 * Below the chart sits the *same* data as a regular HTML table — the chart is
 * decorative for sighted users, the table is canonical for screen readers and
 * for anyone who wants exact numbers.
 */
export function MetricsTimeseries({ timeseries, locale }: Props) {
  const T = (key: TranslationKey) => t(locale, key);

  const points = [...timeseries];

  // Empty period → render the section but show an explicit hint instead of
  // a blank chart.
  if (points.length === 0) {
    return (
      <section
        aria-labelledby="timeseries-heading"
        className="rounded-xl border border-neutral-800 bg-neutral-900 p-5"
      >
        <header className="mb-4">
          <h2
            id="timeseries-heading"
            className="text-lg font-semibold text-white"
          >
            {T("timeseriesTitle")}
          </h2>
          <p className="text-xs text-neutral-500 mt-0.5">
            {T("timeseriesHint")}
          </p>
        </header>
        <p
          role="status"
          className="text-sm text-neutral-400 italic py-2"
        >
          {T("timeseriesEmpty")}
        </p>
      </section>
    );
  }

  // Compute axis maxima — separate scales for counts and USD cost so a small
  // cost number doesn't collapse into the x-axis on busy days.
  let maxCount = 0;
  let maxCost = 0;
  for (const p of points) {
    if (p.detections > maxCount) maxCount = p.detections;
    if (p.yoloRuns > maxCount) maxCount = p.yoloRuns;
    if (p.yoloInstant > maxCount) maxCount = p.yoloInstant;
    if (p.gptFallback > maxCount) maxCount = p.gptFallback;
    if (p.gptCostUsd > maxCost) maxCost = p.gptCostUsd;
  }
  // Headroom + minimum so axis labels never go negative or zero-only.
  const yMaxCount = Math.max(Math.ceil(maxCount * 1.15), 5);
  const yMaxCost = Math.max(maxCost * 1.15, 0.001);

  // X positions: evenly spaced. With one point we still render a usable chart
  // by clamping to the centre of the plot area.
  const xFor = (i: number) =>
    points.length === 1
      ? PADDING.left + PLOT_W / 2
      : PADDING.left + (i / (points.length - 1)) * PLOT_W;

  const yForCount = (v: number) =>
    PADDING.top + PLOT_H - (v / yMaxCount) * PLOT_H;
  const yForUsd = (v: number) =>
    PADDING.top + PLOT_H - (v / yMaxCost) * PLOT_H;

  // Build the polyline path string for a series.
  const pathFor = (s: Series): string => {
    const yFn = s.axis === "count" ? yForCount : yForUsd;
    return points
      .map((p, i) => {
        const x = xFor(i);
        const y = yFn(s.pick(p));
        return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(" ");
  };

  // Reduce date label clutter for long ranges. We always show first + last,
  // and pick at most ~6 evenly spaced ticks in between.
  const tickCount = Math.min(6, points.length);
  const tickIndexes = new Set<number>();
  for (let i = 0; i < tickCount; i++) {
    tickIndexes.add(Math.round((i / Math.max(tickCount - 1, 1)) * (points.length - 1)));
  }

  return (
    <section
      aria-labelledby="timeseries-heading"
      className="rounded-xl border border-neutral-800 bg-neutral-900 p-5"
    >
      <header className="mb-4">
        <h2
          id="timeseries-heading"
          className="text-lg font-semibold text-white"
        >
          {T("timeseriesTitle")}
        </h2>
        <p className="text-xs text-neutral-500 mt-0.5">
          {T("timeseriesHint")}
        </p>
      </header>

      {/* Legend */}
      <div className="flex flex-wrap gap-x-4 gap-y-1.5 mb-3 text-xs">
        {SERIES.map((s) => (
          <div
            key={s.labelKey}
            className="flex items-center gap-1.5 text-neutral-300"
          >
            <span
              className="inline-block w-3 h-0.5 rounded-full"
              style={{ backgroundColor: s.color }}
              aria-hidden="true"
            />
            {T(s.labelKey)}
          </div>
        ))}
      </div>

      {/* SVG chart — purely visual, hidden from assistive tech. */}
      <div className="overflow-x-auto" aria-hidden="true">
        <svg
          viewBox={`0 0 ${CHART_W} ${CHART_H}`}
          className="w-full"
          style={{ minWidth: 320, height: CHART_H }}
          role="presentation"
        >
          {/* Horizontal grid + axis labels */}
          {[0, 1, 2, 3, 4].map((i) => {
            const y = PADDING.top + (PLOT_H / 4) * i;
            const countLabel = Math.round(yMaxCount * (1 - i / 4));
            const usdLabel = (yMaxCost * (1 - i / 4)).toFixed(yMaxCost < 0.1 ? 4 : 2);
            return (
              <g key={i}>
                <line
                  x1={PADDING.left}
                  x2={PADDING.left + PLOT_W}
                  y1={y}
                  y2={y}
                  stroke="#262626"
                  strokeWidth={0.5}
                />
                <text
                  x={PADDING.left - 6}
                  y={y + 3}
                  textAnchor="end"
                  fontSize="9"
                  fill="#737373"
                  fontFamily="monospace"
                >
                  {countLabel}
                </text>
                <text
                  x={PADDING.left + PLOT_W + 6}
                  y={y + 3}
                  textAnchor="start"
                  fontSize="9"
                  fill="#737373"
                  fontFamily="monospace"
                >
                  {usdLabel}
                </text>
              </g>
            );
          })}

          {/* X axis date labels */}
          {points.map((p, i) =>
            tickIndexes.has(i) ? (
              <text
                key={`x-${p.date}`}
                x={xFor(i)}
                y={PADDING.top + PLOT_H + 14}
                textAnchor="middle"
                fontSize="9"
                fill="#737373"
                fontFamily="monospace"
              >
                {formatDateLabel(p.date)}
              </text>
            ) : null,
          )}

          {/* Polylines per series. Use stroke-only for visual clarity. */}
          {SERIES.map((s) => (
            <path
              key={s.labelKey}
              d={pathFor(s)}
              fill="none"
              stroke={s.color}
              strokeWidth={1.5}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          ))}

          {/* End-of-series dot for the cost line so a single non-zero day is visible. */}
          {points.length === 1 &&
            SERIES.map((s) => {
              const yFn = s.axis === "count" ? yForCount : yForUsd;
              const v = s.pick(points[0]);
              if (v === 0) return null;
              return (
                <circle
                  key={`dot-${s.labelKey}`}
                  cx={xFor(0)}
                  cy={yFn(v)}
                  r={2.5}
                  fill={s.color}
                />
              );
            })}
        </svg>
      </div>

      {/* Accessible / canonical table view of the same data. */}
      <div className="mt-4 overflow-x-auto">
        <table className="w-full text-xs text-neutral-300">
          <thead>
            <tr className="text-left text-[11px] uppercase tracking-wide text-neutral-500 border-b border-neutral-800">
              <th scope="col" className="py-1.5 pr-3">
                {T("timeseriesDate")}
              </th>
              {SERIES.map((s) => (
                <th
                  key={s.labelKey}
                  scope="col"
                  className="py-1.5 px-2 text-right"
                  style={{ color: s.color }}
                >
                  {T(s.labelKey)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {points.map((p) => (
              <tr
                key={p.date}
                className="border-b border-neutral-800/50 last:border-b-0"
              >
                <td className="py-1.5 pr-3 text-neutral-400 font-mono">
                  {p.date}
                </td>
                {SERIES.map((s) => (
                  <td
                    key={s.labelKey}
                    className="py-1.5 px-2 text-right tabular-nums"
                  >
                    {s.axis === "usd"
                      ? formatUsdCell(s.pick(p))
                      : s.pick(p).toLocaleString("en-US")}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

