"use client";

import { useRef, useEffect, useCallback, useState } from "react";
import type {
  ClassificationResponse,
  PipelineState,
  FrameAnalysis,
  ClassifyMeta,
  SiteConfig,
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
} from "@/lib/inference-backend";
import { computeThresholds, type ThresholdConfig, type Calibration } from "@/lib/threshold-config";
import { perfMonitor } from "@/lib/perf-monitor";
import { loadYoloRules, resolveYoloDetection, isYoloClassNotWaste } from "@/lib/yolo-rules";
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
/** FG frames required to start the YOLO continuous loop. Kept low — YOLO
 *  handles its own quality; FG is just the "someone is approaching" trigger. */
const FG_TRIGGER_FRAMES = 2;
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
/** YOLO cycles with no waste detections (but FG present) before escalating to API. */
const API_ESCALATION_CYCLES = 5;
/** YOLO cycles a previously-seen detection must be absent before removing it from results. */
const YOLO_GONE_CYCLES = 3;

// ── Background adaptation rates (passed to FrameAnalyzer per pipeline state) ──
// idle / cooldown: full rate — continuously absorb drift and persistent leftovers
const BG_RATE_IDLE = 0.025; // matches BG_LEARN_RATE in frame-analyzer
// result: frozen — BG model still holds the pre-item scene, so item-vs-empty
// diff stays accurate; absorbing the item would erode foreground detection
const BG_RATE_RESULT = 0;
// classifying: frozen — never absorb the held object
const BG_RATE_FROZEN = 0;

// ── ROI margins (fractions of the short-side square capture crop) ──
// frame-analyzer crops center 720×720 from 1280×720 for FG detection.
// DETECTION_ROI_MARGIN: outer FG detection area (nearly full 720×720).
// YOLO_TARGET_INSET: inner YOLO analysis zone (640×640 = 89% of 720).
const DETECTION_ROI_MARGIN = 0.02;
const YOLO_TARGET_INSET = (1 - 640 / 720) / 2; // ~0.0556

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
  const [loadingMessage, setLoadingMessage] = useState<"loading_model_1" | "loading_ready">("loading_model_1");

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
  // Keep stableResultsRef in sync for stale-closure-safe reads in YOLO loop
  useEffect(() => { stableResultsRef.current = stableResults; }, [stableResults]);

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
  const resultEnterTimeRef = useRef(0);
  const classifyStartRef = useRef(0);
  /** Consecutive "nothing detected" results — suppresses reclassification of persistent non-waste objects. */
  const nothingDetectedCountRef = useRef(0);
  const cooldownStartRef = useRef(0);
  const inFlightRef = useRef(false);
  // ── YOLO continuous loop refs ──
  const yoloRunningRef = useRef(false);
  /** Consecutive YOLO cycles with no waste detections (while FG present). */
  const yoloEmptyCyclesRef = useRef(0);
  /** Per-className gone counter — tracks how many YOLO cycles each shown result has been absent. */
  const detectionGoneMapRef = useRef<Map<string, number>>(new Map());
  /** Mirror of stableResults for stale-closure-safe reads in the YOLO loop. */
  const stableResultsRef = useRef<ClassificationResponse[]>([]);
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
      }),
      loadYoloRules(),
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
    async (frame: string, meta: ClassifyMeta, yoloDetections?: YoloDetectionLog[], multi?: boolean, tierResults?: { tier1?: { itemName: string; confidence: number }[] }): Promise<ClassificationResponse & { requestId?: string }> => {
      const doFetch = async (): Promise<ClassificationResponse & { requestId?: string }> => {
        const fetchStartMs = Date.now();
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), API_TIMEOUT_MS);

        try {
          const reqBody = { image: frame, meta, locale, yoloDetections, ...(multi && { multi: true }), ...(tierResults && { tierResults }) };
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
              const retryResult = { ...retryData.results[0], requestId: retryData.requestId } as ClassificationResponse & { _multiResults?: ClassificationResponse[] };
              if (retryData.results.length > 1) retryResult._multiResults = retryData.results;
              return retryResult;
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
            if (responseData.results.length === 0) {
              console.warn("[classify] Multi-item returned no results — treating as unclassifiable");
              return {
                itemName: "unknown",
                wasteStream: "landfill",
                confidence: 0,
                reasoning: "Classification returned no results",
                binColor: "#525252",
                binLabel: "",
                needsReview: true,
                isCompound: false,
                modelUsed: "t2" as const,
              };
            }
          }
          const data: ClassificationResponse & { requestId?: string; _multiResults?: ClassificationResponse[] } =
            Array.isArray(responseData.results)
              ? { ...responseData.results[0], requestId: responseData.requestId }
              : responseData;
          // Preserve all multi-item results so callers can display them all
          if (Array.isArray(responseData.results) && responseData.results.length > 1) {
            data._multiResults = responseData.results;
          }
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

      // During classifying, still run FG analysis but skip the heavy parts.
      // YOLO loop runs independently — here we just monitor FG presence and timeout.
      if (stateRef.current === "classifying") {
        // Continue with frame analysis below so FG detection stays active
        // (needed to detect hand leaving during YOLO scanning).
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
        // FG detection is the "early warning" sensor. When something enters
        // the wide detection ROI (larger than YOLO's 640×640 zone), start the
        // YOLO continuous loop so it's already running by the time the hand
        // reaches the center. No quality or stability gate — YOLO handles that.
        if (roiHasFg) {
          fgPersistRef.current++;
          if (fgPersistRef.current >= FG_TRIGGER_FRAMES) {
            fgPersistRef.current = 0;
            goneCountRef.current = 0;
            yoloEmptyCyclesRef.current = 0;
            detectionGoneMapRef.current.clear();
            classifyStartRef.current = Date.now();
            transition("classifying");
            startYoloLoop(analyzer);
          }
        } else {
          fgPersistRef.current = 0;
          if (nothingDetectedCountRef.current > 0) {
            nothingDetectedCountRef.current = 0;
          }
        }
        return;
      }

      // classifying: YOLO loop is running, waiting for detections.
      // The loop itself handles result transitions via handleYoloCycleResult.
      // Here we only handle FG disappearing (hand left) and timeout.
      if (state === "classifying") {
        if (!roiHasFg) {
          goneCountRef.current++;
          if (goneCountRef.current >= RESULT_GONE_FRAMES) {
            console.log(`[classifying] FG gone → idle`);
            stopYoloLoop();
            goneCountRef.current = 0;
            nothingDetectedCountRef.current++;
            analyzer.boostBackgroundAdaptation();
            cooldownStartRef.current = Date.now();
            transition("cooldown");
          }
        } else {
          goneCountRef.current = 0;
        }
        // Timeout escape hatch
        if (Date.now() - classifyStartRef.current >= CLASSIFYING_TIMEOUT_MS) {
          console.log(`[classifying] timeout → cooldown`);
          stopYoloLoop();
          analyzer.boostBackgroundAdaptation();
          cooldownStartRef.current = Date.now();
          transition("cooldown");
        }
        return;
      }

      if (state === "result") {
        // YOLO loop is still running — it updates results dynamically.
        // FG analysis provides the "everything gone" exit signal.
        if (!resultHasFg) {
          goneCountRef.current++;
          if (goneCountRef.current >= RESULT_GONE_FRAMES) {
            console.log(`[result] FG gone → cooldown`);
            stopYoloLoop();
            analyzer.boostBackgroundAdaptation();
            cooldownStartRef.current = Date.now();
            transition("cooldown");
          }
        } else {
          goneCountRef.current = 0;
          // Persistent-leftover escape hatch
          if (Date.now() - resultEnterTimeRef.current >= RESULT_TIMEOUT_MS) {
            console.log(`[result] timeout → cooldown`);
            stopYoloLoop();
            setStableResults([]); setResultRequestIds([]);
            analyzer.boostBackgroundAdaptation();
            cooldownStartRef.current = Date.now();
            transition("cooldown");
          }
        }
        return;
      }

      if (state === "cooldown") {
        const effectiveCooldown = nothingDetectedCountRef.current > 1
          ? Math.min(COOLDOWN_MS * nothingDetectedCountRef.current, 2_500)
          : COOLDOWN_MS;
        const cooldownElapsed = Date.now() - cooldownStartRef.current >= effectiveCooldown;
        const errorHeld = !errorRef.current || (Date.now() - errorSetAtRef.current >= ERROR_HOLD_MS);

        // If a new item is pending, start YOLO loop immediately
        if (pendingItemRef.current && errorHeld) {
          setStableResults([]); setResultRequestIds([]);
          setError(null);
          pendingItemRef.current = false;
          fgPersistRef.current = 0;
          goneCountRef.current = 0;
          yoloEmptyCyclesRef.current = 0;
          detectionGoneMapRef.current.clear();
          if (roiHasFg) {
            classifyStartRef.current = Date.now();
            transition("classifying");
            startYoloLoop(analyzer);
          } else {
            transition("idle");
          }
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
      yoloRunningRef.current = false; // stop YOLO loop on unmount
    };

    // ── YOLO continuous loop ──
    // Runs back-to-back inference as fast as the model allows (~7-10fps for
    // medium models on WebGPU). Started when FG detects an approaching hand,
    // continues through classifying and result states, stopped when everything
    // leaves the frame.

    function startYoloLoop(currentAnalyzer: FrameAnalyzer) {
      if (yoloRunningRef.current) return;
      const backend = inferenceRef.current;
      if (!backend?.isReady() || !siteConfigRef.current) return;
      yoloRunningRef.current = true;
      console.log(`[yolo-loop] started`);
      // Fire-and-forget async loop
      (async () => {
        while (yoloRunningRef.current) {
          const video = cameraRef.current?.getVideo();
          if (!video) { await new Promise(r => setTimeout(r, 50)); continue; }

          const yoloStart = Date.now();
          let detections: YoloDetection[];
          try {
            detections = await backend.detect(video);
          } catch {
            detections = [];
          }
          const yoloMs = Date.now() - yoloStart;
          perfMonitor.recordYoloInference(yoloMs);

          // Read latest FG analysis from the CV loop
          const analysis = lastAnalysisRef.current;

          handleYoloCycleResult(detections, yoloMs, video, analysis, currentAnalyzer);
        }
        console.log(`[yolo-loop] stopped`);
      })();
    }

    function stopYoloLoop() {
      yoloRunningRef.current = false;
    }

    /** Process one YOLO cycle result — drive state transitions + update displayed results. */
    function handleYoloCycleResult(
      detections: YoloDetection[],
      yoloMs: number,
      video: HTMLVideoElement,
      analysis: FrameAnalysis | null,
      currentAnalyzer: FrameAnalyzer,
    ) {
      const state = stateRef.current;
      const th = thresholdsRef.current;
      const wasteDetections = detections.filter(d => !isYoloClassNotWaste(d.className));

      // ── Resolve detections via YOLO rules ──
      const resolvedResults: (ClassificationResponse & { _bboxX?: number })[] = [];
      let unresolvedCount = 0;
      for (const det of wasteDetections.slice(0, 4)) {
        const bboxX = det.bbox[0] + det.bbox[2] / 2;
        if (det.confidence >= th.YOLO_FALLBACK_THRESHOLD) {
          const r = resolveYoloDetection(det, siteConfigRef.current!, localeRef.current);
          if (r) {
            (r as ClassificationResponse & { _bboxX?: number })._bboxX = bboxX;
            resolvedResults.push(r as ClassificationResponse & { _bboxX?: number });
            continue;
          }
        }
        unresolvedCount++;
      }

      const hasResults = resolvedResults.length > 0;

      if (state === "classifying") {
        if (hasResults) {
          // YOLO found items → show result immediately
          resolvedResults.sort((a, b) => (a._bboxX ?? 0) - (b._bboxX ?? 0));
          console.log(`[yolo-loop] HIT: ${resolvedResults.map(r => r.itemName).join(" + ")} in ${yoloMs}ms`);

          if (analysis) {
            logYoloOnlyResult(video, resolvedResults[0], detections, yoloMs, analysis, "T1", undefined, undefined,
              { tier1: wasteDetections.map(d => ({ itemName: d.className, confidence: d.confidence })).sort((a, b) => b.confidence - a.confidence).slice(0, 5) });
          }

          handleMultiClassificationResults(resolvedResults, resolvedResults.map(() => undefined));
          yoloEmptyCyclesRef.current = 0;
          detectionGoneMapRef.current.clear();
        } else {
          // No YOLO results this cycle
          yoloEmptyCyclesRef.current++;

          // API escalation: YOLO can't find anything but FG says something is there
          if (yoloEmptyCyclesRef.current >= API_ESCALATION_CYCLES
              && analysis && imageQualityBand(analysis) === "good"
              && !inFlightRef.current) {
            console.log(`[yolo-loop] ${API_ESCALATION_CYCLES} empty cycles → escalating to API`);
            inFlightRef.current = true;
            const tier1Hints = wasteDetections
              .map(d => ({ itemName: d.className, confidence: d.confidence }))
              .sort((a, b) => b.confidence - a.confidence).slice(0, 5);
            classifyViaApiAsync(video, analysis, new AbortController().signal, undefined, true, { tier1: tier1Hints })
              .then(({ result: r, requestId, multiResults }) => {
                const apiResults = multiResults ?? (r ? [r] : []);
                if (apiResults.length > 0) {
                  handleMultiClassificationResults(apiResults, apiResults.map(() => requestId));
                } else {
                  nothingDetectedCountRef.current++;
                  cooldownStartRef.current = Date.now();
                  transition("cooldown");
                  stopYoloLoop();
                }
                inFlightRef.current = false;
              })
              .catch(() => {
                nothingDetectedCountRef.current++;
                cooldownStartRef.current = Date.now();
                transition("cooldown");
                stopYoloLoop();
                inFlightRef.current = false;
              });
          }
        }
        return;
      }

      if (state === "result") {
        // ── Dynamic result updates ──
        // Track which displayed items YOLO still sees vs which have disappeared.
        const currentClasses = new Set(resolvedResults.map(r => r.itemName));
        const goneMap = detectionGoneMapRef.current;

        // Update gone counters for displayed results
        const displayedResults = stableResultsRef.current;
        for (const displayed of displayedResults) {
          if (currentClasses.has(displayed.itemName)) {
            // Still visible — reset gone counter
            goneMap.delete(displayed.itemName);
          } else {
            // Not seen this cycle
            goneMap.set(displayed.itemName, (goneMap.get(displayed.itemName) ?? 0) + 1);
          }
        }

        // Remove items that have been gone for YOLO_GONE_CYCLES
        const toRemove = new Set<string>();
        for (const [name, count] of goneMap) {
          if (count >= YOLO_GONE_CYCLES) {
            toRemove.add(name);
            goneMap.delete(name);
          }
        }

        // Add new items that weren't in existing results
        const existingClasses = new Set(displayedResults.map(r => r.itemName));
        const newResults = resolvedResults.filter(r => !existingClasses.has(r.itemName));

        if (toRemove.size > 0 || newResults.length > 0) {
          const updated = [
            ...displayedResults.filter(r => !toRemove.has(r.itemName)),
            ...newResults,
          ].slice(0, 4);

          if (toRemove.size > 0) console.log(`[yolo-loop] removed: ${[...toRemove].join(", ")}`);
          if (newResults.length > 0) console.log(`[yolo-loop] added: ${newResults.map(r => r.itemName).join(", ")}`);

          if (updated.length === 0) {
            // All items removed by YOLO — but wait for FG to confirm exit
            // (handled by the FG-based gone detection in the main CV loop)
          } else {
            setStableResults(updated);
            setResultRequestIds(updated.map(() => undefined));
          }
        }
        return;
      }
    }

    /** Log a YOLO-only classification to the server (fire-and-forget).
     *  Needed because YOLO wins skip the /api/classify route entirely. */
    function logYoloOnlyResult(
      video: HTMLVideoElement,
      result: ClassificationResponse,
      detections: YoloDetection[],
      latencyMs: number,
      analysis: FrameAnalysis,
      modelUsed: "T1" = "T1",
      _hint?: unknown,
      _refinedFrom?: unknown,
      tierResults?: { tier1?: { itemName: string; confidence: number }[] },
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
    // Tier 2: OpenAI API (GPT-5.4-mini) → ~1-3s
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

      // If offline, use local YOLO only → offline fallback
      if (isOffline) {
        handleOfflineClassification(video, backend, yoloReady);
        return;
      }

      const apiController = new AbortController();
      let yoloDetectionLogs: YoloDetectionLog[] | undefined;
      type TierHints = { tier1?: { itemName: string; confidence: number }[] };
      const apiPromise = (multi?: boolean, tierResults?: TierHints) => classifyViaApiAsync(video, analysis, apiController.signal, yoloDetectionLogs, multi, tierResults);

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

          // ── Detection routing ──
          const resolvedResults: (ClassificationResponse & { _bboxX?: number })[] = [];
          let unresolvedCount = 0;

          for (const detection of wasteDetections.slice(0, 4)) {
            const bboxX = detection.bbox[0] + detection.bbox[2] / 2; // center-x
            if (detection.confidence >= thresholdsRef.current.YOLO_FALLBACK_THRESHOLD) {
              const r = resolveYoloDetection(detection, siteConfigRef.current!, localeRef.current);
              if (r) {
                (r as ClassificationResponse & { _bboxX?: number })._bboxX = bboxX;
                resolvedResults.push(r as ClassificationResponse & { _bboxX?: number });
                continue;
              }
            }
            unresolvedCount++;
          }

          // All items resolved locally → instant result
          if (resolvedResults.length > 0 && unresolvedCount === 0) {
            resolvedResults.sort((a, b) => (a._bboxX ?? 0) - (b._bboxX ?? 0));
            console.log(`[tier1] YOLO HIT: ${resolvedResults.map((r) => r.itemName).join(" + ")} in ${yoloMs}ms`);
            logYoloOnlyResult(video, resolvedResults[0], detections, yoloMs, analysis, "T1", undefined, undefined,
              { tier1: wasteDetections.map(d => ({ itemName: d.className, confidence: d.confidence })).sort((a, b) => b.confidence - a.confidence).slice(0, 5) });
            handleMultiClassificationResults(resolvedResults, resolvedResults.map(() => undefined));
            return;
          }

          // ── Some or all items need API resolution (Tier 2) ──
          const best = wasteDetections[0] ?? null;
          const hasBlobPresence = blobs.some(b => blobIsObject(b));

          if (best || unresolvedCount > 0 || hasBlobPresence) {
            const tier1Hints = wasteDetections
              .map(d => ({ itemName: d.className, confidence: d.confidence }))
              .sort((a, b) => b.confidence - a.confidence)
              .slice(0, 5);

            console.log(`[tier1] ${resolvedResults.length} resolved, ${unresolvedCount} unresolved — escalating to API`);

            escalateToApi(
              best, apiPromise, resolvedResults, tier1Hints,
            );
          } else {
            // No waste detections and no qualified blobs
            if (detections.length > 0) {
              console.log(`[tier1] Only non-waste detections (${detections.map(d => d.className).join(", ")}) in ${yoloMs}ms — ignoring`);
              nothingDetectedCountRef.current++;
              cooldownStartRef.current = Date.now();
              transition("cooldown");
              inFlightRef.current = false;
              return;
            }
            // No YOLO detections at all — full-frame API fallback
            console.log(`[tier1] No YOLO detections (${yoloMs}ms) — escalating to API`);
            escalateToApi(null, apiPromise, [], []);
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

    /** Escalate to the API (Tier 2) with full-frame multi-item prompt. */
    function escalateToApi(
      yoloBest: { className: string; confidence: number } | null,
      apiPromise: (multi?: boolean, tierResults?: { tier1?: { itemName: string; confidence: number }[] }) => Promise<{ result: (ClassificationResponse & { requestId?: string }) | null; requestId?: string; multiResults?: ClassificationResponse[] }>,
      tier1Results: (ClassificationResponse & { _bboxX?: number })[],
      tier1Hints: { itemName: string; confidence: number }[],
    ) {
      // Show optimistic T1 results while waiting for API
      if (tier1Results.length > 0) {
        tier1Results.sort((a, b) => (a._bboxX ?? 0) - (b._bboxX ?? 0));
        setStableResults(tier1Results);
        resultEnterTimeRef.current = Date.now();
      }

      // Always send full frame — cheaper and more reliable than per-bbox crops
      apiPromise(true, { tier1: tier1Hints })
        .then(({ result: r, requestId, multiResults }) => {
          const apiResults = multiResults ?? (r ? [r] : []);
          if (apiResults.length > 0) {
            handleMultiClassificationResults(apiResults, apiResults.map(() => requestId));
          } else if (tier1Results.length > 0) {
            handleMultiClassificationResults(tier1Results, tier1Results.map(() => undefined));
          } else {
            handleClassificationError(new Error("API returned no result"));
          }
        })
        .catch((err) => {
          if (tier1Results.length > 0) {
            handleMultiClassificationResults(tier1Results, tier1Results.map(() => undefined));
          } else if (yoloBest) {
            handleClassificationResult(buildOfflineFallback(yoloBest.className, yoloBest.confidence), undefined);
          } else {
            handleClassificationError(err);
          }
        });
    }

    /** Handle offline classification: YOLO → rules → offline fallback. */
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
          const wasteDetections = detections.filter(d => !isYoloClassNotWaste(d.className));
          if (wasteDetections.length > 0) {
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
            // No rules matched — use best detection as fallback
            handleClassificationResult(buildOfflineFallback(wasteDetections[0].className, wasteDetections[0].confidence), undefined);
          } else {
            handleClassificationResult(buildOfflineFallback("unknown item", 0.1), undefined);
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
        modelUsed: "T1",
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
        nothingDetectedCountRef.current++;
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
      /** When true, uses multi-item prompt — for zero-detection fallback. */
      multi?: boolean,
      tierResults?: { tier1?: { itemName: string; confidence: number }[] },
    ): Promise<{ result: (ClassificationResponse & { requestId?: string }) | null; requestId?: string; multiResults?: ClassificationResponse[] }> {
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

      const result = await classify(frame, meta, yoloDetections, multi, tierResults);
      const multiResults = (result as ClassificationResponse & { _multiResults?: ClassificationResponse[] })._multiResults;
      return { result, requestId: result.requestId, multiResults };
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
      : pipelineState === "classifying"
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
          yoloTargetInset={YOLO_TARGET_INSET}
        />
      )}

      {uiScreen === "camera" && (
        <CameraScreen
          pipelineState={pipelineState}
          locale={locale}
          detectionRoiMargin={DETECTION_ROI_MARGIN}
          yoloTargetInset={YOLO_TARGET_INSET}
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
