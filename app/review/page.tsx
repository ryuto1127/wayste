"use client";

import { useEffect, useState, useCallback, Suspense } from "react";
import { AdminNav } from "@/components/AdminNav";
import type { PilotLogEntry } from "@/lib/types";
import type { Locale } from "@/lib/i18n";
import { t } from "@/lib/i18n";

// ── Types ──

type ReviewEntry = PilotLogEntry & {
  verdict: "correct" | "wrong" | "false_detection" | null;
};

type Verdict = "correct" | "wrong" | "false_detection";

export default function ReviewPage() {
  return (
    <Suspense fallback={<div className="h-full bg-neutral-950 text-white flex items-center justify-center"><p className="text-neutral-400">Loading...</p></div>}>
      <ImageReviewPage />
    </Suspense>
  );
}

function ImageReviewPage() {
  const [entries, setEntries] = useState<ReviewEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [locale, setLocale] = useState<Locale>("en");
  const [filter, setFilter] = useState<"all" | "pending" | "reviewed">("all");
  const [saving, setSaving] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  const T = useCallback((key: Parameters<typeof t>[1]) => t(locale, key), [locale]);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/review");
      if (res.ok) {
        const data = await res.json();
        setEntries(Array.isArray(data.entries) ? data.entries : []);
      }
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Refetch when tab becomes visible (e.g., after deleting data on dashboard)
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") load();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [load]);

  const submitVerdict = useCallback(async (requestId: string, verdict: Verdict) => {
    setSaving(requestId);
    try {
      await fetch("/api/review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestId, verdict }),
      });
      setEntries((prev) =>
        prev.map((e) =>
          e.requestId === requestId ? { ...e, verdict } : e,
        ),
      );
    } catch {
      // silent
    } finally {
      setSaving(null);
    }
  }, []);

  const deleteEntry = useCallback(async (requestId: string) => {
    setSaving(requestId);
    try {
      const res = await fetch(`/api/review?requestId=${encodeURIComponent(requestId)}`, {
        method: "DELETE",
      });
      if (res.ok) {
        setEntries((prev) => prev.filter((e) => e.requestId !== requestId));
      }
    } catch {
      // silent
    } finally {
      setSaving(null);
    }
  }, []);

  const bulkDelete = useCallback(async (params: URLSearchParams) => {
    const res = await fetch(`/api/review?${params.toString()}`, { method: "DELETE" });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error((err as { error?: string }).error ?? `Delete failed: ${res.status}`);
    }
    const data = await res.json();
    await load();
    return (data as { deleted: number }).deleted;
  }, [load]);

  const handleExport = useCallback(async () => {
    setExporting(true);
    try {
      const res = await fetch("/api/review/download");
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        alert((err as { error?: string }).error ?? `Export failed: ${res.status}`);
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `review-images-${new Date().toISOString().slice(0, 10)}.zip`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      alert("Export failed");
    } finally {
      setExporting(false);
    }
  }, []);

  const reviewed = entries.filter((e) => e.verdict !== null).length;
  const pending = entries.length - reviewed;

  const filtered = entries.filter((e) => {
    if (filter === "pending") return e.verdict === null;
    if (filter === "reviewed") return e.verdict !== null;
    return true;
  });

  // Accuracy = correct / (correct + wrong), excluding false detections
  const correctCount = entries.filter((e) => e.verdict === "correct").length;
  const wrongCount = entries.filter((e) => e.verdict === "wrong").length;
  const falseCount = entries.filter((e) => e.verdict === "false_detection").length;
  const classifiable = correctCount + wrongCount;
  const accuracy = classifiable > 0 ? correctCount / classifiable : null;

  // Count exportable images for button label
  const exportableCount = entries.filter((e) =>
    e.verdict === "wrong" ||
    (e.verdict === "correct" && e.confidence <= 0.80),
  ).filter((e) => e.imageUrl).length;

  if (loading) {
    return (
      <div className="h-full bg-neutral-950 text-white flex items-center justify-center">
        <p className="text-neutral-400">Loading...</p>
      </div>
    );
  }

  return (
    <div className="h-full bg-neutral-950 text-white p-8 overflow-y-auto">
      <div className="max-w-7xl mx-auto">
        {/* Header */}
        <div className="flex items-center justify-between mb-6 flex-wrap gap-3">
          <div>
            <h1 className="text-3xl font-bold">{T("imageReview")}</h1>
            <p className="text-neutral-400 text-sm mt-1">{T("imageReviewSubtitle")}</p>
          </div>
          <AdminNav locale={locale} onToggleLocale={() => setLocale(locale === "en" ? "ja" : "en")} />
        </div>
        {/* Stats bar */}
        <div className="flex items-center gap-4 mb-6 flex-wrap">
          <div className="bg-neutral-900 rounded-xl px-4 py-2">
            <span className="text-neutral-400 text-sm">{T("allEntries")}: </span>
            <span className="text-white font-bold">{entries.length}</span>
          </div>
          <div className="bg-neutral-900 rounded-xl px-4 py-2">
            <span className="text-emerald-400 text-sm">{reviewed} {T("reviewed")}</span>
          </div>
          <div className="bg-neutral-900 rounded-xl px-4 py-2">
            <span className="text-orange-400 text-sm">{pending} {T("pendingReview")}</span>
          </div>
          {falseCount > 0 && (
            <div className="bg-neutral-900 rounded-xl px-4 py-2">
              <span className="text-neutral-500 text-sm">{falseCount} {T("falseDetection")}</span>
            </div>
          )}
          {accuracy !== null && (
            <div className="bg-neutral-900 rounded-xl px-4 py-2">
              <span className="text-neutral-400 text-sm">{T("accuracyRate")}: </span>
              <span className={`font-bold ${accuracy >= 0.8 ? "text-emerald-400" : accuracy >= 0.6 ? "text-amber-400" : "text-red-400"}`}>
                {Math.round(accuracy * 100)}%
              </span>
              <span className="text-neutral-600 text-xs ml-1">
                ({correctCount}/{classifiable})
              </span>
            </div>
          )}
          {exportableCount > 0 && (
            <button
              onClick={handleExport}
              disabled={exporting}
              className="px-4 py-2 rounded-lg bg-purple-700 hover:bg-purple-600 text-sm font-medium transition-colors disabled:opacity-50"
            >
              {exporting
                ? (locale === "ja" ? "エクスポート中..." : "Exporting...")
                : (locale === "ja" ? `画像ZIP (${exportableCount}枚)` : `Export ZIP (${exportableCount} images)`)}
            </button>
          )}
        </div>

        {/* Bulk delete */}
        <BulkDeletePanel onDelete={bulkDelete} locale={locale} />

        {/* Filter tabs */}
        <div className="flex gap-2 mb-6">
          {(["all", "pending", "reviewed"] as const).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`px-4 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                filter === f
                  ? "bg-neutral-700 text-white"
                  : "bg-neutral-900 text-neutral-400 hover:bg-neutral-800"
              }`}
            >
              {f === "all" ? T("allEntries") : f === "pending" ? T("pendingReview") : T("reviewed")}
            </button>
          ))}
        </div>

        {/* Entries grid */}
        {filtered.length === 0 ? (
          <div className="bg-neutral-900 rounded-2xl p-12 text-center">
            <p className="text-neutral-400 text-lg">
              {filter === "pending" ? "All entries have been reviewed!" : "No entries found."}
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {filtered.map((entry) => (
              <EntryCard
                key={entry.requestId ?? entry.timestamp}
                entry={entry}
                saving={saving === entry.requestId}
                onVerdict={submitVerdict}
                onDelete={deleteEntry}
                locale={locale}
                T={T}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function EntryCard({
  entry,
  saving,
  onVerdict,
  onDelete,
  locale,
  T,
}: {
  entry: ReviewEntry;
  saving: boolean;
  onVerdict: (requestId: string, verdict: Verdict) => void;
  onDelete: (requestId: string) => void;
  locale: Locale;
  T: (key: Parameters<typeof t>[1]) => string;
}) {
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const date = new Date(entry.timestamp).toLocaleString(
    locale === "ja" ? "ja-JP" : "en-US",
    { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" },
  );

  const verdictBorder =
    entry.verdict === "correct" ? "border-emerald-700/60 bg-emerald-950/20"
    : entry.verdict === "wrong" ? "border-red-700/60 bg-red-950/20"
    : entry.verdict === "false_detection" ? "border-neutral-600 bg-neutral-900/50"
    : "border-neutral-800 bg-neutral-800/40";

  const verdictBadge =
    entry.verdict === "correct" ? { text: T("verdictCorrect"), color: "text-emerald-400" }
    : entry.verdict === "wrong" ? { text: T("verdictWrong"), color: "text-red-400" }
    : entry.verdict === "false_detection" ? { text: T("verdictFalse"), color: "text-neutral-400" }
    : null;

  // Model display name
  const modelLabel = entry.modelUsed ?? "unknown";

  // Sharpness score from CV metadata
  const sharpness = entry.meta?.sharpnessScore;

  return (
    <div className={`rounded-xl border p-4 flex flex-col gap-3 ${verdictBorder}`}>
      {/* Image */}
      {entry.blobUploadFailed ? (
        <div className="w-full rounded-lg bg-neutral-700 flex items-center justify-center text-neutral-400 text-sm text-center px-4 py-8">
          {T("imageUnavailable")}
        </div>
      ) : entry.imageUrl ? (
        <img
          src={`/api/pilot-image?url=${encodeURIComponent(entry.imageUrl)}`}
          alt={entry.itemName}
          className="w-full max-h-48 object-contain rounded-lg bg-neutral-800"
        />
      ) : (
        <div className="w-full rounded-lg bg-neutral-700 flex items-center justify-center text-neutral-500 text-sm py-8">
          {T("noImage")}
        </div>
      )}

      {/* Info */}
      <div>
        <p className="font-semibold text-white truncate">{entry.itemName}</p>
        <p className="text-xs text-neutral-500 mt-0.5">{date}</p>
      </div>

      {/* Prediction details */}
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <StreamPill stream={entry.wasteStream} />
        <span className="text-neutral-600 text-xs">
          {Math.round(entry.confidence * 100)}%
        </span>
      </div>

      {/* Model & sharpness metadata */}
      <div className="flex items-center gap-3 text-xs text-neutral-500">
        <span className="bg-neutral-800 px-2 py-0.5 rounded">{modelLabel}</span>
        {sharpness !== undefined && (
          <span className="bg-neutral-800 px-2 py-0.5 rounded">
            {locale === "ja" ? "鮮明度" : "sharpness"}: {Math.round(sharpness)}
          </span>
        )}
      </div>

      {/* Verdict badge */}
      {verdictBadge && (
        <p className={`text-xs font-medium ${verdictBadge.color}`}>
          {verdictBadge.text}
        </p>
      )}

      {/* Verdict buttons — simple 3-way toggle */}
      <div className="flex gap-2 mt-1">
        <button
          onClick={() => entry.requestId && onVerdict(entry.requestId, "correct")}
          disabled={saving || !entry.requestId}
          className={`flex-1 py-2 rounded-lg text-xs font-medium transition-all ${
            entry.verdict === "correct"
              ? "bg-emerald-700 text-white ring-2 ring-emerald-400"
              : "bg-neutral-800/60 hover:bg-emerald-800 text-neutral-300"
          } disabled:opacity-40`}
        >
          ✓ {T("markCorrect")}
        </button>
        <button
          onClick={() => entry.requestId && onVerdict(entry.requestId, "wrong")}
          disabled={saving || !entry.requestId}
          className={`flex-1 py-2 rounded-lg text-xs font-medium transition-all ${
            entry.verdict === "wrong"
              ? "bg-red-700 text-white ring-2 ring-red-400"
              : "bg-neutral-800/60 hover:bg-red-800 text-neutral-300"
          } disabled:opacity-40`}
        >
          ✗ {T("markWrong")}
        </button>
        <button
          onClick={() => entry.requestId && onVerdict(entry.requestId, "false_detection")}
          disabled={saving || !entry.requestId}
          className={`flex-1 py-2 rounded-lg text-xs font-medium transition-all ${
            entry.verdict === "false_detection"
              ? "bg-neutral-600 text-white ring-2 ring-neutral-400"
              : "bg-neutral-800/60 hover:bg-neutral-700 text-neutral-400"
          } disabled:opacity-40`}
        >
          ∅ {T("falseDetection")}
        </button>
      </div>

      {/* Delete button */}
      {entry.requestId && (
        confirmingDelete ? (
          <div className="flex items-center gap-2 mt-1">
            <span className="text-xs text-red-400">{T("confirmDelete")}</span>
            <button
              onClick={() => { onDelete(entry.requestId!); setConfirmingDelete(false); }}
              disabled={saving}
              className="px-3 py-1 rounded-lg text-xs font-medium bg-red-700 hover:bg-red-600 text-white disabled:opacity-40"
            >
              {T("deleteEntry")}
            </button>
            <button
              onClick={() => setConfirmingDelete(false)}
              className="px-3 py-1 rounded-lg text-xs font-medium bg-neutral-800 hover:bg-neutral-700 text-neutral-400"
            >
              {T("cancel")}
            </button>
          </div>
        ) : (
          <button
            onClick={() => setConfirmingDelete(true)}
            disabled={saving}
            className="self-end text-[11px] text-neutral-600 hover:text-red-400 transition-colors disabled:opacity-40"
          >
            {T("deleteEntry")}
          </button>
        )
      )}
    </div>
  );
}

type BulkMode = "before" | "between" | "all";

function BulkDeletePanel({
  onDelete,
  locale,
}: {
  onDelete: (params: URLSearchParams) => Promise<number>;
  locale: Locale;
}) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<BulkMode>("before");
  const [beforeDate, setBeforeDate] = useState("");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [lastResult, setLastResult] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ja = locale === "ja";

  const buildParams = (): URLSearchParams | null => {
    const p = new URLSearchParams();
    if (mode === "all") {
      p.set("all", "true");
    } else if (mode === "before") {
      if (!beforeDate) return null;
      // end of that day
      p.set("before", new Date(`${beforeDate}T23:59:59.999Z`).toISOString());
    } else {
      if (!fromDate || !toDate) return null;
      p.set("from", new Date(`${fromDate}T00:00:00.000Z`).toISOString());
      p.set("to", new Date(`${toDate}T23:59:59.999Z`).toISOString());
    }
    return p;
  };

  const handleConfirm = async () => {
    const params = buildParams();
    if (!params) return;
    setDeleting(true);
    setError(null);
    try {
      const count = await onDelete(params);
      setLastResult(count);
      setConfirming(false);
      setOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Delete failed");
    } finally {
      setDeleting(false);
    }
  };

  const canProceed =
    mode === "all" ||
    (mode === "before" && !!beforeDate) ||
    (mode === "between" && !!fromDate && !!toDate && fromDate <= toDate);

  return (
    <div className="mb-6">
      <div className="flex items-center gap-3">
        <button
          onClick={() => { setOpen((v) => !v); setConfirming(false); setError(null); setLastResult(null); }}
          className="text-xs text-neutral-500 hover:text-red-400 transition-colors"
        >
          {open ? (ja ? "▲ 一括削除を閉じる" : "▲ Close bulk delete") : (ja ? "▼ 一括削除..." : "▼ Bulk delete...")}
        </button>
        {lastResult !== null && (
          <span className="text-xs text-emerald-400">
            {ja ? `${lastResult} 件削除しました` : `${lastResult} entries deleted`}
          </span>
        )}
      </div>

      {open && (
        <div className="mt-3 bg-neutral-900 border border-neutral-800 rounded-xl p-4 flex flex-col gap-4 max-w-lg">
          {/* Mode selector */}
          <div className="flex gap-2">
            {(["before", "between", "all"] as BulkMode[]).map((m) => (
              <button
                key={m}
                onClick={() => { setMode(m); setConfirming(false); }}
                className={`px-3 py-1 rounded-lg text-xs font-medium transition-colors ${
                  mode === m ? "bg-neutral-700 text-white" : "bg-neutral-800 text-neutral-400 hover:bg-neutral-700"
                }`}
              >
                {m === "before" ? (ja ? "日付より前" : "Before date")
                  : m === "between" ? (ja ? "期間指定" : "Between dates")
                  : (ja ? "すべて" : "All")}
              </button>
            ))}
          </div>

          {/* Inputs */}
          {mode === "before" && (
            <div className="flex items-center gap-2">
              <label className="text-xs text-neutral-400 whitespace-nowrap">
                {ja ? "この日付より前:" : "Before:"}
              </label>
              <input
                type="date"
                value={beforeDate}
                onChange={(e) => { setBeforeDate(e.target.value); setConfirming(false); }}
                className="bg-neutral-800 text-white text-xs rounded-lg px-3 py-1.5 border border-neutral-700 focus:outline-none focus:border-neutral-500"
              />
            </div>
          )}

          {mode === "between" && (
            <div className="flex items-center gap-2 flex-wrap">
              <label className="text-xs text-neutral-400">{ja ? "から:" : "From:"}</label>
              <input
                type="date"
                value={fromDate}
                onChange={(e) => { setFromDate(e.target.value); setConfirming(false); }}
                className="bg-neutral-800 text-white text-xs rounded-lg px-3 py-1.5 border border-neutral-700 focus:outline-none focus:border-neutral-500"
              />
              <label className="text-xs text-neutral-400">{ja ? "まで:" : "To:"}</label>
              <input
                type="date"
                value={toDate}
                onChange={(e) => { setToDate(e.target.value); setConfirming(false); }}
                className="bg-neutral-800 text-white text-xs rounded-lg px-3 py-1.5 border border-neutral-700 focus:outline-none focus:border-neutral-500"
              />
            </div>
          )}

          {mode === "all" && (
            <p className="text-xs text-red-400">
              {ja ? "ログに記録されたすべてのエントリを削除します。" : "This will delete every entry in the log."}
            </p>
          )}

          {error && <p className="text-xs text-red-400">{error}</p>}

          {/* Action */}
          {!confirming ? (
            <button
              onClick={() => setConfirming(true)}
              disabled={!canProceed}
              className="self-start px-4 py-1.5 rounded-lg text-xs font-medium bg-red-900 hover:bg-red-800 text-red-300 transition-colors disabled:opacity-40"
            >
              {ja ? "削除する..." : "Delete..."}
            </button>
          ) : (
            <div className="flex items-center gap-3">
              <span className="text-xs text-red-400 font-medium">
                {ja ? "本当に削除しますか？" : "Are you sure?"}
              </span>
              <button
                onClick={handleConfirm}
                disabled={deleting}
                className="px-3 py-1 rounded-lg text-xs font-medium bg-red-700 hover:bg-red-600 text-white disabled:opacity-40"
              >
                {deleting ? (ja ? "削除中..." : "Deleting...") : (ja ? "はい、削除" : "Yes, delete")}
              </button>
              <button
                onClick={() => setConfirming(false)}
                className="px-3 py-1 rounded-lg text-xs font-medium bg-neutral-800 hover:bg-neutral-700 text-neutral-400"
              >
                {ja ? "キャンセル" : "Cancel"}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function StreamPill({ stream }: { stream: string }) {
  const colorMap: Record<string, string> = {
    recycling: "bg-blue-600",
    compost: "bg-green-600",
    landfill: "bg-neutral-600",
    special: "bg-orange-600",
    needs_review: "bg-purple-600",
  };
  return (
    <span className={`${colorMap[stream] ?? "bg-neutral-600"} text-white text-[10px] font-bold uppercase px-2 py-0.5 rounded-md`}>
      {stream}
    </span>
  );
}
