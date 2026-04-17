"use client";

import type { MisclassificationItem } from "@/lib/dashboard-metrics";
import { t, type Locale, type TranslationKey } from "@/lib/i18n";

interface Props {
  items: readonly MisclassificationItem[];
  locale: Locale;
}

/**
 * Horizontal bar chart of the most-misclassified items in the period.
 *
 * Why a bar chart and not a pie / treemap: relative magnitudes are easier to
 * read at a glance with bars, and the same DOM doubles as the accessible
 * table view (each row carries the rank, item name, and count). The bars are
 * built with plain divs (not SVG) because the layout is one-dimensional —
 * SVG would just add ceremony.
 *
 * The chart degrades gracefully:
 *   - 0 items                → "no misclassifications" panel
 *   - any non-empty list     → bars sized relative to the top item
 */
export function MisclassTopChart({ items, locale }: Props) {
  const T = (key: TranslationKey) => t(locale, key);

  // Top item determines the 100% bar width so visual differences are clear
  // even when counts are small (e.g., 3 vs 1 still shows a meaningful gap).
  const maxCount = items.reduce(
    (max, item) => (item.count > max ? item.count : max),
    0,
  );

  return (
    <section
      aria-labelledby="misclass-top-heading"
      className="rounded-xl border border-neutral-800 bg-neutral-900 p-5"
    >
      <header className="mb-4">
        <h2
          id="misclass-top-heading"
          className="text-lg font-semibold text-white"
        >
          {T("misclassTopTitle")}
        </h2>
        <p className="text-xs text-neutral-500 mt-0.5">{T("misclassTopHint")}</p>
      </header>

      {items.length === 0 ? (
        <p
          role="status"
          className="text-sm text-neutral-400 italic py-2"
        >
          {T("misclassEmpty")}
        </p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs uppercase tracking-wide text-neutral-500 border-b border-neutral-800">
              <th scope="col" className="py-2 pr-3 w-10">
                {T("misclassRank")}
              </th>
              <th scope="col" className="py-2 pr-3">
                {T("misclassItem")}
              </th>
              <th scope="col" className="py-2 pl-3 text-right w-20">
                {T("misclassCount")}
              </th>
            </tr>
          </thead>
          <tbody>
            {items.map((item, index) => {
              const widthPct =
                maxCount > 0 ? (item.count / maxCount) * 100 : 0;
              return (
                <tr
                  key={item.itemName}
                  className="border-b border-neutral-800/60 last:border-b-0"
                >
                  <td className="py-2.5 pr-3 text-neutral-500 tabular-nums">
                    {index + 1}
                  </td>
                  <td className="py-2.5 pr-3">
                    <div className="flex items-center gap-3">
                      <span className="text-white truncate max-w-[260px]">
                        {item.itemName}
                      </span>
                      <div
                        className="flex-1 h-1.5 rounded-full bg-neutral-800 overflow-hidden"
                        aria-hidden="true"
                      >
                        <div
                          className="h-full bg-amber-400/80 rounded-full"
                          style={{ width: `${widthPct}%` }}
                        />
                      </div>
                    </div>
                  </td>
                  <td className="py-2.5 pl-3 text-right text-white font-semibold tabular-nums">
                    {item.count}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}
