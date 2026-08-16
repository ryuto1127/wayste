"use client";

import React, { useCallback, useEffect, useRef } from "react";
import type { ClassificationResponse, StreamDefinition, BinPosition } from "@/lib/types";
import type { Locale, TranslationKey } from "@/lib/i18n";
import { t } from "@/lib/i18n";
import type { CameraFeedHandle } from "./CameraFeed";

/**
 * Map a waste stream ID to its display label.
 *
 * The site config's own stream label wins — it is what is printed on the
 * physical bins, and the screen must never contradict the signage.
 * The i18n map is only a fallback for configs without labels; the raw ID
 * is a last resort.
 */
function streamLabel(locale: Locale, streamId: string, streams?: StreamDefinition[]): string {
  const configLabel = streams?.find((s) => s.id === streamId)?.label;
  if (configLabel) return configLabel;
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
  voiceEnabled?: boolean;
  /** Stream definitions from site config — used to look up physical bin positions. */
  streams?: StreamDefinition[];
  /**
   * Reference to the main CameraFeed — used to mirror the live stream into
   * the top-right mini viewfinder so users can verify the camera is still
   * tracking their item.
   */
  cameraRef?: React.RefObject<CameraFeedHandle | null>;
  /** Whether the camera feed is horizontally mirrored. Keeps mini view consistent. */
  mirrorCamera?: boolean;
}

/**
 * Small live camera preview shown at the top-right of the result screen.
 * Mirrors the main camera's MediaStream via a second `<video>` element so
 * the user can see their item is still being tracked while they read the
 * result — without stealing attention from the center hero.
 */
function MiniViewfinder({
  cameraRef,
  mirror,
}: {
  cameraRef: React.RefObject<CameraFeedHandle | null>;
  mirror: boolean;
}) {
  const miniVideoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    let cancelled = false;
    function tryAttach() {
      if (cancelled) return;
      const source = cameraRef.current?.getVideo();
      const mini = miniVideoRef.current;
      if (source?.srcObject && mini && mini.srcObject !== source.srcObject) {
        mini.srcObject = source.srcObject;
      }
    }
    tryAttach();
    // Poll briefly in case the main camera isn't ready yet at mount time.
    const interval = setInterval(tryAttach, 300);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [cameraRef]);

  return (
    <div
      className="absolute top-5 right-5 z-30 rounded-xl overflow-hidden border-2 border-white/70 shadow-lg"
      style={{ width: "14vw", aspectRatio: "16 / 9" }}
      aria-hidden="true"
    >
      <video
        ref={miniVideoRef}
        autoPlay
        playsInline
        muted
        className="w-full h-full object-cover bg-neutral-900"
        style={mirror ? { transform: "scaleX(-1)" } : undefined}
      />
    </div>
  );
}

/** Top-left wayste branding — visual anchor matching the idle screen. */
function BrandingCorner() {
  return (
    <div className="absolute top-5 left-5 z-30 flex items-center gap-2">
      <img src="/logo.svg" alt="wayste logo" className="w-8 h-8" />
      <span className="text-lg font-bold text-teal-400 tracking-tight">
        wayste
      </span>
    </div>
  );
}

export default function ResultScreen({
  results,
  locale,
  voiceEnabled = false,
  streams = [],
  cameraRef,
  mirrorCamera = false,
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

  // KioskDisplay sorts results in physical left-to-right order
  // (mirror-aware), so no reversal is needed here.
  const orderedResults = displayResults;

  // ── Voice announcement via Web Speech API ──
  // Announced items are tracked per item key so that a result-set update
  // (item added/removed while the screen stays up) announces only genuinely
  // new items. Speech is cancelled ONLY on unmount — cancelling in the
  // per-update effect cut announcements off mid-sentence.
  const announcedItemsRef = React.useRef<Set<string>>(new Set());
  React.useEffect(() => {
    if (!voiceEnabled || isNothingDetected) return;
    if (typeof window === "undefined" || !window.speechSynthesis) return;

    for (const result of results) {
      const itemKey = `${result.itemName}::${result.wasteStream}`;
      if (announcedItemsRef.current.has(itemKey)) continue;
      announcedItemsRef.current.add(itemKey);

      const binName = streamLabel(locale, result.wasteStream, streams);
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
  }, [voiceEnabled, results, locale, T, isNothingDetected, streams]);

  React.useEffect(() => {
    return () => {
      if (typeof window !== "undefined" && window.speechSynthesis) {
        window.speechSynthesis.cancel();
      }
    };
  }, []);

  // ── Nothing detected: simplified result screen ──
  if (isNothingDetected) {
    return (
      <div
        className="absolute inset-0 z-20 flex flex-col bg-neutral-950/90 backdrop-blur-sm overflow-y-auto select-none animate-[fadeIn_0.3s_ease-out]"
        role="alert"
        aria-live="assertive"
        aria-atomic="true"
      >
        <BrandingCorner />
        {cameraRef && <MiniViewfinder cameraRef={cameraRef} mirror={mirrorCamera} />}

        <div className="flex-1 flex flex-col items-center justify-center p-6 gap-6 max-w-lg mx-auto w-full text-center">
          <div className="text-8xl" aria-hidden="true">&#x1F64F;</div>
          <div className="text-5xl font-bold text-white">
            {T("nothingDetectedTitle")}
          </div>
          <p className="text-neutral-400 text-xl leading-relaxed whitespace-pre-line">
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
      <BrandingCorner />
      {cameraRef && <MiniViewfinder cameraRef={cameraRef} mirror={mirrorCamera} />}

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

// ── Reasoning ticker — delayed horizontal scroll ──

function ReasoningTicker({ reasoning, delay = 1200 }: { reasoning: string; delay?: number }) {
  const [visible, setVisible] = React.useState(false);
  React.useEffect(() => {
    if (!reasoning) return;
    const timer = setTimeout(() => setVisible(true), delay);
    return () => clearTimeout(timer);
  }, [delay, reasoning]);

  if (!visible || !reasoning) return null;

  return (
    <div className="absolute bottom-0 left-0 right-0 bg-black/60 py-3 overflow-hidden animate-[fadeIn_0.3s_ease-out]">
      <div
        className="whitespace-nowrap text-white/80 text-lg font-medium px-4"
        style={{ animation: "tickerScroll 15s linear infinite" }}
      >
        {reasoning}
      </div>
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

  // Resolve the direction arrow from stream position
  const streamDef = streams.find((s) => s.id === result.wasteStream);
  const position = streamDef?.position;
  const directionArrow = position ? T(positionArrowKey[position]) : null;

  return (
    <div
      className="flex-1 flex flex-col relative transition-colors duration-300"
      style={{ backgroundColor: result.binColor }}
    >
      {/* Screen reader summary */}
      <span className="sr-only">
        {result.itemName}: {streamLabel(locale, result.wasteStream, streams)}.
        {result.preAction && ` ${result.preAction}.`}
      </span>

      {/* Top area — item name + low-confidence warning */}
      <div className="px-6 pt-14 pb-3 flex items-center gap-3">
        <div className="text-4xl font-bold text-white leading-tight flex-1 truncate">
          {result.itemName}
        </div>
        {trust === "low" && (
          <span
            className="text-yellow-400 text-4xl shrink-0"
            aria-label={T("confidenceLow")}
          >
            &#x26A0;
          </span>
        )}
      </div>

      {/* Center hero — preAction + boxed arrow + stream name */}
      <div className="flex-1 flex flex-col items-center justify-center px-6">
        {/* PreAction / Special Instructions — prominent, above arrow.
            For needs_review results the reasoning IS the next-step guidance
            ("check the label / ask staff") — show it here statically instead
            of relegating it to the delayed scrolling ticker. */}
        {(result.preAction || result.specialInstructions || (result.needsReview && result.reasoning)) && (
          <div className="bg-white rounded-2xl px-6 py-4 shadow-lg mb-6 max-w-lg">
            <p
              className="text-3xl font-black text-center leading-snug"
              style={{ color: result.binColor }}
            >
              {result.specialInstructions || result.preAction || result.reasoning}
            </p>
          </div>
        )}

        {/* Arrow — boxed in rounded rectangle */}
        {directionArrow && (
          <div className="bg-white/15 rounded-3xl px-12 py-6 mb-4">
            <div className="text-[14rem] leading-none font-bold text-white text-center" aria-hidden="true">
              {directionArrow}
            </div>
          </div>
        )}

        {/* Stream name */}
        <div className="text-6xl font-black text-white uppercase text-center">
          {streamLabel(locale, result.wasteStream, streams)}
        </div>

        {/* Physical bin position dots */}
        <BinPositionIndicator
          wasteStream={result.wasteStream}
          streams={streams}
          locale={locale}
          size="large"
        />
      </div>

      {/* Compound breakdown (bottom area — preAction already moved above) */}
      {result.isCompound && result.components && result.components.length > 0 && (
        <div className="px-6 pb-6">
          <div className="bg-black/40 border border-white/20 rounded-xl px-5 py-3">
            <CompoundBreakdown components={result.components} locale={locale} streams={streams} />
          </div>
        </div>
      )}

      {/* Reasoning ticker — appears after a delay. Skipped for needs_review,
          whose reasoning is already shown statically in the hero box. */}
      {!result.needsReview && <ReasoningTicker reasoning={result.reasoning} />}
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

  // Dynamic font sizes based on scale (monitor-sized)
  const itemNameSize = fontScale >= 1 ? "text-2xl" : fontScale >= 0.85 ? "text-xl" : "text-lg";
  const binNameSize = fontScale >= 1 ? "text-5xl" : fontScale >= 0.85 ? "text-4xl" : "text-3xl";
  const arrowSize = fontScale >= 1 ? "text-8xl" : fontScale >= 0.85 ? "text-7xl" : "text-6xl";
  const preActionSize = fontScale >= 1 ? "text-lg" : fontScale >= 0.85 ? "text-base" : "text-sm";

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
        {result.itemName}: {streamLabel(locale, result.wasteStream, streams)}.
        {result.preAction && ` ${result.preAction}.`}
      </span>

      {/* Low confidence warning — top-right corner */}
      {trust === "low" && (
        <div className="absolute top-2 right-3 z-10">
          <span
            className="text-yellow-400 text-2xl"
            aria-label={T("confidenceLow")}
          >
            &#x26A0;
          </span>
        </div>
      )}

      {/* Entire card on colored background */}
      <div
        className="flex-1 flex flex-col relative overflow-hidden transition-colors duration-300"
        style={{ backgroundColor: result.binColor }}
      >
        {/* Item name (top) */}
        <div className="px-4 pt-3 pb-2 shrink-0">
          <div className={`${itemNameSize} font-bold text-white leading-tight truncate pr-16`}>
            {result.itemName}
          </div>
        </div>

        {/* Hero — preAction + direction arrow + stream name */}
        <div className="flex-1 flex flex-col items-center justify-center px-4">
          {/* PreAction / Special Instructions — above arrow. needs_review
              reasoning shown statically here (same as FullscreenResult). */}
          {(result.preAction || result.specialInstructions || (result.needsReview && result.reasoning)) && (
            <div className="bg-white rounded-xl px-3 py-2.5 shadow mb-3 max-w-full">
              <p
                className={`${preActionSize} font-black text-center leading-snug`}
                style={{ color: result.binColor }}
              >
                {result.specialInstructions || result.preAction || result.reasoning}
              </p>
            </div>
          )}

          {/* Arrow — boxed */}
          {directionArrow && (
            <div className="bg-white/15 rounded-2xl px-6 py-3 mb-2">
              <div className={`${arrowSize} leading-none font-bold text-white`} aria-hidden="true">
                {directionArrow}
              </div>
            </div>
          )}

          <div className={`${binNameSize} font-black text-white uppercase text-center`}>
            {streamLabel(locale, result.wasteStream, streams)}
          </div>

          {/* Physical bin position dots */}
          <BinPositionIndicator
            wasteStream={result.wasteStream}
            streams={streams}
            locale={locale}
            size="small"
          />
        </div>

        {/* Compound breakdown */}
        {result.isCompound && result.components && result.components.length > 0 && (
          <div className="px-3 pb-3 shrink-0">
            <div className="bg-black/40 border border-white/20 rounded-lg px-3 py-2">
              <SplitScreenCompoundBreakdown components={result.components} locale={locale} streams={streams} />
            </div>
          </div>
        )}

        {/* Reasoning ticker — staggered delay for multi-item; skipped for
            needs_review, whose reasoning is shown statically above. */}
        {!result.needsReview && (
          <ReasoningTicker reasoning={result.reasoning} delay={2500 + animationDelay} />
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
  streams,
}: {
  components: { partName: string; wasteStream: string; instruction: string; optional?: boolean }[];
  locale: Locale;
  streams?: StreamDefinition[];
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
                <StreamBadge stream={c.wasteStream} locale={locale} streams={streams} />
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

/** Map a BinPosition to its i18n arrow key.
 *  Exported — LiveDetectionView (continuous mode) reuses the same glyph
 *  convention so both result surfaces point the same way. */
export const positionArrowKey: Record<BinPosition, TranslationKey> = {
  "far-left": "binPositionArrowFarLeft",
  "left": "binPositionArrowLeft",
  "center": "binPositionArrowCenter",
  "right": "binPositionArrowRight",
  "far-right": "binPositionArrowFarRight",
};

/**
 * Visual indicator showing which physical bin to use.
 * Renders a row of dots (one per bin position) with the active bin
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
  streams,
}: {
  components: { partName: string; wasteStream: string; instruction: string; optional?: boolean }[];
  locale: Locale;
  streams?: StreamDefinition[];
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
            <StreamBadge stream={c.wasteStream} locale={locale} streams={streams} />
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

function StreamBadge({
  stream,
  locale,
  streams,
}: {
  stream: string;
  locale: Locale;
  streams?: StreamDefinition[];
}) {
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
  // Prefer the bin color from site config so the badge matches signage.
  const configColor = streams?.find((s) => s.id === stream)?.color;
  const bg = configColor ? undefined : (colorMap[stream] ?? "bg-neutral-600");

  return (
    <span
      className={`${bg ?? ""} text-white text-[10px] font-bold px-2 py-0.5 rounded-md whitespace-nowrap mt-0.5`}
      style={configColor ? { backgroundColor: configColor } : undefined}
    >
      {streamLabel(locale, stream, streams)}
    </span>
  );
}
