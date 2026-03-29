export type KioskState = "idle" | "detecting" | "result" | "error";

// ── Local camera pipeline states ──
export type PipelineState =
  | "idle"
  | "object_detected"
  | "stabilizing"
  | "classifying"
  | "result"
  | "cooldown";

// ── Frame analysis (client-side CV output) ──
export interface FrameAnalysis {
  foregroundRatio: number;
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
  motionScore: number;
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

// ── Pilot log entry (server-side) ──
export interface PilotLogEntry {
  timestamp: string;
  modelUsed: "nano" | "mini";
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
  needsReview: boolean;
  isCompound: boolean;
  components?: ComponentPart[];
  siteNote?: string;
  modelUsed?: "nano" | "mini";
  imageUrl?: string;  // Vercel Blob URL of the captured frame
}

export interface SiteConfig {
  siteId: string;
  siteName: string;
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
}

export interface StreamDefinition {
  id: WasteStream;
  label: string;
  color: string;
  description: string;
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

export interface FeedbackEntry {
  id: string;
  timestamp: string;
  itemName: string;
  predictedStream: WasteStream;
  confidence: number;
  feedback: "correct" | "wrong";
  actualStream?: WasteStream;
  actualItemName?: string;
  siteId: string;
  imageUrl?: string;  // Vercel Blob URL of the captured frame
  requestId?: string;
}

export type KioskAction =
  | { type: "START_DETECTING" }
  | { type: "CLASSIFICATION_RECEIVED"; payload: ClassificationResponse }
  | { type: "CLASSIFICATION_FAILED"; error: string }
  | { type: "RESET_TO_IDLE" };
