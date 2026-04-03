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
import { loadYoloRules, loadYoloWorldRules, resolveYoloDetection, resolveYoloWorldDetection } from "@/lib/yolo-rules";
// kioskAuthHeaders replaced by session token (server-generated, HMAC-signed)
import CameraFeed, { type CameraFeedHandle } from "./CameraFeed";
import IdleScreen from "./IdleScreen";
import CameraScreen from "./CameraScreen";
import ResultScreen from "./ResultScreen";

// ── Timing constants ──
const ANALYSIS_INTERVAL_MS = 100; // ~10 fps local CV
const COOLDOWN_MS = 1500; // pause before re-scanning (BG model recovery)
const OBJECT_GONE_FRAMES = 2;     // frames below ROI threshold before "gone" (~0.3s at 7fps)
const FG_PERSIST_FRAMES = 2;      // consecutive ROI-blob frames required to leave idle
/** Sharp frames (sharpnessScore > 150) in object_detected before triggering classification. */
const SHARP_FRAMES_REQUIRED = 2;
/**
 * Escape hatch: if the result state persists for this long with the object
 * still visible (e.g., a tissue leftover that never leaves), force a transition
 * to cooldown so the BG model gets a full-rate update window in idle.
 */
const RESULT_TIMEOUT_MS = 30_000;
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
// result: micro rate — slowly absorbs stuck items without corrupting live objects
const BG_RATE_RESULT = 0.001;
// object_detected / classifying: frozen — never absorb the held object
const BG_RATE_FROZEN = 0;

// ── Capture ROI (fraction of frame, applied to both image capture and scan frame UI) ──
const CAPTURE_ROI_MARGIN = 0.15; // 15% margin on each side → 70% of frame sent to model

// ── Entry coherence gate ──
const ROI_BLOB_THRESHOLD = 0.03;

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
  const [stableResult, setStableResult] =
    useState<ClassificationResponse | null>(null);
  const [resultRequestId, setResultRequestId] = useState<string | undefined>(undefined);
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

    /** Track whether continuous YOLO loop has been started. */
    let continuousStarted = false;

    const interval = setInterval(() => {
      const video = cameraRef.current?.getVideo();
      if (!video) return;

      // Start continuous YOLO loop once video and backend are both ready
      if (!continuousStarted && inferenceRef.current?.isReady()) {
        inferenceRef.current.startContinuous(video, CAPTURE_ROI_MARGIN);
        continuousStarted = true;
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
        if (roiHasFg) {
          fgPersistRef.current++;
          if (fgPersistRef.current >= FG_PERSIST_FRAMES) {
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

        if (imageQualityBand(analysis) !== "poor") {
          objectDetectedFrameRef.current++;
        }

        if (objectDetectedFrameRef.current >= SHARP_FRAMES_REQUIRED) {
          objectDetectedFrameRef.current = 0;
          triggerClassification(analysis);
        }
        return;
      }

      if (state === "classifying") {
        if (Date.now() - classifyStartRef.current >= CLASSIFYING_TIMEOUT_MS) {
          console.error("[classify] Timed out in classifying state — forcing recovery");
          inFlightRef.current = false;
          cooldownStartRef.current = Date.now();
          transition("cooldown");
        }
        return;
      }

      if (state === "result") {
        // Result stays on screen until item is removed — no minimum display time.
        if (!roiHasFg) {
          goneCountRef.current++;
          if (goneCountRef.current >= OBJECT_GONE_FRAMES) {
            cooldownStartRef.current = Date.now();
            transition("cooldown");
          }
        } else {
          goneCountRef.current = 0;

          // Persistent-leftover escape hatch
          if (Date.now() - resultEnterTimeRef.current >= RESULT_TIMEOUT_MS) {
            setStableResult(null); setResultRequestId(undefined);
            goneCountRef.current = 0;
            cooldownStartRef.current = Date.now();
            transition("cooldown");
            return;
          }
        }
        return;
      }

      if (state === "cooldown") {
        const cooldownElapsed = Date.now() - cooldownStartRef.current >= COOLDOWN_MS;
        const errorHeld = !errorRef.current || (Date.now() - errorSetAtRef.current >= ERROR_HOLD_MS);

        // If a new item is pending, skip cooldown wait (fast-path to next scan)
        if (pendingItemRef.current && errorHeld) {
          setStableResult(null); setResultRequestId(undefined);
          setError(null);
          pendingItemRef.current = false;
          fgPersistRef.current = 0;
          goneCountRef.current = 0;
          objectDetectedFrameRef.current = 0;
          transition("object_detected");
          return;
        }

        if (cooldownElapsed && errorHeld) {
          setStableResult(null); setResultRequestId(undefined);
          setError(null);
          setStatsVersion((v) => v + 1);
          transition("idle");
        }
        return;
      }
    }, ANALYSIS_INTERVAL_MS);

    return () => {
      clearInterval(interval);
      // Stop continuous YOLO loop on unmount
      inferenceRef.current?.stopContinuous();
    };

    /** Log a YOLO-only classification to the server (fire-and-forget).
     *  Needed because YOLO wins skip the /api/classify route entirely. */
    function logYoloOnlyResult(
      video: HTMLVideoElement,
      result: ClassificationResponse,
      detections: YoloDetection[],
      latencyMs: number,
    ) {
      // Capture and upload image for the log
      const vw = video.videoWidth;
      const vh = video.videoHeight;
      const roiX = Math.round(vw * CAPTURE_ROI_MARGIN);
      const roiY = Math.round(vh * CAPTURE_ROI_MARGIN);
      const roiW = Math.round(vw * (1 - CAPTURE_ROI_MARGIN * 2));
      const roiH = Math.round(vh * (1 - CAPTURE_ROI_MARGIN * 2));
      const scale = Math.min(1, 768 / Math.max(roiW, roiH));
      const outW = Math.round(roiW * scale);
      const outH = Math.round(roiH * scale);

      const canvas = new OffscreenCanvas(outW, outH);
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.drawImage(video, roiX, roiY, roiW, roiH, 0, 0, outW, outH);

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
              },
            }),
          }).catch(() => {}); // best-effort
        };
        reader.readAsDataURL(blob);
      }).catch(() => {});
    }

    // ── Trigger classification (Tiered Pipeline) ──
    //
    // Tier 1: YOLO26n (always-on buffer) → instant, handles COCO-80 items
    // Tier 2: YOLO World (on-demand)     → ~200-800ms, handles recycling-specific items
    // Tier 3: OpenAI API (last resort)   → ~1-3s, handles anything
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

      // ── Tier 1: Get buffered YOLO detections (instant — always-on loop) ──
      const bufferedDetections = backend.getLatestDetections();

      // Also run a fresh detection for accuracy (the buffer may be 100ms stale)
      const yoloStart = Date.now();
      backend.detect(video, CAPTURE_ROI_MARGIN)
        .then((freshDetections) => {
          // Prefer fresh, fall back to buffered
          const detections = freshDetections.length > 0 ? freshDetections : bufferedDetections;
          const yoloMs = Date.now() - yoloStart;

          if (detections.length > 0) {
            yoloDetectionLogs = toDetectionLogs(detections);
          }

          if (detections.length > 0) {
            const best = detections[0];

            // ── High confidence: YOLO wins ──
            if (best.confidence >= YOLO_FALLBACK_THRESHOLD) {
              const result = resolveYoloDetection(best, siteConfigRef.current!);
              if (result) {
                console.log(`[tier1] YOLO HIT: ${best.className} (${(best.confidence * 100).toFixed(1)}%) → ${result.wasteStream} in ${yoloMs}ms`);
                logYoloOnlyResult(video, result, detections, yoloMs);
                handleClassificationResult(result, undefined);
                return;
              }
            }

            // ── Low-to-mid confidence or no rule: try YOLO World (Tier 2) ──
            // Show optimistic UI immediately
            console.log(`[tier1] YOLO conf=${(best.confidence * 100).toFixed(1)}% — escalating to YOLO World`);
            const optimisticResult = buildOptimisticResult(best.className, best.confidence);
            setStableResult(optimisticResult);
            resultEnterTimeRef.current = Date.now();

            // If very low confidence, fire API in parallel with YOLO World
            const fireApiInParallel = best.confidence < YOLO_API_PARALLEL_THRESHOLD;

            escalateToYoloWorld(
              video, backend, best, apiPromise, apiController, fireApiInParallel, detections, yoloMs,
            );
          } else {
            // ── No YOLO detections at all: try YOLO World, then API ──
            console.log(`[tier1] No YOLO detections (${yoloMs}ms) — escalating to YOLO World`);
            escalateToYoloWorld(
              video, backend, null, apiPromise, apiController, true, [], yoloMs,
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
     * Tier 2: YOLO World fallback.
     * Pauses the continuous YOLO loop to free CPU, runs YOLO World inference,
     * and resumes YOLO afterwards.
     */
    function escalateToYoloWorld(
      video: HTMLVideoElement,
      backend: InferenceBackend,
      yoloBest: { className: string; confidence: number } | null,
      apiPromise: () => Promise<{ result: (ClassificationResponse & { requestId?: string }) | null; requestId?: string }>,
      apiController: AbortController,
      fireApiInParallel: boolean,
      yoloDetections: YoloDetection[],
      yoloMs: number,
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

      // Pause continuous YOLO to free CPU for YOLO World
      backend.pauseContinuous();
      const worldStart = Date.now();

      backend.detectWorld(video, CAPTURE_ROI_MARGIN)
        .then((worldDetections) => {
          const worldMs = Date.now() - worldStart;

          if (worldDetections.length > 0) {
            const worldBest = worldDetections[0];

            if (worldBest.confidence >= YOLO_WORLD_ACCEPT_THRESHOLD) {
              const result = resolveYoloWorldDetection(worldBest, siteConfigRef.current!);
              if (result) {
                console.log(`[tier2] YOLO World HIT: ${worldBest.className} (${(worldBest.confidence * 100).toFixed(1)}%) → ${result.wasteStream} in ${worldMs}ms`);
                apiController.abort();
                logYoloOnlyResult(video, result, yoloDetections, yoloMs + worldMs);
                backend.resumeContinuous();
                handleClassificationResult(result, undefined);
                return;
              }
            }

            console.log(`[tier2] YOLO World conf=${(worldBest.confidence * 100).toFixed(1)}% — falling through to API (${worldMs}ms)`);
          } else {
            console.log(`[tier2] YOLO World no detections (${worldMs}ms) — falling through to API`);
          }

          // Resume YOLO before API call (API doesn't need CPU)
          backend.resumeContinuous();

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
          // YOLO World failed — resume YOLO and fall through to API
          backend.resumeContinuous();
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

      backend.detect(video, CAPTURE_ROI_MARGIN)
        .then((detections) => {
          if (detections.length > 0) {
            const best = detections[0];
            const result = resolveYoloDetection(best, siteConfigRef.current!);
            if (result) {
              console.log(`[offline] YOLO HIT: ${best.className} → ${result.wasteStream}`);
              handleClassificationResult(result, undefined);
              return;
            }

            // Try YOLO World offline
            if (backend.isYoloWorldReady()) {
              backend.pauseContinuous();
              backend.detectWorld(video, CAPTURE_ROI_MARGIN)
                .then((worldDets) => {
                  backend.resumeContinuous();
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
                  backend.resumeContinuous();
                  handleClassificationResult(buildOfflineFallback(best.className, best.confidence), undefined);
                });
              return;
            }

            handleClassificationResult(buildOfflineFallback(best.className, best.confidence), undefined);
          } else {
            handleClassificationResult(buildOfflineFallback("unknown item", 0.1), undefined);
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
        cacheResult(result, localeRef.current);
        lastCachedRef.current = cacheKey;
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
      const procStart = Date.now();
      const vw = video.videoWidth;
      const vh = video.videoHeight;
      const roiX = Math.round(vw * CAPTURE_ROI_MARGIN);
      const roiY = Math.round(vh * CAPTURE_ROI_MARGIN);
      const roiW = Math.round(vw * (1 - CAPTURE_ROI_MARGIN * 2));
      const roiH = Math.round(vh * (1 - CAPTURE_ROI_MARGIN * 2));

      const scale = Math.min(1, 768 / Math.max(roiW, roiH));
      const outW = Math.round(roiW * scale);
      const outH = Math.round(roiH * scale);

      const cropCanvas = new OffscreenCanvas(outW, outH);
      const cropCtx = cropCanvas.getContext("2d");
      if (!cropCtx) return { result: null };

      cropCtx.drawImage(video, roiX, roiY, roiW, roiH, 0, 0, outW, outH);
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
    setStableResult(null); setResultRequestId(undefined);
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

  const tips = siteConfigRef.current?.tips ?? [];

  return (
    <div className="h-screen w-screen bg-neutral-950 relative overflow-hidden select-none">
      {/* Camera feed — always mounted, hidden during idle for CV to keep running */}
      <div
        className={`absolute inset-0 transition-opacity duration-300 ${
          uiScreen === "idle" ? "opacity-0" : "opacity-100"
        }`}
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
          tips={tips}
          onToggleLocale={toggleLocale}
          statsVersion={statsVersion}
          voiceEnabled={voiceEnabled}
          onToggleVoice={toggleVoice}
        />
      )}

      {uiScreen === "camera" && (
        <CameraScreen
          pipelineState={pipelineState}
          locale={locale}
          captureRoiMargin={CAPTURE_ROI_MARGIN}
        />
      )}

      {uiScreen === "result" && stableResult && (
        <ResultScreen
          result={stableResult}
          requestId={resultRequestId}
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
