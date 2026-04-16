import { NextResponse } from "next/server";
import OpenAI from "openai";
import { z } from "zod/v4";
import type { ClassifyMeta, ComponentPart, YoloDetectionLog, LocalModelCandidate, MaterialHint } from "@/lib/types";
import {
  loadSiteConfig,
  buildClassificationPrompt,
  buildMultiItemPrompt,
  buildMaterialIdentificationPrompt,
  buildClassificationResult,
  applyOverrides,
} from "@/lib/waste-rules";
import { logPilotEntry } from "@/lib/pilot-log";
import { runInBackground, isolated } from "@/lib/background-task";
import { uploadFrameToBlob } from "@/lib/blob-store";
import { redis } from "@/lib/redis";
import { generateRequestId } from "@/lib/request-id";

import { recordCalibrationPrediction } from "@/lib/calibration";
import { isYoloClassNotWaste } from "@/lib/yolo-rules";
import { verifyKioskRequest } from "@/lib/kiosk-auth";
import { serverFaceDetected } from "@/lib/face-detect-server";

// ── Shared sub-schemas ──
const MetaSchema = z.object({
  sharpnessScore: z.number(),
  imageQuality: z.enum(["good", "fair", "poor"]),
}).optional();

const YoloDetectionsSchema = z.array(
  z.object({
    classId: z.number(),
    className: z.string(),
    confidence: z.number(),
    bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]),
    bboxNorm: z.tuple([z.number(), z.number(), z.number(), z.number()]),
  })
).optional();

const MaterialHintSchema = z.object({
  dominantHue: z.number(),
  saturation: z.number(),
  isMetallic: z.boolean(),
  suggestedMaterial: z.string().nullable(),
  bboxAspectRatio: z.number(),
  texture: z.object({
    uniformity: z.number(),
    edgeDensity: z.number(),
    suggestedSurface: z.enum(["paper", "plastic", "metal", "unknown"]),
  }).optional(),
}).optional();

// ── Tier 1 sub-classification context (material identification path) ──
const Tier1ContextSchema = z.object({
  className: z.string(),
  confidence: z.number(),
}).optional();

// ── Intermediate tier results (for pilot-log traceability) ──
const TierResultsSchema = z.object({
  tier1: z.array(z.object({ itemName: z.string(), confidence: z.number(), x: z.number().optional() })).optional(),
}).optional();

// ── Request validation (single-item format — backward compatible) ──
// Max ~3.75 MB base64 (≈ 2.8 MB raw image) — prevents memory exhaustion DoS
const IMAGE_MAX_LENGTH = 5_000_000;

const SingleRequestSchema = z.object({
  image: z.string().min(100).max(IMAGE_MAX_LENGTH),
  siteId: z.string().optional(),
  locale: z.enum(["en", "ja"]).optional(),
  meta: MetaSchema,
  yoloDetections: YoloDetectionsSchema,
  materialHint: MaterialHintSchema,
  /** When true, uses the multi-item prompt and returns an array of results. */
  multi: z.boolean().optional(),
  /** Tier 1 sub-classification context — triggers material identification prompt. */
  tier1Context: Tier1ContextSchema,
  /** Client-provided intermediate tier results (T1/T2 detections for pilot-log). */
  tierResults: TierResultsSchema,
  /** When true, a face was detected in the frame — skip image storage for privacy. */
  faceDetected: z.boolean().optional(),
});

// ── Batch item schema ──
const BatchItemSchema = z.object({
  image: z.string().min(100).max(IMAGE_MAX_LENGTH),
  yoloHint: z.string().nullable().optional(),
  materialHint: MaterialHintSchema,
  cropBox: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional(),
});

// ── Batch request format ──
const BatchRequestSchema = z.object({
  items: z.array(BatchItemSchema).min(1).max(4),
  siteId: z.string().optional(),
  locale: z.enum(["en", "ja"]).optional(),
  meta: MetaSchema,
  tierResults: TierResultsSchema,
  faceDetected: z.boolean().optional(),
});

// ── Union schema: accepts either format ──
const RequestSchema = z.union([BatchRequestSchema, SingleRequestSchema]);

// ── Rate limiting (Redis-based) ──
// Kiosks are trusted single-device endpoints — allow enough headroom for
// back-to-back scans and retries. 6 requests per 3-second window prevents
// genuine abuse while never blocking legitimate consecutive classifications.
const RATE_LIMIT_MAX = parseInt(process.env.RATE_LIMIT_MAX || "15");
const RATE_LIMIT_TTL_S = 3;

// ── Raw model response validation ──
const RawClassificationSchema = z.object({
  itemName: z.string().default("unknown"),
  wasteStream: z.string().default("needs_review"),
  confidence: z.number().min(0).max(1).default(0),
  reasoning: z.string().default(""),
  preAction: z.string().optional().default(""),
  isCompound: z.boolean().optional().default(false),
  components: z
    .array(
      z.object({
        partName: z.string(),
        wasteStream: z.string(),
        instruction: z.string(),
      })
    )
    .optional(),
  horizontalPosition: z.enum(["left", "center", "right"]).optional(),
});

interface RawClassification {
  itemName: string;
  wasteStream: string;
  confidence: number;
  reasoning: string;
  preAction?: string;
  isCompound?: boolean;
  components?: ComponentPart[];
  horizontalPosition?: "left" | "center" | "right";
}

// ── Multi-item raw response validation ──
const RawMultiClassificationSchema = z.object({
  items: z.array(RawClassificationSchema).max(4),
});

// ── Call a model with Structured Outputs ──
async function callModel(
  openai: OpenAI,
  model: string,
  image: string,
  prompt: string
): Promise<RawClassification> {
  const response = await openai.chat.completions.create({
    model,
    max_completion_tokens: 4096,
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "waste_classification",
        strict: true,
        schema: {
          type: "object",
          properties: {
            itemName: { type: "string" },
            wasteStream: { type: "string" },
            confidence: { type: "number" },
            reasoning: { type: "string" },
            preAction: { type: "string" },
            isCompound: { type: "boolean" },
            components: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  partName: { type: "string" },
                  wasteStream: { type: "string" },
                  instruction: { type: "string" },
                },
                required: ["partName", "wasteStream", "instruction"],
                additionalProperties: false,
              },
            },
          },
          required: ["itemName", "wasteStream", "confidence", "reasoning", "preAction", "isCompound", "components"],
          additionalProperties: false,
        },
      },
    },
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image_url",
            image_url: {
              url: `data:image/jpeg;base64,${image}`,
              detail: "low",
            },
          },
          { type: "text", text: prompt },
        ],
      },
    ],
  });

  const text = response.choices[0]?.message?.content;
  if (!text) throw new Error("No text response from model");

  const parsed = JSON.parse(text);

  // Validate and provide defaults for missing fields
  const validated = RawClassificationSchema.safeParse(parsed);
  if (!validated.success) {
    console.warn("[callModel] Schema validation failed, using raw parse:", validated.error.issues);
    const raw = parsed as Record<string, unknown>;
    return {
      itemName: typeof raw.itemName === "string" ? raw.itemName : "unknown",
      wasteStream: typeof raw.wasteStream === "string" ? raw.wasteStream : "needs_review",
      confidence: typeof raw.confidence === "number" ? Math.max(0, Math.min(1, raw.confidence)) : 0,
      reasoning: typeof raw.reasoning === "string" ? raw.reasoning : "",
      preAction: typeof raw.preAction === "string" ? raw.preAction : "",
      isCompound: raw.isCompound === true,
      components: Array.isArray(raw.components) ? (raw.components as ComponentPart[]) : undefined,
    };
  }

  return validated.data as RawClassification;
}


// ── Call a model with multi-item Structured Outputs ──
async function callModelMulti(
  openai: OpenAI,
  model: string,
  image: string,
  prompt: string
): Promise<RawClassification[]> {
  const response = await openai.chat.completions.create({
    model,
    max_completion_tokens: 4096,
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "waste_classification_multi",
        strict: true,
        schema: {
          type: "object",
          properties: {
            items: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  itemName: { type: "string" },
                  wasteStream: { type: "string" },
                  confidence: { type: "number" },
                  reasoning: { type: "string" },
                  preAction: { type: "string" },
                  isCompound: { type: "boolean" },
                  components: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        partName: { type: "string" },
                        wasteStream: { type: "string" },
                        instruction: { type: "string" },
                      },
                      required: ["partName", "wasteStream", "instruction"],
                      additionalProperties: false,
                    },
                  },
                  horizontalPosition: { type: "string", enum: ["left", "center", "right"] },
                },
                required: ["itemName", "wasteStream", "confidence", "reasoning", "preAction", "isCompound", "components", "horizontalPosition"],
                additionalProperties: false,
              },
            },
          },
          required: ["items"],
          additionalProperties: false,
        },
      },
    },
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image_url",
            image_url: {
              url: `data:image/jpeg;base64,${image}`,
              detail: "low",
            },
          },
          { type: "text", text: prompt },
        ],
      },
    ],
  });

  const text = response.choices[0]?.message?.content;
  if (!text) throw new Error("No text response from model");

  const parsed = JSON.parse(text);
  const validated = RawMultiClassificationSchema.safeParse(parsed);
  if (!validated.success) {
    console.warn("[callModelMulti] Schema validation failed:", validated.error.issues);
    // Attempt to extract items array from raw parse
    if (Array.isArray(parsed?.items)) {
      return (parsed.items as RawClassification[]).slice(0, 4);
    }
    return [];
  }

  return validated.data.items as RawClassification[];
}

export async function POST(request: Request) {
  // ── Kiosk authentication ──
  // Requires `kiosk_session` cookie or `Authorization: Bearer <KIOSK_API_TOKEN>`.
  // Closes the cost-exhaustion DoS vector (unauthenticated OpenAI Vision calls)
  // and the open image-upload vector.
  const auth = await verifyKioskRequest(request);
  if (!auth.ok) return auth.response;

  // ── Redis-based rate limiting ──
  const clientId =
    request.headers.get("x-real-ip")
    ?? request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    ?? "unknown";
  const rlKey = `rl:classify:${clientId}`;
  try {
    const count = await redis.incr(rlKey);
    if (count === 1) {
      await redis.expire(rlKey, RATE_LIMIT_TTL_S);
    }
    if (count > RATE_LIMIT_MAX) {
      return NextResponse.json(
        { error: "rate_limited", retryAfterMs: 1000 },
        { status: 429 }
      );
    }
  } catch (err) {
    console.warn("[classify] Redis rate-limit unavailable, allowing request:", err);
    // requestId not yet generated at this point
  }

  // ── Parse request ──
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body." },
      { status: 400 }
    );
  }

  const parsed = RequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid request.", details: parsed.error.issues },
      { status: 400 }
    );
  }

  const data = parsed.data;
  const isBatch = "items" in data;
  const siteId = data.siteId;
  const locale = data.locale ?? "en";
  const meta = data.meta;
  const clientFaceDetected = data.faceDetected === true;
  const siteConfig = loadSiteConfig(siteId ?? process.env.SITE_ID ?? "japan-office");
  const openai = new OpenAI();
  const startMs = Date.now();
  const requestId = generateRequestId();

  /**
   * Server-side face detection lazily evaluated the first time we're about to
   * upload. We run it against whichever image is being stored — for batch mode
   * that's `items[0].image`; for single/multi it's `singleData.image`. The
   * result is cached per-request so the ONNX pass only runs once even if
   * safeUpload is called from multiple background log paths.
   *
   * The client-supplied `faceDetected` flag is treated as a speed hint: if the
   * client already detected a face we skip the server pass (client said
   * "definitely has face" — trust the positive). If the client said "no face",
   * we re-check server-side because the client may be an attacker lying.
   */
  let serverFaceCheck: Promise<boolean> | null = null;
  const shouldBlockUpload = (image: string): Promise<boolean> => {
    if (clientFaceDetected) return Promise.resolve(true);
    if (!serverFaceCheck) {
      serverFaceCheck = serverFaceDetected(image).catch((err) => {
        console.warn(`[${requestId}] server face detection error, failing closed:`, err);
        return true;
      });
    }
    return serverFaceCheck;
  };

  /** Upload image to blob unless a face was detected (privacy). */
  const safeUpload = async (
    image: string,
    itemName: string,
    wasteStream: string,
    ts: string,
  ): Promise<string | undefined> => {
    if (await shouldBlockUpload(image)) return undefined;
    return uploadFrameToBlob(image, itemName, wasteStream, ts);
  };

  /** Apply conditional override if the model's reasoning mentions the condition keyword. */
  function applyConditionalOverride(
    result: { wasteStream: string; binColor: string; binLabel: string; specialInstructions?: string },
    raw: { itemName: string; wasteStream: string; reasoning?: string },
  ): void {
    const overrideCheck = applyOverrides(raw.itemName, raw.wasteStream, siteConfig, locale);
    if (overrideCheck.conditionalStream && overrideCheck.condition && !overrideCheck.requiresStaff) {
      const conditionLower = overrideCheck.condition.toLowerCase();
      const reasoningLower = (raw.reasoning ?? "").toLowerCase();
      if (reasoningLower.includes(conditionLower)) {
        const condStreamDef = siteConfig.streams.find((s) => s.id === overrideCheck.conditionalStream);
        if (condStreamDef) {
          result.wasteStream = overrideCheck.conditionalStream;
          result.binColor = condStreamDef.color;
          result.binLabel = condStreamDef.label;
          result.specialInstructions = overrideCheck.note;
        }
      }
    }
  }

  /** Classify a single image using GPT-5.4 mini. */
  async function classifySingleImage(
    image: string,
    yoloHint: string | null | undefined,
    itemMaterialHint: MaterialHint | undefined,
    yoloDetections: YoloDetectionLog[] | undefined,
    tier1Ctx?: { className: string; confidence: number },
  ) {
    // ── Material identification path (Tier 1 sub-classification) ──
    // When tier1Context is present, use the material-focused prompt instead
    // of the generic classification prompt.
    if (tier1Ctx) {
      const prompt = buildMaterialIdentificationPrompt(
        siteConfig,
        locale,
        tier1Ctx.className,
        tier1Ctx.confidence,
        [],
      );
      const raw = await callModel(openai, "gpt-5.4-mini", image, prompt);
      const modelUsed = "t2" as const;
      const result = buildClassificationResult(raw, siteConfig, locale);
      result.modelUsed = modelUsed;

      applyConditionalOverride(result, raw);
      return { result, raw, modelUsed };
    }

    // ── Standard classification path ──
    const localCandidates: LocalModelCandidate[] | undefined =
      yoloDetections && yoloDetections.length > 0
        ? yoloDetections.slice(0, 3).map((d) => ({ className: d.className, confidence: d.confidence }))
        : undefined;

    const noLocalHint = yoloHint === null;
    const promptOptions = {
      localCandidates,
      materialHint: itemMaterialHint,
    };

    const prompt = buildClassificationPrompt(siteConfig, locale, promptOptions);
    const promptFinal = noLocalHint
      ? prompt + "\nNo local model could identify this item. Classify from the image alone."
      : prompt;
    const raw = await callModel(openai, "gpt-5.4-mini", image, promptFinal);
    const modelUsed = "t2" as const;

    // Build result + conditional overrides
    const result = buildClassificationResult(raw, siteConfig, locale);
    result.modelUsed = modelUsed;

    applyConditionalOverride(result, raw);

    return { result, raw, modelUsed };
  }

  try {
    if (isBatch) {
      // ── Batch mode: parallel GPT calls for up to 4 items ──
      const batchResults = await Promise.all(
        data.items.map((item) =>
          classifySingleImage(
            item.image,
            item.yoloHint,
            item.materialHint as MaterialHint | undefined,
            undefined,
          )
        )
      );

      const totalServerMs = Date.now() - startMs;
      console.log(`[${requestId}] batch classified ${batchResults.length} items in ${totalServerMs}ms`);

      // Background logging — includes all items in the frame
      const first = batchResults[0];
      if (first) {
        const logTimestamp = new Date().toISOString();
        const batchTierResults = data.tierResults as { tier1?: { itemName: string; confidence: number }[] } | undefined;
        const allItems = batchResults.map(b => ({
          itemName: b.result.itemName,
          wasteStream: b.result.wasteStream,
          confidence: b.result.confidence,
          modelUsed: b.modelUsed,
        }));
        runInBackground(
          Promise.all([
            isolated("calibration", recordCalibrationPrediction(first.result.confidence, first.modelUsed), undefined),
            isolated("blob-upload", safeUpload(data.items[0].image, first.result.itemName, first.result.wasteStream, logTimestamp), undefined),
          ]).then(([, imageUrl]) =>
            isolated("pilot-log", logPilotEntry({
              timestamp: logTimestamp,
              modelUsed: first.modelUsed,
              escalated: false,
              itemName: first.result.itemName,
              wasteStream: first.result.wasteStream,
              confidence: first.result.confidence,
              requiresVerification: first.result.needsReview,
              latencyMs: totalServerMs,
              imageUrl,
              blobUploadFailed: !imageUrl,
              requestId,
              meta: meta as ClassifyMeta | undefined,
              overrideApplied: first.result.wasteStream !== first.raw.wasteStream,
              tierResults: batchTierResults,
              allItems,
            }), undefined)
          )
        );
      }

      return NextResponse.json({
        results: batchResults.map((b) => ({ ...b.result, requestId })),
        requestId,
      });
    }

    // ── Single-item mode (backward compatible) ──
    const singleData = data as z.infer<typeof SingleRequestSchema>;
    const { image, yoloDetections, materialHint, tier1Context } = singleData;

    // ── Multi-item mode: full-frame, zero-detection fallback ──
    if (singleData.multi) {
      const multiPrompt = buildMultiItemPrompt(siteConfig, locale);
      const rawItems = await callModelMulti(openai, "gpt-5.4-mini", image, multiPrompt);
      const totalServerMs = Date.now() - startMs;
      console.log(`[${requestId}] multi-item classified ${rawItems.length} items in ${totalServerMs}ms`);

      // Sort raw items left-to-right by horizontalPosition before building results
      const posOrder: Record<string, number> = { left: 0, center: 1, right: 2 };
      rawItems.sort((a, b) => (posOrder[a.horizontalPosition ?? "center"] ?? 1) - (posOrder[b.horizontalPosition ?? "center"] ?? 1));

      const multiResults = rawItems.map((raw) => {
        const result = buildClassificationResult(raw, siteConfig, locale);
        result.modelUsed = "t2";
        applyConditionalOverride(result, raw);
        return { result, raw };
      });

      // Background logging for all multi-item results
      if (multiResults.length > 0) {
        const logTimestamp = new Date().toISOString();
        const clientTierResults = (data as z.infer<typeof SingleRequestSchema>).tierResults as { tier1?: { itemName: string; confidence: number; x?: number }[] } | undefined
          ?? (() => {
            const yd = (data as z.infer<typeof SingleRequestSchema>).yoloDetections as YoloDetectionLog[] | undefined;
            return yd?.length ? { tier1: yd.map(d => ({ itemName: d.className, confidence: d.confidence })) } : undefined;
          })();
        const allItems = multiResults.map(m => ({
          itemName: m.result.itemName,
          wasteStream: m.result.wasteStream,
          confidence: m.result.confidence,
          modelUsed: "t2",
        }));
        runInBackground(
          Promise.all([
            isolated("calibration", recordCalibrationPrediction(multiResults[0].result.confidence, "t2"), undefined),
            isolated("blob-upload", safeUpload(image, multiResults[0].result.itemName, multiResults[0].result.wasteStream, logTimestamp), undefined),
          ]).then(([, imageUrl]) =>
            Promise.all(multiResults.map((item, i) =>
              isolated("pilot-log", logPilotEntry({
                timestamp: logTimestamp,
                modelUsed: "t2",
                escalated: false,
                itemName: item.result.itemName,
                wasteStream: item.result.wasteStream,
                confidence: item.result.confidence,
                requiresVerification: item.result.needsReview,
                latencyMs: totalServerMs,
                imageUrl,
                blobUploadFailed: !imageUrl,
                requestId: i === 0 ? requestId : `${requestId}-${i}`,
                meta: meta as ClassifyMeta | undefined,
                overrideApplied: item.result.wasteStream !== item.raw.wasteStream,
                tierResults: clientTierResults,
                allItems,
              }), undefined)
            ))
          )
        );
      }

      return NextResponse.json({
        results: multiResults.map((m) => ({ ...m.result, requestId })),
        requestId,
      });
    }

    const { result, raw, modelUsed } = await classifySingleImage(
      image,
      undefined,
      materialHint as MaterialHint | undefined,
      yoloDetections as YoloDetectionLog[] | undefined,
      tier1Context as { className: string; confidence: number } | undefined,
    );

    const totalServerMs = Date.now() - startMs;
    const logTimestamp = new Date().toISOString();

    console.log(`[${requestId}] classified`, {
      modelUsed,
      itemName: result.itemName,
      confidence: result.confidence,
      wasteStream: result.wasteStream,
      latencyMs: totalServerMs,
    });

    // Prefer client-provided tierResults (has T1 data).
    // Fall back to server-constructed from yoloDetections / tier1Context.
    const tierResults = (singleData.tierResults as { tier1?: { itemName: string; confidence: number; x?: number }[] } | undefined) ?? (() => {
      const tr: { tier1?: { itemName: string; confidence: number; x?: number }[] } = {};
      const t1Ctx = tier1Context as { className: string; confidence: number } | undefined;
      if (t1Ctx) {
        tr.tier1 = [{ itemName: t1Ctx.className, confidence: t1Ctx.confidence }];
      } else if (yoloDetections && (yoloDetections as YoloDetectionLog[]).length > 0) {
        const wasteOnly = (yoloDetections as YoloDetectionLog[]).filter(d => !isYoloClassNotWaste(d.className));
        if (wasteOnly.length > 0) tr.tier1 = wasteOnly.map(d => ({ itemName: d.className, confidence: d.confidence }));
      }
      return tr.tier1 ? tr : undefined;
    })();

    runInBackground(
      Promise.all([
        isolated("calibration", recordCalibrationPrediction(result.confidence, modelUsed), undefined),
        isolated("blob-upload", safeUpload(image, result.itemName, result.wasteStream, logTimestamp), undefined),
      ]).then(([, imageUrl]) =>
        isolated("pilot-log", logPilotEntry({
          timestamp: logTimestamp,
          modelUsed,
          escalated: false,
          itemName: result.itemName,
          wasteStream: result.wasteStream,
          confidence: result.confidence,
          requiresVerification: result.needsReview,
          latencyMs: totalServerMs,
          imageUrl,
          blobUploadFailed: !imageUrl,
          requestId,
          meta: meta as ClassifyMeta | undefined,
          yoloDetections: yoloDetections as YoloDetectionLog[] | undefined,
          overrideApplied: result.wasteStream !== raw.wasteStream,
          tierResults,
          allItems: [{ itemName: result.itemName, wasteStream: result.wasteStream, confidence: result.confidence, modelUsed }],
          ...(materialHint && {
            rgbAnalysis: {
              dominantHue: (materialHint as MaterialHint).dominantHue,
              saturation: (materialHint as MaterialHint).saturation,
              isMetallic: (materialHint as MaterialHint).isMetallic,
              bboxAspectRatio: (materialHint as MaterialHint).bboxAspectRatio,
              ...(((materialHint as MaterialHint).texture?.suggestedSurface && (materialHint as MaterialHint).texture?.suggestedSurface !== "unknown") && {
                textureSurface: (materialHint as MaterialHint).texture!.suggestedSurface,
              }),
            },
          }),
        }), undefined)
      )
    );

    return NextResponse.json({ ...result, requestId });
  } catch (err: unknown) {
    console.error(`[${requestId}] Classification error:`, err);
    // Surface quota exhaustion distinctly so the UI can show an actionable message
    if (
      err &&
      typeof err === "object" &&
      "code" in err &&
      (err as { code: string }).code === "insufficient_quota"
    ) {
      return NextResponse.json(
        { error: "API quota exceeded. Please add credits to your OpenAI account." },
        { status: 402 }
      );
    }
    return NextResponse.json(
      { error: "Classification service unavailable." },
      { status: 502 }
    );
  }
}
