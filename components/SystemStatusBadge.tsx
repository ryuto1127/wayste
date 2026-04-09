"use client";

import { useState, useEffect } from "react";
import type { SystemStatus } from "@/lib/inference-backend";
import { subscribeSystemStatus } from "@/lib/inference-backend";

interface SystemStatusBadgeProps {
  /** Whether thermal throttling has been detected. */
  thermalWarning: boolean;
}

/**
 * Small status badge shown in the bottom-left corner of the kiosk.
 * Displays: GPU/CPU provider, model readiness dots, thermal warning.
 */
export default function SystemStatusBadge({ thermalWarning }: SystemStatusBadgeProps) {
  const [status, setStatus] = useState<SystemStatus>({
    yolo26m: "loading",
    yoloWorld: "loading",
    provider: "unknown",
    overallReady: false,
  });

  useEffect(() => {
    return subscribeSystemStatus(setStatus);
  }, []);

  const providerLabel = status.provider === "webgpu" ? "GPU" : status.provider === "wasm" ? "CPU" : "…";
  const providerColor = status.provider === "webgpu"
    ? "text-emerald-400"
    : status.provider === "wasm"
      ? "text-amber-400"
      : "text-neutral-500";

  return (
    <div className="absolute bottom-4 left-4 z-30 flex items-center gap-2 bg-neutral-900/70 backdrop-blur-sm rounded-lg px-3 py-1.5 text-[10px] font-mono select-none">
      {/* Provider badge */}
      <span className={`font-bold ${providerColor}`}>
        {providerLabel}
      </span>

      <span className="text-neutral-600">|</span>

      {/* Model status dots */}
      <div className="flex items-center gap-1.5" title="YOLO26m / YOLO World">
        <StatusDot status={status.yolo26m} label="T1" />
        <StatusDot status={status.yoloWorld} label="T2" />
      </div>

      {/* Thermal warning */}
      {thermalWarning && (
        <>
          <span className="text-neutral-600">|</span>
          <span className="text-orange-400 animate-pulse" title="Thermal throttling detected — analysis reduced to 15fps">
            🌡️
          </span>
        </>
      )}
    </div>
  );
}

function StatusDot({ status, label }: { status: string; label: string }) {
  const color =
    status === "ready"
      ? "bg-emerald-400"
      : status === "loading"
        ? "bg-amber-400 animate-pulse"
        : "bg-red-400";

  return (
    <div className="flex items-center gap-0.5" title={`${label}: ${status}`}>
      <div className={`w-1.5 h-1.5 rounded-full ${color}`} />
      <span className="text-neutral-500">{label}</span>
    </div>
  );
}
