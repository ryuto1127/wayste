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
  ROI_FG_THRESHOLD,
} from "@/lib/frame-analyzer";
import {
  getInferenceBackend,
  type InferenceBackend,
  YOLO_FALLBACK_THRESHOLD,
  YOLO_API_PARALLEL_THRESHOLD,
  YOLO_WORLD_ACCEPT_THRESHOLD,
} from "@/lib/inference-backend";
import { loadYoloRules, loadYoloWorldRules, resolveYoloDetection, resolveYoloWorldDetection, isYoloClassNotWaste } from "@/lib/yolo-rules";
// kioskAuthHeaders replaced by session token (server-generated, HMAC-signed)
import CameraFeed, { type CameraFeedHandle } from "./CameraFeed";
import IdleScreen from "./IdleScreen";
import CameraScreen from "./CameraScreen";
import ResultScreen from "./ResultScreen";

// ── Timing constants ──
const ANALYSIS_INTERVAL_MS = 30;  // ~33 fps local CV
const COOLDOWN_MS = 1500; // pause before re-scanning (BG model recovery)
const OBJECT_GONE_FRAMES = 3;     // frames below ROI threshold before "gone" (~90ms at 33fps)
const RESULT_GONE_FRAMES = 8;     // result state uses a longer window to resist camera flicker (~240ms at 33fps)
const FG_PERSIST_FRAMES = 3;      // consecutive ROI-blob frames required to leave idle (~90ms at 33fps)
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

// ── Entry coherence gate ──
const ROI_BLOB_THRESHOLD = 0.01;

// ── Result-state exit gate (more lenient — keeps result visible for distant/small items) ──
// Lower than entry gate: item shrunken from distance should not dismiss the result.
const RESULT_FG_THRESHOLD = 0.015;
const RESULT_BLOB_THRESHOLD = 0.005;

// ── Elongated-object gate ──
const ROI_BLOB_DIAGONAL_THRESHOLD = 0.35;
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
  /** Server-generated session token for API authentication. */
  sessionToken?: string;
}

/** How often to refresh the session token (3 hours — token TTL is 4 hours). */
const TOKEN_REFRESH_MS = 3 * 60 * 60 * 1000;

export default function KioskDisplay({ defaultLocale, sessionToken: initialToken }: KioskDisplayProps) {
  const cameraRef = useRef<CameraFeedHandle>(null);
  const analyzerRef = useRef<FrameAnalyzer | null>(null);
  /** Current session token — refreshed periodically. */
  const sessionTokenRef = useRef<string>(initialToken ?? "");

  // ── Pipeline state ──
  const stateRef = useRef<PipelineState>("idle");
  const [mounted, setMounted] = useState(false);
  const [pipelineState, setPipelineState] = useState<PipelineState>("idle");
  const [stableResults, setStableResults] =
    useState<ClassificationResponse[]>([]);
  const [resultRequestIds, setResultRequestIds] = useState<(string | undefined)[]>([]);
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

  // ── Session token refresh (runs every 3 hours) ──
  useEffect(() => {
    if (!initialToken) return; // dev mode — no token
    const id = setInterval(() => {
      fetch("/api/session")
        .then((r) => r.json())
        .then((data: { token?: string }) => {
          if (data.token) sessionTokenRef.current = data.token;
        })
        .catch(() => {});
    }, TOKEN_REFRESH_MS);
    return () => clearInterval(id);
  }, [initialToken]);

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
  const errorRef = useRef<string | null>(null);
  /** Mirror of `locale` state as a ref for stale-closure-safe reads inside the CV interval. */
  const localeRef = useRef<Locale>(defaultLocale ?? "en");

  /** Site config fetched from the API. */
  const siteConfigRef = useRef<SiteConfig | null>(null);
  /** Inference backend (ONNX or HTTP — resolved at init). */
  const inferenceRef = useRef<InferenceBackend | null>(null);

  // Prevent SSR — this component requires browser APIs (camera, OffscreenCanvas)
  useEffect(() => setMounted(true), []);

  // ── Initialize inference backend + rules + site config (client-side) ──
  useEffect(() => {
    Promise.all([
      getInferenceBackend().then((backend) => {
        inferenceRef.current = backend;
        // Eagerly start loading YOLO World in the background (lazy init)
        backend.initYoloWorld().then((ok) => {
          if (ok) console.log("[init] YOLO World ready for fallback");
          else console.log("[init] YOLO World not available — will skip tier 2");
        });
      }),
      loadYoloRules(),
      loadYoloWorldRules(),
      fetch("/api/site-config")
        .then((r) => r.json())
        .then((data: SiteConfig) => {
          siteConfigRef.current = data;
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
    async (frame: string, meta: ClassifyMeta, yoloDetections?: YoloDetectionLog[]): Promise<ClassificationResponse & { requestId?: string }> => {
      const doFetch = async (): Promise<ClassificationResponse & { requestId?: string }> => {
        const fetchStartMs = Date.now();
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), API_TIMEOUT_MS);

        try {
          const reqBody = { image: frame, meta, locale, yoloDetections };
          const res = await fetch("/api/classify", {
            method: "POST",
            headers: { "Content-Type": "application/json", ...(sessionTokenRef.current ? { "x-session-token": sessionTokenRef.current } : {}) },
            body: JSON.stringify(reqBody),
            signal: controller.signal,
          });
          const fetchDoneMs = Date.now() - fetchStartMs;

          if (res.status === 429) {
            console.warn(`[classify] Got 429, retrying after ${RATE_LIMIT_RETRY_MS}ms`);
            await new Promise((r) => setTimeout(r, RATE_LIMIT_RETRY_MS));
            const retryStart = Date.now();
            const retryController = new AbortController();
            const retryTimeout = setTimeout(() => retryController.abort(), API_TIMEOUT_MS);
            const retryRes = await fetch("/api/classify", {
              method: "POST",
              headers: { "Content-Type": "application/json", ...(sessionTokenRef.current ? { "x-session-token": sessionTokenRef.current } : {}) },
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

      // Set BG adaptation rate based on pipeline state
      const currentState = stateRef.current;
      const bgRate =
        currentState === "idle" || currentState === "cooldown"
          ? BG_RATE_IDLE
          : currentState === "result"
            ? BG_RATE_RESULT
            : BG_RATE_FROZEN;
      analyzer.setBgRate(bgRate);

      const analysis = analyzer.analyze(video);
      if (!analysis) return;
      lastAnalysisRef.current = analysis;

      const state = stateRef.current;

      if (!analysis.isSettled) return;

      const elongated =
        analysis.roiLargestBlobDiagonalRatio > ROI_BLOB_DIAGONAL_THRESHOLD &&
        analysis.roiLargestBlobRatio > ROI_BLOB_DIAGONAL_MIN_AREA;
      const roiHasFg =
        (analysis.roiForegroundRatio >= ROI_FG_THRESHOLD &&
         analysis.roiLargestBlobRatio >= ROI_BLOB_THRESHOLD) ||
        elongated;
      // Result-state exit uses lower thresholds: a small/distant item still
      // registers as "present" so the result stays on screen.
      const resultHasFg =
        (analysis.roiForegroundRatio >= RESULT_FG_THRESHOLD &&
         analysis.roiLargestBlobRatio >= RESULT_BLOB_THRESHOLD) ||
        elongated;

      // ── Pending-item queue ──
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
          if (goneCountRef.current >= OBJECT_GONE_FRAMES) {
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
          ? Math.min(COOLDOWN_MS * nothingDetectedCountRef.current, 4_000)
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
            headers: { "Content-Type": "application/json", ...(sessionTokenRef.current ? { "x-session-token": sessionTokenRef.current } : {}) },
            body: JSON.stringify({
              image: frame,
              entry: {
                modelUsed: "yolo-local",
                escalated: false,
                itemName: result.itemName,
                wasteStream: result.wasteStream,
                confidence: result.confidence,
                requiresVerification: result.needsReview ?? false,
                latencyMs,
                yoloDetections: toDetectionLogs(detections),
                meta: {
                  skinRatio: analysis.skinRatio,
                  sharpnessScore: analysis.sharpnessScore,
                  imageQuality: imageQualityBand(analysis),
                },
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
      const apiPromise = () => classifyViaApiAsync(video, analysis, apiController.signal, yoloDetectionLogs);

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
      backend.detect(video)
        .then((detections) => {
          const yoloMs = Date.now() - yoloStart;

          if (detections.length > 0) {
            yoloDetectionLogs = toDetectionLogs(detections);
          }

          // Filter out not_waste classes (person, furniture, vehicles, etc.)
          // Hands holding items are expected in a kiosk — they must not block waste detection.
          const wasteDetections = detections.filter(d => !isYoloClassNotWaste(d.className));

          if (wasteDetections.length > 0) {
            const best = wasteDetections[0];

            // ── Multi-item: resolve up to 2 distinct high-confidence detections ──
            if (best.confidence >= YOLO_FALLBACK_THRESHOLD) {
              // Collect distinct class results (max 2)
              const seen = new Set<string>();
              const resolvedResults: ClassificationResponse[] = [];
              for (const det of wasteDetections) {
                if (det.confidence < YOLO_FALLBACK_THRESHOLD) break;
                if (seen.has(det.className)) continue;
                seen.add(det.className);
                const r = resolveYoloDetection(det, siteConfigRef.current!);
                if (r) resolvedResults.push(r);
                if (resolvedResults.length >= 2) break;
              }

              if (resolvedResults.length > 0) {
                console.log(`[tier1] YOLO HIT: ${resolvedResults.map((r) => r.itemName).join(" + ")} in ${yoloMs}ms`);
                logYoloOnlyResult(video, resolvedResults[0], detections, yoloMs, analysis);
                handleMultiClassificationResults(resolvedResults, resolvedResults.map(() => undefined));
                return;
              }
            }

            // ── Low-to-mid confidence or no rule: try YOLO World (Tier 2) ──
            // Show optimistic UI immediately
            console.log(`[tier1] YOLO conf=${(best.confidence * 100).toFixed(1)}% — escalating to YOLO World`);
            const optimisticResult = buildOptimisticResult(best.className, best.confidence);
            setStableResults([optimisticResult]);
            resultEnterTimeRef.current = Date.now();

            // If very low confidence, fire API in parallel with YOLO World
            const fireApiInParallel = best.confidence < YOLO_API_PARALLEL_THRESHOLD;

            escalateToYoloWorld(
              video, backend, best, apiPromise, apiController, fireApiInParallel, detections, yoloMs, analysis,
            );
          } else {
            // ── Only non-waste (person, etc.) or no detections — escalate to YOLO World ──
            if (detections.length > 0) {
              console.log(`[tier1] Only non-waste detections (${detections.map(d => d.className).join(", ")}) in ${yoloMs}ms — escalating to YOLO World`);
            } else {
              console.log(`[tier1] No YOLO detections (${yoloMs}ms) — escalating to YOLO World`);
            }
            escalateToYoloWorld(
              video, backend, null, apiPromise, apiController, true, detections, yoloMs, analysis,
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

    /** Tier 2: YOLO World fallback (on-demand). */
    function escalateToYoloWorld(
      video: HTMLVideoElement,
      backend: InferenceBackend,
      yoloBest: { className: string; confidence: number } | null,
      apiPromise: () => Promise<{ result: (ClassificationResponse & { requestId?: string }) | null; requestId?: string }>,
      apiController: AbortController,
      fireApiInParallel: boolean,
      yoloDetections: YoloDetection[],
      yoloMs: number,
      analysis: FrameAnalysis,
    ) {
      // Start API call in parallel if confidence is very low
      let apiInflight: ReturnType<typeof apiPromise> | null = null;
      if (fireApiInParallel) {
        apiInflight = apiPromise();
      }

      if (!backend.isYoloWorldReady()) {
        // YOLO World not available — fall through to API
        console.log("[tier2] YOLO World not ready — falling through to API");
        const promise = apiInflight ?? apiPromise();
        promise
          .then(({ result: r, requestId }) => {
            if (r) handleClassificationResult(r, requestId);
            else handleClassificationError(new Error("API returned no result"));
          })
          .catch((err) => {
            if (yoloBest) {
              handleClassificationResult(buildOfflineFallback(yoloBest.className, yoloBest.confidence), undefined);
            } else {
              handleClassificationError(err);
            }
          });
        return;
      }

      const worldStart = Date.now();

      backend.detectWorld(video)
        .then((worldDetections) => {
          const worldMs = Date.now() - worldStart;

          if (worldDetections.length > 0) {
            const worldBest = worldDetections[0];

            if (worldBest.confidence >= YOLO_WORLD_ACCEPT_THRESHOLD) {
              const result = resolveYoloWorldDetection(worldBest, siteConfigRef.current!);
              if (result) {
                console.log(`[tier2] YOLO World HIT: ${worldBest.className} (${(worldBest.confidence * 100).toFixed(1)}%) → ${result.wasteStream} in ${worldMs}ms`);
                apiController.abort();
                logYoloOnlyResult(video, result, yoloDetections, yoloMs + worldMs, analysis);
                handleClassificationResult(result, undefined);
                return;
              }
            }

            console.log(`[tier2] YOLO World conf=${(worldBest.confidence * 100).toFixed(1)}% — falling through to API (${worldMs}ms)`);
          } else {
            console.log(`[tier2] YOLO World no detections (${worldMs}ms) — falling through to API`);
          }

          // Tier 3: API
          const promise = apiInflight ?? apiPromise();
          promise
            .then(({ result: r, requestId }) => {
              if (r) handleClassificationResult(r, requestId);
              else handleClassificationError(new Error("API returned no result"));
            })
            .catch((err) => {
              // Fallback: use whatever local detection we had
              const fallbackName = yoloBest?.className ?? (worldDetections[0]?.className);
              const fallbackConf = yoloBest?.confidence ?? (worldDetections[0]?.confidence ?? 0.1);
              if (fallbackName) {
                handleClassificationResult(buildOfflineFallback(fallbackName, fallbackConf), undefined);
              } else {
                handleClassificationError(err);
              }
            });
        })
        .catch(() => {
          // YOLO World failed — fall through to API
          const promise = apiInflight ?? apiPromise();
          promise
            .then(({ result: r, requestId }) => {
              if (r) handleClassificationResult(r, requestId);
              else handleClassificationError(new Error("API returned no result"));
            })
            .catch(handleClassificationError);
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
              const r = resolveYoloDetection(det, siteConfigRef.current!);
              if (r) resolvedResults.push(r);
              if (resolvedResults.length >= 2) break;
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
                    const worldResult = resolveYoloWorldDetection(worldDets[0], siteConfigRef.current!);
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
                    const worldResult = resolveYoloWorldDetection(worldDets[0], siteConfigRef.current!);
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

    /** Build a provisional result shown instantly while the API processes. */
    function buildOptimisticResult(
      className: string,
      confidence: number,
    ): ClassificationResponse {
      const streams = siteConfigRef.current?.streams ?? [];
      const defaultStream = siteConfigRef.current?.defaultStream ?? "landfill";
      const sd = streams.find((s) => s.id === defaultStream);
      return {
        itemName: className,
        wasteStream: defaultStream,
        confidence: Math.min(confidence, 0.4),
        reasoning: localeRef.current === "ja"
          ? "AI が詳細を分析中です..."
          : "AI is refining the classification...",
        binColor: sd?.color ?? "#525252",
        binLabel: sd?.label ?? defaultStream,
        needsReview: false,
        isCompound: false,
        modelUsed: "yolo-local",
      };
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
        (r) => r.itemName.toLowerCase() !== "nothing detected" && r.confidence !== 0
      );

      if (valid.length === 0) {
        nothingDetectedCountRef.current++;
        pendingItemRef.current = false;
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
        valid.map((r, i) => requestIds[results.indexOf(r)] ?? r.requestId)
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

      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

      const result = await classify(frame, meta, yoloDetections);
      return { result, requestId: result.requestId };
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [classify, transition, T]);

  const handleFeedbackGiven = useCallback(() => {
    setStableResults([]); setResultRequestIds([]);
    cooldownStartRef.current = Date.now();
    transition("cooldown");
  }, [transition]);

  // ── Derive which full-screen UI to show ──
  if (!mounted) return null;

  const uiScreen: "idle" | "camera" | "result" =
    pipelineState === "result"
      ? "result"
      : pipelineState === "object_detected" || pipelineState === "classifying"
        ? "camera"
        : "idle"; // idle + cooldown both show idle screen


  return (
    <div className="h-screen w-screen bg-neutral-950 relative overflow-hidden select-none">
      {/* Camera feed — always mounted, hidden during idle for CV to keep running */}
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
          requestIds={resultRequestIds}
          locale={locale}
          onFeedbackGiven={handleFeedbackGiven}
          onToggleLocale={toggleLocale}
          voiceEnabled={voiceEnabled}
          sessionToken={sessionTokenRef.current || undefined}
        />
      )}
    </div>
  );
}
