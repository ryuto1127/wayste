/**
 * Zod schema for `PilotLogEntry` reads from Redis.
 *
 * Why server-side validation on read:
 *   - The pilot-log Redis list now requires kiosk auth on writes (see fc6eb16),
 *     but historic entries — written before that fix — may contain attacker-
 *     planted fields. We must not trust them blindly when rendering on /review
 *     or when forwarding `imageUrl` to fetch().
 *   - Even with kiosk auth, a future bug in the writer could land malformed
 *     data; failing parse → drop entry is safer than handing untyped data
 *     deeper into the codebase.
 *
 * Strategy: tolerant parse — unknown fields are stripped (`.strip()` is the
 * Zod default) but required fields with bad types fail. Callers should drop
 * entries that fail to parse rather than forcing them through.
 */
import { z } from "zod/v4";

const YoloDetectionSchema = z.object({
  classId: z.number(),
  className: z.string().max(128),
  confidence: z.number(),
  bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]),
  bboxNorm: z.tuple([z.number(), z.number(), z.number(), z.number()]),
});

const RgbAnalysisSchema = z.object({
  dominantHue: z.number(),
  saturation: z.number(),
  isMetallic: z.boolean(),
  bboxAspectRatio: z.number(),
  refinedFrom: z.string().max(128).optional(),
  refinedTo: z.string().max(128).optional(),
  textureSurface: z.string().max(64).optional(),
});

const TierResultsSchema = z.object({
  tier1: z
    .array(
      z.object({
        itemName: z.string().max(128),
        confidence: z.number(),
        x: z.number().optional(),
      }),
    )
    .optional(),
});

const AllItemsSchema = z.array(
  z.object({
    itemName: z.string().max(128),
    wasteStream: z.string().max(64),
    confidence: z.number(),
    modelUsed: z.string().max(32).optional(),
  }),
);

/**
 * `meta` is keyed by ClassifyMeta but historically tolerant — accept any object.
 * We don't render it through dangerous sinks, so a permissive parse is fine.
 */
const MetaSchema = z.record(z.string(), z.unknown());

export const PilotLogEntrySchema = z.object({
  timestamp: z.string().max(64),
  modelUsed: z.enum(["t2", "T1"]),
  escalated: z.boolean(),
  itemName: z.string().max(256),
  wasteStream: z.string().max(64),
  confidence: z.number().min(0).max(1),
  requiresVerification: z.boolean(),
  latencyMs: z.number().min(0).max(120_000),
  imageUrl: z.string().url().max(2048).optional(),
  blobUploadFailed: z.boolean().optional(),
  requestId: z.string().max(128).optional(),
  meta: MetaSchema.optional(),
  yoloDetections: z.array(YoloDetectionSchema).max(64).optional(),
  overrideApplied: z.boolean().optional(),
  rgbAnalysis: RgbAnalysisSchema.optional(),
  tierResults: TierResultsSchema.optional(),
  allItems: AllItemsSchema.max(16).optional(),
  blobCount: z.number().min(0).max(64).optional(),
  yoloDetectionCount: z.number().min(0).max(64).optional(),
  tokenUsage: z
    .object({
      promptTokens: z.number().min(0).max(1_000_000),
      completionTokens: z.number().min(0).max(1_000_000),
    })
    .optional(),
});

/**
 * Parse one Redis-stored entry. Returns the typed entry or null if invalid.
 * Pass `null` / undefined / parse failures through as `null` so callers can
 * `.filter(Boolean)` cleanly.
 */
export function parsePilotLogEntry(raw: unknown): import("./types").PilotLogEntry | null {
  if (raw == null) return null;
  let candidate: unknown = raw;
  if (typeof raw === "string") {
    try {
      candidate = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  const res = PilotLogEntrySchema.safeParse(candidate);
  if (!res.success) return null;
  return res.data as import("./types").PilotLogEntry;
}
