"use client";

import { useEffect, useState, useCallback, useRef, useMemo, Suspense } from "react";
import Link from "next/link";
import { AdminNav } from "@/components/AdminNav";
import type { PilotLogEntry } from "@/lib/types";
import type { Locale } from "@/lib/i18n";
import { t } from "@/lib/i18n";

// ── Shared stream definitions ──

const STREAMS: { id: string; labelKey: "recycling" | "compost" | "landfill" | "special" | "needsCorrection"; color: string }[] = [
  { id: "recycling", labelKey: "recycling", color: "bg-blue-600 hover:bg-blue-500" },
  { id: "compost", labelKey: "compost", color: "bg-green-600 hover:bg-green-500" },
  { id: "landfill", labelKey: "landfill", color: "bg-neutral-600 hover:bg-neutral-500" },
  { id: "special", labelKey: "special", color: "bg-orange-600 hover:bg-orange-500" },
  { id: "needs_review", labelKey: "needsCorrection", color: "bg-purple-600 hover:bg-purple-500" },
];

// ── Types ──

type FullReviewEntry = PilotLogEntry & {
  verdict: "correct" | "wrong" | "false_detection" | null;
  verdictStream: string | null;
  correctedItemName: string | null;
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
  const [entries, setEntries] = useState<FullReviewEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [locale, setLocale] = useState<Locale>("en");
  const [filter, setFilter] = useState<"all" | "pending" | "reviewed">("all");
  const [saving, setSaving] = useState<string | null>(null);

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

  const submitVerdict = useCallback(async (
    requestId: string,
    verdict: Verdict,
    verdictStream?: string,
  ) => {
    setSaving(requestId);
    try {
      await fetch("/api/review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: requestId, requestId, verdict, verdictStream }),
      });
      setEntries((prev) =>
        prev.map((e) =>
          e.requestId === requestId
            ? { ...e, verdict, verdictStream: verdictStream ?? null }
            : e
        )
      );
    } catch {
      // silent
    } finally {
      setSaving(null);
    }
  }, []);

  const submitItemName = useCallback(async (requestId: string, correctedItemName: string) => {
    setSaving(requestId);
    try {
      await fetch("/api/review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: requestId, requestId, correctedItemName }),
      });
      setEntries((prev) =>
        prev.map((e) =>
          e.requestId === requestId
            ? { ...e, correctedItemName }
            : e
        )
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
      await fetch(`/api/review?requestId=${encodeURIComponent(requestId)}`, {
        method: "DELETE",
      });
      setEntries((prev) => prev.filter((e) => e.requestId !== requestId));
    } catch {
      // silent
    } finally {
      setSaving(null);
    }
  }, []);

  const reviewed = entries.filter((e) => e.verdict !== null).length;
  const pending = entries.length - reviewed;

  const filtered = entries.filter((e) => {
    if (filter === "pending") return e.verdict === null;
    if (filter === "reviewed") return e.verdict !== null;
    return true;
  });

  // Build sorted list of unique item names for autocomplete
  const knownNames = useMemo(() => {
    const names = new Set<string>();
    for (const e of entries) {
      if (e.correctedItemName) names.add(e.correctedItemName);
      if (e.itemName && e.itemName !== "nothing detected") names.add(e.itemName);
    }
    return [...names].sort((a, b) => a.localeCompare(b));
  }, [entries]);

  // Accuracy = correct / (correct + wrong), excluding false detections
  const correctCount = entries.filter((e) => e.verdict === "correct").length;
  const wrongCount = entries.filter((e) => e.verdict === "wrong").length;
  const falseCount = entries.filter((e) => e.verdict === "false_detection").length;
  const classifiable = correctCount + wrongCount;
  const accuracy = classifiable > 0 ? correctCount / classifiable : null;

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
          {reviewed > 0 && (
            <a
              href="/api/review/download"
              className="px-4 py-2 rounded-lg bg-purple-700 hover:bg-purple-600 text-sm font-medium transition-colors"
            >
              {T("exportData")}
            </a>
          )}
        </div>

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
              <FullEntryCard
                key={entry.requestId ?? entry.timestamp}
                entry={entry}
                saving={saving === entry.requestId}
                onVerdict={submitVerdict}
                onItemName={submitItemName}
                onDelete={deleteEntry}
                knownNames={knownNames}
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

function FullEntryCard({
  entry,
  saving,
  onVerdict,
  onItemName,
  onDelete,
  knownNames,
  locale,
  T,
}: {
  entry: FullReviewEntry;
  saving: boolean;
  onVerdict: (requestId: string, verdict: Verdict, stream?: string) => void;
  onItemName: (requestId: string, correctedItemName: string) => void;
  onDelete: (requestId: string) => void;
  knownNames: string[];
  locale: Locale;
  T: (key: Parameters<typeof t>[1]) => string;
}) {
  const [showStreamPicker, setShowStreamPicker] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [nameInput, setNameInput] = useState(entry.correctedItemName ?? entry.itemName);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const suggestionsRef = useRef<HTMLDivElement>(null);

  const date = new Date(entry.timestamp).toLocaleString(
    locale === "ja" ? "ja-JP" : "en-US",
    { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }
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
        {editingName ? (
          <div className="relative">
            <div className="flex gap-2 items-center">
              <input
                type="text"
                value={nameInput}
                onChange={(e) => { setNameInput(e.target.value); setShowSuggestions(true); }}
                onFocus={() => setShowSuggestions(true)}
                onBlur={() => { setTimeout(() => setShowSuggestions(false), 150); }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && nameInput.trim() && entry.requestId) {
                    onItemName(entry.requestId, nameInput.trim());
                    setEditingName(false);
                    setShowSuggestions(false);
                  }
                  if (e.key === "Escape") {
                    setNameInput(entry.correctedItemName ?? entry.itemName);
                    setEditingName(false);
                    setShowSuggestions(false);
                  }
                }}
                autoFocus
                className="flex-1 bg-neutral-700 text-white text-sm rounded px-2 py-1 outline-none focus:ring-1 focus:ring-purple-500"
              />
              <button
                onClick={() => {
                  if (nameInput.trim() && entry.requestId) {
                    onItemName(entry.requestId, nameInput.trim());
                    setEditingName(false);
                  }
                }}
                disabled={saving || !nameInput.trim()}
                className="px-2 py-1 rounded bg-purple-700 hover:bg-purple-600 text-xs font-medium disabled:opacity-40"
              >
                {T("saveItemName")}
              </button>
            </div>
            {showSuggestions && (() => {
              const q = nameInput.trim().toLowerCase();
              const matches = knownNames.filter(
                (n) => n.toLowerCase().includes(q) && n !== nameInput.trim()
              ).slice(0, 8);
              if (matches.length === 0) return null;
              return (
                <div ref={suggestionsRef} className="absolute z-10 left-0 right-12 mt-1 bg-neutral-700 rounded-lg shadow-lg border border-neutral-600 max-h-40 overflow-y-auto">
                  {matches.map((name) => (
                    <button
                      key={name}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => {
                        setNameInput(name);
                        setShowSuggestions(false);
                        if (entry.requestId) {
                          onItemName(entry.requestId, name);
                          setEditingName(false);
                        }
                      }}
                      className="w-full text-left px-3 py-1.5 text-sm text-white hover:bg-neutral-600 transition-colors"
                    >
                      {name}
                    </button>
                  ))}
                </div>
              );
            })()}
          </div>
        ) : (
          <p
            className="font-semibold text-white truncate cursor-pointer hover:text-purple-300 transition-colors"
            onClick={() => setEditingName(true)}
            title={T("editItemName")}
          >
            {entry.correctedItemName ? (
              <>
                {entry.correctedItemName}
                <span className="text-neutral-500 line-through text-xs ml-2">{entry.itemName}</span>
              </>
            ) : entry.itemName}
            <span className="text-neutral-600 text-xs ml-1">✎</span>
          </p>
        )}
        <p className="text-xs text-neutral-500 mt-0.5">{date}</p>
      </div>

      {/* Prediction */}
      <div className="flex items-center gap-2 text-sm">
        <span className="text-neutral-400">{T("predicted")}:</span>
        <StreamPill stream={entry.wasteStream} />
        <span className="text-neutral-600 text-xs">
          {Math.round(entry.confidence * 100)}%
        </span>
        {entry.verdictStream && entry.verdict === "wrong" && (
          <>
            <span className="text-neutral-600">→</span>
            <StreamPill stream={entry.verdictStream} />
          </>
        )}
      </div>

      {/* Verdict badge */}
      {verdictBadge && (
        <p className={`text-xs font-medium ${verdictBadge.color}`}>
          {verdictBadge.text}
        </p>
      )}

      {/* Verdict buttons */}
      {!showStreamPicker ? (
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
            onClick={() => setShowStreamPicker(true)}
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
      ) : (
        <div>
          <p className="text-xs text-neutral-400 mb-2">{T("selectCorrectStream")}</p>
          <div className="flex flex-wrap gap-2">
            {STREAMS.map((s) => (
              <button
                key={s.id}
                onClick={() => {
                  if (entry.requestId) onVerdict(entry.requestId, "wrong", s.id);
                  setShowStreamPicker(false);
                }}
                disabled={saving}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${s.color} disabled:opacity-40`}
              >
                {T(s.labelKey)}
              </button>
            ))}
            <button
              onClick={() => setShowStreamPicker(false)}
              className="px-3 py-1.5 rounded-lg text-xs font-medium bg-neutral-800 hover:bg-neutral-700 text-neutral-400"
            >
              {T("cancel")}
            </button>
          </div>
        </div>
      )}

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
