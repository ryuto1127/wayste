"use client";

import { useState, useCallback } from "react";
import type {
  ClassificationResponse,
  PipelineState,
  WasteStream,
} from "@/lib/types";
import type { Locale, TranslationKey } from "@/lib/i18n";
import { t } from "@/lib/i18n";
import { useSiteStreams } from "@/lib/site-streams-context";

/** Map a waste stream ID to its localised display label. */
function streamLabel(locale: Locale, streamId: string): string {
  const map: Partial<Record<string, TranslationKey>> = {
    recycling: "recycling",
    compost: "compost",
    landfill: "landfill",
    special: "special",
    ewaste: "ewaste",
    needs_review: "needsVerification",
    burnable: "burnable",
    "non-burnable": "nonBurnable",
    recyclable: "recyclable",
    plastic: "plastic",
  };
  const key = map[streamId];
  return key ? t(locale, key) : streamId;
}

// ── Trust level: replaces raw confidence % ──
type TrustLevel = "high" | "medium" | "low";

function getTrustLevel(confidence: number, needsReview: boolean): TrustLevel {
  if (needsReview || confidence < 0.4) return "low";
  if (confidence < 0.7) return "medium";
  return "high";
}

interface LiveOverlayProps {
  result: ClassificationResponse | null;
  error: string | null;
  pipelineState: PipelineState;
  onFeedbackGiven: () => void;
  locale: Locale;
}

export default function LiveOverlay({
  result,
  error,
  pipelineState,
  onFeedbackGiven,
  locale,
}: LiveOverlayProps) {
  const T = useCallback(
    (key: TranslationKey) => t(locale, key),
    [locale]
  );

  if (error) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center p-8">
        <div className="text-4xl mb-4">!</div>
        <p className="text-lg text-red-400 text-center">{error}</p>
        <p className="text-sm text-neutral-500 mt-2">
          {T("retryingAutomatically")}
        </p>
      </div>
    );
  }

  if (result && (pipelineState === "result" || pipelineState === "cooldown")) {
    return (
      <div className="flex-1 flex flex-col overflow-y-auto">
        <ResultPanel
          result={result}
          onFeedbackGiven={onFeedbackGiven}
          locale={locale}
        />
      </div>
    );
  }

  // ── Empty / detection states ──
  return (
    <div className="flex-1 flex flex-col items-center justify-center p-8">
      <div className="text-neutral-600 text-center">
        {pipelineState === "classifying" ? (
          <>
            <div className="text-4xl mb-4 animate-pulse text-amber-500">
              ...
            </div>
            <p className="text-lg text-amber-400">{T("identifyingItem")}</p>
            <p className="text-sm text-neutral-500 mt-2">
              {T("holdSteadyCam")}
            </p>
          </>
        ) : pipelineState === "object_detected" ? (
          <>
            <div className="text-4xl mb-4 text-blue-400">
              <span className="inline-block animate-pulse">&#9678;</span>
            </div>
            <p className="text-lg text-blue-400">{T("itemDetected")}</p>
            <p className="text-sm text-neutral-500 mt-2">
              {T("holdForScan")}
            </p>
          </>
        ) : pipelineState === "stabilizing" ? (
          <>
            <div className="text-4xl mb-4 animate-pulse text-blue-500">
              ...
            </div>
            <p className="text-lg text-blue-400">{T("readingItem")}</p>
            <p className="text-sm text-neutral-500 mt-2">
              {T("holdSteadyCam")}
            </p>
          </>
        ) : (
          <>
            <div className="text-5xl mb-4 animate-pulse">?</div>
            <p className="text-xl text-neutral-400">{T("holdItemUp")}</p>
            <p className="text-sm text-neutral-600 mt-2">
              {T("systemWillIdentify")}
            </p>
            <p className="text-xs text-neutral-700 mt-4">
              {T("showOneItem")}
            </p>
          </>
        )}
      </div>
    </div>
  );
}

// ── Result panel: trust-level messaging instead of raw confidence % ──

function ResultPanel({
  result,
  onFeedbackGiven,
  locale,
}: {
  result: ClassificationResponse;
  onFeedbackGiven: () => void;
  locale: Locale;
}) {
  const T = useCallback(
    (key: TranslationKey) => t(locale, key),
    [locale]
  );
  const trust = getTrustLevel(result.confidence, result.needsReview);

  return (
    <div className="flex flex-col p-6 gap-4">
      {/* Header */}
      <div className="text-xs font-semibold uppercase tracking-widest text-neutral-500">
        {T("detectedItem")}
      </div>

      {/* Item name */}
      <div className="text-3xl font-bold text-white leading-tight">
        {result.itemName}
      </div>

      {/* ── Bin assignment: trust-level dependent ── */}
      {trust === "low" ? (
        <LowConfidenceBanner result={result} locale={locale} />
      ) : (
        <div
          className="rounded-2xl px-6 py-6 transition-colors duration-300"
          style={{ backgroundColor: result.binColor }}
        >
          <div className="text-xs font-semibold uppercase tracking-widest text-white/70 mb-1">
            {trust === "high" ? T("putThisIn") : T("likelyBelongsIn")}
          </div>
          <div className="text-5xl font-black text-white uppercase">
            {streamLabel(locale, result.wasteStream)}
          </div>
          {trust === "medium" && (
            <p className="text-sm text-white/60 mt-2">
              {locale === "ja" ? "ゴミ箱の表示もご確認ください" : "Please also check the bin label"}
            </p>
          )}
        </div>
      )}

      {/* Pre-action banner */}
      {result.preAction && (
        <div className="bg-amber-900/60 border border-amber-600/40 rounded-xl px-4 py-3 flex items-start gap-3">
          <span className="text-amber-200 text-lg font-bold mt-0.5">!</span>
          <p className="text-amber-100 text-sm font-medium">{result.preAction}</p>
        </div>
      )}

      {/* Site-specific note */}
      {result.siteNote && (
        <div className="bg-blue-900/30 border border-blue-700/40 rounded-xl px-4 py-3">
          <p className="text-blue-300 text-sm">{result.siteNote}</p>
        </div>
      )}

      {/* Compound item decomposition */}
      {result.isCompound &&
        result.components &&
        result.components.length > 0 && (
          <CompoundBreakdown
            components={result.components}
            locale={locale}
          />
        )}

      {/* Special instructions (shown prominently) */}
      {result.specialInstructions && (
        <div className="bg-blue-900/30 border border-blue-700/40 rounded-xl px-4 py-3">
          <p className="text-blue-300 text-sm">{result.specialInstructions}</p>
        </div>
      )}

      {/* Reasoning — collapsible, hidden by default */}
      <CollapsibleReasoning label={T("reasoning")} value={result.reasoning} />

      {/* Feedback section — smaller, at bottom */}
      <div className="mt-auto pt-2">
        <FeedbackButtons
          key={`${result.itemName}::${result.wasteStream}`}
          result={result}
          onFeedbackGiven={onFeedbackGiven}
          locale={locale}
        />
      </div>
    </div>
  );
}

// ── Low-confidence banner: replaces "needs_review" dead end ──
// Instead of "Needs Verification", show the best guess with a soft hedge
// and a fallback instruction ("When in doubt, use Landfill").

function LowConfidenceBanner({
  result,
  locale,
}: {
  result: ClassificationResponse;
  locale: Locale;
}) {
  const T = useCallback(
    (key: TranslationKey) => t(locale, key),
    [locale]
  );

  // Even at low confidence, if we have a stream guess, show it as a soft suggestion.
  // The "needs_review" stream itself is an internal concept — users see the fallback.
  const hasGuess =
    result.wasteStream !== "needs_review" && result.confidence > 0;

  return (
    <div className="rounded-2xl px-6 py-5 bg-amber-800/80 border-2 border-amber-600/60">
      {hasGuess ? (
        <>
          <div className="text-xs font-semibold uppercase tracking-widest text-amber-200/80 mb-1">
            {T("likelyBelongsIn")}
          </div>
          <div className="text-3xl font-black text-white uppercase mb-2">
            {streamLabel(locale, result.wasteStream)}
          </div>
          <p className="text-sm text-amber-100/80">
            {T("notSureCheck")}
          </p>
        </>
      ) : (
        <>
          <div className="text-xs font-semibold uppercase tracking-widest text-amber-200/80 mb-1">
            {T("uncertain")}
          </div>
          <div className="text-2xl font-black text-white uppercase mb-2">
            {T("whenInDoubtUse")} {streamLabel(locale, "landfill")}
          </div>
          <p className="text-sm text-amber-100/80">
            {T("notSureCheck")}
          </p>
        </>
      )}
    </div>
  );
}

function CollapsibleReasoning({ label, value }: { label: string; value: string }) {
  const [open, setOpen] = useState(false);
  return (
    <button
      onClick={() => setOpen((o) => !o)}
      className="w-full text-left bg-neutral-800/50 rounded-xl px-4 py-2.5 transition-colors hover:bg-neutral-800/70"
    >
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold uppercase tracking-wider text-neutral-500">
          {label}
        </span>
        <span className="text-neutral-500 text-xs">{open ? "▲" : "▼"}</span>
      </div>
      {open && <p className="text-sm text-neutral-200 mt-1.5">{value}</p>}
    </button>
  );
}

function CompoundBreakdown({
  components,
  locale,
}: {
  components: { partName: string; wasteStream: string; instruction: string }[];
  locale: Locale;
}) {
  const T = useCallback(
    (key: TranslationKey) => t(locale, key),
    [locale]
  );

  return (
    <div className="bg-neutral-800/70 rounded-xl p-4">
      <div className="text-xs font-semibold uppercase tracking-widest text-neutral-400 mb-3">
        {T("multiplePartsTitle")}
      </div>
      <div className="space-y-2.5">
        {components.map((c, i) => (
          <div
            key={i}
            className="flex items-start gap-3 bg-neutral-700/40 rounded-lg px-3 py-2.5"
          >
            <StreamBadge stream={c.wasteStream} />
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium text-neutral-200">
                {c.partName}
              </div>
              <div className="text-xs text-neutral-400">{c.instruction}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function StreamBadge({ stream }: { stream: string }) {
  const colorMap: Record<string, string> = {
    recycling: "bg-blue-600",
    compost: "bg-green-600",
    landfill: "bg-neutral-600",
    special: "bg-red-600",
    ewaste: "bg-purple-600",
    needs_review: "bg-amber-600",
    burnable: "bg-red-500",
    "non-burnable": "bg-gray-500",
    recyclable: "bg-blue-500",
    plastic: "bg-amber-500",
  };
  const bg = colorMap[stream] ?? "bg-neutral-600";

  return (
    <span
      className={`${bg} text-white text-[10px] font-bold uppercase px-2 py-0.5 rounded-md whitespace-nowrap mt-0.5`}
    >
      {stream}
    </span>
  );
}

// ── Feedback buttons with spam protection ──

function FeedbackButtons({
  result,
  onFeedbackGiven,
  locale,
}: {
  result: ClassificationResponse;
  onFeedbackGiven: () => void;
  locale: Locale;
}) {
  const T = useCallback(
    (key: TranslationKey) => t(locale, key),
    [locale]
  );

  const [state, setState] = useState<
    "idle" | "picking_stream" | "sent" | "sending"
  >("idle");

  const sendFeedback = useCallback(
    async (feedback: "correct" | "wrong", actualStream?: WasteStream) => {
      setState("sending");
      try {
        await fetch("/api/feedback", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            itemName: result.itemName,
            predictedStream: result.wasteStream,
            confidence: result.confidence,
            feedback,
            actualStream,
            imageUrl: result.imageUrl,
          }),
        });
      } catch {
        // best-effort
      }
      setState("sent");
      // Short delay to show "thanks" before resetting
      setTimeout(() => onFeedbackGiven(), 1200);
    },
    [result, onFeedbackGiven]
  );

  if (state === "sent") {
    return (
      <div className="bg-emerald-900/30 border border-emerald-700/40 rounded-xl px-4 py-3 text-center">
        <p className="text-emerald-400 text-sm font-medium">
          {T("thanksFeedback")}
        </p>
      </div>
    );
  }

  if (state === "sending") {
    return (
      <div className="bg-neutral-800/50 rounded-xl px-4 py-3 text-center">
        <p className="text-neutral-400 text-sm">{T("saving")}</p>
      </div>
    );
  }

  // After tapping "Wrong", show available streams so user can indicate the correct one.
  const siteStreams = useSiteStreams();

  const streamColorMap: Record<string, string> = {
    recycling: "bg-blue-700 hover:bg-blue-600",
    compost: "bg-green-700 hover:bg-green-600",
    landfill: "bg-neutral-700 hover:bg-neutral-600",
    special: "bg-red-700 hover:bg-red-600",
    ewaste: "bg-purple-700 hover:bg-purple-600",
    burnable: "bg-red-500 hover:bg-red-400",
    "non-burnable": "bg-gray-500 hover:bg-gray-400",
    recyclable: "bg-blue-500 hover:bg-blue-400",
    plastic: "bg-amber-500 hover:bg-amber-400",
  };

  const DEFAULT_STREAM_IDS = ["recycling", "compost", "landfill", "special"];

  const streams =
    siteStreams.length > 0
      ? siteStreams
          .filter((s) => s.id !== "needs_review")
          .map((s) => ({
            id: s.id as WasteStream,
            label: streamLabel(locale, s.id),
            color: streamColorMap[s.id] ?? "bg-neutral-700 hover:bg-neutral-600",
          }))
      : DEFAULT_STREAM_IDS.map((id) => ({
          id: id as WasteStream,
          label: streamLabel(locale, id),
          color: streamColorMap[id],
        }));

  if (state === "picking_stream") {

    return (
      <div className="space-y-2">
        <p className="text-xs text-neutral-400 text-center">
          {T("whatCorrectDisposal")}
        </p>
        <div className="grid grid-cols-2 gap-2">
          {streams.map((s) => (
            <button
              key={s.id}
              onClick={() => sendFeedback("wrong", s.id)}
              disabled={state !== "picking_stream"}
              className={`${s.color} text-white text-sm font-medium py-2.5 rounded-xl transition-colors`}
            >
              {s.label}
            </button>
          ))}
        </div>
        <button
          onClick={() => setState("idle")}
          className="w-full py-2 text-neutral-500 text-xs hover:text-neutral-400 transition-colors"
        >
          {T("cancel")}
        </button>
      </div>
    );
  }

  return (
    <div className="flex gap-2">
      <button
        onClick={() => sendFeedback("correct")}
        disabled={state !== "idle"}
        className="flex-1 py-1.5 rounded-lg bg-neutral-800/60 hover:bg-neutral-700 text-neutral-400 text-xs font-medium transition-colors disabled:opacity-50"
      >
        {T("correct")}
      </button>
      <button
        onClick={() => setState("picking_stream")}
        disabled={state !== "idle"}
        className="flex-1 py-1.5 rounded-lg bg-neutral-800/60 hover:bg-neutral-700 text-neutral-400 text-xs font-medium transition-colors disabled:opacity-50"
      >
        {T("wrong")}
      </button>
    </div>
  );
}

function PropertyRow({
  label,
  value,
  children,
}: {
  label: string;
  value: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="bg-neutral-800/50 rounded-xl px-4 py-3">
      <div className="text-xs font-semibold uppercase tracking-wider text-neutral-500 mb-0.5">
        {label}
      </div>
      <div className="text-sm text-neutral-200">{value}</div>
      {children}
    </div>
  );
}
