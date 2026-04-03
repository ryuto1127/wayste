"use client";

import { useEffect, useState, useCallback, useMemo } from "react";
import type { FeedbackStats } from "@/lib/feedback-analysis";
import type { Locale } from "@/lib/i18n";
import { t } from "@/lib/i18n";
import Link from "next/link";

export default function DashboardPage() {
  const [stats, setStats] = useState<FeedbackStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [locale, setLocale] = useState<Locale>("en");
  const [isLive, setIsLive] = useState(false);
  const [applyingOverride, setApplyingOverride] = useState<string | null>(null);
  const [appliedOverrides, setAppliedOverrides] = useState<Set<string>>(new Set());

  useEffect(() => {
    const es = new EventSource("/api/stats-stream");

    es.onopen = () => setIsLive(true);

    es.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as FeedbackStats;
        setStats(data);
        setLoading(false);
      } catch {
        // ignore parse errors
      }
    };

    es.onerror = () => {
      setIsLive(false);
    };

    return () => {
      es.close();
      setIsLive(false);
    };
  }, []);

  const T = useCallback(
    (key: Parameters<typeof t>[1]) => t(locale, key),
    [locale]
  );

  const applyOverride = useCallback(async (pattern: string, stream: string) => {
    setApplyingOverride(pattern);
    try {
      const res = await fetch("/api/overrides", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pattern, stream }),
      });
      if (res.ok) {
        setAppliedOverrides((prev) => new Set(prev).add(pattern.toLowerCase()));
      }
    } catch {
      // silent
    } finally {
      setApplyingOverride(null);
    }
  }, []);

  if (loading) {
    return (
      <div className="h-full bg-neutral-950 text-white flex items-center justify-center">
        <p className="text-neutral-400">Loading...</p>
      </div>
    );
  }

  return (
    <div className="h-full bg-neutral-950 text-white p-8 overflow-y-auto">
      <div className="max-w-5xl mx-auto">
        {/* Header */}
        <div className="flex items-center justify-between mb-8">
          <div className="flex items-center gap-3">
            <h1 className="text-3xl font-bold">{T("feedbackDashboard")}</h1>
            {isLive && (
              <span className="flex items-center gap-1.5 text-xs text-emerald-400 font-medium">
                <span className="relative flex h-2 w-2">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
                </span>
                Live
              </span>
            )}
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={() => setLocale(locale === "en" ? "ja" : "en")}
              className="px-3 py-1.5 rounded-lg bg-neutral-800 hover:bg-neutral-700 text-sm transition-colors"
            >
              {T("switchLang")}
            </button>
            <Link
              href="/"
              className="px-4 py-2 rounded-lg bg-neutral-800 hover:bg-neutral-700 text-sm transition-colors"
            >
              {T("backToKiosk")}
            </Link>
          </div>
        </div>

        {!stats || stats.total === 0 ? (
          <div className="bg-neutral-900 rounded-2xl p-12 text-center">
            <p className="text-neutral-400 text-lg">{T("noFeedbackYet")}</p>
          </div>
        ) : (
          <>
            {/* Stats cards */}
            <div className="grid grid-cols-3 gap-4 mb-8">
              <StatCard
                label={T("totalFeedback")}
                value={stats.total.toString()}
              />
              <StatCard
                label={T("accuracyRate")}
                value={`${Math.round(stats.accuracyRate * 100)}%`}
                color={
                  stats.accuracyRate >= 0.8
                    ? "text-emerald-400"
                    : stats.accuracyRate >= 0.6
                      ? "text-amber-400"
                      : "text-red-400"
                }
              />
              <StatCard
                label={T("corrections")}
                value={stats.wrong.toString()}
                color="text-amber-400"
              />
            </div>

            {/* Adaptive threshold */}
            {stats.total >= 20 && (
              <div className="bg-neutral-900 rounded-2xl p-6 mb-6">
                <h2 className="text-lg font-semibold mb-3">
                  {T("adaptiveThreshold")}
                </h2>
                <div className="flex items-center gap-6">
                  <div>
                    <span className="text-xs text-neutral-500 uppercase tracking-wider">
                      {T("currentThreshold")}
                    </span>
                    <p className="text-2xl font-bold text-neutral-300">55%</p>
                  </div>
                  <div className="text-2xl text-neutral-600">→</div>
                  <div>
                    <span className="text-xs text-neutral-500 uppercase tracking-wider">
                      {T("suggestedThreshold")}
                    </span>
                    <p className="text-2xl font-bold text-emerald-400">
                      {Math.round(stats.suggestedThreshold * 100)}%
                    </p>
                  </div>
                  <p className="text-sm text-neutral-500 ml-4">
                    {T("basedOnFeedback")}
                  </p>
                </div>
              </div>
            )}

            {/* Suggested overrides */}
            {stats.suggestedOverrides.length > 0 && (
              <div className="bg-neutral-900 rounded-2xl p-6 mb-6">
                <h2 className="text-lg font-semibold mb-4">
                  {T("suggestedOverrides")}
                </h2>
                <div className="space-y-3">
                  {stats.suggestedOverrides.map((o, i) => (
                    <div
                      key={i}
                      className="flex items-center justify-between bg-neutral-800/60 rounded-xl px-4 py-3"
                    >
                      <div>
                        <span className="text-neutral-200 font-medium">
                          {o.pattern}
                        </span>
                        <span className="text-neutral-500 mx-2">→</span>
                        <span className="text-emerald-400 font-medium">
                          {o.suggestedStream}
                        </span>
                        <span className="text-neutral-500 text-sm ml-3">
                          ({o.wrongCount} {T("timesWrong")})
                        </span>
                      </div>
                      {appliedOverrides.has(o.pattern.toLowerCase()) ? (
                        <span className="text-emerald-400 text-xs font-medium">Applied</span>
                      ) : (
                        <button
                          onClick={() => applyOverride(o.pattern, o.suggestedStream)}
                          disabled={applyingOverride === o.pattern}
                          className="px-3 py-1.5 rounded-lg bg-emerald-700 hover:bg-emerald-600 text-white text-xs font-medium transition-colors disabled:opacity-50"
                        >
                          {applyingOverride === o.pattern ? "..." : "Apply"}
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Most corrected items */}
            {stats.mostCorrected.length > 0 && (
              <div className="bg-neutral-900 rounded-2xl p-6 mb-6">
                <h2 className="text-lg font-semibold mb-4">
                  {T("mostCorrectedItems")}
                </h2>
                <div className="space-y-2">
                  {stats.mostCorrected.map((item, i) => (
                    <div
                      key={i}
                      className="flex items-center justify-between bg-neutral-800/40 rounded-lg px-4 py-2.5"
                    >
                      <span className="text-neutral-200">{item.itemName}</span>
                      <div className="flex items-center gap-3 text-sm">
                        <span className="text-red-400">
                          {item.wrongCount}/{item.totalCount} {T("timesWrong")}
                        </span>
                        <span className="text-neutral-500">
                          {T("correctedTo")}
                        </span>
                        <span className="text-emerald-400 font-medium">
                          {item.mostCommonActual}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Per-stream accuracy */}
            {stats.perStreamAccuracy.length > 0 && (
              <div className="bg-neutral-900 rounded-2xl p-6 mb-6">
                <h2 className="text-lg font-semibold mb-4">
                  {locale === "ja" ? "カテゴリ別正解率" : "Accuracy by Category"}
                </h2>
                <div className="space-y-3">
                  {stats.perStreamAccuracy.map((s) => (
                    <div key={s.stream}>
                      <div className="flex items-center justify-between text-sm mb-1">
                        <div className="flex items-center gap-2">
                          <StreamPill stream={s.stream} />
                          <span className="text-neutral-400 text-xs">
                            ({s.total} {locale === "ja" ? "件" : "items"})
                          </span>
                        </div>
                        <span
                          className={`font-bold text-xs ${
                            s.rate >= 0.8
                              ? "text-emerald-400"
                              : s.rate >= 0.6
                                ? "text-amber-400"
                                : "text-red-400"
                          }`}
                        >
                          {Math.round(s.rate * 100)}%
                        </span>
                      </div>
                      <div className="w-full h-2 bg-neutral-800 rounded-full overflow-hidden">
                        <div
                          className={`h-full rounded-full transition-all duration-500 ${
                            s.rate >= 0.8
                              ? "bg-emerald-500"
                              : s.rate >= 0.6
                                ? "bg-amber-500"
                                : "bg-red-500"
                          }`}
                          style={{ width: `${Math.round(s.rate * 100)}%` }}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* 24-hour trend */}
            {stats.hourlyTrend.some((h) => h.total > 0) && (
              <div className="bg-neutral-900 rounded-2xl p-6 mb-6">
                <h2 className="text-lg font-semibold mb-4">
                  {locale === "ja" ? "24時間の推移" : "24-Hour Activity"}
                </h2>
                <div className="flex items-end gap-1 h-24">
                  {stats.hourlyTrend.map((h) => {
                    const maxTotal = Math.max(
                      ...stats.hourlyTrend.map((x) => x.total),
                      1,
                    );
                    const heightPct = (h.total / maxTotal) * 100;
                    const correctPct = h.total > 0 ? (h.correct / h.total) : 0;
                    return (
                      <div
                        key={h.hour}
                        className="flex-1 flex flex-col items-center gap-0.5"
                        title={`${h.hour}: ${h.total} items, ${Math.round(correctPct * 100)}% correct`}
                      >
                        <div
                          className={`w-full rounded-t transition-all duration-300 ${
                            correctPct >= 0.8
                              ? "bg-emerald-600"
                              : correctPct >= 0.6
                                ? "bg-amber-600"
                                : h.total > 0
                                  ? "bg-red-600"
                                  : "bg-neutral-800"
                          }`}
                          style={{
                            height: `${Math.max(heightPct, h.total > 0 ? 4 : 1)}%`,
                          }}
                        />
                      </div>
                    );
                  })}
                </div>
                <div className="flex justify-between mt-1 text-[9px] text-neutral-600">
                  <span>{stats.hourlyTrend[0]?.hour}</span>
                  <span>{stats.hourlyTrend[stats.hourlyTrend.length - 1]?.hour}</span>
                </div>
              </div>
            )}

            {/* Recent feedback */}
            <div className="bg-neutral-900 rounded-2xl p-6">
              <h2 className="text-lg font-semibold mb-4">
                {T("recentFeedback")}
              </h2>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-neutral-500 text-xs uppercase tracking-wider border-b border-neutral-800">
                      <th className="text-left py-2 pr-4">{T("item")}</th>
                      <th className="text-left py-2 pr-4">{T("predicted")}</th>
                      <th className="text-left py-2 pr-4">{T("actual")}</th>
                      <th className="text-left py-2">{T("time")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {stats.recentFeedback.map((entry) => (
                      <tr
                        key={entry.id}
                        className="border-b border-neutral-800/50"
                      >
                        <td className="py-2.5 pr-4 text-neutral-200">
                          {entry.itemName}
                        </td>
                        <td className="py-2.5 pr-4">
                          <StreamPill stream={entry.predictedStream} />
                        </td>
                        <td className="py-2.5 pr-4">
                          {entry.feedback === "correct" ? (
                            <span className="text-emerald-400 text-xs font-medium">
                              ✓
                            </span>
                          ) : (
                            <StreamPill
                              stream={entry.actualStream ?? "unknown"}
                            />
                          )}
                        </td>
                        <td className="py-2.5 text-neutral-500 text-xs">
                          {new Date(entry.timestamp).toLocaleString(
                            locale === "ja" ? "ja-JP" : "en-US",
                            {
                              month: "short",
                              day: "numeric",
                              hour: "2-digit",
                              minute: "2-digit",
                            }
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function StatCard({
  label,
  value,
  color = "text-white",
}: {
  label: string;
  value: string;
  color?: string;
}) {
  return (
    <div className="bg-neutral-900 rounded-2xl p-5">
      <div className="text-xs font-semibold uppercase tracking-wider text-neutral-500 mb-1">
        {label}
      </div>
      <div className={`text-3xl font-bold ${color}`}>{value}</div>
    </div>
  );
}

function StreamPill({ stream }: { stream: string }) {
  const colorMap: Record<string, string> = {
    recycling: "bg-blue-600",
    compost: "bg-green-600",
    landfill: "bg-neutral-600",
    special: "bg-red-600",
    ewaste: "bg-purple-600",
    needs_review: "bg-amber-600",
  };
  return (
    <span
      className={`${colorMap[stream] ?? "bg-neutral-600"} text-white text-[10px] font-bold uppercase px-2 py-0.5 rounded-md`}
    >
      {stream}
    </span>
  );
}
