"use client";

import React, { useEffect, useState } from "react";
import type { Locale, TranslationKey } from "@/lib/i18n";
import { t } from "@/lib/i18n";

interface SeedlingAnimationProps {
  /** Called when the animation finishes (~1s). */
  onComplete: () => void;
  locale: Locale;
}

/**
 * Soil particle positions: each scatters outward from the seedling base.
 * [translateX end, translateY end, size, delay(ms)]
 */
const SOIL_PARTICLES: [number, number, number, number][] = [
  [-18, -12, 4, 0],
  [16, -14, 3, 60],
  [-10, -18, 3.5, 120],
  [20, -10, 2.5, 80],
  [-22, -8, 3, 160],
];

export default function SeedlingAnimation({
  onComplete,
  locale,
}: SeedlingAnimationProps) {
  const T = (key: TranslationKey) => t(locale, key);
  const [done, setDone] = useState(false);

  // Safety fallback — auto-dismiss after 3s in case onAnimationEnd doesn't fire
  useEffect(() => {
    const timer = setTimeout(() => {
      if (!done) {
        setDone(true);
        onComplete();
      }
    }, 3000);
    return () => clearTimeout(timer);
  }, [done, onComplete]);

  return (
    <div className="absolute inset-0 z-25 flex flex-col items-center justify-center bg-neutral-950/70 select-none">
      {/* SVG seedling with soil particles */}
      <div
        style={{ animation: "seedlingPlant 2.5s ease-out forwards" }}
        onAnimationEnd={() => {
          if (!done) {
            setDone(true);
            onComplete();
          }
        }}
      >
        <svg
          viewBox="0 0 80 100"
          width="120"
          height="150"
          aria-hidden="true"
        >
          {/* Soil particles — scatter outward from base */}
          {SOIL_PARTICLES.map(([tx, ty, size, delay], i) => (
            <rect
              key={i}
              x={40 - size / 2}
              y={88 - size / 2}
              width={size}
              height={size}
              rx={1}
              fill={i % 2 === 0 ? "#8D6E4C" : "#6B4F3A"}
              style={{
                animation: `soilBurst 1s ${delay}ms ease-out forwards`,
                ["--soil-tx" as string]: `${tx}px`,
                ["--soil-ty" as string]: `${ty}px`,
              }}
            />
          ))}

          {/* Ground mound */}
          <ellipse cx="40" cy="90" rx="28" ry="6" fill="#6B4F3A" opacity="0.8" />

          {/* Stem */}
          <line
            x1="40"
            y1="90"
            x2="40"
            y2="58"
            stroke="#7A9A4A"
            strokeWidth="3.5"
            strokeLinecap="round"
          />

          {/* Left leaf */}
          <ellipse
            cx="30"
            cy="58"
            rx="10"
            ry="5.5"
            fill="#8BC34A"
            transform="rotate(-30 30 58)"
          />

          {/* Right leaf */}
          <ellipse
            cx="50"
            cy="62"
            rx="10"
            ry="5.5"
            fill="#9CCC65"
            transform="rotate(25 50 62)"
          />
        </svg>
      </div>

      {/* Thank you message */}
      <div className="mt-4 text-3xl font-bold text-white animate-[fadeIn_0.3s_ease-out]">
        {T("thankYou")}
      </div>
    </div>
  );
}
