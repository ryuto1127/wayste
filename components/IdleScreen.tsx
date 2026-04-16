"use client";

import React, { useState, useEffect, useCallback } from "react";
import type { Locale, TranslationKey } from "@/lib/i18n";
import { t } from "@/lib/i18n";
import type { KioskDayStats } from "@/lib/kiosk-stats";
import { getForestState, isForestComplete } from "@/lib/forest-state";
import ForestVisualization from "./ForestVisualization";

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
  /** Index of the tree that just advanced (triggers growth animation). */
  justAdvancedTreeIndex?: number | null;
  /** Called after the tree growth animation finishes to clear the index. */
  onTreeAnimationDone?: () => void;
}

export default function IdleScreen({
  locale,
  onToggleLocale,
  statsVersion,
  voiceEnabled,
  onToggleVoice,
  detectionRoiMargin,
  yoloTargetInset,
  justAdvancedTreeIndex = null,
  onTreeAnimationDone,
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

  // ── Forest gamification state ──
  // Refresh forest when statsVersion changes (= after each cooldown→idle cycle).
  // useMemo avoids the lint error about setState in useEffect while still
  // recomputing whenever statsVersion changes.
  const forest = React.useMemo(() => getForestState(), [statsVersion]);

  const successPct = stats ? Math.round(stats.successRate * 100) : 0;

  // Accuracy display: show only if ≥20 reviews AND accuracy ≥85%
  const showAccuracy = stats !== null
    && stats.reviewedCount >= 20
    && stats.successRate >= 0.85;

  // ── Viewfinder: dynamically sized to match YOLO's actual 640×640 on screen ──
  // The camera (1280×720) is displayed with object-cover. We compute how large
  // the 640×640 YOLO crop appears on screen, then show 85% of that so users
  // aim inside, guaranteeing items land within the full YOLO field of view.
  const CAMERA_W = 1280;
  const CAMERA_H = 720;
  const YOLO_SIZE = 640;
  const VIEWFINDER_RATIO = 0.85;

  const [viewfinderPx, setViewfinderPx] = useState<number>(0);

  useEffect(() => {
    function calc() {
      const cw = window.innerWidth;
      const ch = window.innerHeight;
      // object-cover: scale to cover the entire container
      const scale = Math.max(cw / CAMERA_W, ch / CAMERA_H);
      const yoloOnScreen = YOLO_SIZE * scale;
      let vf = Math.round(yoloOnScreen * VIEWFINDER_RATIO);
      // Cap to visible screen area (minus padding for forest + CTA)
      const maxSize = Math.min(cw - 32, ch * 0.55);
      vf = Math.min(vf, maxSize);
      setViewfinderPx(vf);
    }
    calc();
    window.addEventListener("resize", calc);
    return () => window.removeEventListener("resize", calc);
  }, []);

  return (
    <div className="absolute inset-0 z-20 flex flex-col items-center justify-center px-6 py-8 select-none animate-[fadeIn_0.3s_ease-out]">

      {/* Top-left: branding (small) */}
      <div className="absolute top-5 left-5 flex items-center gap-2 z-10">
        <img src="/logo.svg" alt="wayste logo" className="w-8 h-8" />
        <span className="text-lg font-bold text-teal-400 tracking-tight">
          wayste
        </span>
      </div>

      {/* Top-right controls: voice toggle + language toggle */}
      <div className="absolute top-5 right-5 flex items-center gap-3 z-10">
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

      {/* Accuracy badge — only shown when enough data and high accuracy */}
      {showAccuracy && (
        <div className="relative z-10 bg-neutral-800/50 rounded-xl px-5 py-2 mb-3 text-center">
          <div className="flex items-center gap-2">
            <div
              className={`text-2xl font-black ${
                successPct >= 80
                  ? "text-emerald-400"
                  : successPct >= 60
                    ? "text-amber-400"
                    : "text-red-400"
              }`}
            >
              {successPct}%
            </div>
            <div className="text-xs text-neutral-400">
              {T("accuracyLabel")}
            </div>
          </div>
        </div>
      )}

      {/* Forest gamification */}
      {forest.sortCount > 0 && (
        <div className="relative z-10 mb-4">
          <ForestVisualization
            trees={forest.trees}
            sortCount={forest.sortCount}
            isComplete={isForestComplete(forest)}
            locale={locale}
            justAdvancedIndex={justAdvancedTreeIndex}
            onGrowAnimationEnd={onTreeAnimationDone}
          />
        </div>
      )}

      {/* Camera viewfinder — 85% of YOLO's 640×640 on screen.
          Users aim here → items reliably land within the full YOLO field of view. */}
      {viewfinderPx > 0 && (
        <div
          className="relative flex-shrink-0 rounded-2xl overflow-hidden mb-3"
          style={{
            width: viewfinderPx,
            height: viewfinderPx,
            boxShadow: "0 0 0 9999px rgba(10, 10, 10, 0.50)",
          }}
        />
      )}


      {/* CTA text */}
      <p
        className="relative z-10 text-4xl text-white font-semibold text-center mb-2"
        style={{ animation: "ctaPulse 2.5s ease-in-out infinite" }}
      >
        {T("holdItemUp")}
      </p>

    </div>
  );
}
