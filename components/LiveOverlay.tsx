"use client";

import { useState, useCallback } from "react";
import type {
  ClassificationResponse,
  PipelineState,
} from "@/lib/types";
import type { Locale, TranslationKey } from "@/lib/i18n";
import { t } from "@/lib/i18n";

/** Map a waste stream ID to its localised display label. */
function streamLabel(locale: Locale, streamId: string): string {
  const map: Partial<Record<string, TranslationKey>> = {
    recycling: "recycling",
    compost: "compost",
    landfill: "landfill",
    special: "special",
    ewaste: "ewaste",
    needs_review: "needsVerification",
  };
  const key = map[streamId];
  return key ? t(locale, key) : streamId;
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
          </>
        )}
      </div>
    </div>
  );
}

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
  const pct = Math.round(result.confidence * 100);

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

      {/* Bin assignment or review state */}
      {result.needsReview ? (
        <ReviewBanner result={result} locale={locale} />
      ) : (
        <div
          className="rounded-2xl px-6 py-5 transition-colors duration-300"
          style={{ backgroundColor: result.binColor }}
        >
          <div className="text-xs font-semibold uppercase tracking-widest text-white/70 mb-1">
            {T("disposeIn")}
          </div>
          <div className="text-4xl font-black text-white uppercase">
            {streamLabel(locale, result.wasteStream)}
          </div>
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

      {/* Properties */}
      <div className="space-y-2.5">
        <PropertyRow label={T("category")} value={streamLabel(locale, result.wasteStream)} />
        <PropertyRow label={T("confidence")} value={`${pct}%`}>
          <div className="w-full h-1.5 bg-neutral-700 rounded-full overflow-hidden mt-1">
            <div
              className={`h-full rounded-full transition-all duration-500 ${
                result.confidence >= 0.8
                  ? "bg-emerald-500"
                  : result.confidence >= 0.55
                    ? "bg-amber-500"
                    : "bg-red-500"
              }`}
              style={{ width: `${pct}%` }}
            />
          </div>
        </PropertyRow>
        <PropertyRow label={T("reasoning")} value={result.reasoning} />
        {result.specialInstructions && (
          <PropertyRow label={T("note")} value={result.specialInstructions} />
        )}
      </div>

      {/* Feedback section */}
      <FeedbackButtons
        key={`${result.itemName}::${result.wasteStream}`}
        result={result}
        onFeedbackGiven={onFeedbackGiven}
        locale={locale}
      />
    </div>
  );
}

function ReviewBanner({
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

  return (
    <div className="rounded-2xl px-6 py-5 bg-amber-700 border-2 border-amber-500">
      <div className="text-xs font-semibold uppercase tracking-widest text-amber-200/80 mb-1">
        {T("uncertain")}
      </div>
      <div className="text-2xl font-black text-white uppercase mb-2">
        {T("needsVerification")}
      </div>
      <p className="text-sm text-amber-100/80">{T("reviewDescription")}</p>
      {result.confidence > 0 && (
        <p className="text-xs text-amber-200/60 mt-2">
          {T("bestGuess")} {result.itemName} → {result.wasteStream} (
          {Math.round(result.confidence * 100)}%)
        </p>
      )}
    </div>
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
    "idle" | "sent" | "sending"
  >("idle");

  const sendFeedback = useCallback(
    async (feedback: "correct" | "wrong", actualStream?: string) => {
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
      onFeedbackGiven();
      setTimeout(() => setState("idle"), 3000);
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

  return (
    <div className="flex gap-2 mt-1">
      <button
        onClick={() => sendFeedback("correct")}
        className="flex-1 py-2.5 rounded-xl bg-neutral-800 hover:bg-neutral-700 text-neutral-300 text-sm font-medium transition-colors"
      >
        {T("correct")}
      </button>
      <button
        onClick={() => sendFeedback("wrong")}
        className="flex-1 py-2.5 rounded-xl bg-neutral-800 hover:bg-neutral-700 text-neutral-300 text-sm font-medium transition-colors"
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
