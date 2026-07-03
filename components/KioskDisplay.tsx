"use client";

import { useRef, useEffect, useCallback, useState } from "react";
import type {
  ClassificationResponse,
  TrackedResult,
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
import { buildClassificationResult } from "@/lib/waste-rules-core";
import {
  computeFrameFingerprint,
  frameDiff,
  greedyIoUMatch,
  computeIoU,
  type Bbox,
} from "@/lib/bbox-utils";
// kioskAuthHeaders replaced by session token (server-generated, HMAC-signed)
import { recordSort } from "@/lib/kiosk-counter";
import CameraFeed, { type CameraFeedHandle } from "./CameraFeed";
import IdleScreen from "./IdleScreen";
import CameraScreen from "./CameraScreen";
import ResultScreen from "./ResultScreen";
import SystemStatusBadge from "./SystemStatusBadge";

// ── Timing constants ──
const ANALYSIS_INTERVAL_MS = 30;  // ~33 fps local CV
const COOLDOWN_MS = 3500; // pause before re-scanning (BG model recovery + seedling animation)
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
const CLASSIFYING_TIMEOUT_MS = 10_000;
/** Time without meaningful frame changes before escalating to API (ms). */
const FRAME_STALE_ESCALATION_MS = 700;
/** Mean pixel diff threshold for "frame has changed significantly" (0–255 scale). */
const FRAME_CHANGE_THRESHOLD = 8;
/** Frame-change YOLO cycles a tracked item must be absent before removing from results.
 *  Higher = more stable display (items don't flicker when YOLO misses a few frames).
 *  At ~30fps YOLO loop rate, 10 cycles ≈ 300ms of continuous absence. */
const YOLO_GONE_CYCLES = 10;
/** Frame-change cycles a new detection must persist in result state before being added.
 *  Prevents flicker from transient YOLO false positives or shifted bboxes. */
const NEW_ITEM_PERSIST_CYCLES = 3;
/** Frame-change cycles an unresolved new item persists before API escalation from result state. */
const UNRESOLVED_ESCALATION_CYCLES = 5;
/** Delay (ms) after entering result state before firing a proactive API sweep
 *  to catch items outside YOLO's vocabulary. Only fires for T1-only results. */
const RESULT_API_SWEEP_DELAY_MS = 1_500;

// ── Cloud fallback (pilot experiments only) ──
/** OFF by default: items YOLO can't confidently resolve become `needs_review`
 *  on-device, and no frame ever leaves the kiosk for classification.
 *  Set NEXT_PUBLIC_CLOUD_FALLBACK=1 to re-enable the legacy GPT escalation
 *  path — pilot experiments only (e.g. the cloud-vs-local shadow comparison
 *  via LOCAL_VLM_ENDPOINT on the server). */
const CLOUD_FALLBACK_ENABLED = process.env.NEXT_PUBLIC_CLOUD_FALLBACK === "1";
/** Confidence assigned to on-device needs_review fallbacks. Must be > 0 —
 *  handleMultiClassificationResults treats confidence 0 as the
 *  "nothing detected" sentinel (see resolveYoloDetection's not_waste branch)
 *  and would discard the card. Kept far below any reviewThreshold so the
 *  result always renders as needs_review. */
const LOCAL_FALLBACK_CONFIDENCE = 0.01;

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
const DETECTION_ROI_MARGIN = 0.10;
const YOLO_TARGET_INSET = 0.10;

const ROI_BLOB_DIAGONAL_MIN_AREA = 0.01;

const YOLO_MODEL_SIZE = 640;

/** Whether the camera feed is mirrored (front-facing / selfie cameras). */
const IS_CAMERA_MIRRORED = process.env.NEXT_PUBLIC_MIRROR_CAMERA === "true";

/**
 * Sort tracked results by physical position (left-to-right on screen).
 * Mirrored camera: high center-x in YOLO space = physical left → sort descending.
 * Non-mirrored: low center-x = physical left → sort ascending.
 */
function sortByPhysicalPosition<T extends { _trackBbox: [number, number, number, number] }>(items: T[]): void {
  items.sort((a, b) => {
    const aCx = a._trackBbox[0] + a._trackBbox[2] / 2;
    const bCx = b._trackBbox[0] + b._trackBbox[2] / 2;
    return IS_CAMERA_MIRRORED ? (bCx - aCx) : (aCx - bCx);
  });
}

/** Score how well an API item name matches a YOLO class name (0 = no match). */
function nameMatchScore(apiName: string, yoloClassName: string): number {
  const api = apiName.toLowerCase();
  const yolo = yoloClassName.toLowerCase();
  if (api === yolo) return 3;
  if (api.includes(yolo)) return 2;
  if (yolo.includes(api)) return 1;
  const lastWord = api.split(/\s+/).pop() ?? "";
  if (lastWord.length >= 3 && (lastWord === yolo || yolo.includes(lastWord))) return 1;
  return 0;
}

/** Check if a bbox is the full-frame fallback (no real position data). */
function isFullFrameFallback(bbox: [number, number, number, number]): boolean {
  return bbox[0] === 0 && bbox[1] === 0 && bbox[2] === 640 && bbox[3] === 640;
}

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
    useState<TrackedResult[]>([]);
  const [resultRequestIds, setResultRequestIds] = useState<(string | undefined)[]>([]);
  /** Stream definitions from site config — passed to ResultScreen for bin position display. */
  const [siteStreams, setSiteStreams] = useState<import("@/lib/types").StreamDefinition[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [locale, setLocale] = useState<Locale>(defaultLocale ?? "en");
  // Keep stableResultsRef in sync for stale-closure-safe reads in YOLO loop
  useEffect(() => { stableResultsRef.current = stableResults; }, [stableResults]);

  /** Incremented each time the pipeline returns to idle after a classification.
   *  Drives idle-screen stats refresh. */
  const [statsVersion, setStatsVersion] = useState(0);

  // ── Voice guidance (site-config driven — end-users cannot toggle) ──
  const [voiceEnabled, setVoiceEnabled] = useState(false);
  /** Whether the camera feed is horizontally mirrored — read from site config. */
  const [mirrorCamera, setMirrorCamera] = useState(
    process.env.NEXT_PUBLIC_MIRROR_CAMERA === "true"
  );

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
  // ── YOLO loop refs ──
  const yoloRunningRef = useRef(false);
  /** Per-trackId gone counter — tracks how many frame-change YOLO cycles each tracked result has been absent. */
  const detectionGoneMapRef = useRef<Map<number, number>>(new Map());
  /** Monotonically increasing tracking ID counter. */
  const nextTrackIdRef = useRef(1);
  /** 32x32 reusable canvas for frame fingerprinting. */
  const fingerprintCanvasRef = useRef<OffscreenCanvas | null>(null);
  /** Grayscale fingerprint of the last frame that YOLO actually processed. */
  const lastYoloFingerprintRef = useRef<Uint8Array | null>(null);
  /** Timestamp of the last YOLO run. */
  const lastYoloRunTimeRef = useRef(0);
  /** AbortController for in-flight API call (enables YOLO race cancellation). */
  const apiAbortRef = useRef<AbortController | null>(null);
  /** Tracks unresolved new bboxes in result state for API escalation. */
  const unresolvedNewItemsRef = useRef<Map<string, { bbox: Bbox; count: number }>>(new Map());
  /** Timer for proactive API sweep in result state (catches items outside YOLO's vocabulary). */
  const resultSweepTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Latest waste detections from YOLO — used for bbox assignment to API results. */
  const latestWasteDetectionsRef = useRef<YoloDetection[]>([]);
  /** Mirror of stableResults for stale-closure-safe reads in the YOLO loop. */
  const stableResultsRef = useRef<TrackedResult[]>([]);
  const lastAnalysisRef = useRef<FrameAnalysis | null>(null);
  const lastCachedRef = useRef("");
  const errorSetAtRef = useRef(0);
  /** Last calibration object reference — detect rolling recalibration updates. */
  const lastCalibrationRef = useRef<Calibration | null>(null);
  const errorRef = useRef<string | null>(null);

  /** Whether the last classification was a successful sort (not nothing_detected). */
  const lastResultSuccessRef = useRef(false);
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
          // Voice and mirror are site-config driven — no end-user toggle.
          setVoiceEnabled(data.voiceEnabled ?? false);
          if (typeof data.mirrorCamera === "boolean") {
            setMirrorCamera(data.mirrorCamera);
          }
        })
        .catch(() => {}),
    ]);

    // Preload the BlazeFace face detector so the first real classification
    // (classify or T1 pilot-log) doesn't pay the ~5 MB WASM + 200 KB model
    // download cost. Not gated into overallReady — if this fails the kiosk
    // still works; call sites fail-closed (treat as "face present") so
    // privacy is preserved even without the detector.
    import("@/lib/face-detect")
      .then((m) => m.warmupFaceDetector())
      .catch(() => {});
  }, []);

  // Fetch defaultLocale from site-config API as a fallback when no prop was passed.
  useEffect(() => {
    if (defaultLocale) return;
    const check = () => {
      const cfg = siteConfigRef.current;
      if (cfg?.defaultLocale && cfg.defaultLocale !== locale) {
        setLocale(cfg.defaultLocale as Locale);
      }
    };
    if (siteConfigRef.current) {
      check();
    } else {
      fetch("/api/site-config")
        .then((r) => r.json())
        .then((data: { defaultLocale?: string }) => {
          if (data.defaultLocale && data.defaultLocale !== locale) {
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

  const transition = useCallback((next: PipelineState) => {
    stateRef.current = next;
    setPipelineState(next);
  }, []);

  // ── Fallback classification ──
  // Default (CLOUD_FALLBACK_ENABLED=false): resolved entirely on-device as
  // `needs_review` — the frame is never sent to the cloud for classification.
  // Legacy cloud path (GPT via /api/classify) only runs when the pilot
  // experiment flag NEXT_PUBLIC_CLOUD_FALLBACK=1 is set.
  const classify = useCallback(
    async (frame: string, meta: ClassifyMeta, yoloDetections?: YoloDetectionLog[], multi?: boolean, tierResults?: { tier1?: { itemName: string; confidence: number; x?: number }[] }, faceDetected?: boolean): Promise<ClassificationResponse & { requestId?: string }> => {
      if (!CLOUD_FALLBACK_ENABLED) {
        // ── On-device resolution: uncertain item → needs_review ──
        const siteConfig = siteConfigRef.current;
        const loc = localeRef.current;
        const raw = {
          itemName: t(loc, "uncertain"),
          wasteStream: "needs_review",
          confidence: LOCAL_FALLBACK_CONFIDENCE,
          reasoning: t(loc, "notSureCheck"),
        };
        const result: ClassificationResponse & { requestId?: string } = siteConfig
          ? { ...buildClassificationResult(raw, siteConfig, loc), modelUsed: "T1" }
          : {
              itemName: raw.itemName,
              wasteStream: "needs_review",
              confidence: LOCAL_FALLBACK_CONFIDENCE,
              reasoning: raw.reasoning,
              binColor: "#D97706",
              binLabel: "Needs Verification",
              needsReview: true,
              isCompound: false,
              modelUsed: "T1",
            };
        // Log for the admin review loop (fire-and-forget) — same frame policy
        // as logYoloOnlyResult: attach it only when the client-side face
        // check passed; the server re-checks before storing.
        const entry = {
          modelUsed: "T1",
          itemName: result.itemName,
          wasteStream: result.wasteStream,
          confidence: LOCAL_FALLBACK_CONFIDENCE,
          requiresVerification: true,
          latencyMs: 0,
          ...(yoloDetections && yoloDetections.length > 0 && { yoloDetections }),
          meta,
          ...(tierResults && { tierResults }),
          allItems: [{ itemName: result.itemName, wasteStream: result.wasteStream, confidence: LOCAL_FALLBACK_CONFIDENCE, modelUsed: "T1" }],
        };
        fetch("/api/pilot-log", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(
            faceDetected ? { faceDetected: true, entry } : { image: frame, faceDetected: false, entry }
          ),
        }).catch(() => {});
        return result;
      }

      const doFetch = async (): Promise<ClassificationResponse & { requestId?: string }> => {
        const fetchStartMs = Date.now();
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), API_TIMEOUT_MS);

        try {
          const reqBody = { image: frame, meta, locale, yoloDetections, ...(multi && { multi: true }), ...(tierResults && { tierResults }), ...(faceDetected && { faceDetected: true }) };
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
                wasteStream: "burnable",
                confidence: 0,
                reasoning: "Classification returned no results",
                binColor: "#EF4444",
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
          // Trigger at 4× baseline, recover at 1.5× baseline (hysteresis)
          if (avg > thermal.baseline * 4) {
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
        // the detection ROI, start the YOLO continuous loop so it's already
        // running by the time the hand reaches the center.
        // After repeated false triggers (nothing detected), require more
        // consecutive FG frames before re-entering classifying — this gives
        // the BG model time to absorb persistent non-waste objects (furniture,
        // walls, etc.) at idle rate.
        if (roiHasFg) {
          fgPersistRef.current++;
          const effectiveTrigger = Math.min(
            FG_TRIGGER_FRAMES + nothingDetectedCountRef.current * 10,
            60, // cap at ~1.8s — enough for BG model to absorb most drift
          );
          if (fgPersistRef.current >= effectiveTrigger) {
            fgPersistRef.current = 0;
            goneCountRef.current = 0;
            detectionGoneMapRef.current.clear();
            unresolvedNewItemsRef.current.clear();
            lastYoloFingerprintRef.current = null;
            classifyStartRef.current = Date.now();
            transition("classifying");
            startYoloLoop(analyzer);
          }
        } else {
          fgPersistRef.current = 0;
          // nothingDetectedCountRef is NOT reset here — only on successful
          // classification. This ensures repeated false triggers from persistent
          // objects (sofa, furniture) face increasing delay, giving the BG model
          // time to absorb them.
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
            pendingItemRef.current = false;
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
          nothingDetectedCountRef.current++;
          pendingItemRef.current = false;
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
            if (resultSweepTimerRef.current) { clearTimeout(resultSweepTimerRef.current); resultSweepTimerRef.current = null; }
            if (lastResultSuccessRef.current) recordSort();
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
            if (resultSweepTimerRef.current) { clearTimeout(resultSweepTimerRef.current); resultSweepTimerRef.current = null; }
            if (lastResultSuccessRef.current) recordSort();
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
          ? Math.min(COOLDOWN_MS + nothingDetectedCountRef.current * 1_000, 8_000)
          : COOLDOWN_MS;
        const cooldownElapsed = Date.now() - cooldownStartRef.current >= effectiveCooldown;
        const errorHeld = !errorRef.current || (Date.now() - errorSetAtRef.current >= ERROR_HOLD_MS);

        // If a new item is pending, start YOLO loop immediately
        if (pendingItemRef.current && errorHeld && nothingDetectedCountRef.current === 0) {
          setStableResults([]); setResultRequestIds([]);
          setError(null);
          pendingItemRef.current = false;
          fgPersistRef.current = 0;
          goneCountRef.current = 0;
          detectionGoneMapRef.current.clear();
          unresolvedNewItemsRef.current.clear();
          lastYoloFingerprintRef.current = null;
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
      if (resultSweepTimerRef.current) { clearTimeout(resultSweepTimerRef.current); resultSweepTimerRef.current = null; }
    };

    // ── YOLO frame-change-triggered loop ──
    // Fires YOLO only when the frame has changed significantly since the last
    // run. This avoids wasting GPU cycles on identical frames and gives each
    // retry a genuinely different view (angle/position). In result state YOLO
    // continues for spatial tracking (bbox IoU) — classifications are locked.

    function startYoloLoop(currentAnalyzer: FrameAnalyzer) {
      if (yoloRunningRef.current) return;
      const backend = inferenceRef.current;
      if (!backend?.isReady() || !siteConfigRef.current) return;
      yoloRunningRef.current = true;
      lastYoloFingerprintRef.current = null; // first run always fires
      lastYoloRunTimeRef.current = Date.now();
      console.log(`[yolo-loop] started`);
      (async () => {
        while (yoloRunningRef.current) {
          const video = cameraRef.current?.getVideo();
          if (!video) { await new Promise(r => setTimeout(r, 50)); continue; }

          // ── Frame-change gate ──
          if (!fingerprintCanvasRef.current) {
            fingerprintCanvasRef.current = new OffscreenCanvas(32, 32);
          }
          const fp = computeFrameFingerprint(video, fingerprintCanvasRef.current);
          const isFirstRun = !lastYoloFingerprintRef.current;
          let shouldRunYolo = isFirstRun;
          if (!isFirstRun) {
            const diff = frameDiff(lastYoloFingerprintRef.current!, fp);
            shouldRunYolo = diff >= FRAME_CHANGE_THRESHOLD;
          }

          if (!shouldRunYolo) {
            // Frame hasn't changed — check stale escalation (classifying only)
            const staleDuration = Date.now() - lastYoloRunTimeRef.current;
            if (staleDuration >= FRAME_STALE_ESCALATION_MS
                && stateRef.current === "classifying"
                && !inFlightRef.current) {
              const analysis = lastAnalysisRef.current;
              if (analysis && imageQualityBand(analysis) === "good") {
                triggerApiEscalation(video, analysis);
              } else {
                // Quality too poor for API — no point staying in classifying
                console.log(`[yolo-loop] Frame stale ${staleDuration}ms, quality insufficient → cooldown`);
                nothingDetectedCountRef.current++;
                pendingItemRef.current = false;
                analyzer.boostBackgroundAdaptation();
                cooldownStartRef.current = Date.now();
                transition("cooldown");
                yoloRunningRef.current = false;
              }
            }
            await new Promise(r => setTimeout(r, 30));
            continue;
          }

          // Frame changed → run YOLO
          lastYoloFingerprintRef.current = fp;
          lastYoloRunTimeRef.current = Date.now();

          const yoloStart = Date.now();
          let detections: YoloDetection[];
          try {
            detections = await backend.detect(video);
          } catch {
            detections = [];
          }
          const yoloMs = Date.now() - yoloStart;
          perfMonitor.recordYoloInference(yoloMs);

          const analysis = lastAnalysisRef.current;
          handleYoloCycleResult(detections, yoloMs, video, analysis, currentAnalyzer);
        }
        console.log(`[yolo-loop] stopped`);
      })();
    }

    function stopYoloLoop() {
      yoloRunningRef.current = false;
      // Abort any in-flight API call when stopping the loop
      if (apiAbortRef.current) {
        apiAbortRef.current.abort();
        apiAbortRef.current = null;
      }
    }

    /** Escalate to API when YOLO can't resolve after frame stale timeout. */
    function triggerApiEscalation(
      video: HTMLVideoElement,
      analysis: FrameAnalysis | null,
    ) {
      if (!analysis || inFlightRef.current) return;
      console.log(`[yolo-loop] Frame stale for ${FRAME_STALE_ESCALATION_MS}ms → escalating to API`);
      inFlightRef.current = true;
      const controller = new AbortController();
      apiAbortRef.current = controller;

      const wasteDetections: YoloDetection[] = []; // no detections to hint
      const tier1Hints = wasteDetections
        .map(d => ({ itemName: d.className, confidence: d.confidence, x: d.bbox[0] + d.bbox[2] / 2 }))
        .sort((a, b) => b.confidence - a.confidence).slice(0, 5);

      classifyViaApiAsync(video, analysis, controller.signal, undefined, true, { tier1: tier1Hints })
        .then(({ result: r, requestId, multiResults }) => {
          apiAbortRef.current = null;
          const apiResults = multiResults ?? (r ? [r] : []);
          if (apiResults.length > 0) {
            handleMultiClassificationResults(apiResults, apiResults.map(() => requestId));
          } else {
            nothingDetectedCountRef.current++;
            pendingItemRef.current = false;
            analyzer.boostBackgroundAdaptation();
            cooldownStartRef.current = Date.now();
            transition("cooldown");
            stopYoloLoop();
          }
          inFlightRef.current = false;
        })
        .catch((err) => {
          if (err instanceof DOMException && err.name === "AbortError") {
            // YOLO won the race — silently ignore
            return;
          }
          apiAbortRef.current = null;
          nothingDetectedCountRef.current++;
          pendingItemRef.current = false;
          analyzer.boostBackgroundAdaptation();
          cooldownStartRef.current = Date.now();
          transition("cooldown");
          stopYoloLoop();
          inFlightRef.current = false;
        });
    }

    /** Escalate a new unresolved item to API from result state. */
    function triggerApiEscalationFromResult(
      video: HTMLVideoElement,
      analysis: FrameAnalysis | null,
      triggeringDetection: YoloDetection,
    ) {
      if (!analysis || inFlightRef.current) return;
      inFlightRef.current = true;
      const controller = new AbortController();
      apiAbortRef.current = controller;

      classifyViaApiAsync(video, analysis, controller.signal, undefined, true, {
        tier1: [{ itemName: triggeringDetection.className, confidence: triggeringDetection.confidence, x: triggeringDetection.bbox[0] + triggeringDetection.bbox[2] / 2 }],
      })
        .then(({ result: r, requestId, multiResults }) => {
          apiAbortRef.current = null;
          const apiResults = multiResults ?? (r ? [r] : []);
          if (apiResults.length > 0 && stateRef.current === "result") {
            // Merge API results into existing locked results
            const newTracked: TrackedResult[] = apiResults.map(apiR => ({
              ...apiR,
              _trackBbox: triggeringDetection.bbox,
              _trackId: nextTrackIdRef.current++,
              _locked: true,
            }));
            setStableResults(prev => {
              const merged = [...prev, ...newTracked].slice(0, 4);
              sortByPhysicalPosition(merged);
              return merged;
            });
            setResultRequestIds(prev => [...prev, ...newTracked.map(() => requestId)]);
          }
          inFlightRef.current = false;
        })
        .catch((err) => {
          if (err instanceof DOMException && err.name === "AbortError") return;
          apiAbortRef.current = null;
          inFlightRef.current = false;
        });
    }

    /** Proactive API sweep: fires after a delay in result state to catch items
     *  outside YOLO's 15-class vocabulary. Runs in parallel with the YOLO loop —
     *  whichever finds a new item first wins, the other is cancelled. */
    function triggerResultApiSweep() {
      resultSweepTimerRef.current = null;
      if (stateRef.current !== "result") return;
      if (inFlightRef.current) return;

      const video = cameraRef.current?.getVideo();
      const analysis = lastAnalysisRef.current;
      if (!video || !analysis) return;

      // Pass confirmed items as hints so GPT focuses on unidentified items
      const currentResults = stableResultsRef.current;
      const tier1Hints = currentResults.map(r => ({
        itemName: r.itemName,
        confidence: r.confidence ?? 1,
        x: r._trackBbox ? r._trackBbox[0] + r._trackBbox[2] / 2 : undefined,
      }));

      inFlightRef.current = true;
      const controller = new AbortController();
      apiAbortRef.current = controller;

      console.log(`[result-sweep] firing API sweep — ${currentResults.length} items already confirmed`);

      classifyViaApiAsync(video, analysis, controller.signal, undefined, true, { tier1: tier1Hints })
        .then(({ result: r, requestId, multiResults }) => {
          apiAbortRef.current = null;
          if (stateRef.current !== "result") { inFlightRef.current = false; return; }

          const apiResults = multiResults ?? (r ? [r] : []);
          // Filter out items that already match existing results
          const existing = stableResultsRef.current;
          const newItems = apiResults.filter(apiR =>
            !existing.some(e => nameMatchScore(e.itemName, apiR.itemName) > 0.5)
          );

          if (newItems.length > 0) {
            const newTracked: TrackedResult[] = newItems.map(item => ({
              ...item,
              _trackBbox: (item as ClassificationResponse & { _bbox?: Bbox })._bbox ?? [0, 0, 640, 640] as Bbox,
              _trackId: nextTrackIdRef.current++,
              _locked: true,
            }));
            setStableResults(prev => {
              const merged = [...prev, ...newTracked].slice(0, 4);
              sortByPhysicalPosition(merged);
              return merged;
            });
            setResultRequestIds(prev => [...prev, ...newItems.map(() => requestId)]);
            console.log(`[result-sweep] added ${newItems.length} new items: ${newItems.map(i => i.itemName).join(", ")}`);

            // Log sweep results — allItems includes original + newly found items
            const sweepAllItems = [
              ...existing.map(e => ({ itemName: e.itemName, wasteStream: e.wasteStream, confidence: e.confidence ?? 1, modelUsed: "T1" as const })),
              ...newItems.map(ni => ({ itemName: ni.itemName, wasteStream: ni.wasteStream, confidence: ni.confidence, modelUsed: "t2" as const })),
            ];
            fetch("/api/pilot-log", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                entry: {
                  modelUsed: "t2",
                  escalated: true,
                  itemName: newItems.map(i => i.itemName).join(", "),
                  wasteStream: newItems[0].wasteStream,
                  confidence: newItems[0].confidence,
                  requiresVerification: false,
                  latencyMs: RESULT_API_SWEEP_DELAY_MS,
                  meta: lastAnalysisRef.current ? { sharpnessScore: lastAnalysisRef.current.sharpnessScore, imageQuality: imageQualityBand(lastAnalysisRef.current) } : undefined,
                  allItems: sweepAllItems,
                },
              }),
            }).catch(() => {});
          } else {
            console.log(`[result-sweep] no new items found`);
          }
          inFlightRef.current = false;
        })
        .catch((err) => {
          if (err instanceof DOMException && err.name === "AbortError") return;
          apiAbortRef.current = null;
          inFlightRef.current = false;
        });
    }

    /** Process one YOLO cycle result — drive state transitions + spatial tracking. */
    function handleYoloCycleResult(
      detections: YoloDetection[],
      yoloMs: number,
      video: HTMLVideoElement,
      analysis: FrameAnalysis | null,
      _currentAnalyzer: FrameAnalyzer,
    ) {
      const state = stateRef.current;
      const th = thresholdsRef.current;
      const wasteDetections = detections.filter(d => !isYoloClassNotWaste(d.className));
      latestWasteDetectionsRef.current = wasteDetections;

      // ── Resolve detections via YOLO rules ──
      const resolvedResults: (ClassificationResponse & { _bbox?: Bbox })[] = [];
      const unresolvedDetections: YoloDetection[] = [];
      for (const det of wasteDetections.slice(0, 4)) {
        if (det.confidence >= th.YOLO_FALLBACK_THRESHOLD) {
          const r = resolveYoloDetection(det, siteConfigRef.current!, localeRef.current);
          if (r) {
            (r as ClassificationResponse & { _bbox?: Bbox })._bbox = det.bbox;
            resolvedResults.push(r as ClassificationResponse & { _bbox?: Bbox });
            continue;
          }
        }
        unresolvedDetections.push(det);
      }

      const hasResults = resolvedResults.length > 0;

      // ═══════════════════════════════════════
      // ── CLASSIFYING STATE ──
      // ═══════════════════════════════════════
      if (state === "classifying") {
        // Blob-vs-detection check: if CV sees more blobs than YOLO detected,
        // there are items YOLO can't classify → don't let YOLO win the race.
        const qualifiedBlobCount = analysis?.blobs?.filter(b => blobIsObject(b)).length ?? 0;
        const yoloMissedItems = qualifiedBlobCount > wasteDetections.length;

        if (hasResults && unresolvedDetections.length === 0 && !yoloMissedItems) {
          // ── All items resolved, blob count matches — YOLO wins the race ──
          if (inFlightRef.current && apiAbortRef.current) {
            console.log(`[yolo-loop] YOLO won race — aborting in-flight API`);
            apiAbortRef.current.abort();
            apiAbortRef.current = null;
            inFlightRef.current = false;
          }

          resolvedResults.sort((a, b) => {
            const aCx = (a._bbox?.[0] ?? 0) + (a._bbox?.[2] ?? 0) / 2;
            const bCx = (b._bbox?.[0] ?? 0) + (b._bbox?.[2] ?? 0) / 2;
            return aCx - bCx;
          });
          console.log(`[yolo-loop] HIT: ${resolvedResults.map(r => r.itemName).join(" + ")} in ${yoloMs}ms`);

          if (analysis) {
            logYoloOnlyResult(video, resolvedResults[0], detections, yoloMs, analysis, "T1", undefined, undefined,
              { tier1: wasteDetections.map(d => ({ itemName: d.className, confidence: d.confidence, x: d.bbox[0] + d.bbox[2] / 2 })).sort((a, b) => b.confidence - a.confidence).slice(0, 5) },
              resolvedResults,
              { blobCount: qualifiedBlobCount, yoloDetectionCount: wasteDetections.length });
          }

          handleMultiClassificationResults(resolvedResults, resolvedResults.map(() => undefined));
          detectionGoneMapRef.current.clear();
        } else if (hasResults) {
          if (!CLOUD_FALLBACK_ENABLED) {
            // ── Local-only mode: no cloud response is coming for the
            // unresolved remainder — display the confidently-resolved items
            // now. If the leftover detection persists, the result-state
            // escalation adds an on-device needs_review card for it.
            console.log(`[yolo-loop] partial: ${resolvedResults.map(r => r.itemName).join(" + ")} resolved — displaying (local-only mode)`);
            if (analysis) {
              logYoloOnlyResult(video, resolvedResults[0], detections, yoloMs, analysis, "T1", undefined, undefined,
                { tier1: wasteDetections.map(d => ({ itemName: d.className, confidence: d.confidence, x: d.bbox[0] + d.bbox[2] / 2 })).sort((a, b) => b.confidence - a.confidence).slice(0, 5) },
                resolvedResults,
                { blobCount: qualifiedBlobCount, yoloDetectionCount: wasteDetections.length });
            }
            handleMultiClassificationResults(resolvedResults, resolvedResults.map(() => undefined));
            detectionGoneMapRef.current.clear();
            return;
          }
          // ── Some resolved but unresolved items or blob mismatch — let API finish ──
          if (yoloMissedItems) {
            console.log(`[yolo-loop] partial: ${resolvedResults.map(r => r.itemName).join(" + ")} resolved, but ${qualifiedBlobCount} blobs vs ${wasteDetections.length} detections — waiting for API`);
          } else {
            console.log(`[yolo-loop] partial: ${resolvedResults.map(r => r.itemName).join(" + ")} resolved, ${unresolvedDetections.length} unresolved — waiting for API`);
          }
        }
        // Note: API escalation for stale frames is handled in the loop itself
        // (triggerApiEscalation), not here.
        return;
      }

      // ═══════════════════════════════════════
      // ── RESULT STATE (locked + bbox IoU tracking) ──
      // ═══════════════════════════════════════
      if (state === "result") {
        const displayedResults = stableResultsRef.current;
        if (displayedResults.length === 0) return;

        // ── nothing_detected + new YOLO hit → restart classification ──
        // When the screen shows "couldn't identify", the user may present a
        // different item (or a better angle). If YOLO now sees something
        // recognizable, restart the pipeline immediately instead of waiting
        // for the item to disappear and re-enter.
        const isNothingDetected = displayedResults.length === 1
          && displayedResults[0].itemName === "nothing_detected";
        if (isNothingDetected && wasteDetections.length > 0 && !inFlightRef.current) {
          const best = wasteDetections[0]; // sorted by confidence
          if (best.confidence >= th.YOLO_FALLBACK_THRESHOLD) {
            console.log(`[result] nothing_detected + new YOLO hit (${best.className} ${(best.confidence * 100).toFixed(0)}%) → reclassify`);
            // Reset state and re-enter classifying with the YOLO loop already running
            goneCountRef.current = 0;
            detectionGoneMapRef.current.clear();
            unresolvedNewItemsRef.current.clear();
            lastYoloFingerprintRef.current = null;
            classifyStartRef.current = Date.now();
            setStableResults([]); setResultRequestIds([]);
            if (resultSweepTimerRef.current) { clearTimeout(resultSweepTimerRef.current); resultSweepTimerRef.current = null; }
            transition("classifying");
            // YOLO loop is already running — process this detection immediately
            handleYoloCycleResult(detections, 0, video, analysis, analyzer);
            return;
          }
        }

        // Build trackable + detection arrays for IoU matching
        const tracked = displayedResults.map(r => ({
          id: r._trackId,
          bbox: r._trackBbox,
        }));
        // ALL waste detections (not just resolved) participate in spatial matching
        const detectionItems = wasteDetections.slice(0, 8).map((det, i) => ({
          bbox: det.bbox as Bbox,
          index: i,
        }));

        const matchResult = greedyIoUMatch(tracked, detectionItems, 0.3);
        const goneMap = detectionGoneMapRef.current;
        let needsUpdate = false;

        // ── Matched: update spatial position only (classification locked) ──
        for (const match of matchResult.matched) {
          const trackedItem = displayedResults.find(r => r._trackId === match.trackedId);
          if (trackedItem) {
            trackedItem._trackBbox = wasteDetections[match.detectionIndex].bbox;
          }
          goneMap.delete(match.trackedId);
        }

        // ── Unmatched tracked: increment gone counter ──
        for (const trackedId of matchResult.unmatchedTracked) {
          goneMap.set(trackedId, (goneMap.get(trackedId) ?? 0) + 1);
        }

        // ── Remove items gone for YOLO_GONE_CYCLES ──
        const toRemoveIds = new Set<number>();
        for (const [trackId, count] of goneMap) {
          if (count >= YOLO_GONE_CYCLES) {
            toRemoveIds.add(trackId);
            goneMap.delete(trackId);
            needsUpdate = true;
          }
        }

        // ── Unmatched detections: new items entering scene ──
        // All new detections (resolved or not) must persist for multiple
        // cycles before being added to results. This prevents flicker from
        // transient YOLO bbox shifts or single-frame false positives.
        for (const detIdx of matchResult.unmatchedDetections) {
          const det = wasteDetections[detIdx];
          if (!det) continue;

          const key = `${Math.round(det.bbox[0])}_${Math.round(det.bbox[1])}`;
          const entry = unresolvedNewItemsRef.current.get(key);
          if (entry) {
            const iou = computeIoU(entry.bbox, det.bbox);
            if (iou > 0.3) {
              entry.count++;
              entry.bbox = det.bbox;

              if (entry.count >= NEW_ITEM_PERSIST_CYCLES) {
                unresolvedNewItemsRef.current.delete(key);

                // Try YOLO rule resolution
                if (det.confidence >= th.YOLO_FALLBACK_THRESHOLD) {
                  const resolved = resolveYoloDetection(det, siteConfigRef.current!, localeRef.current);
                  if (resolved) {
                    const newTracked: TrackedResult = {
                      ...resolved,
                      _trackBbox: det.bbox,
                      _trackId: nextTrackIdRef.current++,
                      _locked: true,
                    };
                    displayedResults.push(newTracked);
                    needsUpdate = true;
                    // YOLO found a new item — abort any in-flight API sweep (race: YOLO wins)
                    if (inFlightRef.current && apiAbortRef.current) {
                      console.log(`[yolo-loop] YOLO won race — aborting API sweep`);
                      apiAbortRef.current.abort();
                      apiAbortRef.current = null;
                      inFlightRef.current = false;
                    }
                    console.log(`[yolo-loop] new item added after ${NEW_ITEM_PERSIST_CYCLES} cycles: ${resolved.itemName}`);
                    continue;
                  }
                }

                // Unresolved → API escalation
                if (!inFlightRef.current) {
                  console.log(`[yolo-loop] unresolved item persisted ${NEW_ITEM_PERSIST_CYCLES} cycles → API escalation`);
                  triggerApiEscalationFromResult(video, analysis, det);
                }
              }
            }
          } else {
            unresolvedNewItemsRef.current.set(key, { bbox: det.bbox, count: 1 });
          }
        }

        if (needsUpdate) {
          const updated = displayedResults
            .filter(r => !toRemoveIds.has(r._trackId))
            .slice(0, 4);
          sortByPhysicalPosition(updated);
          if (toRemoveIds.size > 0) {
            console.log(`[yolo-loop] removed trackIds: ${[...toRemoveIds].join(", ")}`);
          }
          if (updated.length > 0) {
            setStableResults([...updated]); // spread to trigger re-render
            setResultRequestIds(updated.map(() => undefined));
          }
          // If all items removed, wait for FG-based exit (handled in main CV loop)
        }
        return;
      }
    }

    /** Log a YOLO-only classification to the server (fire-and-forget).
     *  Needed because YOLO wins skip the /api/classify route entirely. */
    async function logYoloOnlyResult(
      video: HTMLVideoElement,
      result: ClassificationResponse,
      detections: YoloDetection[],
      latencyMs: number,
      analysis: FrameAnalysis,
      modelUsed: "T1" = "T1",
      _hint?: unknown,
      _refinedFrom?: unknown,
      tierResults?: { tier1?: { itemName: string; confidence: number; x?: number }[] },
      /** All classified items in this frame (for multi-item logging). */
      allResults?: ClassificationResponse[],
      /** CV blob count and YOLO detection count for diagnostics. */
      counts?: { blobCount: number; yoloDetectionCount: number },
    ) {
      // Capture the same center short-side square that YOLO sees (e.g. 720×720
      // from 1280×720). Log images preserve full resolution for fine-tuning.
      const vw = video.videoWidth;
      const vh = video.videoHeight;
      const side = Math.min(vw, vh);
      const roiX = Math.round((vw - side) / 2);
      const roiY = Math.round((vh - side) / 2);

      // ── Client-side face detection gate ──
      // BlazeFace is destructive to OffscreenCanvas (transferToImageBitmap),
      // so draw to a dedicated canvas for the face check. Fail-closed: if
      // the detector errors, treat as "face present" so the image is not
      // stored — the server-side check still runs and provides the authoritative
      // floor against a compromised kiosk.
      const faceCanvas = new OffscreenCanvas(side, side);
      const faceCtx = faceCanvas.getContext("2d");
      if (!faceCtx) return;
      faceCtx.drawImage(video, roiX, roiY, side, side, 0, 0, side, side);

      let faceDetected = false;
      try {
        const { containsFace } = await import("@/lib/face-detect");
        faceDetected = await containsFace(faceCanvas);
      } catch {
        console.warn("[pilot-log] Face detection unavailable — skipping image upload (fail-closed)");
        faceDetected = true;
      }

      // Build allItems from all resolved results
      const allItems = (allResults ?? [result]).map(r => ({
        itemName: r.itemName,
        wasteStream: r.wasteStream,
        confidence: r.confidence,
        modelUsed: modelUsed as string,
      }));

      const entry = {
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
        allItems,
        ...(counts && { blobCount: counts.blobCount, yoloDetectionCount: counts.yoloDetectionCount }),
      };

      // Face present → skip image capture entirely, log metadata only.
      if (faceDetected) {
        fetch("/api/pilot-log", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ faceDetected: true, entry }),
        }).catch(() => {});
        return;
      }

      // No face → capture and upload. `faceCanvas` was drained by
      // `transferToImageBitmap` inside `containsFace`, so redraw the ROI
      // onto a fresh canvas for the JPEG encode. Pass faceDetected: false
      // so the server knows the client already checked — server still
      // re-runs its own detector (`/api/pilot-log/route.ts`) as the
      // authoritative floor, matching the pattern in `/api/classify`.
      try {
        const uploadCanvas = new OffscreenCanvas(side, side);
        const uploadCtx = uploadCanvas.getContext("2d");
        if (!uploadCtx) return;
        uploadCtx.drawImage(video, roiX, roiY, side, side, 0, 0, side, side);
        const blob = await uploadCanvas.convertToBlob({ type: "image/jpeg", quality: 0.82 });
        const dataUrl: string = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onloadend = () => resolve(reader.result as string);
          reader.onerror = reject;
          reader.readAsDataURL(blob);
        });
        const frame = dataUrl.split(",")[1];
        if (!frame) return;
        fetch("/api/pilot-log", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ image: frame, faceDetected: false, entry }),
        }).catch(() => {});
      } catch {
        // best-effort
      }
    }

    /** Convert a ClassificationResponse (possibly with _bbox) to a TrackedResult. */
    function toTrackedResult(r: ClassificationResponse & { _bbox?: Bbox; requestId?: string }): TrackedResult {
      return {
        ...r,
        _trackBbox: r._bbox ?? [0, 0, 640, 640], // full frame fallback
        _trackId: nextTrackIdRef.current++,
        _locked: true,
      };
    }

    function handleMultiClassificationResults(
      results: (ClassificationResponse & { requestId?: string; _bbox?: Bbox })[],
      requestIds: (string | undefined)[],
    ) {
      // Filter out "nothing detected" results
      const valid = results.filter(
        (r) => r.itemName?.toLowerCase() !== "nothing detected" && r.confidence !== 0
      );

      if (valid.length === 0) {
        nothingDetectedCountRef.current++;
        lastResultSuccessRef.current = false;
        setStableResults([toTrackedResult({
          itemName: "nothing_detected",
          wasteStream: "burnable",
          confidence: 0,
          reasoning: "",
          binColor: "#EF4444",
          binLabel: "",
          needsReview: false,
          isCompound: false,
        })]);
        setResultRequestIds([]);
        setError(null);
        goneCountRef.current = 0;
        resultEnterTimeRef.current = Date.now();
        transition("result");
        inFlightRef.current = false;
        return;
      }

      // Successful classification — reset the nothing-detected counter
      lastResultSuccessRef.current = true;
      nothingDetectedCountRef.current = 0;
      const tracked = valid.map(r => toTrackedResult(r));

      // ── Assign bboxes from YOLO detections for API results lacking spatial data ──
      const recentDetections = latestWasteDetectionsRef.current;
      const recentBlobs = lastAnalysisRef.current?.blobs ?? [];
      const usedDetIdxs = new Set<number>();

      // Phase 1: Name-match items to YOLO detections for bbox inheritance
      for (const item of tracked) {
        if (!isFullFrameFallback(item._trackBbox)) continue;
        let bestIdx = -1;
        let bestScore = 0;
        for (let i = 0; i < recentDetections.length; i++) {
          if (usedDetIdxs.has(i)) continue;
          const score = nameMatchScore(item.itemName, recentDetections[i].className);
          if (score > bestScore) { bestScore = score; bestIdx = i; }
        }
        if (bestIdx >= 0) {
          usedDetIdxs.add(bestIdx);
          item._trackBbox = recentDetections[bestIdx].bbox as [number, number, number, number];
        }
      }

      // Phase 2: Assign remaining blobs to items still missing position
      const qualifiedBlobs = recentBlobs
        .filter(b => blobIsObject(b))
        .sort((a, b) => a.bboxNorm[0] - b.bboxNorm[0]);
      let blobIdx = 0;
      for (const item of tracked) {
        if (!isFullFrameFallback(item._trackBbox)) continue;
        if (blobIdx >= qualifiedBlobs.length) break;
        const bl = qualifiedBlobs[blobIdx++];
        item._trackBbox = [
          Math.round((bl.bboxNorm[0] - bl.bboxNorm[2] / 2) * 640),
          Math.round((bl.bboxNorm[1] - bl.bboxNorm[3] / 2) * 640),
          Math.round(bl.bboxNorm[2] * 640),
          Math.round(bl.bboxNorm[3] * 640),
        ];
      }

      // Sort by physical position (left-to-right on screen, mirror-aware)
      sortByPhysicalPosition(tracked);

      setStableResults(tracked);
      setResultRequestIds(
        valid.map((r) => requestIds[results.indexOf(r)] ?? r.requestId)
      );
      setError(null);
      goneCountRef.current = 0;
      resultEnterTimeRef.current = Date.now();
      transition("result");

      // Schedule proactive API sweep for T1-only results (catches items
      // outside YOLO's vocabulary that YOLO can never detect). Cloud-only:
      // in local-only mode the sweep would just append a phantom
      // needs_review card next to every confirmed result, so skip it.
      if (resultSweepTimerRef.current) clearTimeout(resultSweepTimerRef.current);
      const isYoloOnly = requestIds.every(id => id === undefined);
      if (isYoloOnly && CLOUD_FALLBACK_ENABLED) {
        resultSweepTimerRef.current = setTimeout(triggerResultApiSweep, RESULT_API_SWEEP_DELAY_MS);
      }

      for (const result of valid) {
        const cacheKey = `${result.itemName}::${result.wasteStream}`;
        if (cacheKey !== lastCachedRef.current) {
          cacheResult(result, localeRef.current);
          lastCachedRef.current = cacheKey;
        }
      }
      inFlightRef.current = false;
    }

    async function classifyViaApiAsync(
      video: HTMLVideoElement,
      analysis: FrameAnalysis,
      signal?: AbortSignal,
      yoloDetections?: YoloDetectionLog[],
      /** When true, uses multi-item prompt — for zero-detection fallback. */
      multi?: boolean,
      tierResults?: { tier1?: { itemName: string; confidence: number; x?: number }[] },
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

      // ── Face detection: block image storage if a face is found ──
      // Fail-closed: if face detection is unavailable (model failed to load),
      // assume a face may be present and skip image upload for privacy safety.
      let faceDetected = false;
      try {
        const { containsFace } = await import("@/lib/face-detect");
        faceDetected = await containsFace(cropCanvas);
      } catch {
        console.warn("[classify] Face detection unavailable — skipping image upload (fail-closed)");
        faceDetected = true;
      }

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
        faceDetected,
      });

      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

      const result = await classify(frame, meta, yoloDetections, multi, tierResults, faceDetected);
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
          alt="wayste"
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
          mirror={mirrorCamera}
          locale={locale}
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
          statsVersion={statsVersion}
        />
      )}

      {uiScreen === "camera" && (
        <CameraScreen
          pipelineState={pipelineState}
          locale={locale}
          yoloTargetInset={YOLO_TARGET_INSET}
        />
      )}

      {uiScreen === "result" && stableResults.length > 0 && (
        <ResultScreen
          results={stableResults}
          locale={locale}
          voiceEnabled={voiceEnabled}
          streams={siteStreams}
          cameraRef={cameraRef}
          mirrorCamera={mirrorCamera}
        />
      )}

      {/* System status badge — hidden during result screen to avoid overlap */}
      {uiScreen !== "result" && (
        <SystemStatusBadge thermalWarning={thermalWarning} />
      )}
    </div>
  );
}
