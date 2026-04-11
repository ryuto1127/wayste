"use client";

import { useRef, useEffect, useCallback, useState } from "react";
import type {
  ClassificationResponse,
  PipelineState,
  FrameAnalysis,
  ClassifyMeta,
  SiteConfig,
  Tier1SubclassContext,
  YoloDetection,
  YoloDetectionLog,
} from "@/lib/types";
import type { Locale } from "@/lib/i18n";
import { t } from "@/lib/i18n";
import { cacheResult } from "@/lib/offline-cache";
import {
  FrameAnalyzer,
  imageQualityBand,
  blobIsObject,
} from "@/lib/frame-analyzer";
import {
  getInferenceBackend,
  subscribeSystemStatus,
  type InferenceBackend,
  type SystemStatus,
  YOLO_API_PARALLEL_THRESHOLD,
} from "@/lib/inference-backend";
import { computeThresholds, type ThresholdConfig, type Calibration } from "@/lib/threshold-config";
import { perfMonitor } from "@/lib/perf-monitor";
import { loadYoloRules, loadYoloWorldRules, resolveYoloDetection, resolveYoloWorldDetection, resolvePetBottleCompound, resolveYoloWorldWithPooling, isYoloClassNotWaste } from "@/lib/yolo-rules";
import { MATERIAL_VOCABULARY } from "@/lib/material-vocabulary";
import { analyzeMaterial, refineClassName } from "@/lib/rgb-material-analyzer";
import type { MaterialHint } from "@/lib/types";
// kioskAuthHeaders replaced by session token (server-generated, HMAC-signed)
import CameraFeed, { type CameraFeedHandle } from "./CameraFeed";
import IdleScreen from "./IdleScreen";
import CameraScreen from "./CameraScreen";
import ResultScreen from "./ResultScreen";
import SystemStatusBadge from "./SystemStatusBadge";

// ── Timing constants ──
const ANALYSIS_INTERVAL_MS = 30;  // ~33 fps local CV
const COOLDOWN_MS = 1500; // pause before re-scanning (BG model recovery)
const RESULT_GONE_FRAMES = 5;     // result state exit window (~150ms at 33fps) — balanced against flicker risk
/**
 * Consecutive frames in idle with both foreground presence AND acceptable
 * image quality (not "poor") required to trigger classification.
 * Combines the old FG_PERSIST + SHARP_FRAMES gates into a single overlapped check.
 */
const SHARP_FG_FRAMES_REQUIRED = 3;
/**
 * Escape hatch: if the result state persists for this long with the object
 * still visible (e.g., a tissue leftover that never leaves), force a transition
 * to cooldown so the BG model gets a full-rate update window in idle.
 */
const RESULT_TIMEOUT_MS = 20_000;
/** Minimum time an error message is visible before being cleared. */
const ERROR_HOLD_MS = 4_000;
/** Abort API call if it takes longer than this. */
const API_TIMEOUT_MS = 15_000;
/** Retry delay after a 429 rate-limit response. */
const RATE_LIMIT_RETRY_MS = 1_200;
/** Max time in "classifying" state before forcing a timeout recovery. */
const CLASSIFYING_TIMEOUT_MS = 20_000;

// ── Background adaptation rates (passed to FrameAnalyzer per pipeline state) ──
// idle / cooldown: full rate — continuously absorb drift and persistent leftovers
const BG_RATE_IDLE = 0.025; // matches BG_LEARN_RATE in frame-analyzer
// result: frozen — BG model still holds the pre-item scene, so item-vs-empty
// diff stays accurate; absorbing the item would erode foreground detection
const BG_RATE_RESULT = 0;
// object_detected / classifying: frozen — never absorb the held object
const BG_RATE_FROZEN = 0;

// ── Detection ROI margin (fraction of the short-side square capture crop) ──
// frame-analyzer crops the same center square as YOLO (e.g. 720×720 from
// 1280×720), then applies this inset → detection ROI = center 80% (576×576).
const DETECTION_ROI_MARGIN = 0.10;

const ROI_BLOB_DIAGONAL_MIN_AREA = 0.01;

const YOLO_MODEL_SIZE = 640;

/** Convert raw YOLO detections to log format with normalized bboxes. */
function toDetectionLogs(detections: YoloDetection[]): YoloDetectionLog[] {
  return detections.map((d) => ({
    classId: d.classId,
    className: d.className,
    confidence: d.confidence,
    bbox: d.bbox,
    bboxNorm: [
      (d.bbox[0] + d.bbox[2] / 2) / YOLO_MODEL_SIZE,   // x_center
      (d.bbox[1] + d.bbox[3] / 2) / YOLO_MODEL_SIZE,   // y_center
      d.bbox[2] / YOLO_MODEL_SIZE,                       // width
      d.bbox[3] / YOLO_MODEL_SIZE,                       // height
    ],
  }));
}

interface KioskDisplayProps {
  defaultLocale?: Locale;
}

export default function KioskDisplay({ defaultLocale }: KioskDisplayProps) {
  const cameraRef = useRef<CameraFeedHandle>(null);
  const analyzerRef = useRef<FrameAnalyzer | null>(null);

  // ── Model loading state ──
  const [overallReady, setOverallReady] = useState(false);
  const [loadingMessage, setLoadingMessage] = useState<"loading_model_1" | "loading_model_2" | "loading_ready">("loading_model_1");

  // ── Pipeline state ──
  const stateRef = useRef<PipelineState>("idle");
  const [mounted, setMounted] = useState(false);
  const [pipelineState, setPipelineState] = useState<PipelineState>("idle");
  const [stableResults, setStableResults] =
    useState<ClassificationResponse[]>([]);
  const [resultRequestIds, setResultRequestIds] = useState<(string | undefined)[]>([]);
  /** Stream definitions from site config — passed to ResultScreen for bin position display. */
  const [siteStreams, setSiteStreams] = useState<import("@/lib/types").StreamDefinition[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [locale, setLocale] = useState<Locale>(defaultLocale ?? "en");
  /** Track whether the user has manually toggled the language. */
  const userHasToggledRef = useRef(false);
  /** Incremented each time the pipeline returns to idle after a classification.
   *  Drives idle-screen stats refresh. */
  const [statsVersion, setStatsVersion] = useState(0);

  // ── Voice guidance state (persisted in localStorage) ──
  const [voiceEnabled, setVoiceEnabled] = useState(() => {
    if (typeof window === "undefined") return false;
    try { return localStorage.getItem("rb-voice") === "1"; } catch { return false; }
  });
  const toggleVoice = useCallback(() => {
    setVoiceEnabled((v) => {
      const next = !v;
      try { localStorage.setItem("rb-voice", next ? "1" : "0"); } catch {}
      return next;
    });
  }, []);

  // ── CV counters (refs to avoid re-renders) ──
  const goneCountRef = useRef(0);
  const fgPersistRef = useRef(0);
  const pendingItemRef = useRef(false);
  const objectDetectedFrameRef = useRef(0);
  const resultEnterTimeRef = useRef(0);
  const classifyStartRef = useRef(0);
  /** Consecutive "nothing detected" results — suppresses reclassification of persistent non-waste objects. */
  const nothingDetectedCountRef = useRef(0);
  const cooldownStartRef = useRef(0);
  const inFlightRef = useRef(false);
  const lastAnalysisRef = useRef<FrameAnalysis | null>(null);
  const lastCachedRef = useRef("");
  const errorSetAtRef = useRef(0);
  /** Last calibration object reference — detect rolling recalibration updates. */
  const lastCalibrationRef = useRef<Calibration | null>(null);
  const errorRef = useRef<string | null>(null);
  /** Mirror of `locale` state as a ref for stale-closure-safe reads inside the CV interval. */
  const localeRef = useRef<Locale>(defaultLocale ?? "en");

  /** Site config fetched from the API. */
  const siteConfigRef = useRef<SiteConfig | null>(null);
  /** Inference backend (ONNX or HTTP — resolved at init). */
  const inferenceRef = useRef<InferenceBackend | null>(null);
  /** Derived thresholds — recomputed when calibration becomes available. */
  const thresholdsRef = useRef<ThresholdConfig>(computeThresholds(0.5));

  // ── Thermal monitoring ──
  // Track CV analysis duration to detect M1 MBA thermal throttling.
  // If analysis time consistently exceeds 2× baseline, reduce idle fps to ~15.
  const [thermalWarning, setThermalWarning] = useState(false);
  const thermalRef = useRef({
    /** Rolling window of recent analysis durations (ms). */
    durations: [] as number[],
    /** Baseline average (computed from first 60 stable samples). */
    baseline: 0,
    /** How many samples have been collected for baseline. */
    baselineSamples: 0,
    /** Whether throttling is currently detected. */
    throttling: false,
    /** Frame counter for skip-frame throttling. */
    frameCounter: 0,
  });

  // Reset thermal state when tab returns to foreground — background tab
  // throttling inflates analysis durations, causing false thermal detection.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") {
        const thermal = thermalRef.current;
        if (thermal.throttling) {
          thermal.throttling = false;
          thermal.durations = [];
          setThermalWarning(false);
          perfMonitor.recordThermalState(false, 1);
          console.log("[thermal] ✅ Tab visible — reset thermal state");
        }
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, []);

  // Prevent SSR — this component requires browser APIs (camera, OffscreenCanvas)
  useEffect(() => setMounted(true), []);

  // ── Subscribe to model loading status ──
  useEffect(() => {
    return subscribeSystemStatus((s: SystemStatus) => {
      setOverallReady(s.overallReady);
      if (s.yolo26m === "loading") {
        setLoadingMessage("loading_model_1");
      } else if (s.yolo26m === "ready" && s.yoloWorld === "loading") {
        setLoadingMessage("loading_model_2");
      } else if (s.overallReady) {
        setLoadingMessage("loading_ready");
      }
    });
  }, []);

  // ── Initialize inference backend + rules + site config (client-side) ──
  useEffect(() => {
    Promise.all([
      getInferenceBackend().then((backend) => {
        inferenceRef.current = backend;
        // YOLO World is now pre-warmed in parallel during OnnxBackend.init() —
        // no separate initYoloWorld() call needed here.
      }),
      loadYoloRules(),
      loadYoloWorldRules(),
      fetch("/api/site-config")
        .then((r) => r.json())
        .then((data: SiteConfig) => {
          siteConfigRef.current = data;
          if (data.streams) setSiteStreams(data.streams);
          // Initialize thresholds from site sensitivity (calibration applied later)
          thresholdsRef.current = computeThresholds(data.sensitivity ?? 0.5);
        })
        .catch(() => {}),
    ]);
  }, []);

  // Fetch defaultLocale from site-config API as a fallback
  useEffect(() => {
    if (defaultLocale) return;
    const check = () => {
      const cfg = siteConfigRef.current;
      if (cfg?.defaultLocale && cfg.defaultLocale !== locale && !userHasToggledRef.current) {
        setLocale(cfg.defaultLocale as Locale);
      }
    };
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

  useEffect(() => {
    errorRef.current = error;
  }, [error]);

  useEffect(() => {
    localeRef.current = locale;
  }, [locale]);

  const T = useCallback(
    (key: Parameters<typeof t>[1]) => t(locale, key),
    [locale]
  );

  const toggleLocale = useCallback(() => {
    userHasToggledRef.current = true;
    setLocale((l) => (l === "en" ? "ja" : "en"));
  }, []);

  const transition = useCallback((next: PipelineState) => {
    stateRef.current = next;
    setPipelineState(next);
  }, []);

  // ── API call (with timeout + 429 retry) ──
  const classify = useCallback(
    async (frame: string, meta: ClassifyMeta, yoloDetections?: YoloDetectionLog[], materialHint?: MaterialHint, multi?: boolean, tierResults?: { tier1?: { itemName: string; confidence: number }[]; tier2?: { itemName: string; confidence: number }[] }): Promise<ClassificationResponse & { requestId?: string }> => {
      const doFetch = async (): Promise<ClassificationResponse & { requestId?: string }> => {
        const fetchStartMs = Date.now();
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), API_TIMEOUT_MS);

        try {
          const reqBody = { image: frame, meta, locale, yoloDetections, materialHint, ...(multi && { multi: true }), ...(tierResults && { tierResults }) };
          const res = await fetch("/api/classify", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(reqBody),
            signal: controller.signal,
          });
          const fetchDoneMs = Date.now() - fetchStartMs;

          // ── 429: rate limit retry ──
          if (res.status === 429) {
            console.warn(`[classify] Got 429, retrying after ${RATE_LIMIT_RETRY_MS}ms`);
            await new Promise((r) => setTimeout(r, RATE_LIMIT_RETRY_MS));
            const retryStart = Date.now();
            const retryController = new AbortController();
            const retryTimeout = setTimeout(() => retryController.abort(), API_TIMEOUT_MS);
            const retryRes = await fetch("/api/classify", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(reqBody),
              signal: retryController.signal,
            });
            clearTimeout(retryTimeout);
            const retryMs = Date.now() - retryStart;
            console.log(`[classify] Retry completed in ${retryMs}ms`);
            if (!retryRes.ok) {
              const body = await retryRes.json().catch(() => ({}));
              throw new Error((body as { error?: string }).error ?? `API error: ${retryRes.status}`);
            }
            const retryData = await retryRes.json();
            if (Array.isArray(retryData.results)) {
              return { ...retryData.results[0], requestId: retryData.requestId } as ClassificationResponse;
            }
            return retryData as ClassificationResponse;
          }

          if (!res.ok) {
            const body = await res.json().catch(() => ({}));
            throw new Error(
              res.status === 402
                ? "API quota exceeded — add credits at platform.openai.com/settings/billing"
                : (body as { error?: string }).error ?? `API error: ${res.status}`
            );
          }

          const responseData = await res.json();
          // Multi-item response format: { results: ClassificationResponse[], requestId }
          if (Array.isArray(responseData.results)) {
            if (responseData.results.length === 0) throw new Error("Multi-item returned no results");
          }
          const data: ClassificationResponse & { requestId?: string } =
            Array.isArray(responseData.results)
              ? { ...responseData.results[0], requestId: responseData.requestId }
              : responseData;
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

      // ── Thermal throttling: skip every other frame during idle ──
      const thermal = thermalRef.current;
      thermal.frameCounter++;
      if (thermal.throttling && stateRef.current === "idle" && thermal.frameCounter % 2 === 0) {
        return; // effectively ~15fps during idle when throttling
      }

      // During classifying, skip all heavy work — only check timeout.
      if (stateRef.current === "classifying") {
        if (Date.now() - classifyStartRef.current >= CLASSIFYING_TIMEOUT_MS) {
          console.error("[classify] Timed out in classifying state — forcing recovery");
          analyzer.boostBackgroundAdaptation();
          inFlightRef.current = false;
          cooldownStartRef.current = Date.now();
          transition("cooldown");
        }
        return;
      }

      // Set BG adaptation rate based on pipeline state.
      // All result states (including nothing_detected) freeze BG to prevent
      // non-waste objects from being absorbed. boostBackgroundAdaptation()
      // rapidly corrects on exit (gone check or timeout).
      const currentState = stateRef.current;
      const bgRate =
        currentState === "idle" || currentState === "cooldown"
          ? BG_RATE_IDLE
          : currentState === "result"
            ? BG_RATE_RESULT
            : BG_RATE_FROZEN;
      analyzer.setBgRate(bgRate);

      // Keep analyzer's idle threshold in sync for rolling calibration
      if (currentState === "idle" || currentState === "cooldown") {
        analyzer.setIdleFgThreshold(thresholdsRef.current.ROI_FG_THRESHOLD);
      }

      const analysisStart = performance.now();
      const analysis = analyzer.analyze(video);
      if (!analysis) return;
      lastAnalysisRef.current = analysis;

      // ── Thermal monitoring: track analysis duration ──
      // Skip thermal tracking when tab is hidden — browser background throttling
      // inflates analysis duration and causes false thermal detection.
      const analysisDuration = performance.now() - analysisStart;
      perfMonitor.recordCvFrame(analysisDuration);
      if (!document.hidden) {
        if (thermal.baselineSamples < 60) {
          // Collecting baseline (first ~2 seconds)
          thermal.durations.push(analysisDuration);
          thermal.baselineSamples++;
          if (thermal.baselineSamples === 60) {
            thermal.baseline = thermal.durations.reduce((a, b) => a + b, 0) / thermal.durations.length;
            thermal.durations = [];
            console.log(`[thermal] Baseline analysis time: ${thermal.baseline.toFixed(2)}ms`);
          }
        } else {
          thermal.durations.push(analysisDuration);
          if (thermal.durations.length > 30) thermal.durations.shift();
          const avg = thermal.durations.reduce((a, b) => a + b, 0) / thermal.durations.length;
          const ratio = avg / thermal.baseline;
          const wasThrottling = thermal.throttling;
          // Trigger at 2× baseline, recover at 1.5× baseline (hysteresis)
          if (avg > thermal.baseline * 2) {
            thermal.throttling = true;
          } else if (avg < thermal.baseline * 1.5) {
            thermal.throttling = false;
          }
          perfMonitor.recordThermalState(thermal.throttling, ratio);
          if (thermal.throttling !== wasThrottling) {
            console.log(`[thermal] ${thermal.throttling ? "⚠️ Throttling detected" : "✅ Throttling resolved"} (avg=${avg.toFixed(2)}ms, baseline=${thermal.baseline.toFixed(2)}ms)`);
            setThermalWarning(thermal.throttling);
          }
        }
      }

      const state = stateRef.current;

      if (!analysis.isSettled) return;

      // Recompute thresholds when rolling calibration updates
      const cal = analyzer.getCalibration();
      if (cal && cal !== lastCalibrationRef.current) {
        const sensitivity = siteConfigRef.current?.sensitivity ?? 0.5;
        thresholdsRef.current = computeThresholds(sensitivity, cal);
        lastCalibrationRef.current = cal;
      }

      const th = thresholdsRef.current;

      const elongated =
        analysis.roiLargestBlobDiagonalRatio > th.ROI_BLOB_DIAGONAL_THRESHOLD &&
        analysis.roiLargestBlobRatio > ROI_BLOB_DIAGONAL_MIN_AREA;
      const roiHasFg =
        (analysis.roiForegroundRatio >= th.ROI_FG_THRESHOLD &&
         analysis.roiLargestBlobRatio >= th.ROI_BLOB_THRESHOLD) ||
        elongated;
      // Result-state exit uses lower thresholds: a small/distant item still
      // registers as "present" so the result stays on screen.
      const resultHasFg =
        (analysis.roiForegroundRatio >= th.RESULT_FG_THRESHOLD &&
         analysis.roiLargestBlobRatio >= th.RESULT_BLOB_THRESHOLD) ||
        elongated;

      // ── Pending-item queue ──
      if (state !== "idle") {
        if (roiHasFg) {
          fgPersistRef.current++;
          if (fgPersistRef.current >= th.FG_PERSIST_FRAMES) {
            pendingItemRef.current = true;
            fgPersistRef.current = 0;
          }
        } else {
          fgPersistRef.current = 0;
        }
      }

      // ── State machine transitions ──

      if (state === "idle") {
        // ── Overlapped FG + sharpness check ──
        // Count frames that are BOTH foreground-present AND sharp.
        if (roiHasFg && imageQualityBand(analysis) !== "poor") {
          fgPersistRef.current++;
          if (fgPersistRef.current >= SHARP_FG_FRAMES_REQUIRED) {
            fgPersistRef.current = 0;
            goneCountRef.current = 0;
            objectDetectedFrameRef.current = 0;
            triggerClassification(analysis);
          }
        } else if (roiHasFg) {
          // FG present but blurry — count toward persistence but don't trigger
          fgPersistRef.current++;
        } else {
          fgPersistRef.current = 0;
          // Scene cleared — reset nothing-detected suppression
          if (nothingDetectedCountRef.current > 0) {
            nothingDetectedCountRef.current = 0;
          }
        }
        return;
      }

      if (state === "object_detected") {
        if (!roiHasFg) {
          goneCountRef.current++;
          if (goneCountRef.current >= th.OBJECT_GONE_FRAMES) {
            objectDetectedFrameRef.current = 0;
            transition("idle");
          }
          return;
        }
        goneCountRef.current = 0;

        if (imageQualityBand(analysis) !== "poor") {
          objectDetectedFrameRef.current++;
        }

        if (objectDetectedFrameRef.current >= SHARP_FG_FRAMES_REQUIRED) {
          objectDetectedFrameRef.current = 0;
          triggerClassification(analysis);
        }
        return;
      }

      // classifying state is handled above (before frame analysis)
      // to avoid blocking the main thread during API calls.

      if (state === "result") {
        // Result stays on screen until item is removed — no minimum display time.
        // Uses lenient resultHasFg so distant/small items don't prematurely dismiss.
        if (!resultHasFg) {
          goneCountRef.current++;
          if (goneCountRef.current >= RESULT_GONE_FRAMES) {
            // Item removed — boost BG adaptation so the
            // model rapidly absorbs the current scene (was frozen during result).
            analyzer.boostBackgroundAdaptation();
            cooldownStartRef.current = Date.now();
            transition("cooldown");
          }
        } else {
          // If goneCount > 0, the previous item briefly disappeared — this is a
          // new item. Reset and classify immediately without waiting for cooldown.
          if (goneCountRef.current > 0 && roiHasFg) {
            setStableResults([]); setResultRequestIds([]);
            setError(null);
            goneCountRef.current = 0;
            fgPersistRef.current = 0;
            objectDetectedFrameRef.current = 0;
            analyzer.boostBackgroundAdaptation();
            triggerClassification(analysis);
            return;
          }
          goneCountRef.current = 0;

          // Persistent-leftover escape hatch
          if (Date.now() - resultEnterTimeRef.current >= RESULT_TIMEOUT_MS) {
            setStableResults([]); setResultRequestIds([]);
            goneCountRef.current = 0;
            analyzer.boostBackgroundAdaptation();
            cooldownStartRef.current = Date.now();
            transition("cooldown");
            return;
          }
        }
        return;
      }

      if (state === "cooldown") {
        // After repeated "nothing detected", use progressively longer cooldowns
        // to let the background model absorb persistent non-waste objects.
        const effectiveCooldown = nothingDetectedCountRef.current > 1
          ? Math.min(COOLDOWN_MS * nothingDetectedCountRef.current, 2_500)
          : COOLDOWN_MS;
        const cooldownElapsed = Date.now() - cooldownStartRef.current >= effectiveCooldown;
        const errorHeld = !errorRef.current || (Date.now() - errorSetAtRef.current >= ERROR_HOLD_MS);

        // If a new item is pending, skip cooldown wait (fast-path to next scan)
        if (pendingItemRef.current && errorHeld) {
          setStableResults([]); setResultRequestIds([]);
          setError(null);
          pendingItemRef.current = false;
          fgPersistRef.current = 0;
          goneCountRef.current = 0;
          objectDetectedFrameRef.current = 0;

          transition("object_detected");
          return;
        }

        if (cooldownElapsed && errorHeld) {
          setStableResults([]); setResultRequestIds([]);
          setError(null);
          setStatsVersion((v) => v + 1);
          transition("idle");
        }
        return;
      }
    }, ANALYSIS_INTERVAL_MS);

    return () => {
      clearInterval(interval);
    };

    /** Log a YOLO-only classification to the server (fire-and-forget).
     *  Needed because YOLO wins skip the /api/classify route entirely. */
    function logYoloOnlyResult(
      video: HTMLVideoElement,
      result: ClassificationResponse,
      detections: YoloDetection[],
      latencyMs: number,
      analysis: FrameAnalysis,
      modelUsed: "yolo-local" | "yolo-world" = "yolo-local",
      hint?: MaterialHint,
      refinedFrom?: string,
      tierResults?: { tier1?: { itemName: string; confidence: number }[]; tier2?: { itemName: string; confidence: number }[] },
    ) {
      // Capture the same center short-side square that YOLO sees (e.g. 720×720
      // from 1280×720). Log images preserve full resolution for fine-tuning.
      const vw = video.videoWidth;
      const vh = video.videoHeight;
      const side = Math.min(vw, vh);
      const roiX = Math.round((vw - side) / 2);
      const roiY = Math.round((vh - side) / 2);

      const canvas = new OffscreenCanvas(side, side);
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.drawImage(video, roiX, roiY, side, side, 0, 0, side, side);

      canvas.convertToBlob({ type: "image/jpeg", quality: 0.82 }).then((blob) => {
        const reader = new FileReader();
        reader.onloadend = () => {
          const frame = (reader.result as string).split(",")[1];
          if (!frame) return;
          fetch("/api/pilot-log", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              image: frame,
              entry: {
                modelUsed,
                escalated: false,
                itemName: result.itemName,
                wasteStream: result.wasteStream,
                confidence: result.confidence,
                requiresVerification: result.needsReview ?? false,
                latencyMs,
                yoloDetections: toDetectionLogs(detections),
                meta: {
                  sharpnessScore: analysis.sharpnessScore,
                  imageQuality: imageQualityBand(analysis),
                },
                ...(hint && {
                  rgbAnalysis: {
                    dominantHue: hint.dominantHue,
                    saturation: hint.saturation,
                    isMetallic: hint.isMetallic,
                    bboxAspectRatio: hint.bboxAspectRatio,
                    ...(refinedFrom && refinedFrom !== result.itemName && {
                      refinedFrom,
                      refinedTo: result.itemName,
                    }),
                    ...(hint.texture?.suggestedSurface && hint.texture.suggestedSurface !== "unknown" && {
                      textureSurface: hint.texture.suggestedSurface,
                    }),
                  },
                }),
                ...(tierResults && { tierResults }),
              },
            }),
          }).catch(() => {}); // best-effort
        };
        reader.readAsDataURL(blob);
      }).catch(() => {});
    }

    // ── Trigger classification (Tiered Pipeline — all on-demand) ──
    //
    // Tier 1: YOLO26m (on-demand) → conf >= 0.65 + rule → instant result
    // Tier 2: YOLO World (on-demand fallback) → ~200-800ms
    // Tier 3: OpenAI API (last resort) → ~1-3s
    //
    function triggerClassification(analysis: FrameAnalysis) {
      if (inFlightRef.current) return;

      const video = cameraRef.current?.getVideo();
      if (!video) return;

      inFlightRef.current = true;
      classifyStartRef.current = Date.now();
      transition("classifying");

      const backend = inferenceRef.current;
      const yoloReady = backend?.isReady() && siteConfigRef.current;
      const isOffline = typeof navigator !== "undefined" && !navigator.onLine;

      // If offline, use local models only (YOLO → YOLO World → offline fallback)
      if (isOffline) {
        handleOfflineClassification(video, backend, yoloReady);
        return;
      }

      const apiController = new AbortController();
      let yoloDetectionLogs: YoloDetectionLog[] | undefined;
      let materialHintForApi: MaterialHint | undefined;
      type TierHints = { tier1?: { itemName: string; confidence: number }[]; tier2?: { itemName: string; confidence: number }[] };
      const apiPromise = (multi?: boolean, tierResults?: TierHints) => classifyViaApiAsync(video, analysis, apiController.signal, yoloDetectionLogs, materialHintForApi, multi, tierResults);

      if (!yoloReady || !backend) {
        // No YOLO at all — straight to API
        apiPromise()
          .then(({ result: r, requestId }) => {
            if (r) handleClassificationResult(r, requestId);
            else handleClassificationError(new Error("API returned no result"));
          })
          .catch(handleClassificationError);
        return;
      }

      // ── Tier 1: On-demand YOLO detection ──
      const yoloStart = Date.now();
      const blobs = analysis.blobs;
      backend.detect(video)
        .then((detections) => {
          const yoloMs = Date.now() - yoloStart;
          perfMonitor.recordYoloInference(yoloMs);

          if (detections.length > 0) {
            yoloDetectionLogs = toDetectionLogs(detections);
          }

          // Filter out not_waste classes (person, furniture, vehicles, etc.)
          const wasteDetections = detections.filter(d => !isYoloClassNotWaste(d.className));

          // Compute material hint from best waste detection (or any detection)
          const hintSource = wasteDetections[0] ?? detections[0];
          if (hintSource) {
            materialHintForApi = analyzeMaterial(video, hintSource.bbox);
          }

          // ── Bbox-based routing ──
          // Iterate wasteDetections directly — no blob matching needed.
          // Blobs remain the gate for triggering YOLO (presence detection) and
          // detecting item removal (result screen), but routing uses bboxes.
          const resolvedResults: (ClassificationResponse & { _bboxX?: number })[] = [];
          const unresolvedDetections: (YoloDetection & { _bboxX: number })[] = [];
          /** Detections needing material sub-classification (Tier 2 material path). */
          const subclassDetections: (YoloDetection & { _bboxX: number; subclassContext: Tier1SubclassContext })[] = [];
          let firstResolvedHint: MaterialHint | undefined;
          let firstResolvedOriginalName: string | undefined;

          for (const detection of wasteDetections.slice(0, 4)) {
            const bboxX = detection.bbox[0] + detection.bbox[2] / 2; // center-x
            if (detection.confidence >= thresholdsRef.current.YOLO_FALLBACK_THRESHOLD) {
              // Tier 1: high confidence → try resolution with sub-classification awareness
              const resolution = resolveYoloDetection(detection, siteConfigRef.current!, localeRef.current, true);
              if (resolution?.needsSubclassification) {
                // Material-ambiguous class (bottle, cup, etc.) at ≥ 80% — route to Tier 2 material path
                console.log(`[tier1] ${detection.className} (${(detection.confidence * 100).toFixed(1)}%) needs material sub-classification`);
                subclassDetections.push(Object.assign({}, detection, {
                  _bboxX: bboxX,
                  subclassContext: resolution.subclassContext,
                }));
                continue;
              }
              if (resolution?.result) {
                const r = resolution.result;
                const detHint = analyzeMaterial(video, detection.bbox);
                const originalName = r.itemName;
                r.itemName = refineClassName(r.itemName, detHint);
                if (resolvedResults.length === 0) {
                  firstResolvedHint = detHint;
                  firstResolvedOriginalName = originalName;
                }
                (r as ClassificationResponse & { _bboxX?: number })._bboxX = bboxX;
                resolvedResults.push(r as ClassificationResponse & { _bboxX?: number });
                continue;
              }
            }
            // Lower confidence — collect for Tier 2/3 escalation
            unresolvedDetections.push(Object.assign({}, detection, { _bboxX: bboxX }));
          }

          // If we have high-confidence results and nothing needs further resolution, deliver instantly
          if (resolvedResults.length > 0 && unresolvedDetections.length === 0 && subclassDetections.length === 0) {
            // Sort by bbox x-coordinate (left-to-right)
            resolvedResults.sort((a, b) => (a._bboxX ?? 0) - (b._bboxX ?? 0));
            console.log(`[tier1] YOLO HIT: ${resolvedResults.map((r) => r.itemName).join(" + ")} in ${yoloMs}ms`);
            logYoloOnlyResult(video, resolvedResults[0], detections, yoloMs, analysis, "yolo-local", firstResolvedHint, firstResolvedOriginalName);
            handleMultiClassificationResults(resolvedResults, resolvedResults.map(() => undefined));
            return;
          }

          // ── Some items need further resolution ──
          const best = wasteDetections[0] ?? null;
          const hasUnresolved = unresolvedDetections.length > 0;
          const hasSubclass = subclassDetections.length > 0;
          const hasBlobPresence = blobs.some(b => blobIsObject(b));

          if (best || hasUnresolved || hasSubclass || hasBlobPresence) {
            // Show optimistic UI for already-resolved items
            if (resolvedResults.length > 0) {
              resolvedResults.sort((a, b) => (a._bboxX ?? 0) - (b._bboxX ?? 0));
              setStableResults(resolvedResults);
              resultEnterTimeRef.current = Date.now();
            }

            const fireApiInParallel = !best || best.confidence < YOLO_API_PARALLEL_THRESHOLD;
            console.log(`[tier1] ${resolvedResults.length} resolved, ${unresolvedDetections.length} unresolved, ${subclassDetections.length} subclass — escalating`);

            escalateToYoloWorld(
              video, backend, best, apiPromise, apiController, fireApiInParallel, detections, yoloMs, analysis,
              resolvedResults, unresolvedDetections, hasBlobPresence && wasteDetections.length === 0,
              subclassDetections,
            );
          } else {
            // No waste detections and no qualified blobs — escalate
            if (detections.length > 0) {
              console.log(`[tier1] Only non-waste detections (${detections.map(d => d.className).join(", ")}) in ${yoloMs}ms — escalating to YOLO World`);
            } else {
              console.log(`[tier1] No YOLO detections (${yoloMs}ms) — escalating to YOLO World`);
            }
            escalateToYoloWorld(
              video, backend, null, apiPromise, apiController, true, detections, yoloMs, analysis,
              [], [], true,
            );
          }
        })
        .catch(() => {
          // YOLO failed entirely — skip to API
          apiPromise()
            .then(({ result: r, requestId }) => {
              if (r) handleClassificationResult(r, requestId);
              else handleClassificationError(new Error("API returned no result"));
            })
            .catch(handleClassificationError);
        });
    }

    /**
     * Crop the video frame to a YOLO detection's bbox with 20% margin,
     * clamped to frame bounds. Returns base64 JPEG and the crop coordinates.
     */
    async function cropBboxToBase64(
      video: HTMLVideoElement,
      bbox: [number, number, number, number],
    ): Promise<{ image: string; cropBox: [number, number, number, number] } | null> {
      const vw = video.videoWidth;
      const vh = video.videoHeight;
      const side = Math.min(vw, vh);
      // YOLO bbox is in 640×640 model space — scale to the center-crop square
      const scale = side / YOLO_MODEL_SIZE;
      const offsetX = Math.round((vw - side) / 2);
      const offsetY = Math.round((vh - side) / 2);

      const [bx, by, bw, bh] = bbox;
      const marginX = bw * 0.2;
      const marginY = bh * 0.2;

      // Crop coordinates in video pixel space
      const cx = Math.max(0, Math.round((bx - marginX) * scale + offsetX));
      const cy = Math.max(0, Math.round((by - marginY) * scale + offsetY));
      const cw = Math.min(vw - cx, Math.round((bw + marginX * 2) * scale));
      const ch = Math.min(vh - cy, Math.round((bh + marginY * 2) * scale));

      if (cw <= 0 || ch <= 0) return null;

      const canvas = new OffscreenCanvas(cw, ch);
      const ctx = canvas.getContext("2d");
      if (!ctx) return null;
      ctx.drawImage(video, cx, cy, cw, ch, 0, 0, cw, ch);

      const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.82 });
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result as string);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });
      const image = dataUrl.split(",")[1];
      if (!image) return null;

      return { image, cropBox: [cx, cy, cw, ch] };
    }

    /** Tier 2: YOLO World fallback (on-demand). */
    function escalateToYoloWorld(
      video: HTMLVideoElement,
      backend: InferenceBackend,
      yoloBest: { className: string; confidence: number } | null,
      apiPromise: (multi?: boolean, tierResults?: { tier1?: { itemName: string; confidence: number }[]; tier2?: { itemName: string; confidence: number }[] }) => Promise<{ result: (ClassificationResponse & { requestId?: string }) | null; requestId?: string }>,
      apiController: AbortController,
      fireApiInParallel: boolean,
      yoloDetections: YoloDetection[],
      yoloMs: number,
      analysis: FrameAnalysis,
      /** Already-resolved high-confidence Tier 1 results (with _bboxX). */
      tier1Results: (ClassificationResponse & { _bboxX?: number })[] = [],
      /** Low-confidence detections that need Tier 2/3 resolution. */
      unresolvedDetections: (YoloDetection & { _bboxX: number })[] = [],
      /** True when blobs exist but YOLO found zero waste detections — triggers multi-item GPT fallback. */
      zeroBboxFallback: boolean = false,
      /** Detections needing material sub-classification (bottle, cup, etc.). */
      subclassDetections: (YoloDetection & { _bboxX: number; subclassContext: Tier1SubclassContext })[] = [],
    ) {
      type ApiResult = Promise<{ result: (ClassificationResponse & { requestId?: string }) | null; requestId?: string }>;
      // Start API call in parallel if confidence is very low
      let apiInflight: ApiResult | null = null;
      // Derive T1 hints from YOLO detections (available for all apiPromise calls in this scope)
      type TrType = { tier1?: { itemName: string; confidence: number }[]; tier2?: { itemName: string; confidence: number }[] };
      const tier1HintsLocal = yoloDetections.filter(d => !isYoloClassNotWaste(d.className))
        .map(d => ({ itemName: d.className, confidence: d.confidence }));
      const buildTr = (t2?: { itemName: string; confidence: number }[]): TrType | undefined => {
        const tr: TrType = {};
        if (tier1HintsLocal.length > 0) tr.tier1 = tier1HintsLocal;
        if (t2?.length) tr.tier2 = t2;
        return (tr.tier1 || tr.tier2) ? tr : undefined;
      };

      if (fireApiInParallel && unresolvedDetections.length === 0 && zeroBboxFallback) {
        // Full-frame multi-item fallback — use multi-item prompt (T2 not yet available)
        apiInflight = apiPromise(true, buildTr());
      }

      /** Send per-bbox cropped images for unresolved detections via batch API. */
      async function sendCroppedBatchApi(worldHints?: { className: string; confidence: number }[]): Promise<(ClassificationResponse & { _bboxX?: number })[]> {
        if (unresolvedDetections.length === 0) return [];
        const crops = await Promise.all(
          unresolvedDetections.map((det) => cropBboxToBase64(video, det.bbox))
        );
        const validItems: { image: string; yoloHint: string | null; materialHint?: MaterialHint; cropBox: [number, number, number, number]; _bboxX: number }[] = [];
        for (let i = 0; i < crops.length; i++) {
          const crop = crops[i];
          if (!crop) continue;
          const det = unresolvedDetections[i];
          const hint = analyzeMaterial(video, det.bbox);
          validItems.push({
            image: crop.image,
            yoloHint: det.className,
            materialHint: hint,
            cropBox: crop.cropBox,
            _bboxX: det._bboxX,
          });
        }
        if (validItems.length === 0) return [];

        const meta: ClassifyMeta = {
          sharpnessScore: analysis.sharpnessScore,
          imageQuality: imageQualityBand(analysis),
        };

        const res = await fetch("/api/classify", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            items: validItems.map((v) => ({
              image: v.image,
              yoloHint: v.yoloHint,
              materialHint: v.materialHint,
              cropBox: v.cropBox,
            })),
            siteId: siteConfigRef.current?.siteId,
            locale: localeRef.current,
            meta,
            tierResults: (() => {
              const tr: { tier1?: { itemName: string; confidence: number }[]; tier2?: { itemName: string; confidence: number }[] } = {};
              const wasteT1 = yoloDetections.filter(d => !isYoloClassNotWaste(d.className));
              if (wasteT1.length > 0) tr.tier1 = wasteT1.map(d => ({ itemName: d.className, confidence: d.confidence }));
              if (worldHints?.length) tr.tier2 = worldHints.map(d => ({ itemName: d.className, confidence: d.confidence }));
              return (tr.tier1 || tr.tier2) ? tr : undefined;
            })(),
          }),
        });
        if (!res.ok) throw new Error(`Batch API error: ${res.status}`);
        const data = await res.json() as { results: (ClassificationResponse & { requestId?: string })[] };
        return (data.results ?? []).map((r, i) => ({
          ...r,
          _bboxX: validItems[i]?._bboxX,
        }));
      }

      /**
       * Send cropped images for sub-classification detections to the API
       * with tier1Context (material identification prompt path).
       */
      async function sendSubclassBatchApi(
        tier2ResultsForContext: { className: string; confidence: number }[],
      ): Promise<(ClassificationResponse & { _bboxX?: number })[]> {
        if (subclassDetections.length === 0) return [];
        const results: (ClassificationResponse & { _bboxX?: number })[] = [];
        // Process each sub-classification detection individually (each gets its own tier1Context)
        for (const det of subclassDetections) {
          const crop = await cropBboxToBase64(video, det.subclassContext.bbox);
          if (!crop) continue;
          const res = await fetch("/api/classify", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              image: crop.image,
              siteId: siteConfigRef.current?.siteId,
              locale: localeRef.current,
              meta: {
                sharpnessScore: analysis.sharpnessScore,
                imageQuality: imageQualityBand(analysis),
              },
              tier1Context: {
                className: det.subclassContext.className,
                confidence: det.subclassContext.confidence,
                tier2Results: tier2ResultsForContext,
              },
            }),
          });
          if (!res.ok) continue;
          const data = await res.json() as ClassificationResponse & { requestId?: string };
          results.push({ ...data, _bboxX: det._bboxX });
        }
        return results;
      }

      /** Merge all tier results, sort by bbox x, cap at 4. */
      function mergeAndDeliver(
        tier2Results: (ClassificationResponse & { _bboxX?: number })[],
        tier3Results: (ClassificationResponse & { _bboxX?: number })[],
        requestIds: (string | undefined)[],
      ) {
        const allResults = [...tier1Results, ...tier2Results, ...tier3Results];
        // Sort by bbox x-coordinate; results without _bboxX go last
        allResults.sort((a, b) => (a._bboxX ?? Infinity) - (b._bboxX ?? Infinity));
        const capped = allResults.slice(0, 4);
        const cappedIds = capped.map((r) =>
          requestIds[allResults.indexOf(r)] ?? (r as ClassificationResponse & { requestId?: string }).requestId
        );
        handleMultiClassificationResults(capped, cappedIds);
      }

      if (!backend.isYoloWorldReady()) {
        // YOLO World not available — fall through to API
        console.log("[tier2] YOLO World not ready — falling through to API");
        const noWorldPromises: Promise<(ClassificationResponse & { _bboxX?: number })[]>[] = [];
        if (unresolvedDetections.length > 0) {
          noWorldPromises.push(sendCroppedBatchApi());
        }
        if (subclassDetections.length > 0) {
          // No Tier 2 hints available — send directly to Tier 3 material prompt
          noWorldPromises.push(sendSubclassBatchApi([]));
        }
        if (noWorldPromises.length > 0) {
          Promise.all(noWorldPromises)
            .then((allResults) => mergeAndDeliver([], allResults.flat(), []))
            .catch((err) => {
              if (tier1Results.length > 0) {
                mergeAndDeliver([], [], []);
              } else if (yoloBest) {
                handleClassificationResult(buildOfflineFallback(yoloBest.className, yoloBest.confidence), undefined);
              } else {
                handleClassificationError(err);
              }
            });
        } else {
          const promise = apiInflight ?? apiPromise(zeroBboxFallback, buildTr());
          promise
            .then(({ result: r, requestId }) => {
              if (r) mergeAndDeliver([], [r as ClassificationResponse & { _bboxX?: number }], [requestId]);
              else handleClassificationError(new Error("API returned no result"));
            })
            .catch((err) => {
              if (yoloBest) {
                handleClassificationResult(buildOfflineFallback(yoloBest.className, yoloBest.confidence), undefined);
              } else {
                handleClassificationError(err);
              }
            });
        }
        return;
      }

      const worldStart = Date.now();

      backend.detectWorld(video)
        .then((worldDetections) => {
          const worldMs = Date.now() - worldStart;
          perfMonitor.recordWorldInference(worldMs);

          const tier2Results: (ClassificationResponse & { _bboxX?: number })[] = [];
          /** Tier 2 results collected from sub-classification path (for tier1Context). */
          const subclassTier2Hints: { className: string; confidence: number }[] = [];

          if (worldDetections.length > 0) {
            // PET bottle compound check: bottle + cap/label detected together
            if (worldDetections.length >= 2) {
              const compoundResult = resolvePetBottleCompound(worldDetections, siteConfigRef.current!, localeRef.current);
              if (compoundResult) {
                console.log(`[tier2] PET bottle compound: ${worldDetections.map(d => d.className).join(" + ")} in ${worldMs}ms`);
                apiController.abort();
                const t1Waste = yoloDetections.filter(d => !isYoloClassNotWaste(d.className));
                logYoloOnlyResult(video, compoundResult, [...yoloDetections, ...worldDetections], yoloMs + worldMs, analysis, "yolo-world",
                  undefined, undefined,
                  t1Waste.length > 0 ? { tier1: t1Waste.map(d => ({ itemName: d.className, confidence: d.confidence })) } : undefined);
                mergeAndDeliver([compoundResult], [], []);
                return;
              }
            }

            // ── Material sub-classification via YOLO World ──
            // For detections that need material identification, filter YOLO World
            // results to only the relevant material vocabulary and apply confidence
            // pooling before threshold comparison.
            const subclassStillPending: typeof subclassDetections = [];
            for (const det of subclassDetections) {
              const vocabSet = new Set(MATERIAL_VOCABULARY[det.subclassContext.className] ?? []);
              // Filter YOLO World detections to material vocabulary for this class
              const materialDetections = worldDetections.filter((wd) => vocabSet.has(wd.className));
              if (materialDetections.length > 0) {
                // Apply confidence pooling (e.g., aluminium + steel → combined confidence)
                const { pooledDetections, bestResult, bestDetection } = resolveYoloWorldWithPooling(
                  materialDetections, siteConfigRef.current!, localeRef.current,
                );
                // Record all pooled results as tier 2 hints (for tier1Context if we fall through to Tier 3)
                for (const pd of pooledDetections) {
                  subclassTier2Hints.push({ className: pd.className, confidence: pd.confidence });
                }
                if (bestDetection && bestDetection.confidence >= thresholdsRef.current.YOLO_WORLD_ACCEPT_THRESHOLD && bestResult) {
                  const worldHint = analyzeMaterial(video, bestDetection.bbox);
                  bestResult.itemName = refineClassName(bestResult.itemName, worldHint);
                  console.log(`[tier2] Material sub-class HIT: ${det.subclassContext.className} → ${bestDetection.className} (${(bestDetection.confidence * 100).toFixed(1)}%) in ${worldMs}ms`);
                  (bestResult as ClassificationResponse & { _bboxX?: number })._bboxX = det._bboxX;
                  tier2Results.push(bestResult as ClassificationResponse & { _bboxX?: number });
                  continue;
                }
              }
              // Inconclusive — will need Tier 3 material identification
              subclassStillPending.push(det);
            }

            // Try to resolve each unresolved detection via YOLO World
            const stillUnresolved: (YoloDetection & { _bboxX: number })[] = [];
            for (const det of unresolvedDetections) {
              // Find best YOLO World match near this detection's bbox
              const detCx = (det.bbox[0] + det.bbox[2] / 2) / YOLO_MODEL_SIZE;
              const detCy = (det.bbox[1] + det.bbox[3] / 2) / YOLO_MODEL_SIZE;
              let bestWorld = worldDetections[0];
              let bestDist = Infinity;
              for (const wd of worldDetections) {
                const wcx = (wd.bbox[0] + wd.bbox[2] / 2) / YOLO_MODEL_SIZE;
                const wcy = (wd.bbox[1] + wd.bbox[3] / 2) / YOLO_MODEL_SIZE;
                const dist = Math.sqrt((detCx - wcx) ** 2 + (detCy - wcy) ** 2);
                if (dist < bestDist) { bestDist = dist; bestWorld = wd; }
              }
              if (bestWorld && bestWorld.confidence >= thresholdsRef.current.YOLO_WORLD_ACCEPT_THRESHOLD) {
                const r = resolveYoloWorldDetection(bestWorld, siteConfigRef.current!, localeRef.current);
                if (r) {
                  const worldHint = analyzeMaterial(video, bestWorld.bbox);
                  r.itemName = refineClassName(r.itemName, worldHint);
                  (r as ClassificationResponse & { _bboxX?: number })._bboxX = det._bboxX;
                  tier2Results.push(r as ClassificationResponse & { _bboxX?: number });
                  continue;
                }
              }
              stillUnresolved.push(det);
            }

            // If no unresolved detections came in, use YOLO World's best as a single result
            if (unresolvedDetections.length === 0 && subclassDetections.length === 0 && worldDetections.length > 0) {
              const worldBest = worldDetections[0];
              if (worldBest.confidence >= thresholdsRef.current.YOLO_WORLD_ACCEPT_THRESHOLD) {
                const result = resolveYoloWorldDetection(worldBest, siteConfigRef.current!, localeRef.current);
                if (result) {
                  const worldHint = analyzeMaterial(video, worldBest.bbox);
                  const worldOriginalName = result.itemName;
                  result.itemName = refineClassName(result.itemName, worldHint);
                  console.log(`[tier2] YOLO World HIT: ${worldBest.className} (${(worldBest.confidence * 100).toFixed(1)}%) → ${result.itemName} [${result.wasteStream}] in ${worldMs}ms`);
                  apiController.abort();
                  const t1Waste2 = yoloDetections.filter(d => !isYoloClassNotWaste(d.className));
                  logYoloOnlyResult(video, result, [...yoloDetections, ...worldDetections], yoloMs + worldMs, analysis, "yolo-world", worldHint, worldOriginalName,
                    t1Waste2.length > 0 ? { tier1: t1Waste2.map(d => ({ itemName: d.className, confidence: d.confidence })) } : undefined);
                  mergeAndDeliver([result as ClassificationResponse & { _bboxX?: number }], [], []);
                  return;
                }
              }
              console.log(`[tier2] YOLO World conf=${(worldBest.confidence * 100).toFixed(1)}% — falling through to API (${worldMs}ms)`);
            }

            // All resolved via Tier 1 + Tier 2 — deliver
            if (
              stillUnresolved.length === 0 &&
              subclassStillPending.length === 0 &&
              (tier1Results.length + tier2Results.length) > 0 &&
              !zeroBboxFallback
            ) {
              console.log(`[tier2] All resolved: ${tier2Results.length} via YOLO World in ${worldMs}ms`);
              apiController.abort();
              // Log the primary result (first by bbox x)
              const allResolved = [...tier1Results, ...tier2Results];
              allResolved.sort((a, b) => (a._bboxX ?? Infinity) - (b._bboxX ?? Infinity));
              const primary = allResolved[0];
              if (primary) {
                const primaryIsT2 = tier2Results.includes(primary);
                const wasteT1All = yoloDetections.filter(d => !isYoloClassNotWaste(d.className));
                logYoloOnlyResult(
                  video, primary, [...yoloDetections, ...worldDetections], yoloMs + worldMs, analysis,
                  primaryIsT2 ? "yolo-world" : "yolo-local",
                  undefined, undefined,
                  wasteT1All.length > 0 ? { tier1: wasteT1All.map(d => ({ itemName: d.className, confidence: d.confidence })) } : undefined,
                );
              }
              mergeAndDeliver(tier2Results, [], []);
              return;
            }

            // Still unresolved items — send per-bbox crops to API
            if (stillUnresolved.length > 0) {
              // Update unresolvedDetections for the batch API call
              unresolvedDetections.length = 0;
              unresolvedDetections.push(...stillUnresolved);
            }

            // Update subclassDetections for the Tier 3 material API call
            if (subclassStillPending.length > 0) {
              subclassDetections.length = 0;
              subclassDetections.push(...subclassStillPending);
            } else {
              subclassDetections.length = 0;
            }
          } else {
            console.log(`[tier2] YOLO World no detections (${worldMs}ms) — falling through to API`);
            // No YOLO World results — all sub-class detections need Tier 3 (no hints to add)
          }

          // Tier 3: per-bbox cropped API, material identification, or full-frame multi-item fallback
          const tier3Promises: Promise<(ClassificationResponse & { _bboxX?: number })[]>[] = [];

          if (unresolvedDetections.length > 0) {
            const wdHints = worldDetections.map(d => ({ className: d.className, confidence: d.confidence }));
            tier3Promises.push(sendCroppedBatchApi(wdHints));
          }
          if (subclassDetections.length > 0) {
            tier3Promises.push(sendSubclassBatchApi(subclassTier2Hints));
          }

          if (tier3Promises.length > 0) {
            Promise.all(tier3Promises)
              .then((allBatchResults) => {
                const combined = allBatchResults.flat();
                mergeAndDeliver(tier2Results, combined, []);
              })
              .catch((err) => {
                if (tier1Results.length + tier2Results.length > 0) {
                  mergeAndDeliver(tier2Results, [], []);
                } else {
                  handleClassificationError(err);
                }
              });
          } else if (zeroBboxFallback && tier1Results.length + tier2Results.length === 0) {
            // Zero-detection fallback: send full frame to API (multi-item prompt)
            const t2Hints = worldDetections.map(d => ({ itemName: d.className, confidence: d.confidence }));
            const promise = apiInflight ?? apiPromise(true, buildTr(t2Hints));
            promise
              .then(({ result: r, requestId }) => {
                if (r) mergeAndDeliver(tier2Results, [r as ClassificationResponse & { _bboxX?: number }], [requestId]);
                else if (tier1Results.length + tier2Results.length > 0) mergeAndDeliver(tier2Results, [], []);
                else handleClassificationError(new Error("API returned no result"));
              })
              .catch((err) => {
                const fallbackDet = worldDetections[0];
                let fallbackName = yoloBest?.className ?? fallbackDet?.className;
                const fallbackConf = yoloBest?.confidence ?? (fallbackDet?.confidence ?? 0.1);
                if (fallbackName && fallbackDet) {
                  const fbHint = analyzeMaterial(video, fallbackDet.bbox);
                  fallbackName = refineClassName(fallbackName, fbHint);
                }
                if (fallbackName) {
                  handleClassificationResult(buildOfflineFallback(fallbackName, fallbackConf), undefined);
                } else if (tier1Results.length + tier2Results.length > 0) {
                  mergeAndDeliver(tier2Results, [], []);
                } else {
                  handleClassificationError(err);
                }
              });
          } else if (tier1Results.length + tier2Results.length > 0) {
            // We have some resolved results — deliver them
            mergeAndDeliver(tier2Results, [], []);
          }
        })
        .catch(() => {
          // YOLO World failed — fall through to API
          if (unresolvedDetections.length > 0) {
            sendCroppedBatchApi()
              .then((batchResults) => mergeAndDeliver([], batchResults, []))
              .catch(handleClassificationError);
          } else {
            const promise = apiInflight ?? apiPromise(zeroBboxFallback, buildTr());
            promise
              .then(({ result: r, requestId }) => {
                if (r) mergeAndDeliver([], [r as ClassificationResponse & { _bboxX?: number }], [requestId]);
                else handleClassificationError(new Error("API returned no result"));
              })
              .catch(handleClassificationError);
          }
        });
    }

    /** Handle offline classification: YOLO → YOLO World → offline fallback. */
    function handleOfflineClassification(
      video: HTMLVideoElement,
      backend: InferenceBackend | null,
      yoloReady: boolean | SiteConfig | null | undefined,
    ) {
      if (!yoloReady || !backend) {
        handleClassificationResult(buildOfflineFallback("unknown item", 0.1), undefined);
        return;
      }

      backend.detect(video)
        .then((detections) => {
          // Filter out non-waste classes (person, furniture, etc.)
          const wasteDetections = detections.filter(d => !isYoloClassNotWaste(d.className));
          if (wasteDetections.length > 0) {
            const best = wasteDetections[0];
            // Resolve multiple distinct detections (offline)
            const seen = new Set<string>();
            const resolvedResults: ClassificationResponse[] = [];
            for (const det of wasteDetections) {
              if (seen.has(det.className)) continue;
              seen.add(det.className);
              const r = resolveYoloDetection(det, siteConfigRef.current!, localeRef.current);
              if (r) resolvedResults.push(r);
              if (resolvedResults.length >= 4) break;
            }
            if (resolvedResults.length > 0) {
              console.log(`[offline] YOLO HIT: ${resolvedResults.map((r) => r.itemName).join(" + ")}`);
              handleMultiClassificationResults(resolvedResults, resolvedResults.map(() => undefined));
              return;
            }

            // Try YOLO World offline
            if (backend.isYoloWorldReady()) {
              backend.detectWorld(video)
                .then((worldDets) => {
                  if (worldDets.length > 0) {
                    const worldResult = resolveYoloWorldDetection(worldDets[0], siteConfigRef.current!, localeRef.current);
                    if (worldResult) {
                      console.log(`[offline] YOLO World HIT: ${worldDets[0].className} → ${worldResult.wasteStream}`);
                      handleClassificationResult(worldResult, undefined);
                      return;
                    }
                  }
                  handleClassificationResult(buildOfflineFallback(best.className, best.confidence), undefined);
                })
                .catch(() => {
                  handleClassificationResult(buildOfflineFallback(best.className, best.confidence), undefined);
                });
              return;
            }

            handleClassificationResult(buildOfflineFallback(best.className, best.confidence), undefined);
          } else {
            // Only non-waste or no detections — try YOLO World
            if (backend.isYoloWorldReady()) {
              backend.detectWorld(video)
                .then((worldDets) => {
                  if (worldDets.length > 0) {
                    const worldResult = resolveYoloWorldDetection(worldDets[0], siteConfigRef.current!, localeRef.current);
                    if (worldResult) {
                      console.log(`[offline] YOLO World HIT: ${worldDets[0].className} → ${worldResult.wasteStream}`);
                      handleClassificationResult(worldResult, undefined);
                      return;
                    }
                  }
                  handleClassificationResult(buildOfflineFallback("unknown item", 0.1), undefined);
                })
                .catch(() => {
                  handleClassificationResult(buildOfflineFallback("unknown item", 0.1), undefined);
                });
            } else {
              handleClassificationResult(buildOfflineFallback("unknown item", 0.1), undefined);
            }
          }
        })
        .catch(() => {
          handleClassificationResult(buildOfflineFallback("unknown item", 0.1), undefined);
        });
    }

    /** Build a minimal classification result for offline/fallback scenarios. */
    function buildOfflineFallback(
      className: string,
      confidence: number,
    ): ClassificationResponse {
      const streams = siteConfigRef.current?.streams ?? [];
      const reviewStream = streams.find((s) => s.id === "needs_review");
      return {
        itemName: className,
        wasteStream: "needs_review",
        confidence: Math.min(confidence, 0.3),
        reasoning: localeRef.current === "ja"
          ? "オフラインで分類されました。スタッフに確認してください。"
          : "Classified offline — please verify with staff.",
        binColor: reviewStream?.color ?? "#D97706",
        binLabel: reviewStream?.label ?? "Needs Verification",
        needsReview: true,
        isCompound: false,
        modelUsed: "yolo-local",
      };
    }

    function handleClassificationResult(
      result: ClassificationResponse & { requestId?: string },
      requestId: string | undefined,
    ) {
      handleMultiClassificationResults([result], [requestId ?? result.requestId]);
    }

    function handleMultiClassificationResults(
      results: (ClassificationResponse & { requestId?: string })[],
      requestIds: (string | undefined)[],
    ) {
      // Filter out "nothing detected" results
      const valid = results.filter(
        (r) => r.itemName?.toLowerCase() !== "nothing detected" && r.confidence !== 0
      );

      if (valid.length === 0) {
        nothingDetectedCountRef.current = 0;
        setStableResults([{
          itemName: "nothing_detected",
          wasteStream: "landfill",
          confidence: 0,
          reasoning: "",
          binColor: "#525252",
          binLabel: "",
          needsReview: false,
          isCompound: false,
        }]);
        setResultRequestIds([]);
        setError(null);
        goneCountRef.current = 0;
        resultEnterTimeRef.current = Date.now();
        transition("result");
        inFlightRef.current = false;
        return;
      }

      // Successful classification — reset the nothing-detected counter
      nothingDetectedCountRef.current = 0;
      setStableResults(valid);
      setResultRequestIds(
        valid.map((r) => requestIds[results.indexOf(r)] ?? r.requestId)
      );
      setError(null);
      goneCountRef.current = 0;
      resultEnterTimeRef.current = Date.now();
      transition("result");

      for (const result of valid) {
        const cacheKey = `${result.itemName}::${result.wasteStream}`;
        if (cacheKey !== lastCachedRef.current) {
          cacheResult(result, localeRef.current);
          lastCachedRef.current = cacheKey;
        }
      }
      inFlightRef.current = false;
    }

    function handleClassificationError(err: unknown) {
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

    async function classifyViaApiAsync(
      video: HTMLVideoElement,
      analysis: FrameAnalysis,
      signal?: AbortSignal,
      yoloDetections?: YoloDetectionLog[],
      materialHint?: MaterialHint,
      /** When true, uses multi-item prompt — for zero-detection fallback. */
      multi?: boolean,
      tierResults?: { tier1?: { itemName: string; confidence: number }[]; tier2?: { itemName: string; confidence: number }[] },
    ): Promise<{ result: (ClassificationResponse & { requestId?: string }) | null; requestId?: string }> {
      // Send the same center short-side square that YOLO sees to the API.
      const procStart = Date.now();
      const vw = video.videoWidth;
      const vh = video.videoHeight;
      const side = Math.min(vw, vh);
      const roiX = Math.round((vw - side) / 2);
      const roiY = Math.round((vh - side) / 2);

      const cropCanvas = new OffscreenCanvas(side, side);
      const cropCtx = cropCanvas.getContext("2d");
      if (!cropCtx) return { result: null };

      cropCtx.drawImage(video, roiX, roiY, side, side, 0, 0, side, side);
      const cropMs = Date.now() - procStart;

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

      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

      const result = await classify(frame, meta, yoloDetections, materialHint, multi, tierResults);
      return { result, requestId: result.requestId };
    }
  }, [classify, transition, T]);


  // ── Derive which full-screen UI to show ──
  if (!mounted) return null;

  // Show loading screen until all models are warm
  if (!overallReady) {
    return (
      <div className="h-screen w-screen bg-neutral-950 flex flex-col items-center justify-center select-none">
        {/* Logo */}
        <img
          src="/logo.svg"
          alt="Wayste"
          className="w-28 h-28 mb-8 animate-pulse"
        />
        {/* Spinner */}
        <div className="w-10 h-10 mb-6 border-3 border-neutral-700 border-t-emerald-400 rounded-full animate-spin" />
        {/* Loading message */}
        <p className="text-neutral-300 text-lg font-medium">
          {T(loadingMessage)}
        </p>
      </div>
    );
  }

  const uiScreen: "idle" | "camera" | "result" =
    pipelineState === "result"
      ? "result"
      : pipelineState === "object_detected" || pipelineState === "classifying"
        ? "camera"
        : "idle"; // idle + cooldown both show idle screen


  return (
    <div className="h-screen w-screen bg-neutral-950 relative overflow-hidden select-none">
      {/* Camera feed — only mounted after models are ready */}
      <div
        className="absolute inset-0"
      >
        <CameraFeed
          ref={cameraRef}
          mirror={process.env.NEXT_PUBLIC_MIRROR_CAMERA === "true"}
        />
      </div>

      {/* Error overlay — shown on top of any screen */}
      {error && (
        <div className="absolute top-6 left-1/2 -translate-x-1/2 z-30 bg-red-900/80 backdrop-blur-sm rounded-xl px-5 py-3 max-w-md">
          <p className="text-red-200 text-sm font-medium text-center">{error}</p>
          <p className="text-red-400/60 text-xs text-center mt-1">
            {T("retryingAutomatically")}
          </p>
        </div>
      )}

      {/* Full-screen UI states */}
      {uiScreen === "idle" && (
        <IdleScreen
          locale={locale}
          onToggleLocale={toggleLocale}
          statsVersion={statsVersion}
          voiceEnabled={voiceEnabled}
          onToggleVoice={toggleVoice}
          detectionRoiMargin={DETECTION_ROI_MARGIN}
        />
      )}

      {uiScreen === "camera" && (
        <CameraScreen
          pipelineState={pipelineState}
          locale={locale}
          detectionRoiMargin={DETECTION_ROI_MARGIN}
        />
      )}

      {uiScreen === "result" && stableResults.length > 0 && (
        <ResultScreen
          results={stableResults}
          locale={locale}
          onToggleLocale={toggleLocale}
          voiceEnabled={voiceEnabled}
          streams={siteStreams}
        />
      )}

      {/* System status badge — hidden during result screen to avoid overlap */}
      {uiScreen !== "result" && (
        <SystemStatusBadge thermalWarning={thermalWarning} />
      )}
    </div>
  );
}
