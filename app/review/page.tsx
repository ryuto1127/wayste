"use client";

import { useEffect, useState, useCallback } from "react";
import type { FeedbackEntry } from "@/lib/types";

const STREAMS = [
  { id: "recycling", label: "Recycling", color: "bg-blue-600 hover:bg-blue-500" },
  { id: "compost", label: "Compost", color: "bg-green-600 hover:bg-green-500" },
  { id: "landfill", label: "Landfill", color: "bg-neutral-600 hover:bg-neutral-500" },
  { id: "special", label: "Special", color: "bg-orange-600 hover:bg-orange-500" },
  { id: "needs_review", label: "Needs Review", color: "bg-purple-600 hover:bg-purple-500" },
];

type ReviewEntry = FeedbackEntry & { actualStream: string | null; blobUploadFailed?: boolean };

export default function ReviewPage() {
  const [entries, setEntries] = useState<ReviewEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null); // entry id being saved

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

  const corrected = entries.filter((e) => e.actualStream);
  const pending = entries.filter((e) => !e.actualStream);

  if (loading) {
    return (
      <div className="min-h-screen bg-neutral-950 text-white flex items-center justify-center">
        <p className="text-neutral-400">Loading...</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-neutral-950 text-white p-8">
      {/* Header */}
      <div className="max-w-5xl mx-auto">
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-2xl font-bold">Image Review</h1>
            <p className="text-neutral-400 text-sm mt-1">
              Assign correct bins to items users marked as wrong
            </p>
          </div>
          <div className="flex gap-4 text-sm">
            <span className="text-orange-400 font-medium">{pending.length} pending</span>
            <span className="text-emerald-400 font-medium">{corrected.length} corrected</span>
          </div>
        </div>

        {entries.length === 0 && (
          <div className="text-center py-24 text-neutral-500">
            No wrong feedback entries yet.
          </div>
        )}

        {/* Pending entries */}
        {pending.length > 0 && (
          <section className="mb-12">
            <h2 className="text-sm font-semibold text-orange-400 uppercase tracking-wider mb-4">
              Needs correction
            </h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {pending.map((entry) => (
                <EntryCard
                  key={entry.id}
                  entry={entry}
                  saving={saving === entry.id}
                  onCorrect={correct}
                />
              ))}
            </div>
          </section>
        )}

        {/* Already corrected entries */}
        {corrected.length > 0 && (
          <section>
            <h2 className="text-sm font-semibold text-emerald-400 uppercase tracking-wider mb-4">
              Corrected
            </h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {corrected.map((entry) => (
                <EntryCard
                  key={entry.id}
                  entry={entry}
                  saving={saving === entry.id}
                  onCorrect={correct}
                />
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}

function EntryCard({
  entry,
  saving,
  onCorrect,
}: {
  entry: ReviewEntry;
  saving: boolean;
  onCorrect: (id: string, stream: string) => void;
}) {
  const date = new Date(entry.timestamp).toLocaleString();
  const isCorrected = !!entry.actualStream;

  return (
    <div className={`rounded-xl border p-4 flex flex-col gap-3 ${
      isCorrected
        ? "border-emerald-800/50 bg-emerald-950/20"
        : "border-neutral-800 bg-neutral-900"
    }`}>
      {/* Image */}
      {entry.blobUploadFailed ? (
        <div className="w-full h-48 rounded-lg bg-neutral-700 flex items-center justify-center text-neutral-400 text-sm text-center px-4">
          Image unavailable (upload failed)
        </div>
      ) : entry.imageUrl ? (
        <img
          src={entry.imageUrl}
          alt={entry.itemName}
          className="w-full h-48 object-cover rounded-lg bg-neutral-800"
        />
      ) : (
        <div className="w-full h-48 rounded-lg bg-neutral-800 flex items-center justify-center text-neutral-600 text-sm">
          No image
        </div>
      )}

      {/* Info */}
      <div>
        <p className="font-semibold text-white truncate">{entry.itemName}</p>
        <p className="text-xs text-neutral-400 mt-0.5">{date}</p>
      </div>

      {/* Prediction vs correction */}
      <div className="flex items-center gap-2 text-sm">
        <span className="text-neutral-400">Predicted:</span>
        <span className="text-red-400 font-medium">{entry.predictedStream}</span>
        {isCorrected && (
          <>
            <span className="text-neutral-600">→</span>
            <span className="text-emerald-400 font-medium">{entry.actualStream}</span>
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
              entry.actualStream === s.id
                ? "ring-2 ring-white"
                : "opacity-70"
            } disabled:opacity-40`}
          >
            {s.label}
          </button>
        ))}
      </div>

      {/* Confidence */}
      <p className="text-xs text-neutral-600">
        Confidence: {Math.round(entry.confidence * 100)}%
      </p>
    </div>
  );
}
