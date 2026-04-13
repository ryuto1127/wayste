"use client";

import { useEffect, useState, useCallback, useMemo, Suspense } from "react";
import { AdminNav } from "@/components/AdminNav";
import { PerformancePanel } from "@/components/PerformancePanel";
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
  const [statusFilter, setStatusFilter] = useState<"all" | "pending" | "correct" | "wrong" | "false_detection">("all");
  const [streamFilter, setStreamFilter] = useState("");
  const [modelFilter, setModelFilter] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
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

  // Build sibling map: base requestId → all item names classified together
  const siblingMap = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const e of entries) {
      if (!e.requestId) continue;
      const base = e.requestId.replace(/-\d+$/, "");
      const arr = map.get(base) ?? [];
      arr.push(e.itemName);
      map.set(base, arr);
    }
    return map;
  }, [entries]);

  const filtered = entries.filter((e) => {
    if (statusFilter === "pending" && e.verdict !== null) return false;
    if (statusFilter === "correct" && e.verdict !== "correct") return false;
    if (statusFilter === "wrong" && e.verdict !== "wrong") return false;
    if (statusFilter === "false_detection" && e.verdict !== "false_detection") return false;
    if (streamFilter && e.wasteStream !== streamFilter) return false;
    if (modelFilter && e.modelUsed !== modelFilter) return false;
    if (searchQuery && !e.itemName.toLowerCase().includes(searchQuery.toLowerCase())) return false;
    return true;
  });

  const uniqueStreams = [...new Set(entries.map((e) => e.wasteStream))].sort();
  const uniqueModels = [...new Set(entries.map((e) => e.modelUsed))].sort();
  const hasActiveFilters = statusFilter !== "all" || streamFilter !== "" || modelFilter !== "" || searchQuery !== "";

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

        {/* Performance monitoring */}
        <PerformancePanel />

        {/* Analysis export */}
        <AnalysisExportPanel locale={locale} />

        {/* Bulk delete */}
        <BulkDeletePanel onDelete={bulkDelete} locale={locale} />

        {/* Filters */}
        <div className="flex flex-col gap-3 mb-6">
          {/* Status pills */}
          <div className="flex gap-2 flex-wrap">
            {([
              { value: "all" as const, label: T("allEntries") },
              { value: "pending" as const, label: T("pendingReview") },
              { value: "correct" as const, label: T("verdictCorrect"), dot: "bg-emerald-400" },
              { value: "wrong" as const, label: T("verdictWrong"), dot: "bg-red-400" },
              { value: "false_detection" as const, label: T("verdictFalse"), dot: "bg-neutral-400" },
            ]).map((f) => (
              <button
                key={f.value}
                onClick={() => setStatusFilter(f.value)}
                className={`px-4 py-1.5 rounded-lg text-sm font-medium transition-colors flex items-center gap-1.5 ${
                  statusFilter === f.value
                    ? "bg-neutral-700 text-white"
                    : "bg-neutral-900 text-neutral-400 hover:bg-neutral-800"
                }`}
              >
                {"dot" in f && <span className={`w-2 h-2 rounded-full ${f.dot}`} />}
                {f.label}
              </button>
            ))}
          </div>

          {/* Additional filters */}
          <div className="flex items-center gap-3 flex-wrap">
            <select
              value={streamFilter}
              onChange={(e) => setStreamFilter(e.target.value)}
              className="bg-neutral-900 text-sm text-neutral-300 rounded-lg px-3 py-1.5 border border-neutral-800 focus:outline-none focus:border-neutral-600"
            >
              <option value="">{locale === "ja" ? "種類: すべて" : "Stream: All"}</option>
              {uniqueStreams.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>

            <select
              value={modelFilter}
              onChange={(e) => setModelFilter(e.target.value)}
              className="bg-neutral-900 text-sm text-neutral-300 rounded-lg px-3 py-1.5 border border-neutral-800 focus:outline-none focus:border-neutral-600"
            >
              <option value="">{locale === "ja" ? "モデル: すべて" : "Model: All"}</option>
              {uniqueModels.map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>

            <input
              type="text"
              placeholder={locale === "ja" ? "アイテム名で検索..." : "Search items..."}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="bg-neutral-900 text-sm text-neutral-300 rounded-lg px-3 py-1.5 border border-neutral-800 focus:outline-none focus:border-neutral-600 w-48"
            />

            {hasActiveFilters && (
              <button
                onClick={() => { setStatusFilter("all"); setStreamFilter(""); setModelFilter(""); setSearchQuery(""); }}
                className="text-xs text-neutral-500 hover:text-neutral-300 transition-colors"
              >
                {locale === "ja" ? "クリア" : "Clear filters"}
              </button>
            )}

            <span className="text-xs text-neutral-500 ml-auto">
              {filtered.length}/{entries.length}
            </span>
          </div>
        </div>

        {/* Entries grid */}
        {filtered.length === 0 ? (
          <div className="bg-neutral-900 rounded-2xl p-12 text-center">
            <p className="text-neutral-400 text-lg">
              {statusFilter === "pending"
                ? (locale === "ja" ? "すべてのエントリーがレビュー済みです！" : "All entries have been reviewed!")
                : (locale === "ja" ? "該当するエントリーがありません。" : "No entries match the filters.")}
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
                siblingNames={entry.requestId ? siblingMap.get(entry.requestId.replace(/-\d+$/, "")) : undefined}
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
  siblingNames,
}: {
  entry: ReviewEntry;
  saving: boolean;
  onVerdict: (requestId: string, verdict: Verdict) => void;
  onDelete: (requestId: string) => void;
  locale: Locale;
  T: (key: Parameters<typeof t>[1]) => string;
  siblingNames?: string[];
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
        {siblingNames && siblingNames.length > 1 && (
          <p className="text-xs text-neutral-400 mt-0.5 truncate">
            {siblingNames.filter(n => n !== entry.itemName).length > 0
              ? `+ ${siblingNames.filter(n => n !== entry.itemName).join(", ")}`
              : `(${siblingNames.length} items)`}
          </p>
        )}
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

      {/* Tier 1 results (YOLO detections) */}
      {(() => {
        // Use tierResults if available; fallback to yoloDetections for older entries
        // Show top 3, sorted by confidence descending
        const NOT_WASTE = new Set(["person","bicycle","car","motorcycle","airplane","bus","train","truck","boat","traffic light","fire hydrant","stop sign","parking meter","bench","bird","cat","dog","horse","sheep","cow","elephant","bear","zebra","giraffe","chair","couch","potted plant","bed","dining table","toilet","sink","refrigerator"]);
        const top3 = (arr?: { itemName: string; confidence: number }[]) =>
          arr?.filter(r => !NOT_WASTE.has(r.itemName)).sort((a, b) => b.confidence - a.confidence).slice(0, 3);
        const rawT1 = entry.tierResults?.tier1
          ?? (entry.modelUsed !== "yolo-local" && entry.yoloDetections?.length
            ? entry.yoloDetections.map(d => ({ itemName: d.className, confidence: d.confidence }))
            : undefined);
        const t1 = top3(rawT1);
        const hasTierData = entry.tierResults !== undefined || rawT1 !== undefined;
        if (!hasTierData) return null;
        const t1RanNoWaste = rawT1 && rawT1.length > 0 && (!t1 || t1.length === 0);
        return (
          <div className="flex items-center gap-1.5 flex-wrap text-[11px]">
            <span className="text-neutral-600 font-medium shrink-0">T1:</span>
            {t1 && t1.length > 0 ? t1.map((r, i) => (
              <span key={i} className="bg-neutral-800/80 text-neutral-400 px-1.5 py-0.5 rounded">
                {r.itemName} <span className="text-neutral-600">{Math.round(r.confidence * 100)}%</span>
              </span>
            )) : (
              <span className="text-neutral-700 italic">
                {t1RanNoWaste ? "non-waste only" : "no detections"}
              </span>
            )}
          </div>
        );
      })()}

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

// ── Analysis Export Panel ──

type AnalysisVerdict = "correct" | "wrong" | "false_detection" | "unreviewed";
type AnalysisModel = "yolo-local" | "t2";

function AnalysisExportPanel({ locale }: { locale: Locale }) {
  const [open, setOpen] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const ja = locale === "ja";

  // Filters
  const [verdicts, setVerdicts] = useState<Set<AnalysisVerdict>>(new Set());
  const [models, setModels] = useState<Set<AnalysisModel>>(new Set());
  const [confidenceMin, setConfidenceMin] = useState("");
  const [confidenceMax, setConfidenceMax] = useState("");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [item, setItem] = useState("");
  const [stream, setStream] = useState("");
  const [format, setFormat] = useState<"json" | "csv">("json");

  const toggleSet = <T,>(set: Set<T>, value: T): Set<T> => {
    const next = new Set(set);
    if (next.has(value)) next.delete(value); else next.add(value);
    return next;
  };

  const buildUrl = (): string => {
    const params = new URLSearchParams();
    if (verdicts.size > 0) params.set("verdict", [...verdicts].join(","));
    if (models.size > 0) params.set("model", [...models].join(","));
    if (confidenceMin) params.set("confidence_min", confidenceMin);
    if (confidenceMax) params.set("confidence_max", confidenceMax);
    if (fromDate) params.set("from", fromDate);
    if (toDate) params.set("to", toDate);
    if (item.trim()) params.set("item", item.trim());
    if (stream) params.set("stream", stream);
    params.set("format", format);
    return `/api/review/export/analysis?${params.toString()}`;
  };

  const handleDownload = async () => {
    setDownloading(true);
    try {
      const res = await fetch(buildUrl());
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        alert((err as { error?: string }).error ?? `Export failed: ${res.status}`);
        return;
      }

      if (format === "csv") {
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `analysis-${new Date().toISOString().slice(0, 10)}.csv`;
        a.click();
        URL.revokeObjectURL(url);
      } else {
        const blob = new Blob([JSON.stringify(await res.json(), null, 2)], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `analysis-${new Date().toISOString().slice(0, 10)}.json`;
        a.click();
        URL.revokeObjectURL(url);
      }
    } catch {
      alert(ja ? "エクスポートに失敗しました" : "Export failed");
    } finally {
      setDownloading(false);
    }
  };

  const verdictOptions: { value: AnalysisVerdict; label: string; color: string }[] = [
    { value: "correct", label: ja ? "正解" : "Correct", color: "bg-emerald-800 text-emerald-200" },
    { value: "wrong", label: ja ? "不正解" : "Wrong", color: "bg-red-800 text-red-200" },
    { value: "false_detection", label: ja ? "誤検出" : "False", color: "bg-neutral-700 text-neutral-300" },
    { value: "unreviewed", label: ja ? "未レビュー" : "Unreviewed", color: "bg-amber-800 text-amber-200" },
  ];

  const modelOptions: { value: AnalysisModel; label: string }[] = [
    { value: "yolo-local", label: "YOLO (T1)" },
    { value: "t2", label: "GPT mini (T2)" },
  ];

  const streamOptions = ["recycling", "compost", "landfill", "special", "needs_review"];

  return (
    <div className="mb-6">
      <button
        onClick={() => setOpen((v) => !v)}
        className="text-xs text-neutral-500 hover:text-cyan-400 transition-colors"
      >
        {open
          ? (ja ? "▲ 分析エクスポートを閉じる" : "▲ Close analysis export")
          : (ja ? "▼ 分析データエクスポート..." : "▼ Analysis export...")}
      </button>

      {open && (
        <div className="mt-3 bg-neutral-900 border border-neutral-800 rounded-xl p-4 flex flex-col gap-4 max-w-2xl">
          {/* Verdict filter */}
          <div>
            <label className="text-xs text-neutral-400 block mb-1.5">{ja ? "判定結果" : "Verdict"}</label>
            <div className="flex flex-wrap gap-1.5">
              {verdictOptions.map((v) => (
                <button
                  key={v.value}
                  onClick={() => setVerdicts(toggleSet(verdicts, v.value))}
                  className={`px-2.5 py-1 rounded-md text-xs font-medium transition-all ${
                    verdicts.has(v.value)
                      ? `${v.color} ring-1 ring-white/30`
                      : "bg-neutral-800 text-neutral-500 hover:bg-neutral-700"
                  }`}
                >
                  {v.label}
                </button>
              ))}
              {verdicts.size > 0 && (
                <button onClick={() => setVerdicts(new Set())} className="text-[10px] text-neutral-600 hover:text-neutral-400 ml-1">
                  {ja ? "クリア" : "clear"}
                </button>
              )}
            </div>
          </div>

          {/* Model filter */}
          <div>
            <label className="text-xs text-neutral-400 block mb-1.5">{ja ? "モデル" : "Model"}</label>
            <div className="flex flex-wrap gap-1.5">
              {modelOptions.map((m) => (
                <button
                  key={m.value}
                  onClick={() => setModels(toggleSet(models, m.value))}
                  className={`px-2.5 py-1 rounded-md text-xs font-medium transition-all ${
                    models.has(m.value)
                      ? "bg-blue-800 text-blue-200 ring-1 ring-white/30"
                      : "bg-neutral-800 text-neutral-500 hover:bg-neutral-700"
                  }`}
                >
                  {m.label}
                </button>
              ))}
              {models.size > 0 && (
                <button onClick={() => setModels(new Set())} className="text-[10px] text-neutral-600 hover:text-neutral-400 ml-1">
                  {ja ? "クリア" : "clear"}
                </button>
              )}
            </div>
          </div>

          {/* Confidence range + date range row */}
          <div className="flex flex-wrap gap-4">
            <div>
              <label className="text-xs text-neutral-400 block mb-1.5">{ja ? "確信度の範囲" : "Confidence range"}</label>
              <div className="flex items-center gap-1.5">
                <input
                  type="number" step="0.05" min="0" max="1" placeholder="0"
                  value={confidenceMin} onChange={(e) => setConfidenceMin(e.target.value)}
                  className="w-16 bg-neutral-800 text-white text-xs rounded-lg px-2 py-1.5 border border-neutral-700 focus:outline-none focus:border-neutral-500"
                />
                <span className="text-neutral-600 text-xs">–</span>
                <input
                  type="number" step="0.05" min="0" max="1" placeholder="1"
                  value={confidenceMax} onChange={(e) => setConfidenceMax(e.target.value)}
                  className="w-16 bg-neutral-800 text-white text-xs rounded-lg px-2 py-1.5 border border-neutral-700 focus:outline-none focus:border-neutral-500"
                />
              </div>
            </div>

            <div>
              <label className="text-xs text-neutral-400 block mb-1.5">{ja ? "期間" : "Date range"}</label>
              <div className="flex items-center gap-1.5">
                <input
                  type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)}
                  className="bg-neutral-800 text-white text-xs rounded-lg px-2 py-1.5 border border-neutral-700 focus:outline-none focus:border-neutral-500"
                />
                <span className="text-neutral-600 text-xs">–</span>
                <input
                  type="date" value={toDate} onChange={(e) => setToDate(e.target.value)}
                  className="bg-neutral-800 text-white text-xs rounded-lg px-2 py-1.5 border border-neutral-700 focus:outline-none focus:border-neutral-500"
                />
              </div>
            </div>
          </div>

          {/* Item + stream row */}
          <div className="flex flex-wrap gap-4">
            <div>
              <label className="text-xs text-neutral-400 block mb-1.5">{ja ? "アイテム名" : "Item name"}</label>
              <input
                type="text" placeholder={ja ? "部分一致..." : "substring..."}
                value={item} onChange={(e) => setItem(e.target.value)}
                className="w-40 bg-neutral-800 text-white text-xs rounded-lg px-2 py-1.5 border border-neutral-700 focus:outline-none focus:border-neutral-500"
              />
            </div>
            <div>
              <label className="text-xs text-neutral-400 block mb-1.5">{ja ? "ゴミの種類" : "Waste stream"}</label>
              <select
                value={stream} onChange={(e) => setStream(e.target.value)}
                className="bg-neutral-800 text-white text-xs rounded-lg px-2 py-1.5 border border-neutral-700 focus:outline-none focus:border-neutral-500"
              >
                <option value="">{ja ? "すべて" : "All"}</option>
                {streamOptions.map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
            </div>
          </div>

          {/* Format + download */}
          <div className="flex items-end gap-3 flex-wrap">
            <div>
              <label className="text-xs text-neutral-400 block mb-1.5">{ja ? "形式" : "Format"}</label>
              <div className="flex gap-1.5">
                {(["json", "csv"] as const).map((f) => (
                  <button
                    key={f}
                    onClick={() => setFormat(f)}
                    className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${
                      format === f ? "bg-cyan-800 text-cyan-200" : "bg-neutral-800 text-neutral-500 hover:bg-neutral-700"
                    }`}
                  >
                    {f.toUpperCase()}
                  </button>
                ))}
              </div>
            </div>
            <button
              onClick={handleDownload}
              disabled={downloading}
              className="px-5 py-1.5 rounded-lg text-xs font-medium bg-cyan-700 hover:bg-cyan-600 text-white transition-colors disabled:opacity-50"
            >
              {downloading
                ? (ja ? "ダウンロード中..." : "Downloading...")
                : (ja ? "ダウンロード" : "Download")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Bulk Delete Panel ──

type BulkMode = "before" | "date" | "all";

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
  const [targetDate, setTargetDate] = useState("");
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
      // Use local timezone so the selected date matches user's day boundary
      p.set("before", new Date(`${beforeDate}T23:59:59.999`).toISOString());
    } else {
      // date mode: delete all entries from the selected day (local timezone)
      if (!targetDate) return null;
      p.set("from", new Date(`${targetDate}T00:00:00.000`).toISOString());
      p.set("to", new Date(`${targetDate}T23:59:59.999`).toISOString());
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
    (mode === "date" && !!targetDate);

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
            {(["before", "date", "all"] as BulkMode[]).map((m) => (
              <button
                key={m}
                onClick={() => { setMode(m); setConfirming(false); }}
                className={`px-3 py-1 rounded-lg text-xs font-medium transition-colors ${
                  mode === m ? "bg-neutral-700 text-white" : "bg-neutral-800 text-neutral-400 hover:bg-neutral-700"
                }`}
              >
                {m === "before" ? (ja ? "日付より前" : "Before date")
                  : m === "date" ? (ja ? "日付を指定" : "Specific date")
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

          {mode === "date" && (
            <div className="flex items-center gap-2">
              <label className="text-xs text-neutral-400 whitespace-nowrap">
                {ja ? "削除する日付:" : "Date:"}
              </label>
              <input
                type="date"
                value={targetDate}
                onChange={(e) => { setTargetDate(e.target.value); setConfirming(false); }}
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
