"use client";

import React, { useState, useEffect, useCallback, useMemo } from "react";
import type { Locale, TranslationKey } from "@/lib/i18n";
import { t } from "@/lib/i18n";
import { getCounters, bagsEquivalent } from "@/lib/kiosk-counter";

interface IdleScreenProps {
  locale: Locale;
  /** Incremented each time the pipeline returns to idle after a classification. */
  statsVersion: number;
}

/** How long each stat stays visible before rotating to the next one (ms). */
const STAT_ROTATION_MS = 4_000;

export default function IdleScreen({
  locale,
  statsVersion,
}: IdleScreenProps) {
  const T = useCallback(
    (key: TranslationKey) => t(locale, key),
    [locale]
  );

  // Counters come from localStorage; recomputed whenever the pipeline signals
  // a fresh classification via `statsVersion`.
  const counters = useMemo(() => getCounters(), [statsVersion]);

  // ── Rotating stat index ──
  // Three stats: 0 = today, 1 = bags equivalent, 2 = cumulative.
  // We rotate even when numbers are zero so the slot always looks "alive".
  const [statIndex, setStatIndex] = useState(0);
  useEffect(() => {
    const interval = setInterval(() => {
      setStatIndex((i) => (i + 1) % 3);
    }, STAT_ROTATION_MS);
    return () => clearInterval(interval);
  }, []);

  const statMessages: string[] = [
    T("statTodaySorts").replace("{count}", String(counters.today)),
    T("statBagsEquivalent").replace(
      "{count}",
      String(bagsEquivalent(counters.cumulative))
    ),
    T("statTotalSorts").replace("{count}", String(counters.cumulative)),
  ];

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
      // Cap to visible screen area (minus padding for stats + CTA)
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

      {/* Top-left: wayste branding */}
      <div className="absolute top-5 left-5 flex items-center gap-2 z-10">
        <img src="/logo.svg" alt="wayste logo" className="w-8 h-8" />
        <span className="text-lg font-bold text-teal-400 tracking-tight">
          wayste
        </span>
      </div>

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
        className="relative z-10 text-4xl text-white font-semibold text-center mb-4"
        style={{ animation: "ctaPulse 2.5s ease-in-out infinite" }}
      >
        {T("holdItemUp")}
      </p>

      {/* Rotating community stats — small, secondary visual weight.
          Key on statIndex so each message gets its own fade-in animation. */}
      <p
        key={statIndex}
        className="relative z-10 text-base text-neutral-400 text-center animate-[fadeIn_0.4s_ease-out]"
      >
        {statMessages[statIndex]}
      </p>

    </div>
  );
}
