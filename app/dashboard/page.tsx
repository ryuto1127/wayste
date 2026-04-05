"use client";

import { useEffect, useState, useCallback, useRef, Suspense } from "react";
import type { FeedbackStats } from "@/lib/feedback-analysis";
import type { Locale } from "@/lib/i18n";
import { t } from "@/lib/i18n";
import { AdminNav } from "@/components/AdminNav";

export default function DashboardPage() {
  const [stats, setStats] = useState<FeedbackStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [locale, setLocale] = useState<Locale>("en");
  const [isLive, setIsLive] = useState(false);

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
    [locale],
  );

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
        <div className="flex items-center justify-between mb-8 flex-wrap gap-3">
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
          <Suspense fallback={null}>
            <AdminNav locale={locale} onToggleLocale={() => setLocale(locale === "en" ? "ja" : "en")} />
          </Suspense>
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
                      <th className="text-left py-2 pr-4">{locale === "ja" ? "判定" : "Verdict"}</th>
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
                            <span className="text-emerald-400 text-xs font-medium">✓ Correct</span>
                          ) : (
                            <span className="text-red-400 text-xs font-medium">✗ Wrong</span>
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
                            },
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

        {/* ── Data Management ── */}
        <DataManagement locale={locale} T={T} />
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

function DataManagement({ locale, T }: { locale: Locale; T: (key: Parameters<typeof t>[1]) => string }) {
  const [mode, setMode] = useState<"before" | "range" | "all">("before");
  const [beforeDate, setBeforeDate] = useState("");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [result, setResult] = useState<{ deleted: number; kept: number; blobsDeleted: number } | null>(null);
  const [confirmText, setConfirmText] = useState("");
  const dialogRef = useRef<HTMLDialogElement>(null);

  const buildQuery = () => {
    if (mode === "all") return "?all=true";
    if (mode === "before" && beforeDate) return `?before=${beforeDate}`;
    if (mode === "range" && fromDate) {
      let q = `?from=${fromDate}`;
      if (toDate) q += `&to=${toDate}`;
      return q;
    }
    return null;
  };

  const label = mode === "all"
    ? (locale === "ja" ? "全データを削除" : "Delete all data")
    : mode === "before"
      ? (locale === "ja" ? `${beforeDate} より前のデータを削除` : `Delete data before ${beforeDate}`)
      : (locale === "ja" ? `${fromDate} 〜 ${toDate || "現在"} のデータを削除` : `Delete data from ${fromDate} to ${toDate || "now"}`);

  const openConfirm = () => {
    if (!buildQuery()) return;
    setConfirmText("");
    setResult(null);
    dialogRef.current?.showModal();
  };

  const executePurge = async () => {
    const query = buildQuery();
    if (!query) return;
    setDeleting(true);
    setResult(null);
    try {
      const res = await fetch(`/api/pilot-log${query}`, { method: "DELETE" });
      if (res.ok) {
        const data = await res.json();
        setResult(data);
      } else {
        const err = await res.json().catch(() => ({}));
        alert((err as { error?: string }).error ?? `Error: ${res.status}`);
      }
    } catch {
      alert("Request failed");
    } finally {
      setDeleting(false);
    }
  };

  const isReady = !!buildQuery();
  const needsConfirm = mode === "all";

  return (
    <div className="bg-neutral-900 rounded-2xl p-6 mt-6">
      <h2 className="text-lg font-bold mb-4">
        {locale === "ja" ? "データ管理" : "Data Management"}
      </h2>

      <div className="flex flex-wrap gap-2 mb-4">
        <button
          onClick={() => setMode("before")}
          className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${mode === "before" ? "bg-red-700 text-white" : "bg-neutral-800 text-neutral-400 hover:bg-neutral-700"}`}
        >
          {locale === "ja" ? "日付より前を削除" : "Delete before date"}
        </button>
        <button
          onClick={() => setMode("range")}
          className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${mode === "range" ? "bg-red-700 text-white" : "bg-neutral-800 text-neutral-400 hover:bg-neutral-700"}`}
        >
          {locale === "ja" ? "期間指定で削除" : "Delete date range"}
        </button>
        <button
          onClick={() => setMode("all")}
          className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${mode === "all" ? "bg-red-700 text-white" : "bg-neutral-800 text-neutral-400 hover:bg-neutral-700"}`}
        >
          {locale === "ja" ? "全削除" : "Delete all"}
        </button>
      </div>

      <div className="flex flex-wrap items-end gap-3 mb-4">
        {mode === "before" && (
          <label className="flex flex-col gap-1 text-sm text-neutral-400">
            {locale === "ja" ? "この日付より前" : "Before"}
            <input
              type="date"
              value={beforeDate}
              onChange={(e) => setBeforeDate(e.target.value)}
              className="bg-neutral-800 text-white rounded-lg px-3 py-2 border border-neutral-700 focus:outline-none focus:border-white"
            />
          </label>
        )}
        {mode === "range" && (
          <>
            <label className="flex flex-col gap-1 text-sm text-neutral-400">
              {locale === "ja" ? "開始日" : "From"}
              <input
                type="date"
                value={fromDate}
                onChange={(e) => setFromDate(e.target.value)}
                className="bg-neutral-800 text-white rounded-lg px-3 py-2 border border-neutral-700 focus:outline-none focus:border-white"
              />
            </label>
            <label className="flex flex-col gap-1 text-sm text-neutral-400">
              {locale === "ja" ? "終了日" : "To"}
              <input
                type="date"
                value={toDate}
                onChange={(e) => setToDate(e.target.value)}
                className="bg-neutral-800 text-white rounded-lg px-3 py-2 border border-neutral-700 focus:outline-none focus:border-white"
              />
            </label>
          </>
        )}

        <button
          onClick={openConfirm}
          disabled={!isReady || deleting}
          className="px-4 py-2 rounded-lg bg-red-700 hover:bg-red-600 text-sm font-medium disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          {deleting
            ? (locale === "ja" ? "削除中..." : "Deleting...")
            : (locale === "ja" ? "削除" : "Delete")}
        </button>
      </div>

      {result && (
        <div className="bg-neutral-800 rounded-lg p-4 text-sm">
          <p className="text-emerald-400 font-medium">
            {locale === "ja"
              ? `${result.deleted} 件のログと ${result.blobsDeleted} 枚の画像を削除しました（${result.kept} 件を保持）`
              : `Deleted ${result.deleted} entries and ${result.blobsDeleted} images (${result.kept} kept)`}
          </p>
        </div>
      )}

      {/* Confirmation dialog */}
      <dialog
        ref={dialogRef}
        className="bg-neutral-900 text-white rounded-2xl p-6 max-w-md border border-neutral-700 backdrop:bg-black/70"
      >
        <h3 className="text-lg font-bold mb-2 text-red-400">
          {locale === "ja" ? "削除の確認" : "Confirm deletion"}
        </h3>
        <p className="text-sm text-neutral-300 mb-4">{label}</p>
        <p className="text-sm text-neutral-400 mb-1">
          {locale === "ja"
            ? "この操作は元に戻せません。ログ・フィードバック・画像が完全に削除されます。"
            : "This cannot be undone. Logs, feedback, and images will be permanently deleted."}
        </p>

        {needsConfirm && (
          <div className="mt-4 mb-4">
            <p className="text-xs text-neutral-500 mb-1">
              {locale === "ja" ? "確認のため「delete」と入力してください" : "Type \"delete\" to confirm"}
            </p>
            <input
              type="text"
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              placeholder="delete"
              className="w-full bg-neutral-800 text-white rounded-lg px-3 py-2 border border-neutral-700 focus:outline-none focus:border-red-500 text-sm"
            />
          </div>
        )}

        <div className="flex justify-end gap-3 mt-4">
          <button
            onClick={() => dialogRef.current?.close()}
            className="px-4 py-2 rounded-lg bg-neutral-800 hover:bg-neutral-700 text-sm font-medium"
          >
            {locale === "ja" ? "キャンセル" : "Cancel"}
          </button>
          <button
            onClick={() => { dialogRef.current?.close(); executePurge(); }}
            disabled={needsConfirm && confirmText !== "delete"}
            className="px-4 py-2 rounded-lg bg-red-700 hover:bg-red-600 text-sm font-medium disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {locale === "ja" ? "削除する" : "Delete"}
          </button>
        </div>
      </dialog>
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
