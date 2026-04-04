"use client";

import { useCallback } from "react";
import type { PipelineState } from "@/lib/types";
import type { Locale, TranslationKey } from "@/lib/i18n";
import { t } from "@/lib/i18n";

interface CameraScreenProps {
  pipelineState: PipelineState;
  locale: Locale;
  detectionRoiMargin: number;
}

export default function CameraScreen({
  pipelineState,
  locale,
  detectionRoiMargin,
}: CameraScreenProps) {
  const T = useCallback(
    (key: TranslationKey) => t(locale, key),
    [locale]
  );

  const isClassifying = pipelineState === "classifying";
  const borderColor = isClassifying
    ? "border-amber-400/60"
    : "border-blue-400/60";

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

      {/* Corner scan markers */}
      <div
        className="absolute pointer-events-none"
        style={{ inset: `${detectionRoiMargin * 100}%` }}
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
  );
}
