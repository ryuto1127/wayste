"use client";

/**
 * Continuous-mode live view: persistent camera feed with detection
 * annotations (bounding boxes + labels) and a bottom rail of compact
 * result cards. Replaces the idle → camera → result full-screen flow —
 * one stable screen where boxes and cards appear/disappear smoothly.
 *
 * Coordinates: continuous mode runs YOLO on the FULL video frame,
 * letterboxed into the 640×640 model input. Track bboxes (model space) are
 * mapped back to video-normalized coords, then positioned inside a
 * container that reproduces the camera's object-cover geometry — so boxes
 * land on the item everywhere in the frame, edge to edge.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TrackedResult, StreamDefinition, BinPosition } from "@/lib/types";
import type { Locale, TranslationKey } from "@/lib/i18n";
import { t } from "@/lib/i18n";
import { letterboxedBboxToVideoNorm } from "@/lib/bbox-utils";
import { positionArrowKey } from "./ResultScreen";

/** Left-to-right ordering of physical bin positions for the bin-map strip. */
const POSITION_ORDER: Record<BinPosition, number> = {
  "far-left": 0,
  "left": 1,
  "center": 2,
  "right": 3,
  "far-right": 4,
};

/** Height (px) of the bin-map strip at the bottom edge. */
const BIN_STRIP_HEIGHT = 92;

/** Track the rendered size of the root element (guide lines need pixel
 *  coordinates that span the video overlay and the bin strip). */
function useElementSize(): [React.RefObject<HTMLDivElement | null>, { w: number; h: number }] {
  const ref = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    const ro = new ResizeObserver(update);
    ro.observe(el);
    update();
    return () => ro.disconnect();
  }, []);
  return [ref, size];
}

/** Geometry of the object-cover video display inside a w×h viewport. */
function coverGeometry(w: number, h: number, aspect: number) {
  if (w <= 0 || h <= 0 || !(aspect > 0)) return { offX: 0, offY: 0, vw: w, vh: h };
  let vw: number, vh: number;
  if (w / h > aspect) {
    vw = w;
    vh = w / aspect;
  } else {
    vh = h;
    vw = h * aspect;
  }
  return { offX: (w - vw) / 2, offY: (h - vh) / 2, vw, vh };
}

/** Nudge vector per bin position — the arrow bounces along its own
 *  pointing direction (matches the ← ↙ ↓ ↘ → glyph convention). */
const POSITION_NUDGE: Record<BinPosition, { x: string; y: string }> = {
  "far-left": { x: "-10px", y: "0px" },
  "left": { x: "-7px", y: "7px" },
  "center": { x: "0px", y: "10px" },
  "right": { x: "7px", y: "7px" },
  "far-right": { x: "10px", y: "0px" },
};

/** Minimal per-track view model passed from the continuous pipeline. */
export interface LiveTrackView {
  id: number;
  /** bbox in YOLO 640-space [x, y, w, h]. */
  bbox: [number, number, number, number];
  /** True while unconfirmed — rendered as a neutral dashed box. */
  tentative: boolean;
  /** Localized item name once a result card exists for this track. */
  label: string | null;
  /** Bin color once resolved (null → neutral/amber styling). */
  color: string | null;
  /** Resolved waste-stream id — the bin map draws a guide line to it. */
  streamId: string | null;
  confidence: number;
}

interface LiveDetectionViewProps {
  tracks: LiveTrackView[];
  results: TrackedResult[];
  /** Stream definitions — physical bin positions for the direction arrows. */
  streams: StreamDefinition[];
  locale: Locale;
  /** Whether the camera feed is horizontally mirrored. */
  mirror: boolean;
  /** Draw bounding boxes + labels (annotation/demo mode). */
  showOverlay: boolean;
  /** Persistent bin-map strip + item→bin guide lines. */
  showBinMap: boolean;
  /** Camera aspect ratio (videoWidth / videoHeight). */
  videoAspect: number;
}

/** Video-normalized bbox (0–1 within the full frame), mirror-corrected. */
function normBox(
  track: LiveTrackView,
  mirror: boolean,
  videoAspect: number,
): [number, number, number, number] {
  // computeLetterbox is scale invariant — (aspect, 1) ≡ real pixel dims.
  const [nx, ny, nw, nh] = letterboxedBboxToVideoNorm(track.bbox, videoAspect, 1);
  return [mirror ? 1 - nx - nw : nx, ny, nw, nh];
}

function boxStyle(
  track: LiveTrackView,
  norm: [number, number, number, number],
): React.CSSProperties {
  const [nx, ny, nw, nh] = norm;
  return {
    left: `${nx * 100}%`,
    top: `${ny * 100}%`,
    width: `${nw * 100}%`,
    height: `${nh * 100}%`,
    borderColor: track.color ?? (track.tentative ? "rgba(255,255,255,0.55)" : "#F59E0B"),
    borderStyle: track.tentative ? "dashed" : "solid",
  };
}

export default function LiveDetectionView({
  tracks,
  results,
  streams,
  locale,
  mirror,
  showOverlay,
  showBinMap,
  videoAspect,
}: LiveDetectionViewProps) {
  const T = useCallback((key: TranslationKey) => t(locale, key), [locale]);
  const [rootRef, rootSize] = useElementSize();

  const idle = tracks.length === 0 && results.length === 0;

  /** Physical bins, ordered left → right as they stand in the room. */
  const physicalBins = useMemo(
    () =>
      streams
        .filter((s) => s.position)
        .sort((a, b) => POSITION_ORDER[a.position!] - POSITION_ORDER[b.position!]),
    [streams],
  );
  /** Every bin a displayed item involves. A compound item (bottle → body /
   *  cap / label) sends parts to SEVERAL bins, so lighting only its primary
   *  stream would tell the user half the answer. */
  const activeStreams = useMemo(() => {
    const set = new Set<string>();
    for (const r of results) {
      set.add(r.wasteStream as string);
      if (r.isCompound && r.components) {
        for (const c of r.components) set.add(c.wasteStream as string);
      }
    }
    return set;
  }, [results]);

  /** Streams each track routes to — one guide line per destination bin. */
  const streamsForTrack = useMemo(() => {
    const map = new Map<number, string[]>();
    for (const r of results) {
      const ids = [r.wasteStream as string];
      if (r.isCompound && r.components) {
        for (const c of r.components) {
          const id = c.wasteStream as string;
          if (!ids.includes(id)) ids.push(id);
        }
      }
      map.set(r._trackId, ids);
    }
    return map;
  }, [results]);

  /** Bottom offset for cards / hint — sits above the strip when it's shown. */
  const railBottom = showBinMap && physicalBins.length > 0 ? BIN_STRIP_HEIGHT + 20 : 32;
  const binMapVisible = showBinMap && physicalBins.length > 0;

  return (
    <div ref={rootRef} className="absolute inset-0 z-10 pointer-events-none select-none">
      {/* ── Annotation overlay: full-frame coverage. The inner div
             reproduces the camera's object-cover geometry (fixed aspect,
             min-w/min-h full, centered) so video-normalized boxes land
             exactly on the displayed pixels. ── */}
      {showOverlay && (
        <div className="absolute inset-0 overflow-hidden">
          <div
            className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 min-w-full min-h-full"
            style={{ aspectRatio: `${videoAspect}` }}
          >
            {tracks.map((track) => {
              const norm = normBox(track, mirror, videoAspect);
              const labelInsideBox = norm[1] < 0.08; // no room above → chip inside
              return (
                <div
                  key={track.id}
                  className="absolute border-[3px] rounded-xl transition-all duration-75 ease-linear"
                  style={boxStyle(track, norm)}
                >
                  <div
                    className={`absolute ${labelInsideBox ? "top-1.5 left-1.5" : "-top-9 left-0"} flex items-baseline gap-2 bg-neutral-950/80 backdrop-blur-sm rounded-lg px-3 py-1 whitespace-nowrap`}
                  >
                    <span className="text-white text-base font-semibold">
                      {track.label ?? T("detecting")}
                    </span>
                    <span className="text-neutral-400 text-xs font-mono">
                      {Math.round(track.confidence * 100)}%
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ── Guide lines: detected item → target bin slot (flowing dashes) ── */}
      {binMapVisible && rootSize.w > 0 && (
        <svg
          className="absolute inset-0 w-full h-full"
          viewBox={`0 0 ${rootSize.w} ${rootSize.h}`}
          aria-hidden="true"
        >
          {tracks.flatMap((track) => {
            // A compound item draws one line per destination bin.
            const destIds = streamsForTrack.get(track.id)
              ?? (track.streamId ? [track.streamId] : []);
            const [nx, ny, nw, nh] = normBox(track, mirror, videoAspect);
            const g = coverGeometry(rootSize.w, rootSize.h, videoAspect);
            const x1 = g.offX + (nx + nw / 2) * g.vw;
            const y1 = g.offY + (ny + nh) * g.vh;
            const y2 = rootSize.h - BIN_STRIP_HEIGHT + 12;
            return destIds.flatMap((id, i) => {
              const binIdx = physicalBins.findIndex((s) => s.id === id);
              if (binIdx < 0) return [];
              const x2 = ((binIdx + 0.5) / physicalBins.length) * rootSize.w;
              const midY = (y1 + y2) / 2;
              return [
                <path
                  key={`${track.id}-${id}`}
                  d={`M ${x1} ${y1} C ${x1} ${midY}, ${x2} ${midY}, ${x2} ${y2}`}
                  fill="none"
                  stroke={physicalBins[binIdx].color}
                  strokeWidth={i === 0 ? 4 : 3}
                  strokeLinecap="round"
                  strokeDasharray="4 14"
                  opacity={i === 0 ? 0.9 : 0.65}
                  style={{ animation: "dashFlow 0.5s linear infinite" }}
                />,
              ];
            });
          })}
        </svg>
      )}

      {/* ── Idle hint — nothing in view ── */}
      {idle && (
        <div
          className="absolute left-1/2 -translate-x-1/2"
          style={{ bottom: railBottom + 8 }}
        >
          <div className="bg-neutral-900/70 backdrop-blur-sm rounded-2xl px-7 py-3.5">
            <p className="text-neutral-100 text-xl font-medium">{T("liveHint")}</p>
          </div>
        </div>
      )}

      {/* ── Bottom result rail — the ACTION is the hero: a large animated
             arrow pointing at the physical bin + the bin name in its color.
             The item name is supporting detail, small underneath. ── */}
      {results.length > 0 && (
        <div
          className="absolute inset-x-0 flex justify-center items-end gap-4 px-6 animate-[fadeIn_0.2s_ease-out]"
          style={{ bottom: railBottom }}
        >
          {results.map((r) => {
            const position = streams.find((s) => s.id === r.wasteStream)?.position;
            const arrow = position ? T(positionArrowKey[position]) : null;
            const nudge = position ? POSITION_NUDGE[position] : null;
            return (
              <div
                key={r._trackId}
                className="flex items-center gap-5 bg-neutral-900/85 backdrop-blur-md rounded-2xl px-6 py-4 max-w-md shadow-xl border-l-[6px]"
                style={{ borderLeftColor: r.binColor }}
              >
                {arrow && (
                  <span
                    aria-hidden="true"
                    className="text-7xl font-bold leading-none shrink-0"
                    style={{
                      color: r.binColor,
                      animation: "arrowNudge 1s ease-in-out infinite",
                      "--nudge-x": nudge!.x,
                      "--nudge-y": nudge!.y,
                    } as React.CSSProperties}
                  >
                    {arrow}
                  </span>
                )}
                <div className="min-w-0">
                  <p className="text-4xl font-bold leading-tight" style={{ color: r.binColor }}>
                    {r.binLabel}
                  </p>
                  <p className="text-neutral-300 text-base mt-1 truncate">{r.itemName}</p>
                  {(r.specialInstructions ?? r.preAction ?? (r.needsReview ? r.reasoning : undefined)) && (
                    <p className="text-neutral-400 text-sm mt-0.5 leading-snug line-clamp-2">
                      {r.specialInstructions ?? r.preAction ?? r.reasoning}
                    </p>
                  )}
                  {/* Compound item: one piece of waste, several destinations —
                      each part with its own stream color and bin name. */}
                  {r.isCompound && r.components && r.components.length > 0 && (
                    <div className="mt-2 flex flex-col gap-1.5">
                      {r.components.map((c, i) => {
                        const cStream = streams.find((s) => s.id === c.wasteStream);
                        const cPos = cStream?.position;
                        const cArrow = cPos ? T(positionArrowKey[cPos]) : null;
                        return (
                          <div key={i} className="flex items-center gap-2 text-base leading-snug">
                            {/* Each part carries its own direction — a compound
                                item is several journeys, not one. */}
                            <span
                              aria-hidden="true"
                              className="text-2xl font-bold leading-none w-6 text-center shrink-0"
                              style={{ color: cStream?.color ?? "#a3a3a3" }}
                            >
                              {cArrow ?? "•"}
                            </span>
                            <span className="text-neutral-100 font-semibold whitespace-nowrap">
                              {c.partName}
                            </span>
                            <span
                              className="font-bold truncate"
                              style={{ color: cStream?.color ?? "#a3a3a3" }}
                            >
                              {cStream?.label ?? c.wasteStream}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* ── Bin-map strip: the physical bin row, target bin lit ── */}
      {binMapVisible && (
        <div
          className="absolute bottom-0 inset-x-0 flex items-stretch bg-neutral-950/75 backdrop-blur-md border-t border-white/10"
          style={{ height: BIN_STRIP_HEIGHT }}
        >
          {physicalBins.map((s) => {
            const active = activeStreams.has(s.id as string);
            const dimmed = results.length > 0 && !active;
            return (
              <div
                key={s.id as string}
                className={`flex-1 flex flex-col items-center justify-center gap-1.5 transition-opacity duration-300 ${
                  active ? "opacity-100" : dimmed ? "opacity-30" : "opacity-70"
                }`}
              >
                <div
                  className={`w-12 h-7 rounded-t-md rounded-b-lg transition-transform duration-300 ${
                    active ? "scale-110" : ""
                  }`}
                  style={{
                    backgroundColor: s.color,
                    animation: active ? "binPulse 1.2s ease-in-out infinite" : undefined,
                    "--pulse-color": `${s.color}99`,
                  } as React.CSSProperties}
                />
                <span className={`text-sm font-bold ${active ? "text-white" : "text-neutral-300"}`}>
                  {s.label}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
