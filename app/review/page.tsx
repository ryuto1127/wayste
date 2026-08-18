"use client";

/**
 * /review — Sorting dashboard.
 *
 * The single source of truth for "was the AI right?" (see CLAUDE.md: no
 * end-user feedback loop at the kiosk). Everything here is built around one
 * measured bottleneck: **labeling throughput**. Collecting frames is cheap and
 * automatic; a human deciding correct/wrong is the slow step that gates every
 * downstream fine-tune. So the primary view is a keyboard-driven triage queue
 * that shows one item at a time and advances on a single keypress — not a
 * grid the operator has to hunt through.
 *
 * Three views:
 *   triage — one item, big image + boxes, 1/2/3 to judge, auto-advance
 *   grid   — filterable overview, click to jump into triage at that item
 *   stats  — where the model is weak (by item name, by certainty) + ZIP export
 */

import { useEffect, useState, useCallback, useMemo, useRef } from "react";
import { AdminNav } from "@/components/AdminNav";
import type { PilotLogEntry } from "@/lib/types";
import type { Locale } from "@/lib/i18n";
import { t } from "@/lib/i18n";

// ── Types ──

type Verdict = "correct" | "wrong" | "false_detection";
type ReviewEntry = PilotLogEntry & { verdict: Verdict | null };
type Tab = "triage" | "grid" | "stats";

/** Mirrors the export route's selection rule (app/api/review/export/route.ts)
 *  so the count shown here matches what the ZIP will actually contain. */
const CORRECT_CONFIDENCE_THRESHOLD = 0.8;
function isExportable(e: ReviewEntry): boolean {
  if (!e.requestId || !e.imageUrl || !e.verdict) return false;
  return (
    e.verdict === "wrong" ||
    (e.verdict === "correct" &&
      (e.confidence <= CORRECT_CONFIDENCE_THRESHOLD || e.modelUsed !== "T1"))
  );
}

const CONFIDENCE_BUCKETS: { label: string; min: number; max: number }[] = [
  { label: "0–30%", min: 0, max: 0.3 },
  { label: "30–50%", min: 0.3, max: 0.5 },
  { label: "50–70%", min: 0.5, max: 0.7 },
  { label: "70–85%", min: 0.7, max: 0.85 },
  { label: "85–100%", min: 0.85, max: 1.01 },
];

// ── Small shared pieces ──

function accuracyColor(acc: number | null): string {
  if (acc === null) return "text-neutral-500";
  if (acc >= 0.8) return "text-emerald-400";
  if (acc >= 0.5) return "text-amber-400";
  return "text-rose-400";
}

function Bar({ value, tone }: { value: number; tone: string }) {
  return (
    <div className="h-1.5 w-full rounded-full bg-neutral-800 overflow-hidden">
      <div
        className={`h-full rounded-full ${tone} transition-[width] duration-300`}
        style={{ width: `${Math.round(value * 100)}%` }}
      />
    </div>
  );
}

function Kpi({
  label,
  value,
  hint,
  tone = "text-white",
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: string;
}) {
  return (
    <div className="rounded-xl bg-neutral-900 border border-neutral-800 px-4 py-3">
      <p className="text-[11px] uppercase tracking-wide text-neutral-500">{label}</p>
      <p className={`text-2xl font-semibold tabular-nums leading-tight mt-0.5 ${tone}`}>{value}</p>
      {hint ? <p className="text-[11px] text-neutral-500 mt-0.5">{hint}</p> : null}
    </div>
  );
}

/** Image with the frame's YOLO boxes drawn on top.
 *
 *  `bboxNorm` is [cx, cy, w, h] normalized to the stored capture square, so it
 *  maps to percentage offsets directly. Entries written before `captureSpace`
 *  existed may not line up — those get a visible warning rather than silently
 *  misleading boxes. */
function BoxedImage({
  entry,
  showBoxes,
  T,
}: {
  entry: ReviewEntry;
  showBoxes: boolean;
  T: (k: Parameters<typeof t>[1]) => string;
}) {
  const boxes = entry.yoloDetections ?? [];
  const unaligned = boxes.length > 0 && !entry.captureSpace;

  if (!entry.imageUrl) {
    return (
      <div className="aspect-square w-full rounded-xl bg-neutral-900 border border-neutral-800 grid place-items-center">
        <p className="text-sm text-neutral-500">
          {entry.faceBlocked || entry.blobUploadFailed ? T("imageUnavailable") : T("noImage")}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="relative aspect-square w-full rounded-xl overflow-hidden bg-black border border-neutral-800">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={`/api/pilot-image?url=${encodeURIComponent(entry.imageUrl)}`}
          alt={entry.itemName}
          className="w-full h-full object-contain"
        />
        {showBoxes &&
          boxes.map((d, i) => {
            const [cx, cy, w, h] = d.bboxNorm;
            return (
              <div
                key={i}
                className="absolute border-2 border-amber-400/90 rounded-sm"
                style={{
                  left: `${(cx - w / 2) * 100}%`,
                  top: `${(cy - h / 2) * 100}%`,
                  width: `${w * 100}%`,
                  height: `${h * 100}%`,
                }}
              >
                <span className="absolute -top-6 left-0 whitespace-nowrap rounded bg-amber-400 px-1.5 py-0.5 text-[10px] font-medium text-black">
                  {d.className} {Math.round(d.confidence * 100)}%
                </span>
              </div>
            );
          })}
      </div>
      {unaligned ? (
        <p className="text-[11px] text-amber-400/80">{T("rvBboxWarn")}</p>
      ) : null}
    </div>
  );
}

// ── Page ──

export default function ReviewPage() {
  const [entries, setEntries] = useState<ReviewEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [locale, setLocale] = useState<Locale>("ja");
  const [tab, setTab] = useState<Tab>("triage");

  // Triage queue is a SNAPSHOT of ids, not a live filter: an item judged at
  // position 5 must stay at position 5 so "back" can re-open and re-judge it.
  // A live filter would make items vanish under the cursor mid-session.
  const [queueIds, setQueueIds] = useState<string[]>([]);
  const [cursor, setCursor] = useState(0);
  const [queueMode, setQueueMode] = useState<"unreviewed" | "all">("unreviewed");

  // Mirrors of cursor/queue/entries read by event handlers (see the triage
  // navigation block for why the render closure cannot be trusted there).
  const cursorRef = useRef(0);
  const queueIdsRef = useRef<string[]>([]);
  const entriesRef = useRef<ReviewEntry[]>([]);

  const [sessionJudged, setSessionJudged] = useState(0);
  const sessionStart = useRef<number>(Date.now());
  const [showBoxes, setShowBoxes] = useState(true);

  // Grid filters
  const [statusFilter, setStatusFilter] = useState<"all" | "pending" | Verdict>("all");
  const [modelFilter, setModelFilter] = useState("");
  const [search, setSearch] = useState("");

  const [exporting, setExporting] = useState(false);

  const T = useCallback(
    (key: Parameters<typeof t>[1]) => t(locale, key),
    [locale],
  );

  // ── Load ──
  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/review");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setEntries(Array.isArray(data.entries) ? data.entries : []);
      setError(null);
    } catch {
      setError("読み込みに失敗しました / Failed to load");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") load();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [load]);

  useEffect(() => {
    cursorRef.current = cursor;
  }, [cursor]);
  useEffect(() => {
    queueIdsRef.current = queueIds;
  }, [queueIds]);
  useEffect(() => {
    entriesRef.current = entries;
  }, [entries]);

  const byId = useMemo(() => {
    const m = new Map<string, ReviewEntry>();
    for (const e of entries) if (e.requestId) m.set(e.requestId, e);
    return m;
  }, [entries]);

  // Build the queue once entries arrive (and whenever the operator resets it).
  const rebuildQueue = useCallback(
    (mode: "unreviewed" | "all") => {
      const ids = entries
        .filter((e) => e.requestId && (mode === "all" || e.verdict === null))
        .map((e) => e.requestId as string);
      queueIdsRef.current = ids;
      cursorRef.current = 0;
      setQueueIds(ids);
      setCursor(0);
      setQueueMode(mode);
    },
    [entries],
  );

  const queueInitialized = useRef(false);
  useEffect(() => {
    if (queueInitialized.current || entries.length === 0) return;
    queueInitialized.current = true;
    const ids = entries
      .filter((e) => e.requestId && e.verdict === null)
      .map((e) => e.requestId as string);
    // Nothing left unjudged → open the full list so the view isn't just empty.
    setQueueIds(ids.length > 0 ? ids : entries.filter((e) => e.requestId).map((e) => e.requestId as string));
    if (ids.length === 0) setQueueMode("all");
  }, [entries]);

  // ── Counts ──
  const stats = useMemo(() => {
    const total = entries.length;
    const judged = entries.filter((e) => e.verdict !== null).length;
    const correct = entries.filter((e) => e.verdict === "correct").length;
    const wrong = entries.filter((e) => e.verdict === "wrong").length;
    const falseDet = entries.filter((e) => e.verdict === "false_detection").length;
    const exportable = entries.filter(isExportable).length;
    // Accuracy answers "when the AI named something, was it right?", so
    // false_detection (there was no item at all) is excluded from the base.
    const namedJudged = correct + wrong;
    return {
      total,
      judged,
      unreviewed: total - judged,
      correct,
      wrong,
      falseDet,
      exportable,
      accuracy: namedJudged > 0 ? correct / namedJudged : null,
    };
  }, [entries]);

  // ── Save a verdict (optimistic) ──
  const saveVerdict = useCallback(
    async (requestId: string, verdict: Verdict) => {
      const before =
        entriesRef.current.find((e) => e.requestId === requestId)?.verdict ?? null;
      setEntries((prev) =>
        prev.map((e) => (e.requestId === requestId ? { ...e, verdict } : e)),
      );
      if (before === null) setSessionJudged((n) => n + 1);
      try {
        const res = await fetch("/api/review", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ requestId, verdict }),
        });
        if (!res.ok) throw new Error();
        setError(null);
      } catch {
        // Roll back so the screen never claims a save that didn't happen.
        setEntries((prev) =>
          prev.map((e) => (e.requestId === requestId ? { ...e, verdict: before } : e)),
        );
        if (before === null) setSessionJudged((n) => Math.max(0, n - 1));
        setError("保存に失敗しました / Failed to save");
      }
    },
    [],
  );

  const removeEntry = useCallback(
    async (requestId: string) => {
      if (!window.confirm(T("rvConfirmDelete"))) return;
      const snapshot = entries;
      setEntries((prev) => prev.filter((e) => e.requestId !== requestId));
      setQueueIds((prev) => prev.filter((id) => id !== requestId));
      try {
        const res = await fetch(`/api/review?requestId=${encodeURIComponent(requestId)}`, {
          method: "DELETE",
        });
        if (!res.ok) throw new Error();
      } catch {
        setEntries(snapshot);
        setError("削除に失敗しました / Failed to delete");
      }
    },
    [entries, T],
  );

  // ── Triage navigation ──
  //
  // Judging advances the cursor in the SAME tick as the keypress, so reading
  // `cursor`/`queueIds` out of the render closure is unsafe: three fast
  // keypresses all resolve to the same entry — the first receives three
  // verdicts and the next two are skipped without ever being saved (the
  // counter still moves, so the loss is silent). These refs advance
  // synchronously so every press lands on its own entry.
  const current = queueIds[cursor] ? byId.get(queueIds[cursor]) ?? null : null;

  const goNext = useCallback(() => {
    const next = Math.min(
      cursorRef.current + 1,
      Math.max(0, queueIdsRef.current.length - 1),
    );
    cursorRef.current = next;
    setCursor(next);
  }, []);

  const goPrev = useCallback(() => {
    const prev = Math.max(0, cursorRef.current - 1);
    cursorRef.current = prev;
    setCursor(prev);
  }, []);

  const judgeAndAdvance = useCallback(
    (verdict: Verdict) => {
      const id = queueIdsRef.current[cursorRef.current];
      if (!id) return;
      saveVerdict(id, verdict);
      goNext();
    },
    [saveVerdict, goNext],
  );

  // ── Keyboard ──
  useEffect(() => {
    if (tab !== "triage") return;
    const onKey = (ev: KeyboardEvent) => {
      const el = ev.target as HTMLElement | null;
      if (el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return;
      if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
      switch (ev.key) {
        case "1":
          ev.preventDefault();
          judgeAndAdvance("correct");
          break;
        case "2":
          ev.preventDefault();
          judgeAndAdvance("wrong");
          break;
        case "3":
          ev.preventDefault();
          judgeAndAdvance("false_detection");
          break;
        case " ":
        case "ArrowRight":
          ev.preventDefault();
          goNext();
          break;
        case "ArrowLeft":
        case "u":
        case "U":
          ev.preventDefault();
          goPrev();
          break;
        case "b":
        case "B":
          ev.preventDefault();
          setShowBoxes((v) => !v);
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [tab, judgeAndAdvance, goNext, goPrev]);

  // ── Export ──
  const downloadZip = useCallback(async () => {
    setExporting(true);
    try {
      const res = await fetch("/api/review/download");
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.error ?? "書き出しに失敗しました / Export failed");
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `wayste-training-${new Date().toISOString().slice(0, 10)}.zip`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      setError("書き出しに失敗しました / Export failed");
    } finally {
      setExporting(false);
    }
  }, []);

  // ── Derived: grid ──
  const gridEntries = useMemo(() => {
    const q = search.trim().toLowerCase();
    return entries.filter((e) => {
      if (statusFilter === "pending" && e.verdict !== null) return false;
      if (statusFilter !== "all" && statusFilter !== "pending" && e.verdict !== statusFilter)
        return false;
      if (modelFilter && e.modelUsed !== modelFilter) return false;
      if (q && !e.itemName.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [entries, statusFilter, modelFilter, search]);

  // ── Derived: stats ──
  const byClass = useMemo(() => {
    const m = new Map<string, { total: number; correct: number; wrong: number }>();
    for (const e of entries) {
      const row = m.get(e.itemName) ?? { total: 0, correct: 0, wrong: 0 };
      row.total++;
      if (e.verdict === "correct") row.correct++;
      if (e.verdict === "wrong") row.wrong++;
      m.set(e.itemName, row);
    }
    return [...m.entries()]
      .map(([name, r]) => ({
        name,
        ...r,
        judged: r.correct + r.wrong,
        acc: r.correct + r.wrong > 0 ? r.correct / (r.correct + r.wrong) : null,
      }))
      .sort((a, b) => b.total - a.total);
  }, [entries]);

  const byConfidence = useMemo(
    () =>
      CONFIDENCE_BUCKETS.map((b) => {
        const inB = entries.filter(
          (e) => e.confidence >= b.min && e.confidence < b.max,
        );
        const correct = inB.filter((e) => e.verdict === "correct").length;
        const wrong = inB.filter((e) => e.verdict === "wrong").length;
        return {
          label: b.label,
          total: inB.length,
          judged: correct + wrong,
          acc: correct + wrong > 0 ? correct / (correct + wrong) : null,
        };
      }),
    [entries],
  );

  const byModel = useMemo(() => {
    const ids: PilotLogEntry["modelUsed"][] = ["T1", "vlm", "t2"];
    const labelFor = (m: PilotLogEntry["modelUsed"]) =>
      m === "T1" ? T("rvModelT1") : m === "vlm" ? T("rvModelVlm") : T("rvModelT2");
    return ids
      .map((m) => {
        const inM = entries.filter((e) => e.modelUsed === m);
        const correct = inM.filter((e) => e.verdict === "correct").length;
        const wrong = inM.filter((e) => e.verdict === "wrong").length;
        return {
          id: m,
          label: labelFor(m),
          total: inM.length,
          judged: correct + wrong,
          acc: correct + wrong > 0 ? correct / (correct + wrong) : null,
        };
      })
      .filter((r) => r.total > 0);
  }, [entries, T]);

  const perMin = useMemo(() => {
    const mins = (Date.now() - sessionStart.current) / 60000;
    return mins > 0.2 ? sessionJudged / mins : 0;
  }, [sessionJudged]);

  const modelLabel = useCallback(
    (m: PilotLogEntry["modelUsed"]) =>
      m === "T1" ? T("rvModelT1") : m === "vlm" ? T("rvModelVlm") : T("rvModelT2"),
    [T],
  );

  // ── Render ──
  if (loading) {
    return (
      <div className="min-h-screen bg-neutral-950 text-white grid place-items-center">
        <p className="text-neutral-400 text-sm">…</p>
      </div>
    );
  }

  const progress = queueIds.length > 0 ? (cursor + 1) / queueIds.length : 0;

  return (
    <div className="min-h-screen bg-neutral-950 text-white">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 py-6 space-y-6">
        {/* Header */}
        <header className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-xl font-semibold">{T("rvTitle")}</h1>
            <p className="text-sm text-neutral-400 mt-0.5">{T("rvSubtitle")}</p>
          </div>
          <AdminNav
            locale={locale}
            onToggleLocale={() => setLocale((l) => (l === "ja" ? "en" : "ja"))}
          />
        </header>

        {error ? (
          <div className="rounded-lg border border-rose-800 bg-rose-950/50 px-4 py-2.5 text-sm text-rose-200">
            {error}
          </div>
        ) : null}

        {/* KPIs */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Kpi
            label={T("rvUnreviewed")}
            value={String(stats.unreviewed)}
            tone={stats.unreviewed > 0 ? "text-amber-400" : "text-emerald-400"}
            hint={`${T("rvTotalCount")} ${stats.total}`}
          />
          <Kpi
            label={T("rvAccuracy")}
            value={stats.accuracy === null ? "—" : `${Math.round(stats.accuracy * 100)}%`}
            tone={accuracyColor(stats.accuracy)}
            hint={`${T("rvCorrect")} ${stats.correct} / ${T("rvWrong")} ${stats.wrong}`}
          />
          <Kpi
            label={T("rvExportable")}
            value={String(stats.exportable)}
            hint={T("rvFalseDetection") + ` ${stats.falseDet}`}
          />
          <Kpi
            label={T("rvSessionRate")}
            value={String(sessionJudged)}
            hint={perMin > 0 ? `${perMin.toFixed(1)} ${T("rvPerMin")}` : undefined}
          />
        </div>

        {/* Tabs */}
        <div className="flex gap-1 border-b border-neutral-800">
          {(
            [
              ["triage", T("rvTabTriage")],
              ["grid", T("rvTabGrid")],
              ["stats", T("rvTabStats")],
            ] as [Tab, string][]
          ).map(([id, label]) => (
            <button
              key={id}
              onClick={() => setTab(id)}
              className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
                tab === id
                  ? "border-white text-white"
                  : "border-transparent text-neutral-500 hover:text-neutral-300"
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {/* ── TRIAGE ── */}
        {tab === "triage" ? (
          queueIds.length === 0 || !current ? (
            <div className="rounded-xl border border-neutral-800 bg-neutral-900 py-16 text-center">
              <p className="text-lg font-medium">{T("rvAllDone")}</p>
              <p className="text-sm text-neutral-400 mt-1">{T("rvAllDoneHint")}</p>
              <button
                onClick={() => rebuildQueue("all")}
                className="mt-4 px-4 py-2 rounded-lg bg-neutral-800 hover:bg-neutral-700 text-sm"
              >
                {T("rvShowAll")}
              </button>
            </div>
          ) : (
            <div className="space-y-4">
              {/* Progress */}
              <div className="space-y-1.5">
                <div className="flex items-center justify-between text-xs text-neutral-400">
                  <span>
                    {T("rvProgress")} {cursor + 1} / {queueIds.length}
                  </span>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => rebuildQueue(queueMode === "unreviewed" ? "all" : "unreviewed")}
                      className="px-2 py-1 rounded bg-neutral-800 hover:bg-neutral-700 text-neutral-300"
                    >
                      {queueMode === "unreviewed" ? T("rvShowAll") : T("rvUnreviewedOnly")}
                    </button>
                    <span>
                      {T("rvRemaining")} {Math.max(0, queueIds.length - cursor - 1)}
                    </span>
                  </div>
                </div>
                <Bar value={progress} tone="bg-white" />
              </div>

              <div className="grid lg:grid-cols-[1.1fr_1fr] gap-5 items-start">
                <BoxedImage entry={current} showBoxes={showBoxes} T={T} />

                <div className="space-y-4">
                  {/* Prediction */}
                  <div className="rounded-xl border border-neutral-800 bg-neutral-900 p-4 space-y-3">
                    <p className="text-[11px] uppercase tracking-wide text-neutral-500">
                      {T("rvPredicted")}
                    </p>
                    <p className="text-2xl font-semibold">{current.itemName}</p>
                    <div className="grid grid-cols-2 gap-y-2 gap-x-4 text-sm">
                      <span className="text-neutral-500">{T("rvBinLabel")}</span>
                      <span>{current.wasteStream}</span>
                      <span className="text-neutral-500">{T("rvConfidenceLabel")}</span>
                      <span className="tabular-nums">
                        {Math.round(current.confidence * 100)}%
                      </span>
                      <span className="text-neutral-500">{T("rvDecidedBy")}</span>
                      <span>{modelLabel(current.modelUsed)}</span>
                      <span className="text-neutral-500">{T("rvLatencyLabel")}</span>
                      <span className="tabular-nums">{current.latencyMs} ms</span>
                      <span className="text-neutral-500">{T("rvTimeLabel")}</span>
                      <span className="tabular-nums text-neutral-400">
                        {new Date(current.timestamp).toLocaleString(locale === "ja" ? "ja-JP" : "en-US")}
                      </span>
                    </div>
                    {current.verdict ? (
                      <p className="text-xs text-neutral-400 pt-1 border-t border-neutral-800">
                        {T("rvJudgedBadge")}:{" "}
                        <span
                          className={
                            current.verdict === "correct"
                              ? "text-emerald-400"
                              : current.verdict === "wrong"
                                ? "text-rose-400"
                                : "text-neutral-300"
                          }
                        >
                          {current.verdict === "correct"
                            ? T("rvCorrect")
                            : current.verdict === "wrong"
                              ? T("rvWrong")
                              : T("rvFalseDetection")}
                        </span>
                      </p>
                    ) : null}
                  </div>

                  {/* Verdict buttons */}
                  <div className="grid grid-cols-3 gap-2">
                    <button
                      onClick={() => judgeAndAdvance("correct")}
                      className="rounded-xl bg-emerald-600 hover:bg-emerald-500 px-3 py-4 font-semibold transition-colors"
                    >
                      {T("rvCorrect")}
                      <span className="block text-[11px] font-normal opacity-70 mt-0.5">1</span>
                    </button>
                    <button
                      onClick={() => judgeAndAdvance("wrong")}
                      className="rounded-xl bg-rose-600 hover:bg-rose-500 px-3 py-4 font-semibold transition-colors"
                    >
                      {T("rvWrong")}
                      <span className="block text-[11px] font-normal opacity-70 mt-0.5">2</span>
                    </button>
                    <button
                      onClick={() => judgeAndAdvance("false_detection")}
                      className="rounded-xl bg-neutral-700 hover:bg-neutral-600 px-3 py-4 font-semibold transition-colors"
                    >
                      {T("rvFalseDetection")}
                      <span className="block text-[11px] font-normal opacity-70 mt-0.5">3</span>
                    </button>
                  </div>

                  <div className="flex items-center gap-2 flex-wrap text-sm">
                    <button
                      onClick={goPrev}
                      disabled={cursor === 0}
                      className="px-3 py-2 rounded-lg bg-neutral-800 hover:bg-neutral-700 disabled:opacity-40 transition-colors"
                    >
                      ← {T("rvPrev")}
                    </button>
                    <button
                      onClick={goNext}
                      className="px-3 py-2 rounded-lg bg-neutral-800 hover:bg-neutral-700 transition-colors"
                    >
                      {T("rvSkip")} →
                    </button>
                    <button
                      onClick={() => setShowBoxes((v) => !v)}
                      className={`px-3 py-2 rounded-lg transition-colors ${
                        showBoxes
                          ? "bg-amber-500/20 text-amber-300"
                          : "bg-neutral-800 text-neutral-400 hover:bg-neutral-700"
                      }`}
                    >
                      {showBoxes ? "☑" : "☐"} Box
                    </button>
                    <button
                      onClick={() => current.requestId && removeEntry(current.requestId)}
                      className="px-3 py-2 rounded-lg bg-neutral-900 border border-neutral-800 text-neutral-500 hover:text-rose-300 hover:border-rose-900 ml-auto transition-colors"
                    >
                      {T("rvDelete")}
                    </button>
                  </div>

                  <div className="rounded-lg bg-neutral-900/60 border border-neutral-800 px-3 py-2 text-[11px] text-neutral-500">
                    <span className="text-neutral-400">{T("rvKeyboardHint")}: </span>
                    1 {T("rvCorrect")} · 2 {T("rvWrong")} · 3 {T("rvFalseDetection")} · Space{" "}
                    {T("rvSkip")} · ← {T("rvPrev")} · B Box
                  </div>
                </div>
              </div>
            </div>
          )
        ) : null}

        {/* ── GRID ── */}
        {tab === "grid" ? (
          <div className="space-y-4">
            <div className="flex gap-2 flex-wrap items-center">
              {(
                [
                  ["all", T("rvFilterAll")],
                  ["pending", T("rvUnreviewed")],
                  ["correct", T("rvCorrect")],
                  ["wrong", T("rvWrong")],
                  ["false_detection", T("rvFalseDetection")],
                ] as ["all" | "pending" | Verdict, string][]
              ).map(([id, label]) => (
                <button
                  key={id}
                  onClick={() => setStatusFilter(id)}
                  className={`px-3 py-1.5 rounded-lg text-xs transition-colors ${
                    statusFilter === id
                      ? "bg-white text-neutral-900 font-medium"
                      : "bg-neutral-800 text-neutral-300 hover:bg-neutral-700"
                  }`}
                >
                  {label}
                </button>
              ))}
              <select
                value={modelFilter}
                onChange={(e) => setModelFilter(e.target.value)}
                className="px-3 py-1.5 rounded-lg bg-neutral-800 text-xs text-neutral-300 border border-neutral-700"
              >
                <option value="">{T("rvDecidedBy")}: {T("rvFilterAll")}</option>
                <option value="T1">{T("rvModelT1")}</option>
                <option value="vlm">{T("rvModelVlm")}</option>
                <option value="t2">{T("rvModelT2")}</option>
              </select>
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={T("rvSearchPlaceholder")}
                className="px-3 py-1.5 rounded-lg bg-neutral-800 text-xs border border-neutral-700 placeholder:text-neutral-600 flex-1 min-w-40"
              />
            </div>

            {gridEntries.length === 0 ? (
              <p className="text-center text-sm text-neutral-500 py-16">{T("rvNoMatch")}</p>
            ) : (
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
                {gridEntries.map((e) => (
                  <button
                    key={e.requestId ?? e.timestamp}
                    onClick={() => {
                      if (!e.requestId) return;
                      const idx = queueIds.indexOf(e.requestId);
                      if (idx >= 0) {
                        cursorRef.current = idx;
                        setCursor(idx);
                      } else {
                        queueIdsRef.current = [e.requestId];
                        cursorRef.current = 0;
                        setQueueIds([e.requestId]);
                        setCursor(0);
                      }
                      setTab("triage");
                    }}
                    className="text-left rounded-xl overflow-hidden bg-neutral-900 border border-neutral-800 hover:border-neutral-600 transition-colors group"
                  >
                    <div className="aspect-square bg-black relative">
                      {e.imageUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={`/api/pilot-image?url=${encodeURIComponent(e.imageUrl)}`}
                          alt={e.itemName}
                          className="w-full h-full object-cover"
                          loading="lazy"
                        />
                      ) : (
                        <div className="w-full h-full grid place-items-center text-[11px] text-neutral-600">
                          {T("noImage")}
                        </div>
                      )}
                      <span
                        className={`absolute top-1.5 right-1.5 px-1.5 py-0.5 rounded text-[10px] font-medium ${
                          e.verdict === "correct"
                            ? "bg-emerald-500 text-black"
                            : e.verdict === "wrong"
                              ? "bg-rose-500 text-white"
                              : e.verdict === "false_detection"
                                ? "bg-neutral-500 text-white"
                                : "bg-amber-400 text-black"
                        }`}
                      >
                        {e.verdict === "correct"
                          ? T("rvCorrect")
                          : e.verdict === "wrong"
                            ? T("rvWrong")
                            : e.verdict === "false_detection"
                              ? T("rvFalseDetection")
                              : T("rvUnreviewed")}
                      </span>
                    </div>
                    <div className="px-2.5 py-2">
                      <p className="text-sm truncate group-hover:text-white">{e.itemName}</p>
                      <p className="text-[11px] text-neutral-500 tabular-nums">
                        {Math.round(e.confidence * 100)}% · {modelLabel(e.modelUsed)}
                      </p>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        ) : null}

        {/* ── STATS ── */}
        {tab === "stats" ? (
          <div className="space-y-5">
            {/* Export */}
            <div className="rounded-xl border border-neutral-800 bg-neutral-900 p-4 flex items-center justify-between gap-4 flex-wrap">
              <div>
                <p className="font-medium">{T("rvExportTitle")}</p>
                <p className="text-sm text-neutral-400 mt-0.5 max-w-lg">{T("rvExportDesc")}</p>
                <p className="text-sm text-neutral-300 mt-2">
                  {T("rvExportable")}:{" "}
                  <span className="font-semibold tabular-nums">{stats.exportable}</span>
                </p>
              </div>
              <button
                onClick={downloadZip}
                disabled={exporting || stats.exportable === 0}
                className="px-4 py-2.5 rounded-lg bg-white text-neutral-900 font-medium text-sm hover:bg-neutral-200 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                {exporting ? T("rvExporting") : T("rvExportBtn")}
              </button>
            </div>

            {/* By model */}
            <section className="rounded-xl border border-neutral-800 bg-neutral-900 p-4">
              <h2 className="font-medium mb-3">{T("rvByModel")}</h2>
              <div className="space-y-3">
                {byModel.map((r) => (
                  <div key={r.id} className="space-y-1">
                    <div className="flex justify-between text-sm">
                      <span>{r.label}</span>
                      <span className="text-neutral-400 tabular-nums">
                        {r.total} {T("rvCountLabel")} ·{" "}
                        <span className={accuracyColor(r.acc)}>
                          {r.acc === null ? "—" : `${Math.round(r.acc * 100)}%`}
                        </span>
                      </span>
                    </div>
                    <Bar
                      value={r.total / Math.max(1, stats.total)}
                      tone="bg-neutral-600"
                    />
                  </div>
                ))}
              </div>
            </section>

            {/* By confidence — is the model's certainty trustworthy? */}
            <section className="rounded-xl border border-neutral-800 bg-neutral-900 p-4">
              <h2 className="font-medium mb-3">{T("rvByConfidence")}</h2>
              <div className="space-y-2.5">
                {byConfidence.map((r) => (
                  <div key={r.label} className="flex items-center gap-3 text-sm">
                    <span className="w-20 text-neutral-400 tabular-nums shrink-0">{r.label}</span>
                    <div className="flex-1">
                      <Bar
                        value={r.acc ?? 0}
                        tone={
                          r.acc === null
                            ? "bg-neutral-800"
                            : r.acc >= 0.8
                              ? "bg-emerald-500"
                              : r.acc >= 0.5
                                ? "bg-amber-500"
                                : "bg-rose-500"
                        }
                      />
                    </div>
                    <span className={`w-12 text-right tabular-nums ${accuracyColor(r.acc)}`}>
                      {r.acc === null ? "—" : `${Math.round(r.acc * 100)}%`}
                    </span>
                    <span className="w-16 text-right text-neutral-600 tabular-nums text-xs">
                      {r.judged}/{r.total}
                    </span>
                  </div>
                ))}
              </div>
            </section>

            {/* By item name — where more training data is needed */}
            <section className="rounded-xl border border-neutral-800 bg-neutral-900 p-4">
              <h2 className="font-medium mb-3">{T("rvByClass")}</h2>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-neutral-500 text-xs">
                      <th className="text-left font-normal pb-2">{T("rvPredicted")}</th>
                      <th className="text-right font-normal pb-2">{T("rvCountLabel")}</th>
                      <th className="text-right font-normal pb-2">{T("rvReviewedCount")}</th>
                      <th className="text-right font-normal pb-2">{T("rvAccuracy")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {byClass.slice(0, 30).map((r) => (
                      <tr key={r.name} className="border-t border-neutral-800/70">
                        <td className="py-1.5 pr-2">
                          {r.name}
                          {r.judged === 0 ? (
                            <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded bg-neutral-800 text-neutral-500">
                              {T("rvLowData")}
                            </span>
                          ) : null}
                        </td>
                        <td className="text-right tabular-nums text-neutral-400">{r.total}</td>
                        <td className="text-right tabular-nums text-neutral-400">{r.judged}</td>
                        <td className={`text-right tabular-nums ${accuracyColor(r.acc)}`}>
                          {r.acc === null ? "—" : `${Math.round(r.acc * 100)}%`}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          </div>
        ) : null}
      </div>
    </div>
  );
}
