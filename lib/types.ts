export type KioskState = "idle" | "detecting" | "result" | "error";

// ── Local camera pipeline states ──
export type PipelineState =
  | "idle"
  | "classifying"
  | "result"
  | "cooldown";

// ── Per-blob quality metrics (multi-item detection) ──
export interface BlobInfo {
  /** Normalized center-x, center-y, width, height within the ROI (0–1). */
  bboxNorm: [cx: number, cy: number, w: number, h: number];
  /** Number of foreground pixels in this blob. */
  pixelCount: number;
  /** Blob pixel count as a fraction of ROI_PIXEL_COUNT. */
  ratio: number;
  /** Laplacian variance over blob pixels — real objects have texture/edges; shadows are smooth. */
  sharpness: number;
  /** Mean |roiGray[i] - bg[i]| over blob pixels — real objects differ strongly from background. */
  contrastScore: number;
  /** Fraction of blob pixels in skin-tone HSV range. High (>0.6) suggests hand/arm. */
  skinRatio: number;
  /** Mean HSV saturation of blob pixels. Informational for material analysis. */
  saturation: number;
}

// ── Frame analysis (client-side CV output) ──
export interface FrameAnalysis {
  /** Noise-suppressed foreground ratio within the central ROI only (erosion-filtered). */
  roiForegroundRatio: number;
  /**
   * Largest single connected component in the eroded ROI foreground mask,
   * as a fraction of ROI_PIXEL_COUNT. Used to require a coherent blob rather
   * than scattered noise that happens to exceed the ratio threshold.
   */
  roiLargestBlobRatio: number;
  /**
   * Diagonal span of the largest connected blob as a fraction of the
   * ROI's own diagonal length. A round object (bottle cap) has a ratio
   * close to its blob area. A thin elongated object (pen, straw, chopstick)
   * has a ratio much larger than its blob area, enabling detection even
   * when the blob area is below ROI_BLOB_THRESHOLD.
   *
   * Range: 0.0 (no blob) → 1.0+ (blob spans the full ROI diagonal).
   * Typical values:
   *   nothing present  → 0.00 – 0.10
   *   pen / straw      → 0.35 – 0.70
   *   bottle / cup     → 0.20 – 0.50
   */
  roiLargestBlobDiagonalRatio: number;
  sharpnessScore: number;
  /** Top-N foreground blobs with per-blob quality metrics (max 4, sorted by size desc). */
  blobs: BlobInfo[];
  /** False during the startup convergence window — detection is blocked until the background model has settled. */
  isSettled: boolean;
  timestamp: number;
}

// ── Image quality band ──
export type ImageQuality = "good" | "fair" | "poor";

// ── Client-side CV metadata sent with classify request ──
export interface ClassifyMeta {
  sharpnessScore: number;
  imageQuality: ImageQuality;
}

// ── YOLO detection log (for fine-tuning dataset) ──
export interface YoloDetectionLog {
  classId: number;
  className: string;
  confidence: number;
  /** Bounding box in model-space pixels [x1, y1, width, height] (640×640). */
  bbox: [number, number, number, number];
  /** Normalized YOLO format [x_center, y_center, width, height] (0-1). */
  bboxNorm: [number, number, number, number];
}

// ── Pilot log entry (server-side) ──
export interface PilotLogEntry {
  timestamp: string;
  modelUsed: "t2" | "T1";
  escalated: boolean;
  itemName: string;
  wasteStream: string;
  confidence: number;
  requiresVerification: boolean;
  latencyMs: number;
  imageUrl?: string;   // Vercel Blob URL of the captured frame
  blobUploadFailed?: boolean;
  /**
   * True when face detection blocked the upload (privacy gate fired).
   * Distinct from `blobUploadFailed` so ops can tell "upload intentionally
   * skipped" from "upload attempted and failed".
   */
  faceBlocked?: boolean;
  requestId?: string;
  meta?: ClassifyMeta;
  /** YOLO detections for this frame (if YOLO ran). Used for fine-tuning dataset export. */
  yoloDetections?: YoloDetectionLog[];
  /**
   * Which square the stored image (and thus `yoloDetections[].bboxNorm`) is in:
   *   "center_square" — gated mode: center short-side crop of the video
   *   "letterbox"     — continuous mode: full frame letterboxed into a square,
   *                     matching the YOLO fullFrame model input
   * Absent on entries written before this field existed. For those, gated
   * entries are center_square; continuous-mode entries logged before the
   * letterbox capture fix have bboxNorm values that do NOT align with the
   * stored image — treat them as unusable for bbox-on-image work.
   */
  captureSpace?: "center_square" | "letterbox";
  /** Whether an override was applied to change the model's original prediction. */
  overrideApplied?: boolean;
  /** RGB material analysis results (when YOLO ran). */
  rgbAnalysis?: {
    dominantHue: number;
    saturation: number;
    isMetallic: boolean;
    bboxAspectRatio: number;
    refinedFrom?: string;
    refinedTo?: string;
    textureSurface?: string;
  };
  /** Intermediate classification results from Tier 1 (YOLO).
   *  Present when final classification came from Tier 2 (API). */
  tierResults?: {
    tier1?: { itemName: string; confidence: number; x?: number }[];
  };
  /** All classified items in this frame (multi-item detection). */
  allItems?: { itemName: string; wasteStream: string; confidence: number; modelUsed?: string }[];
  /** Number of qualified blobs detected by frame-analyzer CV. */
  blobCount?: number;
  /** Number of YOLO waste-class detections (after filtering non-waste). */
  yoloDetectionCount?: number;
  /**
   * OpenAI token usage for this classification (GPT path only — `modelUsed === "t2"`).
   * Undefined for YOLO-only entries (`modelUsed === "T1"`) and for older entries
   * written before this field was introduced. The dashboard computes GPT cost
   * from `tokenUsage` when present, and falls back to a constant per-call
   * estimate when absent.
   */
  tokenUsage?: { promptTokens: number; completionTokens: number };
  /**
   * Shadow prediction from a local/candidate VLM run on the SAME frame, for
   * cloud-vs-local comparison during a pilot. Populated only when a local VLM
   * endpoint is configured (`LOCAL_VLM_ENDPOINT`); absent otherwise, so it has
   * zero effect on normal operation.
   */
  localModel?: LocalModelPrediction;
}

/** A local/candidate VLM's shadow prediction for one frame (cloud-vs-local comparison). */
export interface LocalModelPrediction {
  /** Model identifier (from `LOCAL_VLM_MODEL`). */
  model: string;
  /** Stream the local VLM chose; empty string when the shadow call failed. */
  wasteStream: string;
  confidence?: number;
  latencyMs: number;
  /** Whether the local stream matched the cloud model's stream. */
  agreesWithCloud: boolean;
  /** Set when the shadow call failed (then wasteStream is "" and agreesWithCloud false). */
  error?: string;
}

/**
 * Known waste streams. Site configs may define additional streams (e.g. "ewaste"),
 * so this is a branded union that allows arbitrary strings at runtime while
 * keeping autocomplete for known values.
 *
 * Why `(string & {})`: Site-specific streams like "ewaste" must be representable
 * without modifying this core type. The branded union preserves IDE autocomplete
 * for known values while remaining open. All runtime stream IDs coming from
 * model output or config are validated against the site's stream list in
 * `buildClassificationResult`, so unknown typos are caught there — not by the
 * type system alone.
 */
export type WasteStream =
  | "recycling"
  | "compost"
  | "landfill"
  | "special"
  | "needs_review"
  | (string & {});

export interface ClassificationRequest {
  image: string;
  siteId?: string;
}

export interface ComponentPart {
  partName: string;
  wasteStream: WasteStream;
  instruction: string;
  /** When true, this part may or may not be present — UI shows "if attached" framing. */
  optional?: boolean;
}

export interface CompoundConfig {
  /** Pattern matched against itemName (same word-boundary logic as overrides). */
  pattern: string;
  components: ComponentPart[];
}

export interface ClassificationResponse {
  itemName: string;
  wasteStream: WasteStream;
  confidence: number;
  reasoning: string;
  binColor: string;
  binLabel: string;
  specialInstructions?: string;
  preAction?: string;
  needsReview: boolean;
  isCompound: boolean;
  components?: ComponentPart[];
  modelUsed?: "t2" | "T1";
  imageUrl?: string;  // Vercel Blob URL of the captured frame
}

// ── Tracked result (spatial tracking in result state) ──

export interface TrackedResult extends ClassificationResponse {
  /** Tracking bbox in YOLO pixel space [x, y, w, h] (640×640). Updated each YOLO cycle. */
  _trackBbox: [number, number, number, number];
  /** Stable tracking ID (monotonically increasing per session). */
  _trackId: number;
  /** Whether this result's classification is locked (never reclassified). */
  _locked: boolean;
}

// ── YOLO edge inference types ──

export interface YoloDetection {
  classId: number;
  className: string;
  confidence: number;
  /** [x, y, width, height] in pixel coordinates of the input image. */
  bbox: [number, number, number, number];
}

export interface YoloClassRule {
  itemName: string;
  itemName_ja?: string;
  wasteStream: WasteStream;
  reasoning: string;
  reasoning_ja?: string;
  preAction?: string;
  preAction_ja?: string;
  /**
   * When true, this class requires material sub-classification
   * (e.g., "bottle" → PET / glass / aluminium). The pipeline routes
   * to Tier 2 (API) with a material-focused prompt.
   */
  needsSubclassification?: boolean;
}

export interface YoloRulesConfig {
  confidence_threshold: number;
  min_box_area: number;
  rules: Record<string, YoloClassRule>;
}

export interface SiteConfig {
  siteId: string;
  siteName: string;
  defaultLocale?: "en" | "ja";
  /**
   * Whether voice announcements play on the result screen.
   * Site-level setting — end-users cannot toggle this at runtime.
   * Default: false (silent kiosk, recommended for offices).
   */
  voiceEnabled?: boolean;
  streams: StreamDefinition[];
  overrides: ItemOverride[];
  defaultStream: WasteStream;
  /**
   * Maps the waste-stream ids used by the on-device YOLO rules
   * (public/models/yolo-rules.json: recyclable/burnable/plastic/special)
   * to this site's own stream ids. Without a mapping, YOLO results whose
   * stream doesn't exist in `streams` fall back to needs_review — which
   * silently disables the instant on-device path for sites that use
   * different stream naming (e.g. recycling/landfill).
   */
  yoloStreamMap?: Record<string, WasteStream>;
  staffHandlingItems?: string[];
  /**
   * Config-driven compound item rules. When an item matches a pattern here,
   * the system forces compound mode with these components — regardless of what
   * the AI or YOLO detected. Takes priority over AI-generated compound detection.
   */
  compounds?: CompoundConfig[];
  reviewThreshold?: number;
  /**
   * Whether to horizontally flip the camera feed.
   * Set to `true` for selfie / front-facing cameras (mirror effect).
   * Set to `false` (default) for fixed kiosk cameras facing outward,
   * so text on packages reads correctly.
   */
  mirrorCamera?: boolean;
  /** Sorting tips shown on the idle screen. Language should match defaultLocale. */
  tips?: { text: string }[];
  /**
   * Preferred item names the AI should use when naming detected items.
   * Improves override hit-rate by reducing non-deterministic naming.
   * If the item doesn't match any canonical name, the AI falls back to free-form.
   */
  canonicalNames?: string[];
  /**
   * Master sensitivity for the CV pipeline (0.0 = strict, 1.0 = sensitive).
   * All detection thresholds are derived from this value via `computeThresholds()`.
   * Default: 0.5.
   */
  sensitivity?: number;
  /**
   * Detection pipeline mode.
   *   "gated" (default) — legacy pipeline: background-subtraction CV gates
   *     decide when YOLO runs; full-screen idle → camera → result flow.
   *   "continuous" — YOLO runs always-on at a paced cadence; a temporal
   *     tracker (lib/detection-tracker.ts) smooths raw detections into
   *     stable results shown over a persistent live camera view.
   */
  detectionMode?: "gated" | "continuous";
  /**
   * Continuous mode only: draw live bounding boxes + labels over the camera
   * feed (demo/annotation view). No effect in gated mode.
   */
  showDetectionOverlay?: boolean;
  /**
   * Continuous mode only: persistent bin-map strip at the bottom edge —
   * the physical bin row (streams with `position`), with the target bin lit
   * and a flowing guide line from each detected item to its bin.
   */
  showBinMap?: boolean;
  /**
   * Continuous mode only: per-site overrides for the temporal tracker's
   * tuning knobs (lib/detection-tracker.ts DEFAULT_TRACKER_CONFIG). Omitted
   * fields keep their defaults. JSON-only tuning per the site-config
   * convention — e.g. a busy exhibition might lengthen coastMs or shorten
   * parkedAfterMs without a code change.
   */
  trackerTuning?: TrackerTuning;
}

/** Optional per-site tracker overrides — mirrors lib/detection-tracker.ts
 *  TrackerConfig (kept structurally assignable to Partial<TrackerConfig>;
 *  defined here separately so browser-safe type modules don't import the
 *  tracker implementation). */
export interface TrackerTuning {
  /** Minimum IoU to consider a detection the same object as a track. */
  minIoU?: number;
  /** Matched cycles within confirmWindow needed to confirm a track. */
  confirmHits?: number;
  confirmWindow?: number;
  /** Minimum wall-clock age (ms) before a track can confirm. */
  confirmMinAgeMs?: number;
  /** Consecutive misses that kill a tentative track. */
  tentativeMaxMisses?: number;
  /** How long a confirmed track survives mid-frame occlusion (ms). */
  coastMs?: number;
  /** Coast time when the track vanished at the frame edge (item left the scene). */
  edgeCoastMs?: number;
  /** Distance (model-space px) from a content bound that counts as "at the edge". */
  edgeMarginPx?: number;
  /** Consecutive foreign-class matches before a class swap. */
  classSwapCycles?: number;
  /** Minimum duration (ms) of a foreign-class streak before swapping. */
  classSwapMinMs?: number;
  /** Hard cap on simultaneously alive tracks. */
  maxTracks?: number;
  /** Stationary time before a confirmed track is suppressed as parked (ms). */
  parkedAfterMs?: number;
  /** Center movement (640-space px) that counts as "the object moved". */
  parkedMoveTolerance?: number;
  /** EMA alpha for confidence smoothing. */
  emaAlpha?: number;
  /** Blend factor for bbox smoothing. */
  bboxAlpha?: number;
}

/** Physical bin position relative to the kiosk monitor. */
export type BinPosition = "far-left" | "left" | "center" | "right" | "far-right";

export interface StreamDefinition {
  id: WasteStream;
  label: string;
  color: string;
  description: string;
  /** Physical bin position relative to the kiosk (omit for non-physical streams like needs_review). */
  position?: BinPosition;
}

export interface ItemOverride {
  pattern: string;
  /** Target stream. Omit (or set requiresStaff) to force needs_review. */
  stream?: WasteStream;
  note?: string;
  note_ja?: string;
  /** When true, forces needs_review regardless of stream. */
  requiresStaff?: boolean;
  /** Alternative stream to use when the condition is met (GPT tier only). */
  conditionalStream?: WasteStream;
  /** Condition that must be met for conditionalStream to apply (e.g. "clean", "dry", "empty"). */
  condition?: string;
}

// ── Tier 1 sub-classification context ──
/**
 * Returned by `resolveYoloDetection()` when a class has
 * `needsSubclassification: true` and confidence ≥ 0.80. The pipeline
 * routes to Tier 2 (API) with a material identification prompt.
 */
export interface Tier1SubclassContext {
  /** The class name (e.g., "bottle", "cup"). */
  className: string;
  /** Tier 1 detection confidence (≥ 0.80). */
  confidence: number;
  /** The detection's bounding box in model space [x, y, w, h]. */
  bbox: [number, number, number, number];
}

// ── Local model candidate (passed to GPT prompts as context) ──
export interface LocalModelCandidate {
  className: string;
  confidence: number;
}

// ── Texture analysis hint (LBP-based) ──
export interface TextureHint {
  uniformity: number;
  edgeDensity: number;
  suggestedSurface: "paper" | "plastic" | "metal" | "unknown";
}

// ── RGB material analysis hint ──
export interface MaterialHint {
  dominantHue: number;
  saturation: number;
  isMetallic: boolean;
  suggestedMaterial: string | null;
  bboxAspectRatio: number;
  texture?: TextureHint;
}

export type KioskAction =
  | { type: "START_DETECTING" }
  | { type: "CLASSIFICATION_RECEIVED"; payload: ClassificationResponse }
  | { type: "CLASSIFICATION_FAILED"; error: string }
  | { type: "RESET_TO_IDLE" };
