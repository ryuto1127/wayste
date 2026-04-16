"use client";

import React from "react";
import type { TreeStage } from "@/lib/forest-state";
import type { Locale, TranslationKey } from "@/lib/i18n";
import { t } from "@/lib/i18n";
import TreeSVG from "./TreeSVG";

interface ForestVisualizationProps {
  trees: TreeStage[];
  sortCount: number;
  isComplete: boolean;
  locale: Locale;
  /** Index of the tree that just advanced (for growth animation). */
  justAdvancedIndex?: number | null;
  /** Called when the growth animation finishes. */
  onGrowAnimationEnd?: () => void;
}

/**
 * Leaf particle positions for the forest-complete effect.
 * Each entry: [x offset from tree center (px), animation delay (s), duration (s)].
 */
const LEAF_PARTICLES: [number, number, number][] = [
  [4, 0, 3.2],
  [-3, 0.7, 2.8],
  [8, 1.4, 3.5],
  [-6, 2.1, 3.0],
  [2, 0.3, 3.8],
  [-8, 1.8, 2.6],
];

export default function ForestVisualization({
  trees,
  sortCount,
  isComplete,
  locale,
  justAdvancedIndex = null,
  onGrowAnimationEnd,
}: ForestVisualizationProps) {
  const T = (key: TranslationKey) => t(locale, key);

  return (
    <div className="relative z-10 bg-neutral-800/40 rounded-2xl px-5 py-3 mb-2 min-w-[320px]">
      {/* Forest complete celebration — SVG globe with healing animation */}
      {isComplete && (
        <div className="flex items-center justify-center gap-3 mb-2">
          {/* Globe with green healing + sparkles */}
          <div className="relative" style={{ width: 40, height: 40 }}>
            <svg
              viewBox="0 0 32 32"
              width="40"
              height="40"
              aria-hidden="true"
              className="block"
            >
              {/* Pulsing green glow behind the globe */}
              <circle
                cx="16"
                cy="16"
                r="15"
                fill="none"
                stroke="#4ADE80"
                strokeWidth="1.5"
                opacity="0.4"
                style={{ animation: "globePulse 2.5s ease-in-out infinite" }}
              />

              {/* Ocean base */}
              <circle cx="16" cy="16" r="12" fill="#1E88E5" />

              {/* Land masses (simplified continents) */}
              <ellipse cx="12" cy="12" rx="4" ry="3" fill="#66BB6A" />
              <ellipse cx="20" cy="14" rx="3" ry="5" fill="#66BB6A" />
              <ellipse cx="14" cy="20" rx="3.5" ry="2" fill="#66BB6A" />
              <circle cx="9" cy="17" r="1.5" fill="#66BB6A" />

              {/* Green healing overlay — fills the globe over time */}
              <circle
                cx="16"
                cy="16"
                r="12"
                fill="#4ADE80"
                opacity="0"
                style={{ animation: "globeHeal 4s ease-out forwards" }}
              />

              {/* Subtle equator / meridian lines for globe feel */}
              <ellipse
                cx="16"
                cy="16"
                rx="12"
                ry="4"
                fill="none"
                stroke="rgba(255,255,255,0.12)"
                strokeWidth="0.5"
              />
              <ellipse
                cx="16"
                cy="16"
                rx="4"
                ry="12"
                fill="none"
                stroke="rgba(255,255,255,0.12)"
                strokeWidth="0.5"
              />

              {/* Shine highlight */}
              <ellipse
                cx="11"
                cy="11"
                rx="3"
                ry="2"
                fill="rgba(255,255,255,0.25)"
                transform="rotate(-30 11 11)"
              />
            </svg>

            {/* Sparkle particles orbiting the globe */}
            {[0, 1, 2, 3, 4].map((i) => (
              <span
                key={`sparkle-${i}`}
                className="absolute rounded-full"
                style={{
                  width: i % 2 === 0 ? 3 : 2,
                  height: i % 2 === 0 ? 3 : 2,
                  backgroundColor: i % 2 === 0 ? "#4ADE80" : "#FDE68A",
                  top: `${6 + i * 5}px`,
                  left: `${i % 2 === 0 ? -2 + i * 2 : 28 - i * 3}px`,
                  animation: `globeSparkle ${1.8 + i * 0.3}s ease-in-out infinite`,
                  animationDelay: `${i * 0.4}s`,
                  opacity: 0,
                }}
                aria-hidden="true"
              />
            ))}
          </div>

          {/* Forest complete label with shimmer */}
          <span
            className="text-sm font-bold ml-1"
            style={{
              background: "linear-gradient(90deg, #4ADE80, #86EFAC, #FDE68A, #4ADE80)",
              backgroundSize: "200% 100%",
              WebkitBackgroundClip: "text",
              WebkitTextFillColor: "transparent",
              backgroundClip: "text",
              animation: "textShimmer 3s linear infinite",
            }}
          >
            {T("forestComplete")}
          </span>
        </div>
      )}

      {/* Tree row + sort count */}
      <div className="flex items-end justify-center gap-0.5 relative">
        {/* Ground line — subtle earth stripe beneath all trees */}
        <div
          className="absolute bottom-0 left-2 right-2 rounded-full"
          style={{
            height: 4,
            background: "linear-gradient(90deg, transparent, #5D4037 10%, #6D4C41 50%, #5D4037 90%, transparent)",
            opacity: 0.6,
          }}
        />

        {/* Tree slots */}
        {trees.map((stage, idx) => {
          const isJustAdvanced = justAdvancedIndex === idx;
          const swayDelay = idx * 0.4; // stagger sway across the row

          return (
            <div
              key={idx}
              className="flex items-end justify-center"
              style={{ width: 40, minHeight: 52 }}
            >
              <div
                style={{
                  // Growth animation when this tree just advanced
                  ...(isJustAdvanced
                    ? { animation: "treeGrow 0.8s ease-out forwards" }
                    : {}),
                  // Sway animation when forest is complete (only for grown trees)
                  ...(isComplete && stage > 0
                    ? {
                        animation: `sway ${2.5 + idx * 0.15}s ease-in-out infinite`,
                        animationDelay: `${swayDelay}s`,
                        transformOrigin: "bottom center",
                      }
                    : {}),
                }}
                onAnimationEnd={isJustAdvanced ? onGrowAnimationEnd : undefined}
              >
                <TreeSVG stage={stage} />
              </div>
            </div>
          );
        })}

        {/* Sort count label */}
        <span className="text-sm font-semibold text-neutral-300 ml-3 whitespace-nowrap self-center">
          {T("forestSortCount").replace("{count}", String(sortCount))}
        </span>

        {/* Leaf particles — only when forest is complete */}
        {isComplete &&
          LEAF_PARTICLES.map(([xOff, delay, dur], i) => (
            <svg
              key={`leaf-${i}`}
              className="absolute pointer-events-none"
              style={{
                left: `calc(${12 + (i % trees.length) * 12}% + ${xOff}px)`,
                top: 2,
                width: 6,
                height: 6,
                animation: `leafFall ${dur}s ease-in-out infinite`,
                animationDelay: `${delay}s`,
              }}
              viewBox="0 0 6 6"
              aria-hidden="true"
            >
              <ellipse cx="3" cy="3" rx="2.5" ry="1.5" fill="#81C784" opacity="0.7" />
            </svg>
          ))}
      </div>
    </div>
  );
}
