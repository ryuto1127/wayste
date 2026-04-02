"use client";

import { useRef, useEffect, useCallback, useState } from "react";
import type {
  ClassificationResponse,
  PipelineState,
  FrameAnalysis,
  ClassifyMeta,
  SiteConfig,
} from "@/lib/types";
import type { Locale } from "@/lib/i18n";
import { t } from "@/lib/i18n";
import { cacheResult } from "@/lib/offline-cache";
import {
  FrameAnalyzer,
  imageQualityBand,
  ROI_FG_THRESHOLD,
} from "@/lib/frame-analyzer";
import { initYolo, isYoloReady, runYoloInference, warmUpYolo } from "@/lib/yolo-inference";
import { loadYoloRules, resolveYoloDetection } from "@/lib/yolo-rules";
import CameraFeed, { type CameraFeedHandle } from "./CameraFeed";
import LiveOverlay from "./LiveOverlay";

// ── Timing constants ──
const ANALYSIS_INTERVAL_MS = 100; // ~10 fps local CV
const COOLDOWN_MS = 1500; // pause before re-scanning
const OBJECT_GONE_FRAMES = 2;     // frames below ROI threshold before "gone" (~0.3s at 7fps)
/**
 * Minimum time the result panel stays on screen after a classification, even if
 * the object is removed immediately. Gives users enough time to read the result
 * before it disappears.
 */
const RESULT_MIN_DISPLAY_MS = 4_000;
const FG_PERSIST_FRAMES = 2;      // consecutive ROI-blob frames required to leave idle
/** Sharp frames (sharpnessScore > 150) in object_detected before triggering classification. */
const SHARP_FRAMES_REQUIRED = 2;
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
const API_TIMEOUT_MS = 15_000;
/** Retry delay after a 429 rate-limit response. */
const RATE_LIMIT_RETRY_MS = 1_200;

// ── Background adaptation rates (passed to FrameAnalyzer per pipeline state) ──
// idle / cooldown: full rate — continuously absorb drift and persistent leftovers
const BG_RATE_IDLE = 0.025; // matches BG_LEARN_RATE in frame-analyzer
// result: micro rate — slowly absorbs stuck items without corrupting live objects
const BG_RATE_RESULT = 0.001;
// object_detected / classifying: frozen — never absorb the held object
const BG_RATE_FROZEN = 0;

// ── Capture ROI (fraction of frame, applied to both image capture and scan frame UI) ──
const CAPTURE_ROI_MARGIN = 0.15; // 15% margin on each side → 70% of frame sent to model

// ── Entry coherence gate ──
// The largest single connected blob in the eroded ROI mask must cover ≥5% of the ROI.
// Prevents scattered noise patches that sum above ROI_FG_THRESHOLD from triggering entry.
const ROI_BLOB_THRESHOLD = 0.03;

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
  const [resultRequestId, setResultRequestId] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [locale, setLocale] = useState<Locale>(defaultLocale ?? "en");
  /** Track whether the user has manually toggled the language. */
  const userHasToggledRef = useRef(false);

  // ── CV counters (refs to avoid re-renders) ──
  const goneCountRef = useRef(0);
  /** Consecutive frames with ROI blob present — must reach FG_PERSIST_FRAMES before leaving idle. */
  const fgPersistRef = useRef(0);
  /** Set when a new foreground blob is detected while the pipeline is busy (non-idle).
   *  Consumed at the cooldown→idle transition to skip idle and fast-path to object_detected. */
  const pendingItemRef = useRef(false);
  /** Sharp frames accumulated in object_detected — triggers classification after SHARP_FRAMES_REQUIRED. */
  const objectDetectedFrameRef = useRef(0);
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

  /** Site config fetched from the API — used for client-side rule application with YOLO. */
  const siteConfigRef = useRef<SiteConfig | null>(null);

  // Prevent SSR — this component requires browser APIs (camera, OffscreenCanvas)
  useEffect(() => setMounted(true), []);

  // ── Initialize YOLO model + rules + site config (client-side) ──
  useEffect(() => {
    // Load YOLO model, rules, and site config in parallel.
    // Failures are non-fatal — the pipeline falls back to the API.
    Promise.all([
      initYolo().then((loaded) => { if (loaded) return warmUpYolo(); }),
      loadYoloRules(),
      fetch("/api/site-config")
        .then((r) => r.json())
        .then((data: SiteConfig) => {
          siteConfigRef.current = data;
        })
        .catch(() => {}),
    ]);
  }, []);

  // Fetch defaultLocale from site-config API as a fallback (handles cases where
  // the prop wasn't passed server-side). The YOLO init useEffect above also
  // fetches site-config and stores the full config in siteConfigRef.
  useEffect(() => {
    if (defaultLocale) return; // already provided via prop
    // Wait briefly for the YOLO init fetch to populate siteConfigRef
    const check = () => {
      const cfg = siteConfigRef.current;
      if (cfg?.defaultLocale && cfg.defaultLocale !== locale && !userHasToggledRef.current) {
        setLocale(cfg.defaultLocale as Locale);
      }
    };
    // If site config is already loaded, use it; otherwise fetch
    if (siteConfigRef.current) {
      check();
    } else {
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
    }
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
    async (frame: string, meta: ClassifyMeta): Promise<ClassificationResponse & { requestId?: string }> => {
      const doFetch = async (): Promise<ClassificationResponse & { requestId?: string }> => {
        const fetchStartMs = Date.now();
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), API_TIMEOUT_MS);

        try {
          const res = await fetch("/api/classify", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ image: frame, meta, locale }),
            signal: controller.signal,
          });
          const fetchDoneMs = Date.now() - fetchStartMs;

          if (res.status === 429) {
            // Rate-limited — wait and retry once
            console.warn(`[classify] Got 429, retrying after ${RATE_LIMIT_RETRY_MS}ms`);
            await new Promise((r) => setTimeout(r, RATE_LIMIT_RETRY_MS));
            const retryStart = Date.now();
            const retryRes = await fetch("/api/classify", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ image: frame, meta, locale }),
            });
            const retryMs = Date.now() - retryStart;
            console.log(`[classify] Retry completed in ${retryMs}ms`);
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
            console.log(`[classify] TIMING: fetch=${fetchDoneMs}ms, requestId=${data.requestId}`);
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

      // ── Pending-item queue ──
      // While the pipeline is busy (non-idle), track consecutive foreground frames.
      // If a blob persists for FG_PERSIST_FRAMES frames, record a pending item so
      // the next cooldown→idle transition fast-paths to object_detected instead of idle.
      // Queue depth is 1 — last-wins; fgPersistRef resets after setting the flag
      // so it doesn't keep firing.
      if (state !== "idle") {
        if (roiHasFg) {
          fgPersistRef.current++;
          if (fgPersistRef.current >= FG_PERSIST_FRAMES) {
            pendingItemRef.current = true;
            fgPersistRef.current = 0;
          }
        } else {
          fgPersistRef.current = 0;
        }
      }

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

        // Sharpness gate: only count frames where the image is not blurry.
        // Skin ratio is intentionally NOT checked — the user is always holding
        // the item, so hand presence is expected and should not block detection.
        if (imageQualityBand(analysis) !== "poor") {
          objectDetectedFrameRef.current++;
        }

        // After SHARP_FRAMES_REQUIRED confirmed frames, trigger classification
        // immediately — no stabilizing phase needed.
        if (objectDetectedFrameRef.current >= SHARP_FRAMES_REQUIRED) {
          objectDetectedFrameRef.current = 0;
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
          const minDisplayElapsed =
            Date.now() - resultEnterTimeRef.current >= RESULT_MIN_DISPLAY_MS;
          if (goneCountRef.current >= OBJECT_GONE_FRAMES && minDisplayElapsed) {
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
            setStableResult(null); setResultRequestId(undefined);
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
          setStableResult(null); setResultRequestId(undefined);
          setError(null);
          if (pendingItemRef.current) {
            // A new item was detected while we were busy — skip idle and jump
            // straight into the next scan without requiring re-presentation.
            pendingItemRef.current = false;
            fgPersistRef.current = 0;
            goneCountRef.current = 0;
            objectDetectedFrameRef.current = 0;
            transition("object_detected");
          } else {
            transition("idle");
          }
        }
        return;
      }
    }, ANALYSIS_INTERVAL_MS);

    return () => clearInterval(interval);

    // ── Trigger classification (called from within the loop) ──
    // Speculative prefetch: fires YOLO + API in parallel. YOLO is fast (~100ms)
    // so if it hits we cancel/ignore the API result. If YOLO misses, the API
    // call is already in flight — no sequential penalty.
    function triggerClassification(analysis: FrameAnalysis) {
      if (inFlightRef.current) return;

      const video = cameraRef.current?.getVideo();
      if (!video) return;

      inFlightRef.current = true;
      transition("classifying");

      const yoloReady = isYoloReady() && siteConfigRef.current;

      // Always start the API call immediately (speculative prefetch).
      // If YOLO wins, we abort this via the AbortController.
      const apiController = new AbortController();
      const apiPromise = classifyViaApiAsync(video, analysis, apiController.signal);

      if (yoloReady) {
        const yoloStart = Date.now();
        runYoloInference(video, CAPTURE_ROI_MARGIN)
          .then((detections) => {
            const yoloMs = Date.now() - yoloStart;

            if (detections.length > 0) {
              const best = detections[0];
              const result = resolveYoloDetection(best, siteConfigRef.current!);

              if (result) {
                console.log(`[yolo] LOCAL HIT: ${best.className} (${(best.confidence * 100).toFixed(1)}%) → ${result.wasteStream} in ${yoloMs}ms`);
                // YOLO won — abort the speculative API call
                apiController.abort();
                handleClassificationResult(result, undefined);
                return;
              }
              console.log(`[yolo] No rule for "${best.className}" — waiting for API`);
            } else {
              console.log(`[yolo] No detections (${yoloMs}ms) — waiting for API`);
            }

            // YOLO miss — await the already-in-flight API call
            apiPromise
              .then(({ result: r, requestId }) => { if (r) handleClassificationResult(r, requestId); })
              .catch(handleClassificationError);
          })
          .catch(() => {
            // YOLO error — await API
            apiPromise
              .then(({ result: r, requestId }) => { if (r) handleClassificationResult(r, requestId); })
              .catch(handleClassificationError);
          });
      } else {
        // No YOLO — just await API
        apiPromise
          .then(({ result: r, requestId }) => { if (r) handleClassificationResult(r, requestId); })
          .catch(handleClassificationError);
      }
    }

    /** Shared result handler for both YOLO and API paths. */
    function handleClassificationResult(
      result: ClassificationResponse & { requestId?: string },
      requestId: string | undefined,
    ) {
      if (
        result.itemName.toLowerCase() === "nothing detected" ||
        result.confidence === 0
      ) {
        cooldownStartRef.current = Date.now();
        transition("cooldown");
        inFlightRef.current = false;
        return;
      }

      setStableResult(result);
      setResultRequestId(requestId ?? result.requestId);
      setError(null);
      goneCountRef.current = 0;
      resultEnterTimeRef.current = Date.now();
      transition("result");

      const cacheKey = `${result.itemName}::${result.wasteStream}`;
      if (cacheKey !== lastCachedRef.current) {
        cacheResult(result);
        lastCachedRef.current = cacheKey;
      }
      inFlightRef.current = false;
    }

    /** Shared error handler for API failures. */
    function handleClassificationError(err: unknown) {
      // Ignore aborts caused by YOLO winning the race
      if (err instanceof DOMException && err.name === "AbortError") {
        return;
      }
      const msg = T("classificationFailed");
      console.error("[classify] API error:", err);
      setError(msg);
      errorSetAtRef.current = Date.now();
      cooldownStartRef.current = Date.now();
      transition("cooldown");
      inFlightRef.current = false;
    }

    /** Capture ROI frame and classify via OpenAI Vision API (async, returns result). */
    async function classifyViaApiAsync(
      video: HTMLVideoElement,
      analysis: FrameAnalysis,
      signal?: AbortSignal,
    ): Promise<{ result: (ClassificationResponse & { requestId?: string }) | null; requestId?: string }> {
      const procStart = Date.now();
      const vw = video.videoWidth;
      const vh = video.videoHeight;
      const roiX = Math.round(vw * CAPTURE_ROI_MARGIN);
      const roiY = Math.round(vh * CAPTURE_ROI_MARGIN);
      const roiW = Math.round(vw * (1 - CAPTURE_ROI_MARGIN * 2));
      const roiH = Math.round(vh * (1 - CAPTURE_ROI_MARGIN * 2));

      // Scale down so longest dimension is at most 320px
      const scale = Math.min(1, 320 / Math.max(roiW, roiH));
      const outW = Math.round(roiW * scale);
      const outH = Math.round(roiH * scale);

      const cropCanvas = new OffscreenCanvas(outW, outH);
      const cropCtx = cropCanvas.getContext("2d");
      if (!cropCtx) return { result: null };

      cropCtx.drawImage(video, roiX, roiY, roiW, roiH, 0, 0, outW, outH);
      const cropMs = Date.now() - procStart;

      // Check if aborted before expensive blob conversion
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

      const blob = await cropCanvas.convertToBlob({ type: "image/jpeg", quality: 0.82 });
      const blobMs = Date.now() - procStart - cropMs;

      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result as string);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });

      const frame = dataUrl.split(",")[1];
      if (!frame) return { result: null };

      const base64Ms = Date.now() - procStart - cropMs - blobMs;

      const meta: ClassifyMeta = {
        skinRatio: analysis.skinRatio,
        sharpnessScore: analysis.sharpnessScore,
        imageQuality: imageQualityBand(analysis),
      };

      console.log(`[classify] IMAGE PROCESSING:`, {
        crop_ms: cropMs,
        convertToBlob_ms: blobMs,
        base64_ms: base64Ms,
        frameSize_bytes: frame.length,
        totalProcMs: Date.now() - procStart,
      });

      // Check if aborted before API call
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

      const result = await classify(frame, meta);
      return { result, requestId: result.requestId };
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [classify, transition, T]);

  const handleFeedbackGiven = useCallback(() => {
    // After feedback, reset so user can scan next item
    setStableResult(null); setResultRequestId(undefined);
    cooldownStartRef.current = Date.now();
    transition("cooldown");
  }, [transition]);

  /** Reset the background model and return to idle — useful during testing
   *  if a persistent leftover has not yet been auto-absorbed. */
  const handleRecalibrate = useCallback(() => {
    analyzerRef.current?.reset();
    setStableResult(null); setResultRequestId(undefined);
    setError(null);
    fgPersistRef.current = 0;
    pendingItemRef.current = false;
    goneCountRef.current = 0;
    objectDetectedFrameRef.current = 0;
    inFlightRef.current = false;
    transition("idle");
  }, [transition]);

  // ── Derive UI signals from pipeline state ──
  if (!mounted) return null;
  const scanning = pipelineState === "classifying";
  const unstable = pipelineState === "object_detected";

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
                    : pipelineState === "object_detected"
                      ? "bg-blue-500"
                      : "bg-emerald-500"
              }`}
            />
          </span>
          <span className="text-sm text-white/70 font-medium">
            {scanning
              ? T("identifyingItem")
              : pipelineState === "object_detected"
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

        {/* Corner scan markers — positioned to match the capture ROI */}
        <div className="absolute pointer-events-none" style={{ inset: `${CAPTURE_ROI_MARGIN * 100}%` }}>
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
          requestId={resultRequestId}
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
