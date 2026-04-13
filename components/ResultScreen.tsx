"use client";

import React, { useCallback } from "react";
import type { ClassificationResponse, StreamDefinition, BinPosition } from "@/lib/types";
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
  /** Stream definitions from site config — used to look up physical bin positions. */
  streams?: StreamDefinition[];
}

export default function ResultScreen({
  results,
  locale,
  onToggleLocale,
  voiceEnabled = false,
  streams = [],
}: ResultScreenProps) {
  const T = useCallback(
    (key: TranslationKey) => t(locale, key),
    [locale]
  );

  // Cap at 4 items max — if more, show only top 4 by confidence
  const displayResults =
    results.length > 4
      ? [...results].sort((a, b) => b.confidence - a.confidence).slice(0, 4)
      : results;

  const isMulti = displayResults.length > 1;
  const firstResult = displayResults[0];
  const isNothingDetected = firstResult.itemName === "nothing_detected";

  // Camera faces the user, so camera-left = user's right.
  // Reverse multi-item order so physical left appears on the left card
  // and physical right appears on the right card.
  const orderedResults = isMulti ? [...displayResults].reverse() : displayResults;

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
        <div className="absolute top-6 right-6 z-30 flex items-center bg-neutral-800/60 rounded-lg overflow-hidden">
          <button
            onClick={locale === "ja" ? onToggleLocale : undefined}
            className={`px-3.5 py-1.5 text-xs font-bold transition-colors ${
              locale === "en"
                ? "bg-teal-600/30 text-teal-300"
                : "text-neutral-500 hover:text-neutral-300"
            }`}
            aria-pressed={locale === "en"}
          >
            EN
          </button>
          <button
            onClick={locale === "en" ? onToggleLocale : undefined}
            className={`px-3.5 py-1.5 text-xs font-bold transition-colors ${
              locale === "ja"
                ? "bg-teal-600/30 text-teal-300"
                : "text-neutral-500 hover:text-neutral-300"
            }`}
            aria-pressed={locale === "ja"}
          >
            日本語
          </button>
        </div>

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
      {/* Language toggle — dual-button */}
      <div className="absolute top-6 right-6 z-30 flex items-center bg-neutral-800/60 rounded-lg overflow-hidden">
        <button
          onClick={locale === "ja" ? onToggleLocale : undefined}
          className={`px-3.5 py-1.5 text-xs font-bold transition-colors ${
            locale === "en"
              ? "bg-teal-600/30 text-teal-300"
              : "text-neutral-500 hover:text-neutral-300"
          }`}
          aria-pressed={locale === "en"}
        >
          EN
        </button>
        <button
          onClick={locale === "en" ? onToggleLocale : undefined}
          className={`px-3.5 py-1.5 text-xs font-bold transition-colors ${
            locale === "ja"
              ? "bg-teal-600/30 text-teal-300"
              : "text-neutral-500 hover:text-neutral-300"
          }`}
          aria-pressed={locale === "ja"}
        >
          日本語
        </button>
      </div>

      {isMulti ? (
        /* Multi-item: responsive grid — 2 cols for 2 items, 3 cols for 3, 2×2 grid for 4 */
        <div
          className="flex-1 grid h-full pt-12"
          style={{
            gridTemplateColumns: orderedResults.length === 4
              ? "repeat(2, 1fr)"
              : `repeat(${orderedResults.length}, 1fr)`,
            gridTemplateRows: orderedResults.length === 4
              ? "repeat(2, 1fr)"
              : "1fr",
          }}
        >
          {orderedResults.map((result, idx) => (
            <SplitScreenCard
              key={`${result.itemName}::${result.wasteStream}::${idx}`}
              result={result}
              locale={locale}
              streams={streams}
              isLast={
                orderedResults.length === 4
                  ? idx === 1 || idx === 3 // right column has no right border
                  : idx === orderedResults.length - 1
              }
              isBottomRow={orderedResults.length === 4 && idx >= 2}
              animationDelay={idx * 50}
              fontScale={orderedResults.length >= 3 ? 0.7 : orderedResults.length === 2 ? 0.85 : 1}
            />
          ))}
        </div>
      ) : (
        /* Single item: fullscreen hero */
        <FullscreenResult result={firstResult} locale={locale} streams={streams} />
      )}
    </div>
  );
}

// ── Fullscreen single-item result ──

function FullscreenResult({
  result,
  locale,
  streams = [],
}: {
  result: ClassificationResponse;
  locale: Locale;
  streams?: StreamDefinition[];
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

  // Resolve the direction arrow from stream position
  const streamDef = streams.find((s) => s.id === result.wasteStream);
  const position = streamDef?.position;
  const directionArrow = position ? T(positionArrowKey[position]) : null;

  // Collect notes to display
  const noteText = result.specialInstructions || result.preAction;
  const secondaryNote = null;

  return (
    <div
      className="flex-1 flex flex-col transition-colors duration-300"
      style={{ backgroundColor: result.binColor }}
    >
      {/* Screen reader summary */}
      <span className="sr-only">
        {result.itemName}: {streamLabel(locale, result.wasteStream)}.
        {result.preAction && ` ${result.preAction}.`}
      </span>

      {/* Top area — item name + confidence on colored background */}
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

      {/* Center hero — giant arrow + stream name */}
      <div className="flex-1 flex flex-col items-center justify-center px-6">
        {directionArrow && (
          <div className="text-[12rem] leading-none font-bold text-white mb-4" aria-hidden="true">
            {directionArrow}
          </div>
        )}
        <div className="text-4xl font-black text-white uppercase text-center">
          {streamLabel(locale, result.wasteStream)}
        </div>
        {/* Physical bin position dots (no direction label) */}
        <BinPositionIndicator
          wasteStream={result.wasteStream}
          streams={streams}
          locale={locale}
          size="large"
        />
      </div>

      {/* Notes banner */}
      {(noteText || secondaryNote || (result.isCompound && result.components?.length)) && (
        <div className="px-6 pb-6 space-y-2">
          {noteText && (
            <div className="bg-white rounded-2xl px-5 py-4 shadow-lg">
              <p
                className="text-2xl font-black text-center"
                style={{ color: result.binColor }}
              >
                {noteText}
              </p>
            </div>
          )}
          {secondaryNote && (
            <div className="bg-white/10 rounded-xl px-5 py-3">
              <p className="text-base text-white/80 text-center">{secondaryNote}</p>
            </div>
          )}
          {result.isCompound && result.components && result.components.length > 0 && (
            <div className="bg-black/40 border border-white/20 rounded-xl px-5 py-3">
              <CompoundBreakdown components={result.components} locale={locale} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Split-screen card (full-height column for multi-item layout) ──

function SplitScreenCard({
  result,
  locale,
  streams = [],
  isLast,
  isBottomRow = false,
  animationDelay = 0,
  fontScale = 1,
}: {
  result: ClassificationResponse;
  locale: Locale;
  streams?: StreamDefinition[];
  /** Whether this is the last column (no right border). */
  isLast: boolean;
  /** Whether this card is in the bottom row of a 2×2 grid. */
  isBottomRow?: boolean;
  /** Staggered fade-in delay in ms. */
  animationDelay?: number;
  /** Font size scale factor (1 = full, 0.85 = 2 items, 0.7 = 3-4 items). */
  fontScale?: number;
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

  // Dynamic font sizes based on scale
  const itemNameSize = fontScale >= 1 ? "text-lg" : fontScale >= 0.85 ? "text-base" : "text-sm";
  const binNameSize = fontScale >= 1 ? "text-3xl" : fontScale >= 0.85 ? "text-2xl" : "text-xl";
  const arrowSize = fontScale >= 1 ? "text-6xl" : fontScale >= 0.85 ? "text-5xl" : "text-4xl";

  // Resolve direction arrow from stream position
  const streamDef = streams.find((s) => s.id === result.wasteStream);
  const position = streamDef?.position;
  const directionArrow = position ? T(positionArrowKey[position]) : null;

  return (
    <div
      className={`relative flex flex-col h-full overflow-hidden animate-[fadeIn_0.3s_ease-out_both]${
        isLast ? "" : " border-r-2 border-neutral-800/60"
      }${isBottomRow ? " border-t-2 border-neutral-800/60" : ""}`}
      style={{ animationDelay: `${animationDelay}ms` }}
    >
      {/* Screen reader summary */}
      <span className="sr-only">
        {result.itemName}: {streamLabel(locale, result.wasteStream)}.
        {result.preAction && ` ${result.preAction}.`}
      </span>

      {/* Confidence badge — top-right corner */}
      <div className="absolute top-2 right-3 z-10">
        <span
          className={`${trustColor} text-white text-[10px] font-bold uppercase px-2 py-0.5 rounded-md`}
        >
          {trustLabel}
        </span>
      </div>

      {/* Entire card on colored background */}
      <div
        className="flex-1 flex flex-col overflow-hidden transition-colors duration-300"
        style={{ backgroundColor: result.binColor }}
      >
        {/* Item name (top) */}
        <div className="px-4 pt-3 pb-2 shrink-0">
          <div className={`${itemNameSize} font-bold text-white leading-tight truncate pr-16`}>
            {result.itemName}
          </div>
        </div>

        {/* Hero — direction arrow + stream name */}
        <div className="flex-1 flex flex-col items-center justify-center px-4">
          {directionArrow && (
            <div className={`${arrowSize} leading-none font-bold text-white mb-2`} aria-hidden="true">
              {directionArrow}
            </div>
          )}
          <div className={`${binNameSize} font-black text-white uppercase text-center`}>
            {streamLabel(locale, result.wasteStream)}
          </div>

          {/* Physical bin position dots */}
          <BinPositionIndicator
            wasteStream={result.wasteStream}
            streams={streams}
            locale={locale}
            size="small"
          />
        </div>

        {/* Notes banner */}
        {(result.preAction || result.specialInstructions || (result.isCompound && result.components?.length)) && (
          <div className="px-3 pb-3 space-y-1.5 shrink-0">
            {(result.preAction || result.specialInstructions) && (
              <div className="bg-white rounded-xl px-3 py-2.5 shadow">
                <p
                  className="text-sm font-black text-center"
                  style={{ color: result.binColor }}
                >
                  {result.preAction || result.specialInstructions}
                </p>
              </div>
            )}
            {result.preAction && result.specialInstructions && (
              <div className="bg-white/10 rounded-lg px-3 py-2">
                <p className="text-xs text-white/80 text-center">{result.specialInstructions}</p>
              </div>
            )}
            {result.isCompound && result.components && result.components.length > 0 && (
              <div className="bg-black/40 border border-white/20 rounded-lg px-3 py-2">
                <SplitScreenCompoundBreakdown components={result.components} locale={locale} />
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Compound item breakdown for split-screen cards.
 * Shows a numbered step list with stream badges — compact for column width.
 */
function SplitScreenCompoundBreakdown({
  components,
  locale,
}: {
  components: { partName: string; wasteStream: string; instruction: string; optional?: boolean }[];
  locale: Locale;
}) {
  const T = useCallback(
    (key: TranslationKey) => t(locale, key),
    [locale]
  );

  return (
    <div>
      <div className="text-xs font-bold uppercase tracking-widest text-amber-300 mb-2">
        {T("separateInto")}
      </div>
      <div className="space-y-1.5">
        {components.map((c, i) => (
          <div
            key={i}
            className="flex items-start gap-2 bg-neutral-900/70 rounded-lg px-2.5 py-1.5"
          >
            <span className="text-xs font-bold text-amber-300 mt-0.5 shrink-0">
              {T("separationStep").replace("{n}", String(i + 1))}
            </span>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-1.5 flex-wrap">
                <StreamBadge stream={c.wasteStream} />
                <span className="text-xs font-semibold text-white truncate">
                  {c.partName}
                </span>
                {c.optional && (
                  <span className="text-[10px] text-neutral-400 italic">{T("ifPresent")}</span>
                )}
              </div>
              <div className="text-xs text-neutral-300 mt-0.5">{c.instruction}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Bin position indicator ──

/** Ordered list of all physical bin positions from left to right. */
const BIN_POSITIONS: BinPosition[] = ["far-left", "left", "center", "right", "far-right"];

/** Map a BinPosition to its i18n label key. */
const positionLabelKey: Record<BinPosition, TranslationKey> = {
  "far-left": "binPositionFarLeft",
  "left": "binPositionLeft",
  "center": "binPositionCenter",
  "right": "binPositionRight",
  "far-right": "binPositionFarRight",
};

/** Map a BinPosition to its i18n arrow key. */
const positionArrowKey: Record<BinPosition, TranslationKey> = {
  "far-left": "binPositionArrowFarLeft",
  "left": "binPositionArrowLeft",
  "center": "binPositionArrowCenter",
  "right": "binPositionArrowRight",
  "far-right": "binPositionArrowFarRight",
};

/**
 * Visual indicator showing which physical bin to use.
 * Renders a row of 5 dots (one per bin position) with the active bin
 * highlighted in its stream color, plus a directional label below.
 */
function BinPositionIndicator({
  wasteStream,
  streams,
  locale,
  size = "large",
}: {
  wasteStream: string;
  streams: StreamDefinition[];
  locale: Locale;
  size?: "large" | "small";
}) {
  const streamDef = streams.find((s) => s.id === wasteStream);
  const position = streamDef?.position;

  // Don't render if no position (e.g. needs_review or config without positions)
  if (!position) return null;

  const T = (key: TranslationKey) => t(locale, key);

  // Build the set of all positions that have physical bins in this site config
  const sitePositions = new Set<BinPosition>();
  for (const s of streams) {
    if (s.position) sitePositions.add(s.position);
  }

  // Only render positions that exist in the site config
  const activePositions = BIN_POSITIONS.filter((p) => sitePositions.has(p));
  if (activePositions.length === 0) return null;

  const binColor = streamDef?.color ?? "#FFFFFF";
  const isLarge = size === "large";
  const dotSize = isLarge ? "w-5 h-5" : "w-3 h-3";
  const activeDotSize = isLarge ? "w-7 h-7" : "w-4 h-4";
  const gapSize = isLarge ? "gap-3" : "gap-2";

  return (
    <div
      className={`flex flex-col items-center ${isLarge ? "mt-6" : "px-4 py-2.5"}`}
      aria-label={`${T(positionLabelKey[position])}`}
    >
      {/* Dot row — each dot represents a physical bin slot */}
      <div className={`flex items-center ${gapSize}`}>
        {activePositions.map((pos) => {
          const isActive = pos === position;
          // Find the stream at this position for its color (inactive dots)
          const streamAtPos = streams.find((s) => s.position === pos);
          return (
            <div
              key={pos}
              className={`rounded-full transition-all duration-300 ${
                isActive
                  ? `${activeDotSize} ring-2 ring-white/80 shadow-lg`
                  : `${dotSize} opacity-30`
              }`}
              style={{
                backgroundColor: isActive
                  ? binColor
                  : streamAtPos?.color ?? "#6B7280",
              }}
              aria-hidden="true"
            />
          );
        })}
      </div>
    </div>
  );
}

// ── Sub-components ──

function CompoundBreakdown({
  components,
  locale,
}: {
  components: { partName: string; wasteStream: string; instruction: string; optional?: boolean }[];
  locale: Locale;
}) {
  const T = useCallback(
    (key: TranslationKey) => t(locale, key),
    [locale]
  );

  return (
    <div>
      <div className="text-xs font-bold uppercase tracking-widest text-amber-300 mb-2">
        {T("multiplePartsTitle")}
      </div>
      <div className="space-y-1.5">
        {components.map((c, i) => (
          <div
            key={i}
            className="flex items-start gap-2 bg-neutral-900/70 rounded-lg px-3 py-2"
          >
            <StreamBadge stream={c.wasteStream} />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-sm font-semibold text-white">{c.partName}</span>
                {c.optional && (
                  <span className="text-xs text-neutral-400 italic">{T("ifPresent")}</span>
                )}
              </div>
              <div className="text-xs text-neutral-300">{c.instruction}</div>
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
