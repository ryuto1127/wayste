"use client";

import { useCallback } from "react";
import type { PipelineState } from "@/lib/types";
import type { Locale, TranslationKey } from "@/lib/i18n";
import { t } from "@/lib/i18n";

interface CameraScreenProps {
  pipelineState: PipelineState;
  locale: Locale;
  yoloTargetInset: number;
}

export default function CameraScreen({
  pipelineState,
  locale,
  yoloTargetInset,
}: CameraScreenProps) {
  const T = useCallback(
    (key: TranslationKey) => t(locale, key),
    [locale]
  );

  const isClassifying = pipelineState === "classifying";
  const borderColor = isClassifying
    ? "border-amber-400/60"
    : "border-blue-400/60";

  // The detection ROI is a square centered in the frame, based on the shorter
  // dimension (height for 16:9). The margin is applied within that square.
  // To place markers correctly on the 16:9 video, we need asymmetric insets:
  //   vertical: detectionRoiMargin of the height
  //   horizontal: must account for the square crop centering + inner margin
  // For 1280×720: center square = 720×720 → starts at x=280 (21.875% of 1280)
  // Inner ROI at 20% inset of 720 = 144px inset → starts at x=424 (33.125% of 1280)
  // Using CSS calc with aspect-ratio-aware percentages:
  const verticalInset = `${yoloTargetInset * 100}%`;
  // horizontalInset = (frameW - frameH) / (2 * frameW) + detectionRoiMargin * (frameH / frameW)
  // For 16:9: = (16-9)/(2*16) + margin * (9/16) = 0.21875 + margin * 0.5625
  // We use a CSS-friendly approximation: the square's edge + inner margin
  // Generic formula that works for any aspect ratio via calc():
  // left/right = 50% - (50% - margin*100%) * (height/width)
  // Since we don't know exact aspect ratio in CSS, use a pragmatic approach:
  // wrap markers in an aspect-square container centered in the frame.

  return (
    <div className="absolute inset-0 z-10 pointer-events-none animate-[fadeIn_0.2s_ease-out]">
      {/* Status indicator */}
      <div className="absolute top-6 left-6 flex items-center gap-2 pointer-events-auto">
        <span className="relative flex h-3 w-3">
          <span
            className={`animate-ping absolute inline-flex h-full w-full rounded-full opacity-75 ${
              isClassifying ? "bg-amber-400" : "bg-blue-400"
            }`}
          />
          <span
            className={`relative inline-flex rounded-full h-3 w-3 ${
              isClassifying ? "bg-amber-500" : "bg-blue-500"
            }`}
          />
        </span>
        <span className="text-sm text-white/70 font-medium" role="status" aria-live="polite">
          {isClassifying ? T("analyzingPleaseWait") : T("itemDetected")}
        </span>
      </div>

      {/* Hold steady prompt */}
      {!isClassifying && (
        <div className="absolute bottom-8 left-1/2 -translate-x-1/2">
          <div className="bg-amber-900/80 backdrop-blur-sm rounded-xl px-5 py-2.5">
            <p className="text-amber-200 text-sm font-medium">
              {T("holdForScan")}
            </p>
          </div>
        </div>
      )}

      {/* Corner scan markers — placed inside a center-square container
          that matches the YOLO/analyzer crop area (short-side based).
          While classifying, the marker wrapper breathes (scales subtly in/out)
          to give a visual "thinking" signal during the 1–2s inference wait. */}
      <div className="absolute inset-0 flex items-center justify-center">
        <div className="relative h-full aspect-square max-w-full">
          <div
            className="absolute pointer-events-none"
            style={{
              inset: verticalInset,
              transformOrigin: "center",
              animation: isClassifying
                ? "breathe 2.4s ease-in-out infinite"
                : undefined,
            }}
          >
            <div
              className={`absolute top-0 left-0 w-10 h-10 border-t-2 border-l-2 rounded-tl-lg transition-colors duration-300 ${borderColor}`}
            />
            <div
              className={`absolute top-0 right-0 w-10 h-10 border-t-2 border-r-2 rounded-tr-lg transition-colors duration-300 ${borderColor}`}
            />
            <div
              className={`absolute bottom-0 left-0 w-10 h-10 border-b-2 border-l-2 rounded-bl-lg transition-colors duration-300 ${borderColor}`}
            />
            <div
              className={`absolute bottom-0 right-0 w-10 h-10 border-b-2 border-r-2 rounded-br-lg transition-colors duration-300 ${borderColor}`}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
