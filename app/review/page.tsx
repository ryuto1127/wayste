"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import Link from "next/link";
import type { FeedbackEntry } from "@/lib/types";
import type { Locale } from "@/lib/i18n";
import { t } from "@/lib/i18n";

const STREAMS: { id: string; labelKey: "recycling" | "compost" | "landfill" | "special" | "needsCorrection"; color: string }[] = [
  { id: "recycling", labelKey: "recycling", color: "bg-blue-600 hover:bg-blue-500" },
  { id: "compost", labelKey: "compost", color: "bg-green-600 hover:bg-green-500" },
  { id: "landfill", labelKey: "landfill", color: "bg-neutral-600 hover:bg-neutral-500" },
  { id: "special", labelKey: "special", color: "bg-orange-600 hover:bg-orange-500" },
  { id: "needs_review", labelKey: "needsCorrection", color: "bg-purple-600 hover:bg-purple-500" },
];

type ReviewEntry = FeedbackEntry & { actualStream: string | null; blobUploadFailed?: boolean };

export default function ReviewPage() {
  const [entries, setEntries] = useState<ReviewEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);
  const [savingName, setSavingName] = useState<string | null>(null);
  const [locale, setLocale] = useState<Locale>("en");

  const T = useCallback((key: Parameters<typeof t>[1]) => t(locale, key), [locale]);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/review");
      if (res.ok) setEntries(await res.json());
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const correct = useCallback(async (id: string, actualStream: string) => {
    setSaving(id);
    try {
      await fetch("/api/review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, actualStream }),
      });
      setEntries((prev) =>
        prev.map((e) => (e.id === id ? { ...e, actualStream } : e))
      );
    } catch {
      // silent
    } finally {
      setSaving(null);
    }
  }, []);

  const correctName = useCallback(async (id: string, actualItemName: string) => {
    setSavingName(id);
    try {
      await fetch("/api/review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, actualItemName }),
      });
      setEntries((prev) =>
        prev.map((e) => (e.id === id ? { ...e, actualItemName } : e))
      );
    } catch {
      // silent
    } finally {
      setSavingName(null);
    }
  }, []);

  const corrected = entries.filter((e) => e.actualStream);
  const pending = entries.filter((e) => !e.actualStream);

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
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-3xl font-bold">{T("imageReview")}</h1>
            <p className="text-neutral-400 text-sm mt-1">{T("imageReviewSubtitle")}</p>
          </div>
          <div className="flex items-center gap-3">
            <div className="flex gap-3 text-sm">
              <span className="text-orange-400 font-medium">{pending.length} {T("pendingCount")}</span>
              <span className="text-emerald-400 font-medium">{corrected.length} {T("correctedCount")}</span>
            </div>
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

        {entries.length === 0 ? (
          <div className="bg-neutral-900 rounded-2xl p-12 text-center">
            <p className="text-neutral-400 text-lg">{T("noWrongEntries")}</p>
          </div>
        ) : (
          <>
            {/* Pending entries */}
            {pending.length > 0 && (
              <div className="bg-neutral-900 rounded-2xl p-6 mb-6 w-full">
                <h2 className="text-sm font-semibold text-orange-400 uppercase tracking-wider mb-4">
                  {T("needsCorrection")}
                </h2>
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                  {pending.map((entry) => (
                    <EntryCard
                      key={entry.id}
                      entry={entry}
                      saving={saving === entry.id}
                      savingName={savingName === entry.id}
                      onCorrect={correct}
                      onCorrectName={correctName}
                      locale={locale}
                      T={T}
                    />
                  ))}
                </div>
              </div>
            )}

            {/* Corrected entries */}
            {corrected.length > 0 && (
              <div className="bg-neutral-900 rounded-2xl p-6">
                <h2 className="text-sm font-semibold text-emerald-400 uppercase tracking-wider mb-4">
                  {T("correctedSection")}
                </h2>
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                  {corrected.map((entry) => (
                    <EntryCard
                      key={entry.id}
                      entry={entry}
                      saving={saving === entry.id}
                      savingName={savingName === entry.id}
                      onCorrect={correct}
                      onCorrectName={correctName}
                      locale={locale}
                      T={T}
                    />
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function EntryCard({
  entry,
  saving,
  savingName,
  onCorrect,
  onCorrectName,
  locale,
  T,
}: {
  entry: ReviewEntry;
  saving: boolean;
  savingName: boolean;
  onCorrect: (id: string, stream: string) => void;
  onCorrectName: (id: string, name: string) => void;
  locale: Locale;
  T: (key: Parameters<typeof t>[1]) => string;
}) {
  const [editingName, setEditingName] = useState(false);
  const [nameValue, setNameValue] = useState(entry.actualItemName ?? entry.itemName);
  const inputRef = useRef<HTMLInputElement>(null);

  const displayName = entry.actualItemName ?? entry.itemName;
  const date = new Date(entry.timestamp).toLocaleString(
    locale === "ja" ? "ja-JP" : "en-US",
    { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }
  );
  const isCorrected = !!entry.actualStream;

  const startEdit = () => {
    setNameValue(entry.actualItemName ?? entry.itemName);
    setEditingName(true);
    setTimeout(() => inputRef.current?.focus(), 0);
  };

  const saveEdit = async () => {
    const trimmed = nameValue.trim();
    if (trimmed && trimmed !== (entry.actualItemName ?? entry.itemName)) {
      await onCorrectName(entry.id, trimmed);
    }
    setEditingName(false);
  };

  const cancelEdit = () => {
    setNameValue(entry.actualItemName ?? entry.itemName);
    setEditingName(false);
  };

  return (
    <div className={`rounded-xl border p-4 flex flex-col gap-3 ${
      isCorrected
        ? "border-emerald-800/50 bg-emerald-950/20"
        : "border-neutral-800 bg-neutral-800/40"
    }`}>
      {/* Image */}
      {entry.blobUploadFailed ? (
        <div className="w-full rounded-lg bg-neutral-700 flex items-center justify-center text-neutral-400 text-sm text-center px-4 py-8">
          {T("imageUnavailable")}
        </div>
      ) : entry.imageUrl ? (
        <img
          src={entry.imageUrl}
          alt={displayName}
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
          <div className="flex items-center gap-2">
            <input
              ref={inputRef}
              value={nameValue}
              onChange={(e) => setNameValue(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") saveEdit(); if (e.key === "Escape") cancelEdit(); }}
              disabled={savingName}
              className="flex-1 bg-neutral-700 text-white text-sm font-semibold rounded-lg px-2 py-1 border border-neutral-500 focus:outline-none focus:border-white min-w-0"
            />
            <button
              onClick={saveEdit}
              disabled={savingName}
              className="px-2 py-1 rounded-lg bg-emerald-700 hover:bg-emerald-600 text-xs font-medium disabled:opacity-40 shrink-0"
            >
              {savingName ? "…" : T("saveName")}
            </button>
            <button
              onClick={cancelEdit}
              disabled={savingName}
              className="px-2 py-1 rounded-lg bg-neutral-700 hover:bg-neutral-600 text-xs font-medium disabled:opacity-40 shrink-0"
            >
              ✕
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-1.5 group">
            <p className="font-semibold text-white truncate">
              {displayName}
              {entry.actualItemName && entry.actualItemName !== entry.itemName && (
                <span className="ml-1.5 text-xs text-neutral-500 font-normal line-through">{entry.itemName}</span>
              )}
            </p>
            <button
              onClick={startEdit}
              title={T("editName")}
              className="text-neutral-600 hover:text-neutral-300 transition-colors opacity-0 group-hover:opacity-100 shrink-0"
            >
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
                <path d="M13.488 2.513a1.75 1.75 0 0 0-2.475 0L6.75 6.774a2.75 2.75 0 0 0-.596.892l-.848 2.047a.75.75 0 0 0 .98.98l2.047-.848a2.75 2.75 0 0 0 .892-.596l4.261-4.263a1.75 1.75 0 0 0 0-2.474ZM3.75 12.5a.75.75 0 0 0 0 1.5h8.5a.75.75 0 0 0 0-1.5h-8.5Z" />
              </svg>
            </button>
          </div>
        )}
        <p className="text-xs text-neutral-500 mt-0.5">{date}</p>
      </div>

      {/* Prediction vs correction */}
      <div className="flex items-center gap-2 text-sm">
        <span className="text-neutral-400">{T("predicted")}:</span>
        <StreamPill stream={entry.predictedStream} />
        {isCorrected && (
          <>
            <span className="text-neutral-600">→</span>
            <StreamPill stream={entry.actualStream!} />
          </>
        )}
      </div>

      {/* Stream buttons */}
      <div className="flex flex-wrap gap-2 mt-1">
        {STREAMS.map((s) => (
          <button
            key={s.id}
            onClick={() => onCorrect(entry.id, s.id)}
            disabled={saving}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${s.color} ${
              entry.actualStream === s.id ? "ring-2 ring-white" : "opacity-70"
            } disabled:opacity-40`}
          >
            {T(s.labelKey)}
          </button>
        ))}
      </div>

      {/* Confidence */}
      <p className="text-xs text-neutral-500">
        {T("confidence")}: {Math.round(entry.confidence * 100)}%
      </p>
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
