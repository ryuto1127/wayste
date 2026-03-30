"use client";

import { useRef, useEffect, useCallback, useState } from "react";
import type {
  ClassificationResponse,
  PipelineState,
  FrameAnalysis,
  ClassifyMeta,
} from "@/lib/types";
import type { Locale } from "@/lib/i18n";
import { t } from "@/lib/i18n";
import { cacheResult } from "@/lib/offline-cache";
import {
  FrameAnalyzer,
  imageQualityBand,
  ROI_FG_THRESHOLD,
  MOTION_RATIO_THRESHOLD,
} from "@/lib/frame-analyzer";
import CameraFeed, { type CameraFeedHandle } from "./CameraFeed";
import LiveOverlay from "./LiveOverlay";

// ── Timing constants ──
const ANALYSIS_INTERVAL_MS = 100; // ~10 fps local CV
const STABILITY_REQUIRED = 4; // quality frames needed in stabilizing to trigger classification
/**
 * Escape hatch: if stabilizing has run this many total frames without accumulating
 * STABILITY_REQUIRED quality frames (heavy hand occlusion, persistent motion), classify
 * anyway with what we have. Prevents the user from being stuck in "stabilizing" forever.
 */
const STABILIZING_MAX_FRAMES = 28; // ~4.2s at 7fps
const COOLDOWN_MS = 1500; // pause before re-scanning
const OBJECT_GONE_FRAMES = 2;     // frames below ROI threshold before "gone" (~0.3s at 7fps)
const FG_PERSIST_FRAMES = 3;      // consecutive ROI-blob frames required to leave idle
const OBJECT_DETECTED_TIMEOUT = 8; // frames in object_detected before forcing to stabilizing
/**
 * If the result state persists for this long with the object still visible
 * (e.g., a tissue leftover that never leaves), force a transition to cooldown
 * so the BG model gets a full-rate update window in idle.
 * Set high so the result stays on screen long enough for the user to read and
 * give feedback — the primary dismiss path is item removal (OBJECT_GONE_FRAMES).
 */
const RESULT_TIMEOUT_MS = 30_000;
/** Minimum time an error message is visible before being cleared. */
const ERROR_HOLD_MS = 4_000;
/** Abort API call if it takes longer than this. */
const API_TIMEOUT_MS = 8_000;
/** Retry delay after a 429 rate-limit response. */
const RATE_LIMIT_RETRY_MS = 1_200;

// ── Background adaptation rates (passed to FrameAnalyzer per pipeline state) ──
// idle / cooldown: full rate — continuously absorb drift and persistent leftovers
const BG_RATE_IDLE = 0.015; // matches BG_LEARN_RATE in frame-analyzer
// result: micro rate — slowly absorbs stuck items without corrupting live objects
const BG_RATE_RESULT = 0.001;
// object_detected / stabilizing / classifying: frozen — never absorb the held object
const BG_RATE_FROZEN = 0;

// ── Entry coherence gate ──
// The largest single connected blob in the eroded ROI mask must cover ≥5% of the ROI.
// Prevents scattered noise patches that sum above ROI_FG_THRESHOLD from triggering entry.
const ROI_BLOB_THRESHOLD = 0.05;

// ── Elongated-object gate ──
// The largest blob's bounding-box diagonal as a fraction of the ROI diagonal.
// Detects thin objects (pens, straws, chopsticks) whose pixel area is too
// small to pass ROI_FG_THRESHOLD or ROI_BLOB_THRESHOLD.
// 0.35 ≈ a pen held diagonally across ~35% of the ROI width+height.
// Does NOT replace the area gates — it is an OR condition alongside them.
// Also requires a minimum blob area (ROI_BLOB_DIAGONAL_MIN_AREA) to prevent
// diffuse noise patches from triggering detection via diagonal alone.
const ROI_BLOB_DIAGONAL_THRESHOLD = 0.35;
const ROI_BLOB_DIAGONAL_MIN_AREA = 0.01; // ~69 eroded pixels — filters noise, passes real thin objects

// ── Stabilizing motion gate ──
// A frame only counts toward classification if inter-frame motion is below this value.
// Slightly stricter than the idle isStable check (0.08) but not demanding perfect stillness.
const STABILIZE_MOTION_THRESHOLD = 0.06;

interface KioskDisplayProps {
  defaultLocale?: Locale;
}

export default function KioskDisplay({ defaultLocale }: KioskDisplayProps) {
  const cameraRef = useRef<CameraFeedHandle>(null);
  const analyzerRef = useRef<FrameAnalyzer | null>(null);

  // ── Pipeline state ──
  const stateRef = useRef<PipelineState>("idle");
  const [mounted, setMounted] = useState(false);
  const [pipelineState, setPipelineState] = useState<PipelineState>("idle");
  const [stableResult, setStableResult] =
    useState<ClassificationResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [locale, setLocale] = useState<Locale>(defaultLocale ?? "en");
  /** Track whether the user has manually toggled the language. */
  const userHasToggledRef = useRef(false);

  // ── CV counters (refs to avoid re-renders) ──
  const stableCountRef = useRef(0);
  const goneCountRef = useRef(0);
  const skinWaitRef = useRef(0);
  /** Consecutive frames with ROI blob present — must reach FG_PERSIST_FRAMES before leaving idle. */
  const fgPersistRef = useRef(0);
  /** Frames spent in object_detected with ROI blob present — triggers stabilizing after OBJECT_DETECTED_TIMEOUT. */
  const objectDetectedFrameRef = useRef(0);
  /** Total frames spent in stabilizing — escape hatch to prevent lock-out on persistent occlusion. */
  const stabilizingFramesRef = useRef(0);
  /** Timestamp when the result state was entered — used for the stuck-result timeout. */
  const resultEnterTimeRef = useRef(0);
  const cooldownStartRef = useRef(0);
  const inFlightRef = useRef(false);
  const lastAnalysisRef = useRef<FrameAnalysis | null>(null);
  const lastCachedRef = useRef("");
  /** Timestamp when error was set — used to enforce ERROR_HOLD_MS minimum visibility. */
  const errorSetAtRef = useRef(0);
  /** Mirror of `error` state as a ref so the CV interval can read it without a stale closure. */
  const errorRef = useRef<string | null>(null);

  // Prevent SSR — this component requires browser APIs (camera, OffscreenCanvas)
  useEffect(() => setMounted(true), []);

  // Fetch defaultLocale from site-config API as a fallback (handles cases where
  // the prop wasn't passed server-side).
  useEffect(() => {
    if (defaultLocale) return; // already provided via prop
    fetch("/api/site-config")
      .then((r) => r.json())
      .then((data: { defaultLocale?: string }) => {
        if (
          data.defaultLocale &&
          data.defaultLocale !== locale &&
          !userHasToggledRef.current
        ) {
          setLocale(data.defaultLocale as Locale);
        }
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep error ref in sync with state for stale-closure-safe reads inside the CV interval.
  useEffect(() => {
    errorRef.current = error;
  }, [error]);

  const T = useCallback(
    (key: Parameters<typeof t>[1]) => t(locale, key),
    [locale]
  );

  const toggleLocale = useCallback(() => {
    userHasToggledRef.current = true;
    setLocale((l) => (l === "en" ? "ja" : "en"));
  }, []);

  // ── Set pipeline state (ref + react state) ──
  const transition = useCallback((next: PipelineState) => {
    stateRef.current = next;
    setPipelineState(next);
  }, []);

  // ── API call (with timeout + 429 retry) ──
  const classify = useCallback(
    async (frame: string, meta: ClassifyMeta): Promise<ClassificationResponse> => {
      const doFetch = async (): Promise<ClassificationResponse> => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), API_TIMEOUT_MS);

        try {
          const res = await fetch("/api/classify", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ image: frame, meta, locale }),
            signal: controller.signal,
          });

          if (res.status === 429) {
            // Rate-limited — wait and retry once
            await new Promise((r) => setTimeout(r, RATE_LIMIT_RETRY_MS));
            const retryRes = await fetch("/api/classify", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ image: frame, meta, locale }),
            });
            if (!retryRes.ok) {
              const body = await retryRes.json().catch(() => ({}));
              throw new Error((body as { error?: string }).error ?? `API error: ${retryRes.status}`);
            }
            return (await retryRes.json()) as ClassificationResponse;
          }

          if (!res.ok) {
            const body = await res.json().catch(() => ({}));
            throw new Error(
              res.status === 402
                ? "API quota exceeded — add credits at platform.openai.com/settings/billing"
                : (body as { error?: string }).error ?? `API error: ${res.status}`
            );
          }

          const data = (await res.json()) as ClassificationResponse & { requestId?: string };
          if (data.requestId) {
            console.log(`[classify] requestId=${data.requestId}`);
          }
          return data;
        } finally {
          clearTimeout(timeout);
        }
      };

      return doFetch();
    },
    [locale]
  );

  // ── Main CV + state machine loop ──
  useEffect(() => {
    if (!analyzerRef.current) {
      analyzerRef.current = new FrameAnalyzer();
    }
    const analyzer = analyzerRef.current;

    const interval = setInterval(() => {
      const video = cameraRef.current?.getVideo();
      if (!video) return;

      // ── Set BG adaptation rate for this frame based on pipeline state ──
      // Must be called before analyze() so the rate takes effect immediately.
      const currentState = stateRef.current;
      const bgRate =
        currentState === "idle" || currentState === "cooldown"
          ? BG_RATE_IDLE        // full rate — absorbs drift and persistent leftovers
          : currentState === "result"
            ? BG_RATE_RESULT    // micro rate — slowly absorbs stuck objects over time
            : BG_RATE_FROZEN;   // frozen — never absorb the actively presented object
      analyzer.setBgRate(bgRate);

      const analysis = analyzer.analyze(video);
      if (!analysis) return;
      lastAnalysisRef.current = analysis;

      const state = stateRef.current;

      // Block all detection until the background model has converged.
      // During this window the UI stays in idle ("Live").
      if (!analysis.isSettled) return;

      // ROI-based blob presence: ratio threshold + coherence check.
      // Both must pass: enough total eroded foreground AND a single large blob.
      // This prevents scattered noise patches that sum above the ratio threshold
      // from triggering entry — real objects form one coherent region.
      // Thin/elongated objects (pen, straw, chopstick) have a small area but
      // a large bounding-box diagonal — detect them even if area gates fail.
      // Require a minimum blob area to prevent noise from triggering this path.
      const elongated =
        analysis.roiLargestBlobDiagonalRatio > ROI_BLOB_DIAGONAL_THRESHOLD &&
        analysis.roiLargestBlobRatio > ROI_BLOB_DIAGONAL_MIN_AREA;
      const roiHasFg =
        (analysis.roiForegroundRatio >= ROI_FG_THRESHOLD &&
         analysis.roiLargestBlobRatio >= ROI_BLOB_THRESHOLD) ||
        elongated;
      const isStable = analysis.motionScore < MOTION_RATIO_THRESHOLD;

      // ────────────────────────────────────
      // State machine transitions
      // ────────────────────────────────────

      if (state === "idle") {
        if (roiHasFg) {
          fgPersistRef.current++;
          if (fgPersistRef.current >= FG_PERSIST_FRAMES) {
            // ROI blob confirmed for FG_PERSIST_FRAMES consecutive frames.
            // BG keeps updating at BG_RATE_IDLE throughout — noise pixels (low
            // contrast) erode below FG_PIXEL_THRESHOLD and the blob fails before
            // reaching this count; real object pixels (higher contrast) survive.
            fgPersistRef.current = 0;
            stableCountRef.current = 0;
            skinWaitRef.current = 0;
            goneCountRef.current = 0;
            objectDetectedFrameRef.current = 0;
            transition("object_detected");
          }
        } else {
          fgPersistRef.current = 0;
        }
        return;
      }

      if (state === "object_detected") {
        if (!roiHasFg) {
          goneCountRef.current++;
          if (goneCountRef.current >= OBJECT_GONE_FRAMES) {
            objectDetectedFrameRef.current = 0;
            transition("idle");
          }
          return;
        }
        goneCountRef.current = 0;
        objectDetectedFrameRef.current++;

        // Fast path: a naturally stable frame — go to stabilizing immediately.
        // Timeout path: object has been present long enough without stability —
        //   transition anyway so the user is never stuck with "hold still" forever.
        if (isStable || objectDetectedFrameRef.current >= OBJECT_DETECTED_TIMEOUT) {
          stableCountRef.current = 0;
          skinWaitRef.current = 0;
          objectDetectedFrameRef.current = 0;
          stabilizingFramesRef.current = 0;
          transition("stabilizing");
        }
        return;
      }

      if (state === "stabilizing") {
        if (!roiHasFg) {
          goneCountRef.current++;
          if (goneCountRef.current >= OBJECT_GONE_FRAMES) {
            stabilizingFramesRef.current = 0;
            transition("idle");
          }
          return;
        }
        goneCountRef.current = 0;
        stabilizingFramesRef.current++;

        // Quality-gated accumulation: only count frames where the object is
        // visible enough AND not actively moving.
        //   imageQualityBand !== "poor" → sharpness OK + skin ratio acceptable
        //   motionScore < STABILIZE_MOTION_THRESHOLD → object not actively rotating/moving
        // Non-quality frames don't advance the counter but don't reset it either —
        // the user just holds a beat longer, never has to start over.
        // After STABILIZING_MAX_FRAMES total frames, classify anyway (escape hatch).
        const isQualityFrame =
          imageQualityBand(analysis) !== "poor" &&
          analysis.motionScore < STABILIZE_MOTION_THRESHOLD;
        if (isQualityFrame) {
          stableCountRef.current++;
        }

        if (
          stableCountRef.current >= STABILITY_REQUIRED ||
          stabilizingFramesRef.current >= STABILIZING_MAX_FRAMES
        ) {
          stabilizingFramesRef.current = 0;
          triggerClassification(analysis);
        }
        return;
      }

      if (state === "classifying") {
        // Wait for API response — no transitions here
        return;
      }

      if (state === "result") {
        if (!roiHasFg) {
          goneCountRef.current++;
          if (goneCountRef.current >= OBJECT_GONE_FRAMES) {
            cooldownStartRef.current = Date.now();
            transition("cooldown");
          }
        } else {
          goneCountRef.current = 0;

          // Persistent-leftover escape hatch: if a stationary object (e.g. a dropped
          // tissue) keeps the ROI occupied for RESULT_TIMEOUT_MS without the user
          // removing it, force a cooldown. This gives the BG model a full-rate update
          // window in the subsequent idle phase so the leftover is gradually absorbed.
          if (Date.now() - resultEnterTimeRef.current >= RESULT_TIMEOUT_MS) {
            setStableResult(null);
            goneCountRef.current = 0;
            cooldownStartRef.current = Date.now();
            transition("cooldown");
            return;
          }

          // Result stays until the object leaves frame (OBJECT_GONE_FRAMES) or
          // the escape-hatch timeout fires (RESULT_TIMEOUT_MS). Motion while
          // holding the item no longer resets the result.
        }
        return;
      }

      if (state === "cooldown") {
        const cooldownElapsed = Date.now() - cooldownStartRef.current >= COOLDOWN_MS;
        // If an error is showing, don't clear it until ERROR_HOLD_MS has passed
        const errorHeld = !errorRef.current || (Date.now() - errorSetAtRef.current >= ERROR_HOLD_MS);
        if (cooldownElapsed && errorHeld) {
          setStableResult(null);
          setError(null);
          transition("idle");
        }
        return;
      }
    }, ANALYSIS_INTERVAL_MS);

    return () => clearInterval(interval);

    // ── Trigger classification (called from within the loop) ──
    function triggerClassification(analysis: FrameAnalysis) {
      if (inFlightRef.current) return;

      const video = cameraRef.current?.getVideo();
      if (!video) return;

      /**
       * Crop to ROI before sending to OpenAI:
       * - Reduces payload size and API cost
       * - Focuses the model on the object in the central region
       * - Does NOT affect the local CV detection pipeline which runs
       *   on its own downscaled canvas independently
       */
      const vw = video.videoWidth;
      const vh = video.videoHeight;
      const roiX = Math.round(vw * 0.20);
      const roiY = Math.round(vh * 0.20);
      const roiW = Math.round(vw * 0.60);
      const roiH = Math.round(vh * 0.60);

      // Scale down so longest dimension is at most 640px
      const scale = Math.min(1, 640 / Math.max(roiW, roiH));
      const outW = Math.round(roiW * scale);
      const outH = Math.round(roiH * scale);

      const cropCanvas = new OffscreenCanvas(outW, outH);
      const cropCtx = cropCanvas.getContext("2d");
      if (!cropCtx) return;
      cropCtx.drawImage(video, roiX, roiY, roiW, roiH, 0, 0, outW, outH);

      // Convert to blob then base64
      cropCanvas.convertToBlob({ type: "image/jpeg", quality: 0.82 }).then((blob) => {
        const reader = new FileReader();
        reader.onloadend = () => {
          const dataUrl = reader.result as string;
          const frame = dataUrl.split(",")[1];
          if (!frame) return;

          inFlightRef.current = true;
          transition("classifying");

          const meta: ClassifyMeta = {
            skinRatio: analysis.skinRatio,
            sharpnessScore: analysis.sharpnessScore,
            imageQuality: imageQualityBand(analysis),
          };

          classify(frame, meta)
        .then((result) => {
          // If "nothing detected" came back, go through cooldown before retrying.
          // Going straight to idle would immediately re-trigger the same false
          // foreground, creating a live→detect→identify loop.
          if (
            result.itemName.toLowerCase() === "nothing detected" ||
            result.confidence === 0
          ) {
            cooldownStartRef.current = Date.now();
            transition("cooldown");
            return;
          }

          setStableResult(result);
          setError(null);
          goneCountRef.current = 0;
          resultEnterTimeRef.current = Date.now();
          transition("result");

          // Cache high-confidence results
          const cacheKey = `${result.itemName}::${result.wasteStream}`;
          if (cacheKey !== lastCachedRef.current) {
            cacheResult(result);
            lastCachedRef.current = cacheKey;
          }
        })
        .catch((err) => {
          const msg = err instanceof DOMException && err.name === "AbortError"
            ? T("connectionSlow")
            : T("classificationFailed");
          console.warn("[classify] API error:", err);
          setError(msg);
          errorSetAtRef.current = Date.now();
          // Stay in cooldown so the error is visible for ERROR_HOLD_MS
          cooldownStartRef.current = Date.now();
          transition("cooldown");
        })
        .finally(() => {
          inFlightRef.current = false;
        });
        };
        reader.readAsDataURL(blob);
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [classify, transition, T]);

  const handleFeedbackGiven = useCallback(() => {
    // After feedback, reset so user can scan next item
    setStableResult(null);
    cooldownStartRef.current = Date.now();
    transition("cooldown");
  }, [transition]);

  /** Reset the background model and return to idle — useful during testing
   *  if a persistent leftover has not yet been auto-absorbed. */
  const handleRecalibrate = useCallback(() => {
    analyzerRef.current?.reset();
    setStableResult(null);
    setError(null);
    fgPersistRef.current = 0;
    stableCountRef.current = 0;
    goneCountRef.current = 0;
    objectDetectedFrameRef.current = 0;
    stabilizingFramesRef.current = 0;
    inFlightRef.current = false;
    transition("idle");
  }, [transition]);

  // ── Derive UI signals from pipeline state ──
  if (!mounted) return null;
  const scanning = pipelineState === "classifying";
  const unstable =
    pipelineState === "object_detected" || pipelineState === "stabilizing";

  return (
    <div className="h-screen w-screen bg-neutral-950 flex overflow-hidden select-none">
      {/* Left: Camera feed */}
      <div className="relative flex-1 h-full">
        <CameraFeed
          ref={cameraRef}
          mirror={process.env.NEXT_PUBLIC_MIRROR_CAMERA === "true"}
        />

        {/* Status indicator */}
        <div className="absolute top-6 left-6 flex items-center gap-2">
          <span className="relative flex h-3 w-3">
            {scanning ? (
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75" />
            ) : pipelineState === "result" ? (
              <span className="absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-50" />
            ) : (
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
            )}
            <span
              className={`relative inline-flex rounded-full h-3 w-3 ${
                scanning
                  ? "bg-amber-500"
                  : pipelineState === "result"
                    ? "bg-emerald-500"
                    : pipelineState === "object_detected" ||
                        pipelineState === "stabilizing"
                      ? "bg-blue-500"
                      : "bg-emerald-500"
              }`}
            />
          </span>
          <span className="text-sm text-white/70 font-medium">
            {scanning
              ? T("identifyingItem")
              : pipelineState === "object_detected" ||
                  pipelineState === "stabilizing"
                ? T("itemDetected")
                : pipelineState === "result"
                  ? T("detectedItem")
                  : T("live")}
          </span>
        </div>

        {/* Hold steady prompt */}
        {unstable && !stableResult && (
          <div className="absolute bottom-6 left-1/2 -translate-x-1/2">
            <div className="bg-amber-900/80 backdrop-blur-sm rounded-xl px-5 py-2.5">
              <p className="text-amber-200 text-sm font-medium">
                {T("holdForScan")}
              </p>
            </div>
          </div>
        )}

        {/* Corner scan markers */}
        <div className="absolute inset-12 pointer-events-none">
          <div
            className={`absolute top-0 left-0 w-10 h-10 border-t-2 border-l-2 rounded-tl-lg transition-colors duration-300 ${
              unstable
                ? "border-blue-400/60"
                : pipelineState === "classifying"
                  ? "border-amber-400/60"
                  : pipelineState === "result"
                    ? "border-emerald-400/80"
                    : "border-emerald-400/60"
            }`}
          />
          <div
            className={`absolute top-0 right-0 w-10 h-10 border-t-2 border-r-2 rounded-tr-lg transition-colors duration-300 ${
              unstable
                ? "border-blue-400/60"
                : pipelineState === "classifying"
                  ? "border-amber-400/60"
                  : pipelineState === "result"
                    ? "border-emerald-400/80"
                    : "border-emerald-400/60"
            }`}
          />
          <div
            className={`absolute bottom-0 left-0 w-10 h-10 border-b-2 border-l-2 rounded-bl-lg transition-colors duration-300 ${
              unstable
                ? "border-blue-400/60"
                : pipelineState === "classifying"
                  ? "border-amber-400/60"
                  : pipelineState === "result"
                    ? "border-emerald-400/80"
                    : "border-emerald-400/60"
            }`}
          />
          <div
            className={`absolute bottom-0 right-0 w-10 h-10 border-b-2 border-r-2 rounded-br-lg transition-colors duration-300 ${
              unstable
                ? "border-blue-400/60"
                : pipelineState === "classifying"
                  ? "border-amber-400/60"
                  : pipelineState === "result"
                    ? "border-emerald-400/80"
                    : "border-emerald-400/60"
            }`}
          />
        </div>
      </div>

      {/* Right: Live classification panel */}
      <div className="w-[420px] h-full bg-neutral-900 border-l border-neutral-800 flex flex-col">
        <LiveOverlay
          result={stableResult}
          error={error}
          pipelineState={pipelineState}
          onFeedbackGiven={handleFeedbackGiven}
          locale={locale}
          onToggleLocale={toggleLocale}
        />
      </div>
    </div>
  );
}
