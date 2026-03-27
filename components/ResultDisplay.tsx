"use client";

import type { ClassificationResponse } from "@/lib/types";
import ConfidenceMeter from "./ConfidenceMeter";

interface ResultDisplayProps {
  result: ClassificationResponse;
  secondsRemaining: number;
}

export default function ResultDisplay({
  result,
  secondsRemaining,
}: ResultDisplayProps) {
  const isLowConfidence = result.confidence < 0.6;
  const isVeryLow = result.confidence < 0.3;

  if (isVeryLow) {
    return (
      <div className="flex flex-col items-center justify-center h-full animate-[fadeIn_0.3s_ease-out] select-none">
        <div className="text-6xl mb-6">?</div>
        <h2 className="text-4xl md:text-5xl font-bold text-neutral-300 mb-4 text-center">
          Item Not Recognized
        </h2>
        <p className="text-xl text-neutral-400 mb-8 text-center max-w-lg">
          Try holding the item closer to the camera, or ask a staff member for
          help.
        </p>
        <ConfidenceMeter confidence={result.confidence} />
        <ProgressBar seconds={secondsRemaining} />
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center justify-center h-full animate-[fadeIn_0.3s_ease-out] select-none gap-6">
      {/* Item name */}
      <h2 className="text-3xl md:text-4xl font-semibold text-neutral-200 text-center">
        {result.itemName}
      </h2>

      {/* Main bin indicator */}
      <div
        className="w-full max-w-2xl rounded-3xl px-8 py-10 flex flex-col items-center justify-center shadow-2xl transition-colors duration-300"
        style={{ backgroundColor: result.binColor }}
      >
        <span className="text-5xl md:text-7xl lg:text-8xl font-black text-white tracking-wide text-center uppercase">
          {result.binLabel}
        </span>
      </div>

      {/* Low confidence warning */}
      {isLowConfidence && (
        <div className="bg-amber-900/50 border border-amber-600 rounded-xl px-6 py-3 max-w-lg text-center">
          <p className="text-amber-300 text-lg font-medium">
            Not fully sure about this one — please verify
          </p>
        </div>
      )}

      {/* Reasoning */}
      <p className="text-lg text-neutral-400 text-center max-w-lg">
        {result.reasoning}
      </p>

      {/* Special instructions */}
      {result.specialInstructions && (
        <div className="bg-neutral-800 rounded-xl px-6 py-3 max-w-lg text-center">
          <p className="text-neutral-300 text-base">
            {result.specialInstructions}
          </p>
        </div>
      )}

      {/* Confidence */}
      <ConfidenceMeter confidence={result.confidence} />

      {/* Countdown */}
      <ProgressBar seconds={secondsRemaining} />
    </div>
  );
}

function ProgressBar({ seconds }: { seconds: number }) {
  return (
    <div className="mt-2 text-sm text-neutral-600">
      Next scan in {seconds}s
    </div>
  );
}
