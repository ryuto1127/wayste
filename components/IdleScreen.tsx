"use client";

import { useState, useEffect, useCallback } from "react";
import type { Locale, TranslationKey } from "@/lib/i18n";
import { t } from "@/lib/i18n";
import type { KioskDayStats } from "@/lib/kiosk-stats";

interface IdleScreenProps {
  locale: Locale;
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

  const hasData = stats !== null && stats.totalClassifications > 0;
  const successPct = stats ? Math.round(stats.successRate * 100) : 0;

  // The camera preview shows the center square of the frame (matching YOLO crop).
  // The ROI guide is inset by detectionRoiMargin within that square.
  // Outer region gets a dark overlay to draw the eye toward the ROI.
  const roiInsetPct = `${detectionRoiMargin * 100}%`;

  return (
    <div className="absolute inset-0 z-20 flex flex-col items-center justify-center px-6 py-8 select-none animate-[fadeIn_0.3s_ease-out]">

      {/* Top-right controls: voice toggle + language toggle */}
      <div className="absolute top-6 right-6 flex items-center gap-3 z-10">
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
      <div className="relative z-10 mb-4 text-center">
        <h1 className="text-2xl font-bold text-white tracking-tight">
          ♻️ Recycling Buddy
        </h1>
      </div>

      {/* Stats card */}
      <div className="relative z-10 bg-neutral-800/50 rounded-2xl px-8 py-5 mb-5 min-w-[280px] text-center">
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

      {/* Camera viewfinder with ROI guide.
          The massive box-shadow darkens everything outside the viewfinder
          so the live camera feed (behind this overlay) only shows through here. */}
      <div
        className="relative w-full max-w-xl aspect-square rounded-2xl overflow-hidden mb-5"
        style={{ boxShadow: "0 0 0 9999px rgba(10, 10, 10, 0.75)" }}
      >

        {/* Dark vignette overlay outside the ROI — outer zone is dimmed so
            the user can see their hand/item but attention is drawn to the
            brighter ROI center. */}
        <div className="absolute inset-0 pointer-events-none">
          {/* Top strip */}
          <div
            className="absolute top-0 left-0 right-0 bg-neutral-950/35"
            style={{ height: roiInsetPct }}
          />
          {/* Bottom strip */}
          <div
            className="absolute bottom-0 left-0 right-0 bg-neutral-950/35"
            style={{ height: roiInsetPct }}
          />
          {/* Left strip (between top and bottom) */}
          <div
            className="absolute bg-neutral-950/35"
            style={{
              top: roiInsetPct,
              bottom: roiInsetPct,
              left: 0,
              width: roiInsetPct,
            }}
          />
          {/* Right strip (between top and bottom) */}
          <div
            className="absolute bg-neutral-950/35"
            style={{
              top: roiInsetPct,
              bottom: roiInsetPct,
              right: 0,
              width: roiInsetPct,
            }}
          />
        </div>

        {/* ROI boundary — thin continuous border + glow pulse */}
        <div
          className="absolute pointer-events-none rounded-xl border border-white/20"
          style={{
            inset: roiInsetPct,
            animation: "roiGlow 3s ease-in-out infinite",
          }}
        />

        {/* ROI corner brackets — larger and bolder for visibility */}
        <div
          className="absolute pointer-events-none"
          style={{ inset: roiInsetPct }}
        >
          <div className="absolute top-0 left-0 w-10 h-10 border-t-[3px] border-l-[3px] rounded-tl-xl border-white/70" />
          <div className="absolute top-0 right-0 w-10 h-10 border-t-[3px] border-r-[3px] rounded-tr-xl border-white/70" />
          <div className="absolute bottom-0 left-0 w-10 h-10 border-b-[3px] border-l-[3px] rounded-bl-xl border-white/70" />
          <div className="absolute bottom-0 right-0 w-10 h-10 border-b-[3px] border-r-[3px] rounded-br-xl border-white/70" />
        </div>

        {/* Pulsing hand icon in the center */}
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <span className="text-4xl opacity-60 animate-[pulse_2s_ease-in-out_infinite]">
            👋
          </span>
        </div>
      </div>

      {/* CTA text */}
      <p className="relative z-10 text-lg text-neutral-300 font-medium text-center mb-4">
        {T("holdItemUp")}
      </p>

    </div>
  );
}
