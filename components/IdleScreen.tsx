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
  /** Detection ROI margin (fraction, e.g. 0.02 = 2% inset of center square). */
  detectionRoiMargin: number;
  /** YOLO target inset (fraction, e.g. 0.0556 = inner 89% where YOLO analyzes). */
  yoloTargetInset: number;
}

export default function IdleScreen({
  locale,
  onToggleLocale,
  statsVersion,
  voiceEnabled,
  onToggleVoice,
  detectionRoiMargin,
  yoloTargetInset,
}: IdleScreenProps) {
  const T = useCallback(
    (key: TranslationKey) => t(locale, key),
    [locale]
  );

  // ── Stats ──
  const [stats, setStats] = useState<KioskDayStats | null>(null);

  useEffect(() => {
    let cancelled = false;
    const fetchStats = () => {
      fetch("/api/kiosk-stats")
        .then((r) => r.json())
        .then((data: KioskDayStats) => {
          if (!cancelled) setStats(data);
        })
        .catch(() => {});
    };
    fetchStats();
    const interval = setInterval(fetchStats, 15_000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [statsVersion]);

  const hasData = stats !== null && stats.totalClassifications > 0;
  const successPct = stats ? Math.round(stats.successRate * 100) : 0;

  // Three-zone vignette: outer (dark) → middle (slightly dark) → inner (clear).
  // The viewfinder square represents the FG detection area (720×720).
  // The YOLO target zone (640×640) is inset within it.
  const _roiInsetPct = `${detectionRoiMargin * 100}%`; // ~2% — detection edge
  const yoloInsetPct = `${yoloTargetInset * 100}%`;    // ~5.56% — YOLO target

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
        {/* Language toggle — dual-button so both options are always visible */}
        <div className="flex items-center bg-neutral-800/60 rounded-lg overflow-hidden">
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
      </div>

      {/* Branding */}
      <div className="relative z-10 mb-4 flex items-center justify-center gap-3">
        <img src="/logo.svg" alt="wayste logo" className="w-14 h-14" />
        <h1 className="text-3xl font-bold text-teal-400 tracking-tight">
          wayste
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
        className="relative w-full max-w-lg max-h-[55vh] aspect-square flex-shrink-0 rounded-2xl overflow-hidden mb-5"
        style={{ boxShadow: "0 0 0 9999px rgba(10, 10, 10, 0.50)" }}
      >

        {/* Middle zone vignette — region between viewfinder edge and YOLO target.
            Slightly dimmed so the YOLO target zone stands out as the brightest area. */}
        <div className="absolute inset-0 pointer-events-none">
          {/* Top strip */}
          <div
            className="absolute top-0 left-0 right-0 bg-neutral-950/15"
            style={{ height: yoloInsetPct }}
          />
          {/* Bottom strip */}
          <div
            className="absolute bottom-0 left-0 right-0 bg-neutral-950/15"
            style={{ height: yoloInsetPct }}
          />
          {/* Left strip (between top and bottom) */}
          <div
            className="absolute bg-neutral-950/15"
            style={{
              top: yoloInsetPct,
              bottom: yoloInsetPct,
              left: 0,
              width: yoloInsetPct,
            }}
          />
          {/* Right strip (between top and bottom) */}
          <div
            className="absolute bg-neutral-950/15"
            style={{
              top: yoloInsetPct,
              bottom: yoloInsetPct,
              right: 0,
              width: yoloInsetPct,
            }}
          />
        </div>

        {/* YOLO target boundary — thin continuous border + glow pulse */}
        <div
          className="absolute pointer-events-none rounded-xl border border-white/20"
          style={{
            inset: yoloInsetPct,
            animation: "roiGlow 3s ease-in-out infinite",
          }}
        />

        {/* YOLO target corner brackets — guide users to hold items here */}
        <div
          className="absolute pointer-events-none"
          style={{ inset: yoloInsetPct }}
        >
          <div className="absolute top-0 left-0 w-10 h-10 border-t-[3px] border-l-[3px] rounded-tl-xl border-white/70" />
          <div className="absolute top-0 right-0 w-10 h-10 border-t-[3px] border-r-[3px] rounded-tr-xl border-white/70" />
          <div className="absolute bottom-0 left-0 w-10 h-10 border-b-[3px] border-l-[3px] rounded-bl-xl border-white/70" />
          <div className="absolute bottom-0 right-0 w-10 h-10 border-b-[3px] border-r-[3px] rounded-br-xl border-white/70" />
        </div>

      </div>

      {/* CTA text */}
      <p
        className="relative z-10 text-4xl text-white font-semibold text-center mb-4"
        style={{ animation: "ctaPulse 2.5s ease-in-out infinite" }}
      >
        {T("holdItemUp")}
      </p>

    </div>
  );
}
