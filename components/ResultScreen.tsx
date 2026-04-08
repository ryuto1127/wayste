"use client";

import React, { useCallback } from "react";
import type { ClassificationResponse } from "@/lib/types";
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
  results: ClassificationResponse[];
  locale: Locale;
  onToggleLocale: () => void;
  voiceEnabled?: boolean;
}

export default function ResultScreen({
  results,
  locale,
  onToggleLocale,
  voiceEnabled = false,
}: ResultScreenProps) {
  const T = useCallback(
    (key: TranslationKey) => t(locale, key),
    [locale]
  );

  const isMulti = results.length > 1;
  const firstResult = results[0];
  const isNothingDetected = firstResult.itemName === "nothing_detected";

  // ── Voice announcement via Web Speech API ──
  const announcedRef = React.useRef(false);
  React.useEffect(() => {
    if (!voiceEnabled || announcedRef.current || isNothingDetected) return;
    if (typeof window === "undefined" || !window.speechSynthesis) return;
    announcedRef.current = true;

    window.speechSynthesis.cancel();

    for (const result of results) {
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

      if (result.preAction && !result.needsReview) {
        const preUtterance = new SpeechSynthesisUtterance(
          T("voicePreAction").replace("{action}", result.preAction)
        );
        preUtterance.lang = locale === "ja" ? "ja-JP" : "en-US";
        preUtterance.rate = 0.95;
        preUtterance.volume = 0.8;
        window.speechSynthesis.speak(preUtterance);
      }
    }

    return () => { window.speechSynthesis.cancel(); };
  }, [voiceEnabled, results, locale, T, isNothingDetected]);

  // ── Nothing detected: simplified result screen ──
  if (isNothingDetected) {
    return (
      <div
        className="absolute inset-0 z-20 flex flex-col bg-neutral-950/90 backdrop-blur-sm overflow-y-auto select-none animate-[fadeIn_0.3s_ease-out]"
        role="alert"
        aria-live="assertive"
        aria-atomic="true"
      >
        <button
          onClick={onToggleLocale}
          className="absolute top-6 right-6 z-30 px-3 py-1.5 text-neutral-400 hover:text-neutral-200 text-xs font-medium transition-colors"
        >
          {T("switchLang")}
        </button>

        <div className="flex-1 flex flex-col items-center justify-center p-6 gap-6 max-w-md mx-auto w-full text-center">
          <div className="text-6xl" aria-hidden="true">&#x2753;</div>
          <div className="text-3xl font-bold text-white">
            {T("nothingDetectedTitle")}
          </div>
          <p className="text-neutral-400 text-base leading-relaxed">
            {T("nothingDetectedDesc")}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div
      className="absolute inset-0 z-20 flex flex-col bg-neutral-950/90 backdrop-blur-sm select-none animate-[fadeIn_0.3s_ease-out]"
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

      {isMulti ? (
        /* Multi-item: stack cards vertically */
        <div className="flex-1 flex flex-col p-4 gap-3 overflow-y-auto">
          <div className="text-xs font-semibold uppercase tracking-widest text-neutral-400 mb-1 pt-8">
            {T("multipleItemsDetected")}
          </div>
          {results.map((result, idx) => (
            <MultiItemCard
              key={`${result.itemName}::${result.wasteStream}::${idx}`}
              result={result}
              locale={locale}
              index={idx}
            />
          ))}
        </div>
      ) : (
        /* Single item: fullscreen hero */
        <FullscreenResult result={firstResult} locale={locale} />
      )}
    </div>
  );
}

// ── Fullscreen single-item result ──

function FullscreenResult({
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

  const trust = getTrustLevel(result.confidence, result.needsReview);
  const trustLabel =
    trust === "high"
      ? T("confidenceHigh")
      : trust === "medium"
        ? T("confidenceMedium")
        : T("confidenceLow");
  const trustColor =
    trust === "high"
      ? "bg-emerald-600"
      : trust === "medium"
        ? "bg-amber-600"
        : "bg-red-600";

  return (
    <div className="flex-1 flex flex-col">
      {/* Screen reader summary */}
      <span className="sr-only">
        {result.itemName}: {streamLabel(locale, result.wasteStream)}.
        {result.preAction && ` ${result.preAction}.`}
      </span>

      {/* Item name bar */}
      <div className="px-6 pt-14 pb-3 flex items-center gap-3">
        <div className="text-2xl font-bold text-white leading-tight flex-1 truncate">
          {result.itemName}
        </div>
        <span
          className={`${trustColor} text-white text-[10px] font-bold uppercase px-2 py-0.5 rounded-md shrink-0`}
        >
          {trustLabel}
        </span>
      </div>

      {/* Hero bin — fills remaining space */}
      <div
        className="flex-1 flex flex-col items-center justify-center px-6 transition-colors duration-300"
        style={{ backgroundColor: result.binColor }}
      >
        <div className="text-sm font-semibold uppercase tracking-widest text-white/70 mb-4">
          {T("putThisInBin")}
        </div>
        <div className="text-[8rem] leading-none mb-4" aria-hidden="true">
          {streamIcon(result.wasteStream)}
        </div>
        <div className="text-6xl font-black text-white uppercase text-center">
          {streamLabel(locale, result.wasteStream)}
        </div>
      </div>

      {/* Bottom info strip — pre-action, notes, compound, special instructions */}
      {(result.preAction || result.siteNote || result.specialInstructions || (result.isCompound && result.components?.length)) && (
        <div className="px-6 py-4 space-y-2 bg-neutral-950/80">
          {result.preAction && (
            <div className="flex items-start gap-2">
              <span className="text-amber-300 font-bold text-sm">!</span>
              <p className="text-amber-100 text-sm font-medium">{result.preAction}</p>
            </div>
          )}
          {result.siteNote && (
            <p className="text-blue-300 text-sm">{result.siteNote}</p>
          )}
          {result.isCompound && result.components && result.components.length > 0 && (
            <CompoundBreakdown components={result.components} locale={locale} />
          )}
          {result.specialInstructions && (
            <p className="text-blue-300 text-sm">{result.specialInstructions}</p>
          )}
        </div>
      )}
    </div>
  );
}

// ── Multi-item card (compact) ──

function MultiItemCard({
  result,
  locale,
  index,
}: {
  result: ClassificationResponse;
  locale: Locale;
  index: number;
}) {
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
  const trustColor =
    trust === "high"
      ? "bg-emerald-600"
      : trust === "medium"
        ? "bg-amber-600"
        : "bg-red-600";

  return (
    <div className="bg-neutral-900/60 rounded-2xl border border-neutral-800 overflow-hidden">
      {/* Screen reader summary */}
      <span className="sr-only">
        {result.itemName}: {streamLabel(locale, result.wasteStream)}.
        {result.preAction && ` ${result.preAction}.`}
      </span>

      {/* Item header */}
      <div className="px-4 pt-3 pb-2 flex items-center gap-2">
        <span className="text-xs font-semibold text-neutral-500 uppercase tracking-wider">
          {T("itemNumber").replace("{n}", String(index + 1))}
        </span>
        <span className="text-sm font-bold text-white flex-1 truncate">{result.itemName}</span>
        <span className={`${trustColor} text-white text-[10px] font-bold uppercase px-2 py-0.5 rounded-md`}>
          {trustLabel}
        </span>
      </div>

      {/* Bin display */}
      <div
        className="px-4 py-5 flex items-center gap-3 transition-colors duration-300"
        style={{ backgroundColor: result.binColor }}
      >
        <span className="text-4xl" aria-hidden="true">{streamIcon(result.wasteStream)}</span>
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-widest text-white/70">
            {T("putThisInBin")}
          </div>
          <div className="text-3xl font-black text-white uppercase">
            {streamLabel(locale, result.wasteStream)}
          </div>
        </div>
      </div>

      {/* Optional info */}
      {(result.preAction || result.siteNote || result.specialInstructions) && (
        <div className="px-4 py-2.5 space-y-1.5">
          {result.preAction && (
            <div className="flex items-start gap-2">
              <span className="text-amber-300 font-bold text-xs">!</span>
              <p className="text-amber-100 text-xs font-medium">{result.preAction}</p>
            </div>
          )}
          {result.siteNote && <p className="text-blue-300 text-xs">{result.siteNote}</p>}
          {result.specialInstructions && <p className="text-blue-300 text-xs">{result.specialInstructions}</p>}
        </div>
      )}
    </div>
  );
}

// ── Sub-components ──

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
    <div>
      <div className="text-xs font-semibold uppercase tracking-widest text-neutral-400 mb-1.5">
        {T("multiplePartsTitle")}
      </div>
      <div className="space-y-1.5">
        {components.map((c, i) => (
          <div
            key={i}
            className="flex items-start gap-2 bg-neutral-800/60 rounded-lg px-3 py-2"
          >
            <StreamBadge stream={c.wasteStream} />
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium text-neutral-200">{c.partName}</div>
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
