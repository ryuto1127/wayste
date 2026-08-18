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
import { buildLocalNeedsReviewResult, LOCAL_FALLBACK_CONFIDENCE } from "@/lib/local-fallback";
import {
  computeFrameFingerprint,
  frameDiff,
  greedyIoUMatch,
  computeIoU,
  computeLetterbox,
  MODEL_INPUT_SIZE,
  scaleFrom640,
  type Bbox,
} from "@/lib/bbox-utils";
// kioskAuthHeaders replaced by session token (server-generated, HMAC-signed)
import { recordSort } from "@/lib/kiosk-counter";
import { DetectionTracker, type Track } from "@/lib/detection-tracker";
import { syncContinuousCards } from "@/lib/continuous-cards";
import { buildUnknownDetections, UNKNOWN_OBJECT_CLASS_ID } from "@/lib/unknown-object";
import {
  judgeCropWithVlm,
  cropTrackToDataUrl,
  cropContainsFace,
  getVlmMode,
  DEFAULT_BROWSER_VLM_MODEL,
  type VlmJudgment,
} from "@/lib/vlm-client";
import type { BrowserVlmProgress } from "@/lib/vlm-browser";
import { buildClassificationResult } from "@/lib/waste-rules-core";
import CameraFeed, { type CameraFeedHandle } from "./CameraFeed";
import IdleScreen from "./IdleScreen";
import CameraScreen from "./CameraScreen";
import ResultScreen from "./ResultScreen";
import LiveDetectionView, { type LiveTrackView } from "./LiveDetectionView";
import SystemStatusBadge from "./SystemStatusBadge";

// ── Timing constants ──
// Exported constants below are imported by __tests__/state-machine.test.ts so
// the test simulator always uses the real values — do not duplicate them there.
const ANALYSIS_INTERVAL_MS = 30;  // ~33 fps local CV
export const COOLDOWN_MS = 3500; // pause before re-scanning (BG model recovery + seedling animation)
/** Extra cooldown per consecutive nothing-detected miss (progressive backoff). */
export const COOLDOWN_EXTENSION_PER_MISS_MS = 1_000;
/** Upper bound for the progressively extended cooldown. */
export const COOLDOWN_MAX_MS = 8_000;
export const RESULT_GONE_FRAMES = 5;     // result state exit window (~150ms at 33fps) — balanced against flicker risk
/** FG frames required to start the YOLO continuous loop. Kept low — YOLO
 *  handles its own quality; FG is just the "someone is approaching" trigger. */
export const FG_TRIGGER_FRAMES = 2;
/**
 * Escape hatch: if the result state persists for this long with the object
 * still visible (e.g., a tissue leftover that never leaves), force a transition
 * to cooldown so the BG model gets a full-rate update window in idle.
 */
export const RESULT_TIMEOUT_MS = 20_000;
/** Minimum time an error message is visible before being cleared. */
const ERROR_HOLD_MS = 4_000;
/** Abort API call if it takes longer than this. */
const API_TIMEOUT_MS = 15_000;
/** Retry delay after a 429 rate-limit response. */
const RATE_LIMIT_RETRY_MS = 1_200;
/** Max time in "classifying" state before forcing a timeout recovery. */
const CLASSIFYING_TIMEOUT_MS = 10_000;
/** Local-only mode: if classifying has produced no result after this long
 *  (item moving, below-threshold detections, out-of-vocabulary object),
 *  resolve on-device as needs_review instead of scanning silently until
 *  CLASSIFYING_TIMEOUT_MS and showing nothing. Only meaningful when the
 *  cloud fallback is off — no frame quality requirement applies since no
 *  image is sent anywhere for classification. */
const LOCAL_UNRESOLVED_ESCALATION_MS = 2_500;
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

// ── Continuous mode (site config detectionMode: "continuous") ──
/** Fallback pacing between YOLO cycles when the camera's frame rate is
 *  unknown (~30fps). The loop matches the camera's real rate when readable —
 *  running faster than the camera delivers frames would re-process identical
 *  images (pure heat, zero information). Inference time counts toward the
 *  interval; slow devices degrade to their natural rate, and thermal
 *  throttling halves the cadence. */
const CONTINUOUS_YOLO_INTERVAL_MS = 33;
/** Clamp for camera-derived pacing: 15ms allows 60fps cameras; 100ms floor
 *  keeps even a misreported rate from stalling the loop. */
const CONTINUOUS_INTERVAL_CLAMP: [number, number] = [15, 100];
/** Min bbox area (model-space px²) in continuous mode. Full-frame letterbox
 *  shrinks a 16:9 frame to 640×360 inside the model input — objects are
 *  ~1/4 the area they'd be in the gated center-crop, so the gated default
 *  (1500) would silently drop everything but close-ups. */
const CONTINUOUS_MIN_BOX_AREA = scaleFrom640(400);
/** How long a confirmed track may stay below the instant-resolve bar before
 *  it is resolved on-device as needs_review (never show nothing). */
const CONTINUOUS_NEEDS_REVIEW_MS = 1_500;
/** Minimum spacing between pilot-log posts in continuous mode — a person
 *  walking through with items must not spam the log with uploads. */
const CONTINUOUS_LOG_MIN_INTERVAL_MS = 4_000;
/** If the continuous YOLO loop produces no iteration for this long, the CV
 *  interval assumes it hung (stuck await, zombie exit) and restarts it.
 *  An unattended kiosk must self-heal, not sit dead until someone notices. */
const CONTINUOUS_WATCHDOG_MS = 10_000;
/** YOLO boxes below TRACK_KEEP_THRESHOLD but above this floor are treated as
 *  class-agnostic "unknown object" evidence — the class guess is unreliable
 *  down there, but the box still marks an object-shaped thing. Ratio of the
 *  keep threshold, with an absolute floor against pure noise. */
const UNKNOWN_CANDIDATE_FLOOR_RATIO = 0.45;
/** Absolute floor, NOT derived from the keep threshold. Tying it to a ratio
 *  meant that lowering the tracker's bars also widened the junk intake —
 *  boxes down at 12% confidence are the model shrugging, and pairing that
 *  with any foreground makes bare walls sprout "確認が必要" cards. */
const UNKNOWN_CANDIDATE_MIN_CONF = 0.25;
/** Above this ROI foreground ratio the whole scene is changing (camera bump,
 *  pan, lighting shift) — background-subtraction blobs are meaningless and
 *  must not spawn unknown-object candidates. */
const SCENE_UNSTABLE_FG_RATIO = 0.35;
/** For this long after the continuous loop's first cycle, unknown candidates
 *  are LEARNED as background zones instead of tracked — whatever is visible
 *  at startup (window handles, furniture, wall fixtures) is scenery, not an
 *  item someone brought. Short on purpose: the scene at start is already
 *  static, so there is nothing to wait for. */
const CONTINUOUS_BASELINE_MS = 1_500;
/** Thermal proxy guards. The 120×120 CV analysis costs ~1–3ms on any
 *  healthy machine; below this absolute cost the load is trivial no matter
 *  what the ratio says. Real heat also builds over tens of seconds — an
 *  elevation must last this long before the ladder escalates. */
/** Movement bound (model px) for demoting a track to permanent scenery.
 *  Much tighter than STEADY_MAX_TRAVEL_PX: that one asks "steady enough to
 *  judge", this one asks "bolted to the room". A held item breathes several
 *  px even when the person tries to hold still, so it never qualifies —
 *  which matters, because demotion silences that spot for good. */
const SCENERY_MAX_TRAVEL_PX = 3;
const THERMAL_MIN_AVG_MS = 8;
const THERMAL_SUSTAIN_MS = 8_000;
/** An unknown track that has sat still this long is background that slipped
 *  past the baseline — demote its region to a background zone. Held and
 *  presented items are never this still, so waiting longer only means
 *  living with a false detection for longer. */
const UNKNOWN_STATIC_TO_ZONE_MS = 6_000;
/** Max per-cycle raw-center travel (model-space px) for a track to count as
 *  "steadily presented". needs_review cards are only created for steady
 *  tracks — patterns riding on moving clothing/hands never surface. */
const STEADY_MAX_TRAVEL_PX = 8;
/** Retry delay after a failed/unavailable VLM judgment — the track's
 *  "judged" mark is lifted so a later, healthier cycle tries again. */
const VLM_RETRY_DELAY_MS = 5_000;
/** Minimum spacing between VLM judgments by thermal level (a judgment is
 *  the heaviest single GPU op — space when warm, stop when hot). */
const VLM_GAP_NORMAL_MS = 2_000;
const VLM_GAP_WARM_MS = 10_000;
/** How often to sweep the frame for faces (veto zones), and how long a
 *  sweep's result stays valid. */
const FACE_SWEEP_INTERVAL_MS = 1_200;
const FACE_ZONE_TTL_MS = 2_500;
/** Face sweep runs on a small letterboxed canvas of this size. */
const FACE_SWEEP_CANVAS_SIZE = 256;
/** Cap on remembered background zones (FIFO). */
const BACKGROUND_ZONE_CAP = 16;
/** Sustained whole-scene instability longer than this means the CAMERA
 *  MOVED (not a passer-by): learned scenery zones are now wrong coordinates
 *  and are discarded; once the scene settles, the baseline re-learns.
 *  A person crossing the frame clears in a few hundred ms, so this only
 *  needs to outlast that — not to be cautious. */
const VIEW_CHANGE_UNSTABLE_MS = 700;

// ── Cloud fallback (pilot experiments only) ──
/** OFF by default: items YOLO can't confidently resolve become `needs_review`
 *  on-device, and no frame ever leaves the kiosk for classification.
 *  Set NEXT_PUBLIC_CLOUD_FALLBACK=1 to re-enable the legacy GPT escalation
 *  path — pilot experiments only (e.g. the cloud-vs-local shadow comparison
 *  via LOCAL_VLM_ENDPOINT on the server). */
const CLOUD_FALLBACK_ENABLED = process.env.NEXT_PUBLIC_CLOUD_FALLBACK === "1";

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

/** Model input side — single source of truth in lib/bbox-utils.ts so the
 *  ONNX export size, letterbox math and bbox thresholds can't drift apart. */
const YOLO_MODEL_SIZE = MODEL_INPUT_SIZE;

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

  // ── Continuous mode (site-config driven) ──
  const [continuousMode, setContinuousMode] = useState(false);
  const [showOverlay, setShowOverlay] = useState(false);
  const [showBinMap, setShowBinMap] = useState(false);
  /** Continuous mode starts in a setup phase: live camera only, so the
   *  operator can aim the camera. Detection (and the background baseline)
   *  begins when they press start — a baseline learned mid-aiming would be
   *  garbage. Persisted per browser session so crash/HMR reloads self-heal
   *  without a human, while a fresh session (new install day) asks again. */
  const [continuousStarted, setContinuousStarted] = useState(false);
  const [liveTracks, setLiveTracks] = useState<LiveTrackView[]>([]);
  /** Camera aspect ratio (w/h) — the overlay needs it to map full-frame
   *  letterboxed model coords onto the object-cover video display. */
  const [videoAspect, setVideoAspect] = useState(16 / 9);
  const detectionModeRef = useRef<"gated" | "continuous">("gated");
  const trackerRef = useRef<DetectionTracker | null>(null);
  /** Result cards keyed by track id (continuous mode only). */
  const continuousCardsRef = useRef<Map<number, TrackedResult>>(new Map());
  const lastContinuousLogRef = useRef(0);
  /** Starter installed by the main pipeline effect, invoked by the mode effect. */
  const startContinuousLoopRef = useRef<(() => void) | null>(null);
  /** Timestamp of the last continuous-loop iteration — watchdog input. */
  const lastContinuousCycleAtRef = useRef(0);
  /** Whether an unknown-object (blob-backed) track is currently displayed —
   *  freezes BG adaptation so the blob sustaining it isn't absorbed. */
  const hasUnknownTrackRef = useRef(false);
  /** Remembered scenery (model space): startup furniture + demoted
   *  long-static tracks. FIFO-capped. `className` records what the model
   *  called the thing when it was learned (null = unknown-net candidate),
   *  so a DIFFERENT item presented over the same spot still detects — only
   *  the scenery itself is silenced. */
  const backgroundZonesRef = useRef<{ bbox: Bbox; className: string | null }[]>([]);
  /** End of the startup baseline-learning window (0 = not started). */
  const baselineUntilRef = useRef(0);
  /** When sustained whole-scene instability began (0 = scene stable). */
  const sceneUnstableSinceRef = useRef(0);
  /** True once the current instability episode was treated as a camera move. */
  const viewChangeHandledRef = useRef(false);
  /** Latest face sweep result (model-space boxes + timestamp). */
  const faceZonesRef = useRef<{ boxes: Bbox[]; at: number }>({ boxes: [], at: 0 });
  /** Reusable small canvas for the face sweep (HTMLCanvas — MediaPipe input). */
  const faceSweepCanvasRef = useRef<HTMLCanvasElement | null>(null);
  /** Track ids already sent to the local VLM (Tier 1.5) this lifetime —
   *  one judgment per track; class swaps and losses clear the mark. */
  const vlmJudgedRef = useRef<Set<number>>(new Set());
  /** Single-concurrency latch for local VLM judgments. */
  const vlmInFlightRef = useRef(false);
  /** Out-of-vocabulary net: site-config default, operator-togglable from
   *  the demo panel. Ref for the loop, state for the button. */
  const unknownNetRef = useRef(true);
  const [unknownNetOn, setUnknownNetOn] = useState(true);
  /** Browser-mode VLM download/load progress — drives the gauge. */
  const [vlmProgress, setVlmProgress] = useState<BrowserVlmProgress | null>(null);
  /** Loaded vlm-browser module — lets the judge loop check readiness
   *  synchronously (a track must NOT be marked judged while the model is
   *  still downloading, or it would never be retried). */
  const vlmBrowserModRef = useRef<typeof import("@/lib/vlm-browser") | null>(null);
  /** When the last VLM judgment started — thermal-adaptive spacing. */
  const lastVlmJudgeAtRef = useRef(0);
  /** Demo system panel: thermal level / degradation ratio / measured fps. */
  const [sysStats, setSysStats] = useState<{ level: 0 | 1 | 2; ratio: number; fps: number; yoloMs: number } | null>(null);
  const continuousCycleCountRef = useRef(0);
  const lastStatsAtRef = useRef(0);
  /** EMA of YOLO inference time per cycle — the fps bottleneck readout. */
  const yoloMsEmaRef = useRef(0);
  /** Alternator for overlay setState — boxes redraw at half the loop rate
   *  (CSS transitions bridge the gap); React render cost was eating fps. */
  const overlayFlipRef = useRef(false);

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
  /** Generation token for the YOLO loop. Incremented on every start; a loop
   *  iteration compares its captured generation after each await so a loop
   *  stopped-then-restarted while detect() was in flight can neither revive
   *  the old loop (doubled loops sharing refs) nor apply detections captured
   *  from the PREVIOUS user's scene to the new session. */
  const yoloGenRef = useRef(0);
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
    /** Whether throttling is currently detected (legacy binary — level 2). */
    throttling: false,
    /** Graduated thermal level derived from the CV-time degradation ratio
     *  (the browser can't read the actual temperature — sustained slowdown
     *  IS the thermal signal): 0 normal → 1 warm (half the YOLO/CV rate,
     *  space VLM judgments) → 2 hot (quarter rate, VLM paused). */
    level: 0 as 0 | 1 | 2,
    /** Frame counter for skip-frame throttling. */
    frameCounter: 0,
    /** When the current stretch of elevated readings began (0 = not
     *  elevated). Escalation requires the stretch to be SUSTAINED. */
    elevatedSince: 0,
  });

  // Reset thermal state when tab returns to foreground — background tab
  // throttling inflates analysis durations, causing false thermal detection.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") {
        const thermal = thermalRef.current;
        if (thermal.throttling || thermal.level > 0) {
          thermal.throttling = false;
          thermal.level = 0;
          thermal.durations = [];
          thermal.elevatedSince = 0;
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

  // Same-session reloads skip the camera-aiming setup phase.
  useEffect(() => {
    try {
      if (sessionStorage.getItem("wayste_continuous_started") === "1") {
        setContinuousStarted(true);
      }
    } catch {
      // sessionStorage unavailable (private mode etc.) — setup shows again.
    }
  }, []);

  /** Full reset of everything continuous-mode has learned/tracked —
   *  used on start, and by the operator's back-to-setup escape hatch. */
  const resetContinuousPipeline = useCallback(() => {
    analyzerRef.current?.reset();
    trackerRef.current?.reset();
    continuousCardsRef.current = new Map();
    backgroundZonesRef.current = [];
    baselineUntilRef.current = 0;
    sceneUnstableSinceRef.current = 0;
    viewChangeHandledRef.current = false;
    lastContinuousCycleAtRef.current = 0;
    vlmJudgedRef.current.clear();
    faceZonesRef.current = { boxes: [], at: 0 };
    setStableResults([]);
    setLiveTracks([]);
  }, []);

  /** Operator toggle: track objects the model can't name (不明) or annotate
   *  only nameable classes. Flipping it clears any 不明 leftovers via a
   *  fresh background learn — cheaper than reasoning about half-alive
   *  unknown tracks. */
  const handleToggleUnknownNet = useCallback(() => {
    const next = !unknownNetRef.current;
    unknownNetRef.current = next;
    setUnknownNetOn(next);
    console.log(`[continuous] unknown-object net ${next ? "ON" : "OFF"}`);
  }, []);

  /** Re-learn what counts as background WITHOUT leaving the live view.
   *  Same wipe as start (pixel background model, learned scenery zones,
   *  tracks, cards), then the startup baseline re-runs against the scene as
   *  it stands now. Use after nudging the camera, after a lighting change,
   *  or when the room itself has picked up a false detection. */
  const handleBackgroundReset = useCallback(() => {
    console.log("[continuous] background reset — re-learning the scene");
    resetContinuousPipeline();
  }, [resetContinuousPipeline]);

  /** Operator pressed start: the camera angle is final. Reset everything
   *  that observed the aiming phase, then begin detection + baseline. */
  const handleStartContinuous = useCallback(() => {
    resetContinuousPipeline();
    try {
      sessionStorage.setItem("wayste_continuous_started", "1");
    } catch {
      // Best-effort persistence only.
    }
    setContinuousStarted(true);
  }, [resetContinuousPipeline]);

  // ── Operator escape hatch: Esc returns to the camera-aiming setup phase
  // (kiosks carry no on-screen settings; a keyboard is a setup-time tool
  // end-users don't have). Everything learned is discarded — press start
  // again once the new angle is final.
  useEffect(() => {
    if (!continuousMode) return;
    const onKeyDown = (e: KeyboardEvent) => {
      // R re-learns the background in place; Esc goes back to aiming.
      if (e.key === "r" || e.key === "R") {
        handleBackgroundReset();
        return;
      }
      if (e.key !== "Escape") return;
      console.log("[continuous] Esc — back to camera setup");
      yoloRunningRef.current = false;
      yoloGenRef.current++;
      resetContinuousPipeline();
      try {
        sessionStorage.removeItem("wayste_continuous_started");
      } catch {
        // Best-effort only.
      }
      setContinuousStarted(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [continuousMode, resetContinuousPipeline, handleBackgroundReset]);

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
    // Site config is a hard prerequisite for the YOLO loop (startYoloLoop
    // refuses without it). A single failed fetch at boot must not permanently
    // brick an unattended kiosk — retry with backoff until it loads.
    let siteConfigRetryTimer: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;
    const loadSiteConfigWithRetry = (attempt = 0) => {
      fetch("/api/site-config")
        .then((r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return r.json();
        })
        .then((data: SiteConfig) => {
          if (cancelled) return;
          siteConfigRef.current = data;
          if (data.streams) setSiteStreams(data.streams);
          // Initialize thresholds from site sensitivity (calibration applied later)
          thresholdsRef.current = computeThresholds(data.sensitivity ?? 0.5);
          // Voice and mirror are site-config driven — no end-user toggle.
          setVoiceEnabled(data.voiceEnabled ?? false);
          if (typeof data.mirrorCamera === "boolean") {
            setMirrorCamera(data.mirrorCamera);
          }
          // Detection mode + overlay are site-config driven too. The ref must
          // be set before the state flips so the CV interval stops running
          // gated transitions before the continuous loop starts.
          detectionModeRef.current = data.detectionMode ?? "gated";
          setContinuousMode(detectionModeRef.current === "continuous");
          setShowOverlay(data.showDetectionOverlay ?? false);
          setShowBinMap(data.showBinMap ?? false);
          unknownNetRef.current = data.unknownObjectFallback !== false;
          setUnknownNetOn(unknownNetRef.current);
          // Model choice is site-config driven and the ONNX session loads
          // once per page — select BEFORE the backend's first init. The
          // backend deliberately waits for site config (config is already a
          // hard prerequisite for the YOLO loop, so this defers nothing).
          import("@/lib/yolo-inference")
            .then((y) => y.setActiveYoloModel(data.yoloModel ?? "demo5"))
            .catch(() => {})
            .then(() => getInferenceBackend())
            .then((backend) => {
              inferenceRef.current = backend;
            });
          // Browser-mode VLM: start the model download IMMEDIATELY — it
          // overlaps camera aiming and YOLO warmup, so the wait is mostly
          // invisible, and the browser cache makes later launches instant.
          if (getVlmMode(data.localVlm) === "browser") {
            import("@/lib/vlm-browser")
              .then((m) => {
                vlmBrowserModRef.current = m;
                m.subscribeBrowserVlm((p) => setVlmProgress({ ...p }));
                m.initBrowserVlm(
                  data.localVlm?.model ?? DEFAULT_BROWSER_VLM_MODEL,
                  data.localVlm?.dtype,
                );
              })
              .catch((err) => console.warn("[vlm-browser] init import failed:", err));
          }
        })
        .catch(() => {
          if (cancelled) return;
          const delayMs = Math.min(2000 * 2 ** attempt, 30_000);
          console.warn(`[site-config] load failed — retrying in ${delayMs}ms`);
          siteConfigRetryTimer = setTimeout(() => loadSiteConfigWithRetry(attempt + 1), delayMs);
        });
    };

    // Backend init moved inside the site-config .then — the model choice
    // (yoloModel) must be applied before the ONNX session first loads.
    loadYoloRules();
    loadSiteConfigWithRetry();

    // Preload the BlazeFace face detector so the first real classification
    // (classify or T1 pilot-log) doesn't pay the ~5 MB WASM + 200 KB model
    // download cost. Not gated into overallReady — if this fails the kiosk
    // still works; call sites fail-closed (treat as "face present") so
    // privacy is preserved even without the detector.
    import("@/lib/face-detect")
      .then((m) => m.warmupFaceDetector())
      .catch(() => {});

    return () => {
      cancelled = true;
      if (siteConfigRetryTimer) clearTimeout(siteConfigRetryTimer);
    };
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
        const loc = localeRef.current;
        const result: ClassificationResponse & { requestId?: string } =
          buildLocalNeedsReviewResult(loc, siteConfigRef.current);
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

    // Expose the continuous-loop starter (declared below, hoisted) to the
    // mode effect — it fires once site config reports detectionMode.
    startContinuousLoopRef.current = startContinuousLoop;

    const interval = setInterval(() => {
      const video = cameraRef.current?.getVideo();
      if (!video) return;

      // ── Thermal throttling: skip every other frame during idle ──
      const thermal = thermalRef.current;
      thermal.frameCounter++;
      if (thermal.throttling && stateRef.current === "idle" && thermal.frameCounter % 2 === 0) {
        return; // effectively ~15fps during idle when throttling
      }
      // Continuous mode sheds CV load from thermal level 1 (~16fps analysis
      // — meta/blobs don't need more when the machine is warm).
      if (
        detectionModeRef.current === "continuous" &&
        thermal.level >= 1 &&
        thermal.frameCounter % 2 === 0
      ) {
        return;
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
      // Continuous mode: idle rate, EXCEPT while an unknown-object track is
      // displayed — its CV blob is the diff against the pre-item background,
      // and absorbing the item would starve the synthetic detections that
      // sustain the track (card would vanish with the item still there).
      const currentState = stateRef.current;
      const bgRate =
        detectionModeRef.current === "continuous"
          ? (hasUnknownTrackRef.current ? BG_RATE_FROZEN : BG_RATE_IDLE)
          : currentState === "idle" || currentState === "cooldown"
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
      // Skip sampling while the browser VLM is still downloading/compiling —
      // that one-time work congests the main thread and either poisons the
      // baseline (too slow) or fakes a thermal spike (ratio vs a quiet
      // baseline), depending on when it lands.
      const vlmPreparing =
        vlmBrowserModRef.current?.getBrowserVlmState?.() === "preparing";
      if (!document.hidden && !vlmPreparing) {
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
          // Self-correcting baseline: the first 60 samples may coincide with
          // one-time load (model download/compile), inflating the baseline
          // and blinding the ladder. If we now run clearly FASTER than the
          // baseline, the current speed is the truer baseline — adopt it.
          if (avg < thermal.baseline * 0.7) {
            thermal.baseline = Math.max(avg, 0.1);
          }
          const ratio = avg / thermal.baseline;
          const prevLevel = thermal.level;
          // Two guards keep this a HEAT signal rather than a busy-main-
          // thread signal (which locked out the VLM on a cool machine):
          //  - absolute floor: a big ratio over a tiny denominator is
          //    scheduler noise. Genuine throttling drives the absolute
          //    cost past the floor; sub-floor work is trivial regardless.
          //  - sustain: heat builds over tens of seconds. A busy stretch
          //    (shader compile, HMR, GC) spikes and clears — hold the
          //    current level until the elevation has lasted.
          const elevated = avg >= THERMAL_MIN_AVG_MS && ratio >= 2;
          if (!elevated) thermal.elevatedSince = 0;
          else if (!thermal.elevatedSince) thermal.elevatedSince = Date.now();
          const sustained =
            thermal.elevatedSince > 0 &&
            Date.now() - thermal.elevatedSince >= THERMAL_SUSTAIN_MS;
          if (elevated && sustained) {
            // Graduated ladder with hysteresis: escalate at 2× / 4× the
            // baseline; a level-2 machine stays hot down to 3×.
            if (ratio >= 4) thermal.level = 2;
            else if (ratio >= 3) thermal.level = Math.max(prevLevel === 2 ? 2 : 1, 1) as 0 | 1 | 2;
            else thermal.level = 1;
          } else if (!elevated) {
            // De-escalate at 1.5× so levels don't flap.
            if (ratio >= 1.5) thermal.level = Math.min(prevLevel, 1) as 0 | 1 | 2;
            else thermal.level = 0;
          }
          // else: elevated but not yet sustained — hold the current level.
          thermal.throttling = thermal.level === 2;
          perfMonitor.recordThermalState(thermal.throttling, ratio);
          if (thermal.level !== prevLevel) {
            console.log(
              `[thermal] level ${prevLevel} → ${thermal.level} (avg=${avg.toFixed(2)}ms, baseline=${thermal.baseline.toFixed(2)}ms, ×${ratio.toFixed(1)})`,
            );
            setThermalWarning(thermal.level === 2);
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

      // ── Continuous mode: no gated transitions ──
      // The CV loop still feeds analysis meta (sharpness for pilot logs),
      // thermal monitoring, and rolling calibration above — but detection
      // and all UI state are driven by the continuous YOLO loop.
      if (detectionModeRef.current === "continuous") {
        // Demo system panel: refresh measured fps / thermal stats ~1/s.
        if (Date.now() - lastStatsAtRef.current >= 1_000) {
          const dtSec = lastStatsAtRef.current > 0
            ? (Date.now() - lastStatsAtRef.current) / 1000
            : 0;
          const fps = dtSec > 0 ? continuousCycleCountRef.current / dtSec : 0;
          continuousCycleCountRef.current = 0;
          lastStatsAtRef.current = Date.now();
          const ratio =
            thermal.baseline > 0 && thermal.durations.length > 0
              ? thermal.durations.reduce((a, b) => a + b, 0) /
                thermal.durations.length /
                thermal.baseline
              : 1;
          setSysStats({ level: thermal.level, ratio, fps, yoloMs: yoloMsEmaRef.current });
        }
        // Watchdog: the loop stamps every iteration; a long silence means a
        // hung await or zombie exit. Restart — self-heal, don't sit dead.
        const lastCycle = lastContinuousCycleAtRef.current;
        if (lastCycle > 0 && Date.now() - lastCycle > CONTINUOUS_WATCHDOG_MS) {
          console.warn("[continuous] watchdog: loop stalled — restarting");
          lastContinuousCycleAtRef.current = Date.now();
          yoloRunningRef.current = false;
          yoloGenRef.current++; // invalidate any hung in-flight iteration
          startContinuousLoop();
        }
        return;
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
            // Only enter classifying when the loop can actually run (model
            // ready + site config loaded) — otherwise the kiosk would sit on
            // a dead camera screen until the 10s timeout with nothing running.
            if (startYoloLoop(analyzer)) {
              transition("classifying");
            }
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
          ? Math.min(COOLDOWN_MS + nothingDetectedCountRef.current * COOLDOWN_EXTENSION_PER_MISS_MS, COOLDOWN_MAX_MS)
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
          if (roiHasFg && startYoloLoop(analyzer)) {
            classifyStartRef.current = Date.now();
            transition("classifying");
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

    /** Start the YOLO loop. Returns false when prerequisites (model ready,
     *  site config loaded) aren't met — callers must NOT enter `classifying`
     *  in that case, or the kiosk sits on a dead camera screen until timeout. */
    function startYoloLoop(currentAnalyzer: FrameAnalyzer): boolean {
      if (yoloRunningRef.current) return true;
      const backend = inferenceRef.current;
      if (!backend?.isReady() || !siteConfigRef.current) return false;
      yoloRunningRef.current = true;
      const gen = ++yoloGenRef.current;
      lastYoloFingerprintRef.current = null; // first run always fires
      lastYoloRunTimeRef.current = Date.now();
      console.log(`[yolo-loop] started (gen ${gen})`);
      (async () => {
        while (yoloRunningRef.current && yoloGenRef.current === gen) {
          const video = cameraRef.current?.getVideo();
          if (!video) { await new Promise(r => setTimeout(r, 50)); continue; }

          // ── Local-only rescue: item present but unresolved for too long ──
          // A moving or out-of-vocabulary item keeps changing the frame, so
          // the stale-frame branch below never fires — without this check the
          // kiosk would scan silently for CLASSIFYING_TIMEOUT_MS and show
          // NOTHING. Resolving as needs_review requires no cloud image, so no
          // frame-quality condition applies.
          if (!CLOUD_FALLBACK_ENABLED
              && stateRef.current === "classifying"
              && !inFlightRef.current
              && Date.now() - classifyStartRef.current >= LOCAL_UNRESOLVED_ESCALATION_MS
              && lastAnalysisRef.current) {
            console.log(`[yolo-loop] unresolved for ${LOCAL_UNRESOLVED_ESCALATION_MS}ms → on-device needs_review`);
            triggerApiEscalation(video, lastAnalysisRef.current);
          }

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
              // The "good" quality gate exists for the CLOUD path (a sharp
              // frame is worth waiting for before paying for a Vision call).
              // In local-only mode the escalation sends no frame anywhere —
              // resolve regardless of quality.
              if (analysis && (!CLOUD_FALLBACK_ENABLED || imageQualityBand(analysis) === "good")) {
                triggerApiEscalation(video, analysis);
              } else {
                // Cloud mode + quality too poor for API — no point staying
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

          // The loop may have been stopped (and possibly restarted for a NEW
          // user/scene) while detect() was awaiting. Applying these detections
          // would classify the previous scene as the current one.
          if (!yoloRunningRef.current || yoloGenRef.current !== gen) break;

          const analysis = lastAnalysisRef.current;
          try {
            handleYoloCycleResult(detections, yoloMs, video, analysis, currentAnalyzer);
          } catch (err) {
            // A single bad cycle (e.g. a rule-resolution bug) must not kill the
            // loop — that would strand the kiosk in `classifying` until timeout
            // with no result and no log.
            console.error("[yolo-loop] cycle handler failed:", err);
          }
        }
        console.log(`[yolo-loop] stopped (gen ${gen})`);
      })();
      return true;
    }

    function stopYoloLoop() {
      yoloRunningRef.current = false;
      // Abort any in-flight API call when stopping the loop
      if (apiAbortRef.current) {
        apiAbortRef.current.abort();
        apiAbortRef.current = null;
      }
      // The abort above rejects any pending escalation with AbortError, whose
      // catch handlers return without clearing the in-flight flag. Left true,
      // it would permanently block every future escalation — the on-device
      // needs_review path would silently die until a confident YOLO hit.
      inFlightRef.current = false;
    }

    // ═══════════════════════════════════════
    // ── CONTINUOUS MODE (always-on YOLO + temporal tracker) ──
    // ═══════════════════════════════════════

    /** Always-on YOLO loop, paced to ~10fps. Unlike the gated loop there is
     *  no frame-change gate: a static frame must keep feeding the tracker or
     *  a motionless item would read as "vanished" and start coasting. */
    function startContinuousLoop() {
      if (yoloRunningRef.current) return;
      yoloRunningRef.current = true;
      const gen = ++yoloGenRef.current;
      console.log(`[continuous] loop started (gen ${gen})`);
      (async () => {
        while (yoloRunningRef.current && yoloGenRef.current === gen) {
          // Stamp every iteration (including waits) — the CV interval's
          // watchdog restarts the loop if this goes silent.
          lastContinuousCycleAtRef.current = Date.now();
          const video = cameraRef.current?.getVideo();
          const backend = inferenceRef.current;
          if (!video || !backend?.isReady() || !siteConfigRef.current) {
            await new Promise((r) => setTimeout(r, 200));
            continue;
          }
          const t0 = Date.now();
          let detections: YoloDetection[] = [];
          try {
            // Detect down to the unknown-candidate floor — boxes in
            // [floor, keep) become class-agnostic unknown evidence, boxes
            // ≥ keep feed tracks normally. fullFrame: continuous mode
            // covers the entire camera view, not the center square.
            const keep = thresholdsRef.current.TRACK_KEEP_THRESHOLD;
            detections = await backend.detect(
              video, 0, CONTINUOUS_MIN_BOX_AREA,
              Math.max(UNKNOWN_CANDIDATE_MIN_CONF, keep * UNKNOWN_CANDIDATE_FLOOR_RATIO),
              true,
            );
          } catch {
            // A single failed inference must not kill the loop.
          }
          const cycleMs = Date.now() - t0;
          perfMonitor.recordYoloInference(cycleMs);
          yoloMsEmaRef.current =
            yoloMsEmaRef.current === 0 ? cycleMs : yoloMsEmaRef.current * 0.8 + cycleMs * 0.2;
          if (!yoloRunningRef.current || yoloGenRef.current !== gen) break;

          // ── Face sweep (~1fps): veto zones for the unknown fallback ──
          // The kiosk must never box a face, and clothing near a face is a
          // person, not presented waste. Fully on-device; nothing stored.
          // Only consumers: the unknown net's suppress zones and the
          // server-mode VLM face gate — skip the BlazeFace work (main-thread
          // fps budget) when neither is active.
          const faceSweepNeeded =
            unknownNetRef.current ||
            getVlmMode(siteConfigRef.current?.localVlm) === "server";
          if (
            faceSweepNeeded &&
            Date.now() - faceZonesRef.current.at >= FACE_SWEEP_INTERVAL_MS
          ) {
            try {
              await sweepFaceZones(video);
            } catch {
              // Face veto is best-effort — never block the pipeline.
            }
            if (!yoloRunningRef.current || yoloGenRef.current !== gen) break;
          }

          try {
            handleContinuousCycle(detections, Date.now(), video, cycleMs);
          } catch (err) {
            console.error("[continuous] cycle handler failed:", err);
          }
          continuousCycleCountRef.current++;
          // Pace the loop to the camera's actual frame rate (no point
          // running YOLO faster than new frames arrive); halve under
          // thermal throttling.
          const cameraFps = (video.srcObject as MediaStream | null)
            ?.getVideoTracks?.()[0]?.getSettings?.().frameRate;
          const baseInterval = cameraFps && cameraFps > 0
            ? Math.min(
                Math.max(1000 / cameraFps, CONTINUOUS_INTERVAL_CLAMP[0]),
                CONTINUOUS_INTERVAL_CLAMP[1],
              )
            : CONTINUOUS_YOLO_INTERVAL_MS;
          // Thermal ladder: full rate → half → quarter as the machine heats.
          // Also yield to an in-flight VLM judgment: both models share one
          // GPU. ×2, not more — with the 480px small model YOLO only takes
          // ~25ms, so a harsher backoff starves the LIVE view (8fps reads as
          // "laggy demo") to speed a judgment the user isn't staring at.
          const thermalLevel = thermalRef.current.level;
          const targetInterval =
            baseInterval *
            (thermalLevel === 2 ? 4 : thermalLevel === 1 ? 2 : 1) *
            (vlmInFlightRef.current ? 2 : 1);
          const sleepMs = Math.max(5, targetInterval - (Date.now() - t0));
          await new Promise((r) => setTimeout(r, sleepMs));
        }
        console.log(`[continuous] loop stopped (gen ${gen})`);
      })();
    }

    /** Detect faces on a small letterboxed copy of the frame and store their
     *  model-space boxes (padded) as veto zones for the unknown fallback. */
    async function sweepFaceZones(video: HTMLVideoElement) {
      const { detectFaceBoxes } = await import("@/lib/face-detect");
      if (!faceSweepCanvasRef.current) {
        faceSweepCanvasRef.current = document.createElement("canvas");
        faceSweepCanvasRef.current.width = FACE_SWEEP_CANVAS_SIZE;
        faceSweepCanvasRef.current.height = FACE_SWEEP_CANVAS_SIZE;
      }
      const canvas = faceSweepCanvasRef.current;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      const vw = video.videoWidth;
      const vh = video.videoHeight;
      if (!vw || !vh) return;
      // Same letterbox layout as the YOLO input, at sweep resolution — face
      // boxes then map to model space with a single scale factor.
      const lb = computeLetterbox(vw, vh, FACE_SWEEP_CANVAS_SIZE);
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, FACE_SWEEP_CANVAS_SIZE, FACE_SWEEP_CANVAS_SIZE);
      ctx.drawImage(video, 0, 0, vw, vh, lb.dx, lb.dy, lb.dw, lb.dh);

      const faces = await detectFaceBoxes(canvas);
      const scale = YOLO_MODEL_SIZE / FACE_SWEEP_CANVAS_SIZE;
      faceZonesRef.current = {
        at: Date.now(),
        boxes: faces.map((f) => {
          // Pad 25% on each side — hair/shoulders belong to the person too.
          const padX = f.w * 0.25;
          const padY = f.h * 0.25;
          return [
            (f.x - padX) * scale,
            (f.y - padY) * scale,
            (f.w + padX * 2) * scale,
            (f.h + padY * 2) * scale,
          ] as Bbox;
        }),
      };
    }

    function overlapRatio(a: Bbox, b: Bbox): number {
      const ix = Math.max(0, Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0]));
      const iy = Math.max(0, Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]));
      const minArea = Math.min(a[2] * a[3], b[2] * b[3]);
      return minArea > 0 ? (ix * iy) / minArea : 0;
    }

    /** True when this detection IS remembered scenery: same spot AND the
     *  same thing the model saw there when the region was learned. A bottle
     *  held up in front of the shelf is a different class → still detected. */
    function isScenery(bbox: Bbox, className: string): boolean {
      return backgroundZonesRef.current.some(
        (z) =>
          (z.className === null || z.className === className) &&
          overlapRatio(bbox, z.bbox) > 0.35,
      );
    }

    /** Remember a region as scenery (FIFO-capped, overlap-deduped). */
    function addBackgroundZone(bbox: Bbox, className: string | null = null) {
      const zones = backgroundZonesRef.current;
      const existing = zones.find((z) => overlapRatio(z.bbox, bbox) > 0.5);
      if (existing) {
        // Re-learning the same spot: keep the narrower rule (a named zone
        // silences one class; a null zone silences everything there).
        if (existing.className !== className) existing.className = null;
        return;
      }
      zones.push({ bbox: [...bbox] as Bbox, className });
      if (zones.length > BACKGROUND_ZONE_CAP) zones.shift();
    }

    /** One continuous-mode cycle: feed the tracker, sync result cards to
     *  displayable tracks, publish overlay state. */
    function handleContinuousCycle(
      detections: YoloDetection[],
      now: number,
      video: HTMLVideoElement,
      cycleMs: number,
    ) {
      const th = thresholdsRef.current;
      const siteConfig = siteConfigRef.current;
      if (!siteConfig) return;
      // Site config may override tracker tuning knobs (JSON-only, per site).
      if (!trackerRef.current) trackerRef.current = new DetectionTracker(siteConfig.trackerTuning);

      // Keep the overlay's aspect mapping in sync (bail-out when unchanged).
      const aspect = video.videoWidth / video.videoHeight;
      if (Number.isFinite(aspect) && aspect > 0) {
        setVideoAspect((prev) => (Math.abs(prev - aspect) < 0.01 ? prev : aspect));
      }

      // Remembered scenery is dropped HERE, at the source: suppressing it
      // later (at card creation) still leaves a track, and a track still
      // draws an annotation box — the shelf keeps flickering boxes even
      // though no card appears. Nothing downstream should ever see it.
      const wasteDetections = detections.filter(
        (d) => !isYoloClassNotWaste(d.className) && !isScenery(d.bbox as Bbox, d.className),
      );
      // Split at the keep threshold: below it YOLO's class guess is
      // unreliable — those boxes become class-agnostic unknown evidence.
      const confidentDetections = wasteDetections.filter(
        (d) => d.confidence >= th.TRACK_KEEP_THRESHOLD,
      );
      const lowConfDetections = wasteDetections.filter(
        (d) => d.confidence < th.TRACK_KEEP_THRESHOLD,
      );

      // ── Class-agnostic fallback ──
      // A fully out-of-vocabulary item must never leave the kiosk silently
      // unresponsive. Primary evidence: low-confidence YOLO boxes (robust
      // to camera/background motion). Secondary: CV blobs — fixed-camera
      // net for objects YOLO gives zero boxes, auto-suspended while the
      // whole scene is changing. The tracker's temporal confirmation
      // filters the noise; cards resolve as needs_review.
      const analysisForBlobs = lastAnalysisRef.current;
      const hasAspect = Number.isFinite(aspect) && aspect > 0;
      const sceneUnstable =
        !analysisForBlobs?.isSettled ||
        analysisForBlobs.roiForegroundRatio > SCENE_UNSTABLE_FG_RATIO;

      // ── Auto view-change handling ──
      // A passer-by destabilizes the scene for a moment; a MOVED CAMERA
      // destabilizes it until the background model re-converges. Sustained
      // instability therefore means the learned scenery zones point at
      // wrong coordinates — discard them and, once the scene settles in
      // its new framing, re-learn the baseline. No operator action needed.
      if (sceneUnstable) {
        if (sceneUnstableSinceRef.current === 0) {
          sceneUnstableSinceRef.current = now;
        } else if (
          !viewChangeHandledRef.current &&
          now - sceneUnstableSinceRef.current >= VIEW_CHANGE_UNSTABLE_MS
        ) {
          viewChangeHandledRef.current = true;
          console.log("[continuous] sustained scene change → camera moved: clearing scenery zones");
          backgroundZonesRef.current = [];
          analyzerRef.current?.boostBackgroundAdaptation();
        }
      } else {
        if (viewChangeHandledRef.current) {
          console.log("[continuous] scene settled — re-learning background baseline");
          baselineUntilRef.current = now + CONTINUOUS_BASELINE_MS;
        }
        sceneUnstableSinceRef.current = 0;
        viewChangeHandledRef.current = false;
      }

      const faceZones =
        now - faceZonesRef.current.at < FACE_ZONE_TTL_MS ? faceZonesRef.current.boxes : [];
      // The out-of-vocabulary net is a site choice (config default) with an
      // operator toggle in the demo panel. With a broad model (coco80) most
      // demo items already have a named class, and the occasional 不明 card
      // is noise that also keeps the VLM busy.
      const unknownEnabled = unknownNetRef.current;
      let synthetic = hasAspect && unknownEnabled
        ? buildUnknownDetections({
            lowConfDetections,
            blobs: analysisForBlobs?.isSettled ? analysisForBlobs.blobs : [],
            sceneUnstable,
            confidentDetections,
            knownTrackBboxes: trackerRef.current
              .getTracks()
              .filter((t) => t.classId !== UNKNOWN_OBJECT_CLASS_ID)
              .map((t) => t.bbox),
            suppressZones: [
              ...backgroundZonesRef.current.map((z) => z.bbox),
              ...faceZones,
            ],
            videoAspect: aspect,
            confidence: th.TRACK_APPEAR_THRESHOLD,
          })
        : [];

      // ── Startup baseline: whatever is visible in the first seconds is
      // scenery (window handles, fixtures), not an item someone brought.
      // Learn those regions as background zones instead of tracking them.
      if (baselineUntilRef.current === 0) {
        baselineUntilRef.current = now + CONTINUOUS_BASELINE_MS;
      }
      if (now < baselineUntilRef.current) {
        for (const cand of synthetic) addBackgroundZone(cand.bbox as Bbox);
        synthetic = [];
        // NAMED scenery too: a teddy bear on a shelf or a poster is a real
        // COCO class, so the unknown net's zones never covered it — a small
        // camera shake later re-detects it and a needs_review card pops on
        // furniture. Anything visible during the baseline that would NOT
        // resolve instantly (unmapped class or sub-resolve confidence) is
        // scenery; remember its region and refuse needs_review cards there.
        // Instant-resolving classes (a bottle already on the desk) are left
        // alone — parked-suppression owns that case.
        for (const d of confidentDetections) {
          if (
            d.confidence < th.TRACK_RESOLVE_THRESHOLD ||
            !resolveYoloDetection(d, siteConfigRef.current!, localeRef.current)
          ) {
            addBackgroundZone(d.bbox as Bbox, d.className);
          }
        }
      }

      // Content bounds let the tracker clear edge-exited items fast while
      // still coasting through mid-frame occlusion.
      const lb = computeLetterbox(hasAspect ? aspect : 16 / 9, 1, YOLO_MODEL_SIZE);
      const { tracks, events } = trackerRef.current.update(
        [...confidentDetections, ...synthetic],
        now,
        {
          appearConfidence: th.TRACK_APPEAR_THRESHOLD,
          keepConfidence: th.TRACK_KEEP_THRESHOLD,
          contentBounds: { x0: lb.dx, y0: lb.dy, x1: lb.dx + lb.dw, y1: lb.dy + lb.dh },
        },
      );

      // BG freeze input: is a blob-backed unknown track currently displayed?
      hasUnknownTrackRef.current = tracks.some(
        (t) => t.classId === UNKNOWN_OBJECT_CLASS_ID && DetectionTracker.isDisplayable(t),
      );

      // ── Demote long-static, unresolvable tracks to scenery ──
      // Background that slipped past the startup baseline (revealed by a
      // lighting change, a camera nudge, or present before a watchdog
      // restart) sits still indefinitely — a presented item never does.
      // Zone it; the detection filter above then silences it for good.
      // Applies to NAMED tracks too (the shelf teddy bear is a real COCO
      // class), but only while they can't resolve to a bin: an item that
      // firmly resolves is answered, and parked-suppression owns the
      // "left on the counter" case.
      for (const t of tracks) {
        if (
          now - t.firstSeenAt >= UNKNOWN_STATIC_TO_ZONE_MS &&
          t.travelEma <= SCENERY_MAX_TRAVEL_PX &&
          t.confidence < th.TRACK_RESOLVE_THRESHOLD
        ) {
          console.log(`[continuous] static track ${t.id} (${t.className}) → scenery`);
          addBackgroundZone(
            t.bbox,
            t.classId === UNKNOWN_OBJECT_CLASS_ID ? null : t.className,
          );
        }
      }

      const { cards, changed, actions, sessionEnded } = syncContinuousCards(
        tracks,
        events,
        continuousCardsRef.current,
        {
          // Continuous mode resolves at the tracker-calibrated bar, not the
          // gated single-frame bar — see TRACK_RESOLVE_THRESHOLD.
          instantConfidence: th.TRACK_RESOLVE_THRESHOLD,
          needsReviewMs: CONTINUOUS_NEEDS_REVIEW_MS,
          // Only steadily-presented tracks earn a needs_review card —
          // patterns riding on moving clothing/hands never surface.
          // (Scenery is already gone: filtered out at the detection source.)
          needsReviewGate: (t) => t.travelEma <= STEADY_MAX_TRAVEL_PX,
        },
        now,
        {
          resolveTrack: (t: Track) =>
            resolveYoloDetection(
              { classId: t.classId, className: t.className, confidence: t.confidence, bbox: [...t.bbox] },
              siteConfig,
              localeRef.current,
            ),
          buildNeedsReview: () => buildLocalNeedsReviewResult(localeRef.current, siteConfig),
        },
      );
      continuousCardsRef.current = cards;

      for (const a of actions) {
        switch (a.type) {
          case "instantHit":
            console.log(`[continuous] HIT: ${a.card.itemName} (${(a.track.confidence * 100).toFixed(0)}%)`);
            maybeLogContinuous(video, a.card, detections, cycleMs);
            break;
          case "needsReview":
            console.log(`[continuous] unresolved ${a.track.className} → needs_review`);
            maybeLogContinuous(video, a.card, detections, cycleMs);
            break;
          case "upgraded":
            console.log(`[continuous] upgraded needs_review → ${a.card.itemName}`);
            break;
          case "classSwapped":
            console.log(`[continuous] class swap ${a.previousClassName} → ${a.track.className}`);
            break;
        }
      }

      if (changed) {
        const arr = [...cards.values()].slice(0, 4);
        sortByPhysicalPosition(arr);
        if (sessionEnded) {
          // Session over — items left the scene after results were shown.
          recordSort();
          setStatsVersion((v) => v + 1);
        }
        setStableResults(arr);
        setResultRequestIds(arr.map(() => undefined));
      }

      // ── Tier 1.5: unresolved cards go to the local VLM (when configured) ──
      for (const ev of events) {
        if (ev.type === "lost") vlmJudgedRef.current.delete(ev.trackId);
        else if (ev.type === "classChanged") vlmJudgedRef.current.delete(ev.track.id);
      }
      maybeJudgeUnresolvedWithVlm(tracks, cards, video);

      // ── Overlay state — every OTHER cycle (React render cost at the full
      // loop rate was eating fps; the 75ms CSS transition bridges the gap).
      // Card changes always publish immediately.
      overlayFlipRef.current = !overlayFlipRef.current;
      if (changed || overlayFlipRef.current) {
        setLiveTracks(
          tracks
            .filter((t) => !t.parked)
            .map((t) => {
              const card = cards.get(t.id);
              return {
                id: t.id,
                bbox: [...t.bbox] as [number, number, number, number],
                tentative: !card,
                label: card ? card.itemName : null,
                color: card ? card.binColor : null,
                streamId: card ? (card.wasteStream as string) : null,
                confidence: t.confidence,
              };
            }),
        );
      }
    }

    /** Tier 1.5: pick ONE unresolved (needs_review) card whose track is
     *  steady and not yet judged, crop it from the live video, and ask the
     *  local VLM. A verdict above the site's review bar upgrades the card
     *  through the same path YOLO upgrades use; anything else keeps the
     *  honest needs_review answer. Never blocks the pipeline. */
    function maybeJudgeUnresolvedWithVlm(
      tracks: Track[],
      cards: Map<number, TrackedResult>,
      video: HTMLVideoElement,
    ) {
      const vlmCfg = siteConfigRef.current?.localVlm;
      const vlmMode = getVlmMode(vlmCfg);
      if (!vlmMode) return;
      if (vlmInFlightRef.current) return;
      // Browser mode: readiness is checked BEFORE any track is marked as
      // judged — cards created while the model is still downloading must be
      // picked up once it becomes ready, not skipped forever.
      if (
        vlmMode === "browser" &&
        vlmBrowserModRef.current?.getBrowserVlmState() !== "ready"
      ) {
        return;
      }
      // Thermal-adaptive pacing: a VLM judgment is the heaviest single GPU
      // op — space them out when warm, stop entirely when hot.
      const thermalLevel = thermalRef.current.level;
      if (thermalLevel >= 2) return;
      const minGap = thermalLevel === 1 ? VLM_GAP_WARM_MS : VLM_GAP_NORMAL_MS;
      if (Date.now() - lastVlmJudgeAtRef.current < minGap) return;

      for (const [id, card] of cards) {
        if (card._locked) continue; // only unresolved needs_review cards
        if (vlmJudgedRef.current.has(id)) continue;
        const t = tracks.find((tr) => tr.id === id);
        if (!t || !DetectionTracker.isDisplayable(t)) continue;
        // Judge a steady crop — a motion-blurred crop wastes the call.
        if (t.travelEma > STEADY_MAX_TRAVEL_PX) continue;

        vlmJudgedRef.current.add(id);
        vlmInFlightRef.current = true;
        lastVlmJudgeAtRef.current = Date.now();
        const bbox = [...t.bbox] as Bbox;
        const classNameAtJudge = t.className;
        // A judgment that never happened (crop failed, model glitch,
        // timeout) must not brand the track as judged forever — lift the
        // mark after a delay so a later, healthier cycle retries.
        const scheduleRetry = () =>
          setTimeout(() => vlmJudgedRef.current.delete(id), VLM_RETRY_DELAY_MS);

        (async () => {
          const t0 = Date.now();
          try {
            const siteConfig = siteConfigRef.current;
            if (!siteConfig) {
              scheduleRetry();
              return;
            }
            // "server" mode sends the crop off-device — face-gate it first
            // (the proxy re-checks server-side as the authoritative floor).
            if (vlmMode === "server" && (await cropContainsFace(video, bbox))) {
              console.log(`[vlm] track ${id}: crop contains a face — not sent`);
              return;
            }
            const dataUrl = await cropTrackToDataUrl(video, bbox);
            if (!dataUrl) {
              scheduleRetry();
              return;
            }
            const judgment = await judgeCropWithVlm(
              dataUrl, vlmCfg!, siteConfig, localeRef.current,
            );
            const latencyMs = Date.now() - t0;
            if (!judgment) {
              console.log(`[vlm] no verdict for track ${id} (${latencyMs}ms) — will retry`);
              scheduleRetry();
              return;
            }
            console.log(
              `[vlm] track ${id}: ${judgment.itemName} → ${judgment.wasteStream} ` +
              `(${(judgment.confidence * 100).toFixed(0)}%, ${latencyMs}ms)`,
            );
            const applied =
              judgment.wasteStream !== "needs_review" &&
              judgment.confidence >= (siteConfig.reviewThreshold ?? 0.55);
            if (applied) {
              // The scene may have moved on mid-judgment: card resolved by a
              // YOLO upgrade, track lost, or the object swapped (class vote).
              const current = continuousCardsRef.current.get(id);
              const trackNow = trackerRef.current?.getTracks().find((tr) => tr.id === id);
              if (current && !current._locked && trackNow?.className === classNameAtJudge) {
                const result = buildClassificationResult(
                  {
                    itemName: judgment.itemName,
                    wasteStream: judgment.wasteStream,
                    confidence: judgment.confidence,
                    reasoning: judgment.reasoning ?? "",
                  },
                  siteConfig,
                  localeRef.current,
                );
                result.modelUsed = "vlm";
                continuousCardsRef.current.set(id, {
                  ...result,
                  _trackBbox: current._trackBbox,
                  _trackId: id,
                  _locked: true,
                });
                const arr = [...continuousCardsRef.current.values()].slice(0, 4);
                sortByPhysicalPosition(arr);
                setStableResults(arr);
                setResultRequestIds(arr.map(() => undefined));
              }
            }
            logVlmVerdict(judgment, latencyMs, applied);
          } catch (err) {
            console.warn("[vlm] judgment error:", err);
            scheduleRetry();
          } finally {
            vlmInFlightRef.current = false;
          }
        })();
        break; // one judgment at a time
      }
    }

    /** Fire-and-forget pilot-log for a VLM verdict (metadata only — the
     *  crop never leaves the machine). */
    function logVlmVerdict(judgment: VlmJudgment, latencyMs: number, applied: boolean) {
      fetch("/api/pilot-log", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          entry: {
            modelUsed: "vlm",
            escalated: true,
            itemName: judgment.itemName,
            wasteStream: applied ? judgment.wasteStream : "needs_review",
            confidence: judgment.confidence,
            requiresVerification: !applied,
            latencyMs,
          },
        }),
      }).catch(() => {});
    }

    /** Throttled pilot-log for continuous mode — reuses the gated path's
     *  face-gated logger, spaced out so walk-throughs don't spam uploads. */
    function maybeLogContinuous(
      video: HTMLVideoElement,
      result: ClassificationResponse,
      detections: YoloDetection[],
      cycleMs: number,
    ) {
      const analysis = lastAnalysisRef.current;
      if (!analysis) return;
      if (Date.now() - lastContinuousLogRef.current < CONTINUOUS_LOG_MIN_INTERVAL_MS) return;
      lastContinuousLogRef.current = Date.now();
      const waste = detections.filter((d) => !isYoloClassNotWaste(d.className));
      logYoloOnlyResult(
        video, result, detections, cycleMs, analysis, "T1", undefined, undefined,
        {
          tier1: waste
            .map((d) => ({ itemName: d.className, confidence: d.confidence, x: d.bbox[0] + d.bbox[2] / 2 }))
            .sort((a, b) => b.confidence - a.confidence)
            .slice(0, 5),
        },
        [result],
        undefined,
        // Continuous-mode detections are full-frame letterboxed — log the
        // matching letterboxed square, not the gated center crop.
        true,
      );
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
          // The pipeline may have moved on while the call was in flight
          // (YOLO hit → result, or FG gone → cooldown). A stale response
          // must not overwrite the fresher state.
          if (stateRef.current !== "classifying") {
            inFlightRef.current = false;
            return;
          }
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
            // YOLO won the race (or the loop was stopped) — the escalation
            // is void. The flag must still be cleared or every future
            // escalation is silently blocked.
            inFlightRef.current = false;
            return;
          }
          apiAbortRef.current = null;
          if (stateRef.current !== "classifying") {
            inFlightRef.current = false;
            return;
          }
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
          if (err instanceof DOMException && err.name === "AbortError") {
            inFlightRef.current = false;
            return;
          }
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
          if (err instanceof DOMException && err.name === "AbortError") {
            inFlightRef.current = false;
            return;
          }
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
        // Matching is by IoU, NOT by exact bbox position: YOLO boxes jitter
        // a few pixels between runs (and the frame-change gate guarantees the
        // frame moved), so a position-keyed lookup would reset the counter
        // every cycle and new items would never accumulate enough persistence.
        for (const detIdx of matchResult.unmatchedDetections) {
          const det = wasteDetections[detIdx];
          if (!det) continue;

          let key: string | null = null;
          let entry: { bbox: Bbox; count: number } | null = null;
          let bestIoU = 0.3; // minimum overlap to count as the same item
          for (const [k, e] of unresolvedNewItemsRef.current) {
            const iou = computeIoU(e.bbox, det.bbox);
            if (iou > bestIoU) {
              bestIoU = iou;
              key = k;
              entry = e;
            }
          }
          if (entry && key) {
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
          } else {
            unresolvedNewItemsRef.current.set(
              `${Math.round(det.bbox[0])}_${Math.round(det.bbox[1])}_${nextTrackIdRef.current}`,
              { bbox: det.bbox, count: 1 },
            );
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
      /** True when detections came from a full-frame letterboxed inference
       *  (continuous mode) — the logged image must then be the same
       *  letterboxed square, or bboxNorm won't line up with the pixels. */
      fullFrameCapture = false,
    ) {
      // Capture the exact square the detections were produced in, so logged
      // bboxNorm values align with the stored image (review overlays and
      // fine-tuning export draw boxes on it). Log images preserve full
      // resolution for fine-tuning.
      //   gated:      center short-side square crop (e.g. 720×720 from 1280×720)
      //   continuous: FULL frame letterboxed into a long-side square, matching
      //               the model input in `lib/yolo-inference.ts` fullFrame mode
      const vw = video.videoWidth;
      const vh = video.videoHeight;
      const side = fullFrameCapture ? Math.max(vw, vh) : Math.min(vw, vh);
      const drawCaptureSquare = (ctx: OffscreenCanvasRenderingContext2D) => {
        if (fullFrameCapture) {
          const { dx, dy, dw, dh } = computeLetterbox(vw, vh, side);
          ctx.fillStyle = "#727272"; // same padding as the YOLO letterbox input
          ctx.fillRect(0, 0, side, side);
          ctx.drawImage(video, 0, 0, vw, vh, dx, dy, dw, dh);
        } else {
          const roiX = Math.round((vw - side) / 2);
          const roiY = Math.round((vh - side) / 2);
          ctx.drawImage(video, roiX, roiY, side, side, 0, 0, side, side);
        }
      };

      // ── Client-side face detection gate ──
      // BlazeFace is destructive to OffscreenCanvas (transferToImageBitmap),
      // so draw to a dedicated canvas for the face check. Fail-closed: if
      // the detector errors, treat as "face present" so the image is not
      // stored — the server-side check still runs and provides the authoritative
      // floor against a compromised kiosk.
      const faceCanvas = new OffscreenCanvas(side, side);
      const faceCtx = faceCanvas.getContext("2d");
      if (!faceCtx) return;
      drawCaptureSquare(faceCtx);

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
        captureSpace: (fullFrameCapture ? "letterbox" : "center_square") as
          "letterbox" | "center_square",
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
      // `transferToImageBitmap` inside `containsFace`, so redraw the capture
      // square onto a fresh canvas for the JPEG encode. Pass faceDetected: false
      // so the server knows the client already checked — server still
      // re-runs its own detector (`/api/pilot-log/route.ts`) as the
      // authoritative floor, matching the pattern in `/api/classify`.
      try {
        const uploadCanvas = new OffscreenCanvas(side, side);
        const uploadCtx = uploadCanvas.getContext("2d");
        if (!uploadCtx) return;
        drawCaptureSquare(uploadCtx);
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

  // ── Start the continuous loop once the mode is selected AND the operator
  // has confirmed the camera angle. (The loop itself waits for the camera,
  // model, and site config to be ready, so firing early is safe.)
  useEffect(() => {
    if (!continuousMode || !continuousStarted) return;
    startContinuousLoopRef.current?.();
  }, [continuousMode, continuousStarted]);


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

      {/* Continuous mode: one persistent live view — camera + annotations +
          compact result cards. No idle/camera/result screen switching.
          Before the operator confirms the camera angle, only the live frame
          and a start button are shown (setup phase). */}
      {continuousMode ? (
        continuousStarted ? (
          <LiveDetectionView
            tracks={liveTracks}
            results={stableResults}
            streams={siteStreams}
            locale={locale}
            mirror={mirrorCamera}
            showOverlay={showOverlay}
            showBinMap={showBinMap}
            videoAspect={videoAspect}
          />
        ) : (
          <div className="absolute inset-0 z-10 select-none">
            <div className="absolute top-8 left-1/2 -translate-x-1/2 pointer-events-none">
              <div className="bg-neutral-900/70 backdrop-blur-sm rounded-2xl px-6 py-3">
                <p className="text-neutral-100 text-lg font-medium">{T("setupHint")}</p>
              </div>
            </div>
            <div className="absolute bottom-12 left-1/2 -translate-x-1/2">
              <button
                type="button"
                onClick={handleStartContinuous}
                className="bg-emerald-500 hover:bg-emerald-400 active:scale-95 transition text-neutral-950 text-2xl font-bold rounded-2xl px-10 py-5 shadow-xl focus-visible:outline-2 focus-visible:outline-emerald-300"
              >
                {T("startDetection")}
              </button>
            </div>
          </div>
        )
      ) : (
        <>
          {/* Full-screen UI states (gated mode) */}
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
        </>
      )}

      {/* Demo system panel (annotation mode only): thermal load ladder,
          CV degradation ratio, measured detection fps, AI-judge state —
          shows the adaptive machinery working, live. */}
      {continuousMode && continuousStarted && showOverlay && sysStats && (
        <div className="absolute top-5 left-5 z-30 flex items-center gap-3 bg-neutral-900/80 backdrop-blur-md rounded-xl px-4 py-2 text-xs font-mono text-neutral-300 pointer-events-none select-none">
          <span className="flex items-center gap-1.5">
            <span
              className={`inline-block w-2 h-2 rounded-full ${
                sysStats.level === 2
                  ? "bg-red-400"
                  : sysStats.level === 1
                    ? "bg-amber-400"
                    : "bg-emerald-400"
              }`}
            />
            {T("sysLoad")}{" "}
            {sysStats.level === 2
              ? T("sysLoadHot")
              : sysStats.level === 1
                ? T("sysLoadWarm")
                : T("sysLoadNormal")}{" "}
            ×{sysStats.ratio.toFixed(1)}
          </span>
          <span className="text-neutral-600">|</span>
          <span>{Math.round(sysStats.fps)} fps</span>
          <span className="text-neutral-600">|</span>
          <span>YOLO {Math.round(sysStats.yoloMs)}ms</span>
          <span className="text-neutral-600">|</span>
          {/* Operator control — annotation mode only, so the production
              kiosk face still carries no settings for end users. */}
          <button
            type="button"
            onClick={handleBackgroundReset}
            className="pointer-events-auto rounded-md bg-neutral-700 hover:bg-neutral-600 active:scale-95 transition px-2.5 py-1 text-neutral-100 font-sans focus-visible:outline-2 focus-visible:outline-emerald-400"
            title="R"
          >
            {T("resetBackground")}
          </button>
          <span className="text-neutral-600">|</span>
          <button
            type="button"
            onClick={handleToggleUnknownNet}
            className={`pointer-events-auto rounded-md px-2.5 py-1 font-sans active:scale-95 transition focus-visible:outline-2 focus-visible:outline-emerald-400 ${
              unknownNetOn
                ? "bg-emerald-700 hover:bg-emerald-600 text-emerald-50"
                : "bg-neutral-700 hover:bg-neutral-600 text-neutral-300"
            }`}
          >
            {T("unknownNet")} {unknownNetOn ? "ON" : "OFF"}
          </button>
          <span className="text-neutral-600">|</span>
          <span>
            VLM{" "}
            {vlmProgress?.state === "preparing"
              ? `${T("sysVlmPreparing")} ${Math.round(vlmProgress.fraction * 100)}%`
              : vlmProgress?.state === "ready"
                ? sysStats.level >= 2
                  ? T("sysVlmPaused")
                  : vlmInFlightRef.current
                    ? T("sysVlmJudging")
                    : T("sysVlmIdle")
                : T("sysVlmOff")}
          </span>
        </div>
      )}

      {/* Browser-VLM preparation gauge — a determinate bar with real MB
          numbers feels far shorter than a spinner. Download starts at page
          load, overlapping camera aiming; weights are cached, so this card
          only ever appears on the first launch. */}
      {continuousMode && vlmProgress?.state === "preparing" && (
        <div className="absolute top-5 right-5 z-30 w-72 bg-neutral-900/85 backdrop-blur-md rounded-xl px-4 py-3 pointer-events-none select-none">
          <p className="text-neutral-100 text-sm font-semibold">
            {vlmProgress.fraction < 0.995 ? T("vlmPreparing") : T("vlmLoadingGpu")}
          </p>
          <div className="mt-2 h-2 rounded-full bg-neutral-700 overflow-hidden">
            <div
              className="h-full bg-emerald-400 rounded-full transition-[width] duration-300"
              style={{ width: `${Math.round(vlmProgress.fraction * 100)}%` }}
            />
          </div>
          <p className="mt-1.5 text-neutral-400 text-xs tabular-nums">
            {Math.round(vlmProgress.fraction * 100)}%
            {vlmProgress.totalBytes > 0 &&
              ` ・ ${Math.round(vlmProgress.loadedBytes / 1048576)} / ${Math.round(vlmProgress.totalBytes / 1048576)} MB`}
          </p>
          <p className="text-neutral-500 text-[11px] mt-0.5">{T("vlmFirstRunNote")}</p>
        </div>
      )}

      {/* System status badge — hidden during result screen to avoid overlap,
          and hidden under the bin-map strip (bottom-left collision) unless
          there's a thermal warning worth surfacing. */}
      {(continuousMode ? (!showBinMap || thermalWarning) : uiScreen !== "result") && (
        <SystemStatusBadge thermalWarning={thermalWarning} />
      )}
    </div>
  );
}
