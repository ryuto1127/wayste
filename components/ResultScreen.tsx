"use client";

import React, { useState, useCallback } from "react";
import type { ClassificationResponse } from "@/lib/types";
import type { Locale, TranslationKey } from "@/lib/i18n";
import { t } from "@/lib/i18n";
// Auth is handled via session token passed as a prop

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

/** Map a waste stream ID to its emoji icon for triple-encoding (color + icon + text). */
function streamIcon(streamId: string): string {
  const map: Record<string, string> = {
    recycling: "\u267B\uFE0F",
    compost: "\uD83C\uDF42",
    landfill: "\uD83D\uDDD1\uFE0F",
    special: "\u26A0\uFE0F",
    ewaste: "\uD83D\uDD0C",
    needs_review: "\u2753",
    burnable: "\uD83D\uDD25",
    "non-burnable": "\uD83E\uDDCA",
    recyclable: "\u267B\uFE0F",
    plastic: "\uD83E\uDED9",
  };
  return map[streamId] ?? "\uD83D\uDCE6";
}

type TrustLevel = "high" | "medium" | "low";

function getTrustLevel(confidence: number, needsReview: boolean): TrustLevel {
  if (needsReview || confidence < 0.4) return "low";
  if (confidence < 0.7) return "medium";
  return "high";
}

interface ResultScreenProps {
  result: ClassificationResponse;
  requestId?: string;
  locale: Locale;
  onFeedbackGiven: () => void;
  onToggleLocale: () => void;
  voiceEnabled?: boolean;
  sessionToken?: string;
}

export default function ResultScreen({
  result,
  requestId,
  locale,
  onFeedbackGiven,
  onToggleLocale,
  voiceEnabled = false,
  sessionToken,
}: ResultScreenProps) {
  const T = useCallback(
    (key: TranslationKey) => t(locale, key),
    [locale]
  );

  const trust = getTrustLevel(result.confidence, result.needsReview);
  const trustLabel =
    trust === "high"
      ? T("confidenceHigh")
      : trust === "medium"
        ? T("confidenceMedium")
        : T("confidenceLow");
  const trustDesc =
    trust === "high"
      ? T("confidenceHighDesc")
      : trust === "medium"
        ? T("confidenceMediumDesc")
        : T("confidenceLowDesc");
  const trustColor =
    trust === "high"
      ? "bg-emerald-600"
      : trust === "medium"
        ? "bg-amber-600"
        : "bg-red-600";

  // ── Voice announcement via Web Speech API ──
  const announcedRef = React.useRef(false);
  React.useEffect(() => {
    if (!voiceEnabled || announcedRef.current) return;
    if (typeof window === "undefined" || !window.speechSynthesis) return;
    announcedRef.current = true;

    // Cancel any ongoing speech
    window.speechSynthesis.cancel();

    const binName = streamLabel(locale, result.wasteStream);
    const announcement = result.needsReview
      ? T("voiceNeedsReview")
      : T("voiceResultAnnouncement")
          .replace("{item}", result.itemName)
          .replace("{bin}", binName);

    const utterance = new SpeechSynthesisUtterance(announcement);
    utterance.lang = locale === "ja" ? "ja-JP" : "en-US";
    utterance.rate = 0.95;
    utterance.volume = 0.8;
    window.speechSynthesis.speak(utterance);

    // Pre-action follow-up
    if (result.preAction && !result.needsReview) {
      const preUtterance = new SpeechSynthesisUtterance(
        T("voicePreAction").replace("{action}", result.preAction)
      );
      preUtterance.lang = locale === "ja" ? "ja-JP" : "en-US";
      preUtterance.rate = 0.95;
      preUtterance.volume = 0.8;
      window.speechSynthesis.speak(preUtterance);
    }

    return () => { window.speechSynthesis.cancel(); };
  }, [voiceEnabled, result, locale, T]);

  return (
    <div
      className="absolute inset-0 z-20 flex flex-col bg-neutral-950/90 backdrop-blur-sm overflow-y-auto select-none animate-[fadeIn_0.3s_ease-out]"
      role="alert"
      aria-live="assertive"
      aria-atomic="true"
    >
      {/* Language toggle */}
      <button
        onClick={onToggleLocale}
        className="absolute top-6 right-6 z-30 px-3 py-1.5 text-neutral-400 hover:text-neutral-200 text-xs font-medium transition-colors"
      >
        {T("switchLang")}
      </button>

      <div className="flex-1 flex flex-col p-6 pt-14 gap-4 max-w-2xl mx-auto w-full">
        {/* Screen reader summary */}
        <span className="sr-only">
          {result.itemName}: {streamLabel(locale, result.wasteStream)}.
          {result.preAction && ` ${result.preAction}.`}
          {result.reasoning && ` ${result.reasoning}`}
        </span>

        {/* Item name + trust badge */}
        <div className="flex items-start gap-3">
          <div className="text-3xl font-bold text-white leading-tight flex-1">
            {result.itemName}
          </div>
          <div className="flex flex-col items-end gap-1 shrink-0">
            <span
              className={`${trustColor} text-white text-xs font-bold uppercase px-2.5 py-1 rounded-lg`}
            >
              {trustLabel}
            </span>
            <span className="text-[11px] text-neutral-400 text-right">
              {trustDesc}
            </span>
          </div>
        </div>

        {/* Hero bin assignment */}
        <div
          className="rounded-2xl px-6 py-8 transition-colors duration-300"
          style={{ backgroundColor: result.binColor }}
        >
          <div className="text-xs font-semibold uppercase tracking-widest text-white/70 mb-2">
            {T("putThisInBin")}
          </div>
          <div className="text-5xl font-black text-white uppercase flex items-center gap-3">
            <span aria-hidden="true">{streamIcon(result.wasteStream)}</span>
            {streamLabel(locale, result.wasteStream)}
          </div>
        </div>

        {/* Pre-action banner */}
        {result.preAction && (
          <div className="bg-amber-900/60 border border-amber-600/40 rounded-xl px-4 py-3 flex items-start gap-3">
            <span className="text-amber-200 text-lg font-bold mt-0.5">!</span>
            <p className="text-amber-100 text-sm font-medium">
              {result.preAction}
            </p>
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

        {/* Special instructions */}
        {result.specialInstructions && (
          <div className="bg-blue-900/30 border border-blue-700/40 rounded-xl px-4 py-3">
            <p className="text-blue-300 text-sm">
              {result.specialInstructions}
            </p>
          </div>
        )}

        {/* Reasoning */}
        <div className="bg-neutral-800/50 rounded-xl px-4 py-3">
          <div className="text-xs font-semibold uppercase tracking-wider text-neutral-500 mb-1.5">
            {T("reasoning")}
          </div>
          <p className="text-sm text-neutral-200">{result.reasoning}</p>
        </div>

        {/* Feedback */}
        <div className="mt-auto pt-2 pb-4">
          <FeedbackButtons
            key={`${result.itemName}::${result.wasteStream}`}
            result={result}
            requestId={requestId}
            onFeedbackGiven={onFeedbackGiven}
            locale={locale}
            sessionToken={sessionToken}
          />
        </div>
      </div>
    </div>
  );
}

// ── Sub-components (moved from LiveOverlay) ──

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
      <span aria-hidden="true">{streamIcon(stream)} </span>
      {stream}
    </span>
  );
}

function FeedbackButtons({
  result,
  requestId,
  onFeedbackGiven,
  locale,
  sessionToken,
}: {
  result: ClassificationResponse;
  requestId?: string;
  onFeedbackGiven: () => void;
  locale: Locale;
  sessionToken?: string;
}) {
  const T = useCallback(
    (key: TranslationKey) => t(locale, key),
    [locale]
  );

  const [state, setState] = useState<"idle" | "sent" | "sending">("idle");

  const sendFeedback = useCallback(
    async (feedback: "correct" | "wrong") => {
      setState("sending");
      try {
        await fetch("/api/feedback", {
          method: "POST",
          headers: { "Content-Type": "application/json", ...(sessionToken ? { "x-session-token": sessionToken } : {}) },
          body: JSON.stringify({
            itemName: result.itemName,
            predictedStream: result.wasteStream,
            confidence: result.confidence,
            feedback,
            requestId,
          }),
        });
      } catch {
        // best-effort
      }
      setState("sent");
      setTimeout(() => onFeedbackGiven(), 1200);
    },
    [result, requestId, onFeedbackGiven]
  );

  if (state === "sent") {
    return (
      <div className="bg-emerald-900/30 border border-emerald-700/40 rounded-2xl px-6 py-5 text-center">
        <p className="text-emerald-400 text-lg font-semibold">
          {T("thanksFeedback")}
        </p>
      </div>
    );
  }

  if (state === "sending") {
    return (
      <div className="bg-neutral-800/50 rounded-2xl px-6 py-5 text-center">
        <p className="text-neutral-400 text-base">{T("saving")}</p>
      </div>
    );
  }

  return (
    <div className="flex gap-4">
      <button
        onClick={() => sendFeedback("correct")}
        disabled={state !== "idle"}
        className="flex-1 py-5 rounded-2xl bg-emerald-800/40 border-2 border-emerald-600/50 hover:bg-emerald-700/50 active:bg-emerald-600/60 active:scale-[0.97] text-white font-bold text-lg transition-all disabled:opacity-50 flex items-center justify-center gap-2.5"
      >
        <span className="text-2xl leading-none" aria-hidden="true">👍</span>
        {T("correct")}
      </button>
      <button
        onClick={() => sendFeedback("wrong")}
        disabled={state !== "idle"}
        className="flex-1 py-5 rounded-2xl bg-red-900/40 border-2 border-red-600/50 hover:bg-red-800/50 active:bg-red-700/60 active:scale-[0.97] text-white font-bold text-lg transition-all disabled:opacity-50 flex items-center justify-center gap-2.5"
      >
        <span className="text-2xl leading-none" aria-hidden="true">👎</span>
        {T("wrong")}
      </button>
    </div>
  );
}
