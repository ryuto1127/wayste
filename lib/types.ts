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
  requestId?: string;
  meta?: ClassifyMeta;
  /** YOLO detections for this frame (if YOLO ran). Used for fine-tuning dataset export. */
  yoloDetections?: YoloDetectionLog[];
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
  streams: StreamDefinition[];
  overrides: ItemOverride[];
  defaultStream: WasteStream;
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
