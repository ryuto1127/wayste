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
import { runInBackground } from "@/lib/background-task";
import { uploadFrameToBlob } from "@/lib/blob-store";
import { redis } from "@/lib/redis";
import { generateRequestId } from "@/lib/request-id";

import { recordCalibrationPrediction } from "@/lib/calibration";

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
  tier2Results: z.array(
    z.object({
      className: z.string(),
      confidence: z.number(),
    })
  ),
}).optional();

// ── Request validation (single-item format — backward compatible) ──
const SingleRequestSchema = z.object({
  image: z.string().min(100),
  siteId: z.string().optional(),
  locale: z.enum(["en", "ja"]).optional(),
  meta: MetaSchema,
  yoloDetections: YoloDetectionsSchema,
  materialHint: MaterialHintSchema,
  /** When true, uses the multi-item prompt and returns an array of results. */
  multi: z.boolean().optional(),
  /** Tier 1 sub-classification context — triggers material identification prompt. */
  tier1Context: Tier1ContextSchema,
});

// ── Batch item schema ──
const BatchItemSchema = z.object({
  image: z.string().min(100),
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
});

interface RawClassification {
  itemName: string;
  wasteStream: string;
  confidence: number;
  reasoning: string;
  preAction?: string;
  isCompound?: boolean;
  components?: ComponentPart[];
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
                },
                required: ["itemName", "wasteStream", "confidence", "reasoning", "preAction", "isCompound", "components"],
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
  const siteConfig = loadSiteConfig(siteId ?? process.env.SITE_ID ?? "default");
  const openai = new OpenAI();
  const startMs = Date.now();
  const requestId = generateRequestId();

  /** Classify a single image using GPT-5.4 mini. */
  async function classifySingleImage(
    image: string,
    yoloHint: string | null | undefined,
    itemMaterialHint: MaterialHint | undefined,
    yoloDetections: YoloDetectionLog[] | undefined,
    tier1Ctx?: { className: string; confidence: number; tier2Results: { className: string; confidence: number }[] },
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
        tier1Ctx.tier2Results,
      );
      const raw = await callModel(openai, "gpt-5.4-mini", image, prompt);
      const modelUsed = "mini" as const;
      const result = buildClassificationResult(raw, siteConfig, locale);
      result.modelUsed = modelUsed;

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
    const modelUsed = "mini" as const;

    // Build result + conditional overrides
    const result = buildClassificationResult(raw, siteConfig, locale);
    result.modelUsed = modelUsed;

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

      // Background logging for first item
      const first = batchResults[0];
      if (first) {
        const logTimestamp = new Date().toISOString();
        runInBackground(
          Promise.all([
            recordCalibrationPrediction(first.result.confidence, first.modelUsed),
            uploadFrameToBlob(data.items[0].image, first.result.itemName, first.result.wasteStream, logTimestamp),
          ]).then(([, imageUrl]) =>
            logPilotEntry({
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
            })
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

      const multiResults = rawItems.map((raw) => {
        const result = buildClassificationResult(raw, siteConfig, locale);
        result.modelUsed = "mini";
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
        return { result, raw };
      });

      // Background logging for first item
      if (multiResults.length > 0) {
        const first = multiResults[0];
        const logTimestamp = new Date().toISOString();
        runInBackground(
          Promise.all([
            recordCalibrationPrediction(first.result.confidence, "mini"),
            uploadFrameToBlob(image, first.result.itemName, first.result.wasteStream, logTimestamp),
          ]).then(([, imageUrl]) =>
            logPilotEntry({
              timestamp: logTimestamp,
              modelUsed: "mini",
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
            })
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
      tier1Context as { className: string; confidence: number; tier2Results: { className: string; confidence: number }[] } | undefined,
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

    runInBackground(
      Promise.all([
        recordCalibrationPrediction(result.confidence, modelUsed),
        uploadFrameToBlob(image, result.itemName, result.wasteStream, logTimestamp),
      ]).then(([, imageUrl]) =>
        logPilotEntry({
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
        })
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
