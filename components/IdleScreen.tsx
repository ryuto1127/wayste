"use client";

import { useState, useEffect, useCallback } from "react";
import type { Locale, TranslationKey } from "@/lib/i18n";
import { t } from "@/lib/i18n";
import type { KioskDayStats } from "@/lib/kiosk-stats";

interface IdleScreenProps {
  locale: Locale;
  tips: { text: string }[];
  onToggleLocale: () => void;
  /** Incremented each time the pipeline returns to idle after a classification. */
  statsVersion: number;
  voiceEnabled: boolean;
  onToggleVoice: () => void;
  /** Detection ROI margin (fraction, e.g. 0.20 = 20% inset of center square). */
  detectionRoiMargin: number;
}

export default function IdleScreen({
  locale,
  tips,
  onToggleLocale,
  statsVersion,
  voiceEnabled,
  onToggleVoice,
  detectionRoiMargin,
}: IdleScreenProps) {
  const T = useCallback(
    (key: TranslationKey) => t(locale, key),
    [locale]
  );

  // ── Stats ──
  const [stats, setStats] = useState<KioskDayStats | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/kiosk-stats")
      .then((r) => r.json())
      .then((data: KioskDayStats) => {
        if (!cancelled) setStats(data);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [statsVersion]);

  // ── Tip rotation ──
  const [tipIndex, setTipIndex] = useState(0);

  useEffect(() => {
    if (tips.length === 0) return;
    setTipIndex(0);
    const timer = setInterval(() => {
      setTipIndex((i) => (i + 1) % tips.length);
    }, 8_000);
    return () => clearInterval(timer);
  }, [tips]);

  const hasData = stats !== null && stats.totalClassifications > 0;
  const successPct = stats ? Math.round(stats.successRate * 100) : 0;

  // The camera preview shows the center square of the frame (matching YOLO crop).
  // The ROI guide is inset by detectionRoiMargin within that square.
  // Outer region gets a dark overlay to draw the eye toward the ROI.
  const roiInsetPct = `${detectionRoiMargin * 100}%`;

  return (
    <div className="absolute inset-0 z-20 flex flex-col items-center justify-center bg-neutral-950 px-6 py-8 select-none animate-[fadeIn_0.3s_ease-out]">
      {/* Top-right controls: voice toggle + language toggle */}
      <div className="absolute top-6 right-6 flex items-center gap-3">
        <button
          onClick={onToggleVoice}
          className={`px-3 py-1.5 text-xs font-medium transition-colors rounded-lg ${
            voiceEnabled
              ? "bg-blue-600/20 text-blue-400 hover:bg-blue-600/30"
              : "text-neutral-500 hover:text-neutral-300"
          }`}
          aria-label={voiceEnabled ? T("voiceOff") : T("voiceOn")}
          aria-pressed={voiceEnabled}
        >
          {voiceEnabled ? "\uD83D\uDD0A" : "\uD83D\uDD07"} {voiceEnabled ? T("voiceOn") : T("voiceOff")}
        </button>
        <button
          onClick={onToggleLocale}
          className="px-3 py-1.5 text-neutral-500 hover:text-neutral-300 text-xs font-medium transition-colors"
        >
          {T("switchLang")}
        </button>
      </div>

      {/* Branding */}
      <div className="mb-4 text-center">
        <h1 className="text-2xl font-bold text-white tracking-tight">
          ♻️ Recycling Buddy
        </h1>
      </div>

      {/* Stats card */}
      <div className="bg-neutral-800/50 rounded-2xl px-8 py-5 mb-5 min-w-[280px] text-center">
        {hasData ? (
          <>
            <div className="text-xs font-semibold uppercase tracking-widest text-neutral-500 mb-3">
              {T("todaysStats")}
            </div>
            <div className="flex items-center justify-center gap-6">
              <div>
                <div className="text-3xl font-black text-white">
                  {stats.totalClassifications}
                </div>
                <div className="text-xs text-neutral-400 mt-1">
                  {T("itemsSorted")}
                </div>
              </div>
              <div className="w-px h-10 bg-neutral-700" />
              <div>
                <div
                  className={`text-3xl font-black ${
                    successPct >= 80
                      ? "text-emerald-400"
                      : successPct >= 60
                        ? "text-amber-400"
                        : "text-red-400"
                  }`}
                >
                  {successPct}%
                </div>
                <div className="text-xs text-neutral-400 mt-1">
                  {T("successRateLabel")}
                </div>
              </div>
            </div>
          </>
        ) : (
          <div className="text-neutral-300 text-lg font-medium py-2">
            {T("firstUserWelcome")}
          </div>
        )}
      </div>

      {/* Camera preview with ROI guide */}
      <div className="relative w-full max-w-sm aspect-square rounded-2xl overflow-hidden mb-5">
        {/* Live camera feed — visible through the component tree.
            The parent KioskDisplay renders <CameraFeed> behind all overlays.
            We punch a transparent window here so it shows through. */}
        <div className="absolute inset-0 bg-transparent" />

        {/* Dark vignette overlay outside the ROI — guides attention inward */}
        <div className="absolute inset-0 pointer-events-none">
          {/* Top strip */}
          <div
            className="absolute top-0 left-0 right-0 bg-neutral-950/60"
            style={{ height: roiInsetPct }}
          />
          {/* Bottom strip */}
          <div
            className="absolute bottom-0 left-0 right-0 bg-neutral-950/60"
            style={{ height: roiInsetPct }}
          />
          {/* Left strip (between top and bottom) */}
          <div
            className="absolute bg-neutral-950/60"
            style={{
              top: roiInsetPct,
              bottom: roiInsetPct,
              left: 0,
              width: roiInsetPct,
            }}
          />
          {/* Right strip (between top and bottom) */}
          <div
            className="absolute bg-neutral-950/60"
            style={{
              top: roiInsetPct,
              bottom: roiInsetPct,
              right: 0,
              width: roiInsetPct,
            }}
          />
        </div>

        {/* ROI corner markers */}
        <div
          className="absolute pointer-events-none"
          style={{ inset: roiInsetPct }}
        >
          <div className="absolute top-0 left-0 w-8 h-8 border-t-2 border-l-2 rounded-tl-lg border-white/50" />
          <div className="absolute top-0 right-0 w-8 h-8 border-t-2 border-r-2 rounded-tr-lg border-white/50" />
          <div className="absolute bottom-0 left-0 w-8 h-8 border-b-2 border-l-2 rounded-bl-lg border-white/50" />
          <div className="absolute bottom-0 right-0 w-8 h-8 border-b-2 border-r-2 rounded-br-lg border-white/50" />
        </div>

        {/* Pulsing hand icon in the center */}
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <span className="text-4xl opacity-60 animate-[pulse_2s_ease-in-out_infinite]">
            👋
          </span>
        </div>
      </div>

      {/* CTA text */}
      <p className="text-lg text-neutral-300 font-medium text-center mb-4">
        {T("holdItemUp")}
      </p>

      {/* Sorting tip */}
      {tips.length > 0 && (
        <div className="max-w-md text-center min-h-[48px] flex items-center justify-center">
          <div
            key={tipIndex}
            className="animate-[fadeIn_0.5s_ease-out]"
          >
            <div className="text-xs font-semibold uppercase tracking-widest text-neutral-600 mb-1">
              💡 {T("sortingTip")}
            </div>
            <p className="text-neutral-400 text-sm leading-relaxed">
              {tips[tipIndex]?.text}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
