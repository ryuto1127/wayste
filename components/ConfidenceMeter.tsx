"use client";

interface ConfidenceMeterProps {
  confidence: number;
}

export default function ConfidenceMeter({ confidence }: ConfidenceMeterProps) {
  const pct = Math.round(confidence * 100);

  let color: string;
  let label: string;

  if (confidence >= 0.8) {
    color = "bg-emerald-500";
    label = "High confidence";
  } else if (confidence >= 0.6) {
    color = "bg-amber-500";
    label = "Moderate confidence";
  } else {
    color = "bg-red-500";
    label = "Low confidence";
  }

  return (
    <div className="w-full max-w-md">
      <div className="flex items-center justify-between mb-2">
        <span className="text-sm text-neutral-400 font-medium">{label}</span>
        <span className="text-sm text-neutral-500">{pct}%</span>
      </div>
      <div className="w-full h-2 bg-neutral-700 rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-500 ${color}`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}
