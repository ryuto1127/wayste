export type KioskState = "idle" | "detecting" | "result" | "error";

// ── Local camera pipeline states ──
export type PipelineState =
  | "idle"
  | "object_detected"
  | "classifying"
  | "result"
  | "cooldown";

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
  skinRatio: number;
  sharpnessScore: number;
  /** False during the startup convergence window — detection is blocked until the background model has settled. */
  isSettled: boolean;
  timestamp: number;
}

// ── Image quality band ──
export type ImageQuality = "good" | "fair" | "poor";

// ── Client-side CV metadata sent with classify request ──
export interface ClassifyMeta {
  skinRatio: number;
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
  modelUsed: "nano" | "mini" | "yolo-local" | "yolo-world";
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
  siteNote?: string;
  modelUsed?: "nano" | "mini" | "yolo-local" | "yolo-world";
  imageUrl?: string;  // Vercel Blob URL of the captured frame
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
  wasteStream: WasteStream;
  reasoning: string;
  preAction?: string;
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
  siteRules?: SiteRule[];
  staffHandlingItems?: string[];
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
  stream: WasteStream;
  note?: string;
}

export interface SiteRule {
  pattern: string;
  instruction: string;
  stream?: WasteStream;
  requiresStaff?: boolean;
}

export type KioskAction =
  | { type: "START_DETECTING" }
  | { type: "CLASSIFICATION_RECEIVED"; payload: ClassificationResponse }
  | { type: "CLASSIFICATION_FAILED"; error: string }
  | { type: "RESET_TO_IDLE" };
