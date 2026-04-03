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
}

export default function IdleScreen({
  locale,
  tips,
  onToggleLocale,
  statsVersion,
  voiceEnabled,
  onToggleVoice,
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

  return (
    <div className="absolute inset-0 z-20 flex flex-col items-center justify-center bg-neutral-950 px-8 py-12 select-none animate-[fadeIn_0.3s_ease-out]">
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
      <div className="mb-10 text-center">
        <h1 className="text-2xl font-bold text-white tracking-tight">
          ♻️ Recycling Buddy
        </h1>
      </div>

      {/* Stats card */}
      <div className="bg-neutral-800/50 rounded-2xl px-8 py-6 mb-8 min-w-[280px] text-center">
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

      {/* Sorting tip */}
      {tips.length > 0 && (
        <div className="mb-10 max-w-md text-center min-h-[60px] flex items-center justify-center">
          <div
            key={tipIndex}
            className="animate-[fadeIn_0.5s_ease-out]"
          >
            <div className="text-xs font-semibold uppercase tracking-widest text-neutral-600 mb-2">
              💡 {T("sortingTip")}
            </div>
            <p className="text-neutral-300 text-sm leading-relaxed">
              {tips[tipIndex]?.text}
            </p>
          </div>
        </div>
      )}

      {/* CTA */}
      <div className="text-center">
        <div className="text-4xl mb-3 animate-[pulse_2s_ease-in-out_infinite]">
          👋
        </div>
        <p className="text-xl text-neutral-300 font-medium">
          {T("holdItemUp")}
        </p>
        <p className="text-sm text-neutral-600 mt-2">
          {T("systemWillIdentify")}
        </p>
      </div>
    </div>
  );
}
