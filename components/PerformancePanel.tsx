"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { perfMonitor, type PerfSample, type PerfStats, type ThermalEvent, type TimeScale } from "@/lib/perf-monitor";

// ── Chart constants ──

const CHART_W = 800;
const THERMAL_STRIP_H = 20;
const THERMAL_GAP = 6;
const CHART_H = 200 + THERMAL_STRIP_H + THERMAL_GAP;
const PADDING = { top: 20, right: 60, bottom: 30, left: 50 };
const PLOT_W = CHART_W - PADDING.left - PADDING.right;
const PLOT_H = CHART_H - PADDING.top - PADDING.bottom - THERMAL_STRIP_H - THERMAL_GAP;

// Colors
const CV_COLOR = "#38bdf8";      // sky-400
const FPS_COLOR = "#a78bfa";     // violet-400
const YOLO_COLOR = "#fb923c";    // orange-400
const GRID_COLOR = "#333";
const TEXT_COLOR = "#999";
const THROTTLE_BG = "rgba(239, 68, 68, 0.08)";

export function PerformancePanel() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [open, setOpen] = useState(false);
  const [samples, setSamples] = useState<PerfSample[]>([]);
  const [stats, setStats] = useState<{
    cv: PerfStats; fps: PerfStats; yolo: PerfStats; world: PerfStats;
  } | null>(null);
  const [thermalLog, setThermalLog] = useState<ThermalEvent[]>([]);
  const [throttling, setThrottling] = useState(false);
  const [thermalRatio, setThermalRatio] = useState(0);
  const [scale, setScale] = useState<TimeScale>("10m");

  const refresh = useCallback(() => {
    setSamples(perfMonitor.getSamples(scale));
    setStats(perfMonitor.getLifetimeStats());
    setThermalLog(perfMonitor.getThermalLog());
    setThrottling(perfMonitor.isThrottling());
    setThermalRatio(perfMonitor.getThermalRatio());
  }, [scale]);

  // Subscribe to updates + poll every second when open
  useEffect(() => {
    if (!open) return;
    refresh();
    const unsub = perfMonitor.subscribe(refresh);
    const interval = setInterval(refresh, 1000);
    return () => { unsub(); clearInterval(interval); };
  }, [open, refresh]);

  // Draw chart whenever samples change
  useEffect(() => {
    if (!open || samples.length < 2) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    drawChart(ctx, samples, scale);
  }, [open, samples, scale]);

  const hasSamples = samples.length > 0;

  return (
    <div className="mb-6">
      <button
        onClick={() => setOpen((v) => !v)}
        className="text-xs text-neutral-500 hover:text-cyan-400 transition-colors"
      >
        {open ? "▲ Close performance" : "▼ Performance..."}
      </button>

      {open && (
        <div className="mt-3 bg-neutral-900 border border-neutral-800 rounded-xl p-4 space-y-4">
          {/* Scale selector + thermal gauge */}
          <div className="flex items-center justify-between gap-4">
            <ThermalGauge ratio={thermalRatio} throttling={throttling} />
            <div className="flex gap-1 shrink-0">
              {(["10m", "1h", "24h"] as const).map((s) => (
                <button
                  key={s}
                  onClick={() => setScale(s)}
                  className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${
                    scale === s
                      ? "bg-neutral-700 text-white"
                      : "bg-neutral-800 text-neutral-500 hover:text-neutral-300"
                  }`}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>

          {!hasSamples && (
            <p className="text-xs text-neutral-600">Waiting for kiosk data...</p>
          )}

          {/* Chart */}
          {hasSamples && (
            <div className="overflow-x-auto">
              <canvas
                ref={canvasRef}
                width={CHART_W}
                height={CHART_H}
                className="rounded-lg bg-neutral-950"
                style={{ width: CHART_W, height: CHART_H }}
              />
              {/* Legend */}
              <div className="flex gap-4 mt-2 text-xs flex-wrap">
                <LegendItem color={CV_COLOR} label="CV analysis (ms)" />
                <LegendItem color={FPS_COLOR} label="Frame rate (fps)" />
                <LegendItem color={YOLO_COLOR} label="YOLO T1 (ms)" dot />
                <div className="flex items-center gap-1.5 text-neutral-400">
                  <span className="w-4 h-2 rounded-sm" style={{ background: "linear-gradient(to right, #065f46, #fbbf24, #f87171)" }} />
                  Thermal ratio
                </div>
              </div>
            </div>
          )}

          {/* Stats table */}
          {stats && stats.cv.count > 0 && (
            <div className="overflow-x-auto">
              <table className="text-xs text-neutral-400 w-full">
                <thead>
                  <tr className="border-b border-neutral-800">
                    <th className="text-left py-1 pr-4 font-medium text-neutral-300">Metric</th>
                    <th className="text-right py-1 px-3 font-medium text-neutral-300">Min</th>
                    <th className="text-right py-1 px-3 font-medium text-neutral-300">Avg</th>
                    <th className="text-right py-1 px-3 font-medium text-neutral-300">Max</th>
                    <th className="text-right py-1 pl-3 font-medium text-neutral-300">Samples</th>
                  </tr>
                </thead>
                <tbody>
                  <StatsRow label="CV analysis (ms)" stats={stats.cv} color={CV_COLOR} />
                  <StatsRow label="Frame rate (fps)" stats={stats.fps} color={FPS_COLOR} />
                  {stats.yolo.count > 0 && (
                    <StatsRow label="YOLO T1 (ms)" stats={stats.yolo} color={YOLO_COLOR} />
                  )}
                </tbody>
              </table>
            </div>
          )}

          {/* Data duration */}
          {hasSamples && (
            <p className="text-[11px] text-neutral-600">
              {samples.length}s of data ({Math.round(samples.length / 60)}m)
            </p>
          )}

          {/* Thermal log */}
          {thermalLog.length > 0 && (
            <div>
              <label className="text-xs text-neutral-400 block mb-1">Thermal transitions</label>
              <div className="max-h-32 overflow-y-auto text-xs text-neutral-500 space-y-0.5 font-mono">
                {[...thermalLog].reverse().map((ev, i) => (
                  <div key={i}>
                    <span className="text-neutral-600">
                      {new Date(ev.ts * 1000).toLocaleTimeString()}
                    </span>
                    {" "}
                    <span className={ev.throttling ? "text-red-400" : "text-emerald-400"}>
                      {ev.throttling ? "THROTTLING" : "NORMAL"}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Thermal gauge ──
// Horizontal bar: 0× to 5.0× baseline. Green up to 1.5×, yellow 1.5–4×, red 4×+.
// The marker needle shows the current ratio.

function ThermalGauge({ ratio, throttling }: { ratio: number; throttling: boolean }) {
  // Scale: 0 to 5.0× baseline (trigger threshold: 4×)
  const maxScale = 5.0;
  const pct = Math.min(ratio / maxScale, 1) * 100;
  const hasData = ratio > 0;

  // Label
  const label = !hasData
    ? "No baseline yet"
    : ratio < 1.2
      ? "Cool"
      : ratio < 1.5
        ? "Warm"
        : ratio < 4.0
          ? "Hot"
          : "Throttling";

  // Needle color
  const needleColor = !hasData
    ? "#525252"
    : ratio < 1.5
      ? "#34d399"  // emerald-400
      : ratio < 4.0
        ? "#fbbf24"  // amber-400
        : "#f87171"; // red-400

  return (
    <div className="flex-1 min-w-0">
      <div className="flex items-center justify-between mb-1.5">
        <label className="text-xs text-neutral-400">Thermal state</label>
        <span
          className="text-xs font-medium"
          style={{ color: needleColor }}
        >
          {label}
          {hasData && ` (${ratio.toFixed(2)}x)`}
        </span>
      </div>

      {/* Bar */}
      <div className="relative h-3 rounded-full overflow-hidden bg-neutral-800">
        {/* Gradient: green → yellow → red */}
        <div
          className="absolute inset-0 rounded-full"
          style={{
            background: "linear-gradient(to right, #065f46 0%, #34d399 40%, #fbbf24 65%, #f87171 85%, #991b1b 100%)",
          }}
        />

        {/* Needle */}
        {hasData && (
          <div
            className="absolute top-0 h-full w-0.5 bg-white shadow-[0_0_4px_rgba(255,255,255,0.6)]"
            style={{ left: `${pct}%`, transition: "left 0.5s ease-out" }}
          />
        )}
      </div>

      {/* Scale ticks */}
      <div className="flex justify-between mt-0.5 text-[10px] text-neutral-600 font-mono px-0.5">
        <span>1.0x</span>
        <span>2.0x</span>
        <span>3.0x</span>
        <span>4.0x</span>
      </div>
    </div>
  );
}

// ── Chart drawing ──

function drawChart(ctx: CanvasRenderingContext2D, samples: PerfSample[], scale: TimeScale = "10m"): void {
  const w = CHART_W;
  const h = CHART_H;

  ctx.clearRect(0, 0, w, h);

  // Find ranges
  let maxCv = 0;
  let maxFps = 0;
  for (const s of samples) {
    if (s.cvMs > maxCv) maxCv = s.cvMs;
    if (s.frameCount > maxFps) maxFps = s.frameCount;
    if (s.yoloMs !== null && s.yoloMs > maxCv) maxCv = s.yoloMs;
    if (s.worldMs !== null && s.worldMs > maxCv) maxCv = s.worldMs;
  }
  // Add headroom
  maxCv = Math.max(maxCv * 1.2, 10);
  maxFps = Math.max(maxFps * 1.2, 10);

  const xScale = PLOT_W / Math.max(samples.length - 1, 1);
  const toX = (i: number) => PADDING.left + i * xScale;
  const toCvY = (v: number) => PADDING.top + PLOT_H - (v / maxCv) * PLOT_H;
  const toFpsY = (v: number) => PADDING.top + PLOT_H - (v / maxFps) * PLOT_H;

  // Draw throttling background bands
  for (let i = 0; i < samples.length; i++) {
    if (samples[i].throttling) {
      ctx.fillStyle = THROTTLE_BG;
      ctx.fillRect(toX(i) - xScale / 2, PADDING.top, xScale, PLOT_H);
    }
  }

  // Grid lines (horizontal)
  ctx.strokeStyle = GRID_COLOR;
  ctx.lineWidth = 0.5;
  for (let i = 0; i <= 4; i++) {
    const y = PADDING.top + (PLOT_H / 4) * i;
    ctx.beginPath();
    ctx.moveTo(PADDING.left, y);
    ctx.lineTo(PADDING.left + PLOT_W, y);
    ctx.stroke();

    // Left axis labels (ms)
    ctx.fillStyle = TEXT_COLOR;
    ctx.font = "10px monospace";
    ctx.textAlign = "right";
    const msLabel = Math.round(maxCv * (1 - i / 4));
    ctx.fillText(`${msLabel}`, PADDING.left - 6, y + 3);

    // Right axis labels (fps)
    ctx.textAlign = "left";
    const fpsLabel = Math.round(maxFps * (1 - i / 4));
    ctx.fillText(`${fpsLabel}`, PADDING.left + PLOT_W + 6, y + 3);
  }

  // Axis labels
  ctx.fillStyle = CV_COLOR;
  ctx.font = "9px monospace";
  ctx.textAlign = "right";
  ctx.fillText("ms", PADDING.left - 6, PADDING.top - 6);
  ctx.fillStyle = FPS_COLOR;
  ctx.textAlign = "left";
  ctx.fillText("fps", PADDING.left + PLOT_W + 6, PADDING.top - 6);

  // Time labels on bottom axis
  ctx.fillStyle = TEXT_COLOR;
  ctx.textAlign = "center";
  ctx.font = "9px monospace";
  const labelCount = Math.min(6, samples.length);
  for (let i = 0; i < labelCount; i++) {
    const idx = Math.round((i / (labelCount - 1)) * (samples.length - 1));
    const x = toX(idx);
    const sec = samples[idx].ts;
    const d = new Date(sec * 1000);
    const hh = d.getHours().toString().padStart(2, "0");
    const mm = d.getMinutes().toString().padStart(2, "0");
    const ss = d.getSeconds().toString().padStart(2, "0");
    const timeLabel = scale === "24h" ? `${hh}:${mm}` : `${hh}:${mm}:${ss}`;
    ctx.fillText(timeLabel, x, PADDING.top + PLOT_H + 16);
  }

  // Draw CV analysis line
  ctx.strokeStyle = CV_COLOR;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  for (let i = 0; i < samples.length; i++) {
    const x = toX(i);
    const y = toCvY(samples[i].cvMs);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();

  // Draw FPS line
  ctx.strokeStyle = FPS_COLOR;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  for (let i = 0; i < samples.length; i++) {
    const x = toX(i);
    const y = toFpsY(samples[i].frameCount);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();

  // Draw YOLO inference dots
  for (let i = 0; i < samples.length; i++) {
    if (samples[i].yoloMs !== null) {
      ctx.fillStyle = YOLO_COLOR;
      ctx.beginPath();
      ctx.arc(toX(i), toCvY(samples[i].yoloMs!), 3, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // ── Thermal ratio strip ──
  // Color-coded bar below the main chart showing thermal danger over time.
  const stripTop = PADDING.top + PLOT_H + THERMAL_GAP + 20; // 20 = space for time labels
  const stripH = THERMAL_STRIP_H;
  const barW = Math.max(xScale, 1);

  // Background
  ctx.fillStyle = "#1a1a1a";
  ctx.fillRect(PADDING.left, stripTop, PLOT_W, stripH);

  // Label
  ctx.fillStyle = TEXT_COLOR;
  ctx.font = "9px monospace";
  ctx.textAlign = "right";
  ctx.fillText("thermal", PADDING.left - 6, stripTop + stripH / 2 + 3);

  // Threshold labels on right
  ctx.textAlign = "left";
  ctx.fillStyle = "#666";
  ctx.fillText("5.0x", PADDING.left + PLOT_W + 6, stripTop + stripH / 2 + 3);

  for (let i = 0; i < samples.length; i++) {
    const ratio = samples[i].thermalRatio;
    if (!ratio || ratio === 0) continue;
    const x = toX(i) - barW / 2;

    // Color: green → yellow → red mapped to 0.5–2.5
    ctx.fillStyle = ratioToColor(ratio);
    ctx.fillRect(x, stripTop, barW + 0.5, stripH);
  }

  // Draw threshold lines at 1.5x and 4.0x
  const ratio1_5 = 1.5 / 5.0; // position within strip
  const ratio2_0 = 4.0 / 5.0;
  ctx.strokeStyle = "rgba(255,255,255,0.2)";
  ctx.lineWidth = 0.5;
  ctx.setLineDash([3, 3]);
  // Vertical reference lines aren't meaningful here — draw as thin horizontal markers at edges
  // Instead, we'll just outline the strip
  ctx.setLineDash([]);
  ctx.strokeStyle = "#333";
  ctx.lineWidth = 0.5;
  ctx.strokeRect(PADDING.left, stripTop, PLOT_W, stripH);
}

/** Map thermal ratio to a green→yellow→red color. Trigger threshold: 4.0×. */
function ratioToColor(ratio: number): string {
  if (ratio <= 1.5) {
    // Green → Yellow (0.5x–1.5x)
    const t = Math.max(0, (ratio - 0.5) / 1.0); // 0 at 0.5x, 1 at 1.5x
    const g = Math.round(209 - t * 80);  // 209 → 129
    const r = Math.round(6 + t * 245);   // 6 → 251
    return `rgb(${r},${g},52)`;
  }
  if (ratio < 4.0) {
    // Yellow → Orange (1.5x–4.0x)
    const t = (ratio - 1.5) / 2.5; // 0 at 1.5x, 1 at 4.0x
    const g = Math.round(129 - t * 100); // 129 → 29
    return `rgb(251,${g},36)`;
  }
  // Red (4.0x+)
  return `rgb(248,29,36)`;
}

// ── Small helper components ──

function LegendItem({ color, label, dot }: { color: string; label: string; dot?: boolean }) {
  return (
    <div className="flex items-center gap-1.5 text-neutral-400">
      {dot ? (
        <span className="w-2 h-2 rounded-full" style={{ backgroundColor: color }} />
      ) : (
        <span className="w-4 h-0.5 rounded" style={{ backgroundColor: color }} />
      )}
      {label}
    </div>
  );
}

function StatsRow({ label, stats, color }: { label: string; stats: PerfStats; color: string }) {
  return (
    <tr className="border-b border-neutral-800/50">
      <td className="py-1 pr-4" style={{ color }}>{label}</td>
      <td className="text-right py-1 px-3">{stats.min}</td>
      <td className="text-right py-1 px-3">{stats.avg}</td>
      <td className="text-right py-1 px-3">{stats.max}</td>
      <td className="text-right py-1 pl-3 text-neutral-600">{stats.count}</td>
    </tr>
  );
}
