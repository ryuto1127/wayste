import { NextResponse } from "next/server";
import { waitUntil } from "@vercel/functions";
import OpenAI from "openai";
import { z } from "zod/v4";
import type { ClassifyMeta, ComponentPart } from "@/lib/types";
import {
  loadSiteConfig,
  buildNanoPrompt,
  buildClassificationPrompt,
  buildClassificationResult,
} from "@/lib/waste-rules";
import { logPilotEntry } from "@/lib/pilot-log";
import { uploadFrameToBlob } from "@/lib/blob-store";
import { redis } from "@/lib/redis";
import { generateRequestId } from "@/lib/request-id";

// ── Request validation ──
const RequestSchema = z.object({
  image: z.string().min(100),
  siteId: z.string().optional(),
  locale: z.enum(["en", "ja"]).optional(),
  meta: z
    .object({
      skinRatio: z.number(),
      sharpnessScore: z.number(),
      imageQuality: z.enum(["good", "fair", "poor"]),
    })
    .optional(),
});

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

// ── Call a model and parse its JSON response ──
async function callModel(
  openai: OpenAI,
  model: string,
  image: string,
  prompt: string
): Promise<RawClassification> {
  const response = await openai.chat.completions.create({
    model,
    max_completion_tokens: model.includes("nano") ? 200 : 400,
    response_format: { type: "json_object" },
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

  // Parse JSON — with response_format: "json_object" the output should be valid JSON,
  // but we still extract defensively in case the model wraps it in markdown fences.
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Fallback: extract the first JSON object from the response
    const jsonMatch = text.match(/\{[\s\S]*?\}(?=[^}]*$)/);
    if (!jsonMatch) throw new Error("No JSON found in response");
    parsed = JSON.parse(jsonMatch[0]);
  }

  // Validate and provide defaults for missing fields
  const validated = RawClassificationSchema.safeParse(parsed);
  if (!validated.success) {
    console.warn("[callModel] Schema validation failed, using raw parse:", validated.error.issues);
    // Graceful degradation: use raw parse but enforce minimum shape
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

// ── Escalation policy: should we re-query with mini? ──
// Keep this list short — every escalation adds ~2s latency.
// Trust nano when it is confident; only escalate on genuine uncertainty.
function shouldEscalate(
  raw: RawClassification,
  meta?: ClassifyMeta
): boolean {
  const name = raw.itemName.toLowerCase();

  // No point re-asking for these
  if (name === "nothing detected" || name === "unknown") return false;

  // Model is genuinely unsure
  if (raw.confidence < 0.5) return true;

  // Model explicitly flagged it for review
  if (raw.wasteStream === "needs_review") return true;

  return false;
}

export async function POST(request: Request) {
  // ── Redis-based rate limiting ──
  const forwarded = request.headers.get("x-forwarded-for");
  const clientId = forwarded?.split(",")[0]?.trim() || "unknown";
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

  const { image, siteId, locale = "en", meta } = parsed.data;
  const siteConfig = loadSiteConfig(siteId ?? process.env.SITE_ID ?? "default");
  const openai = new OpenAI();
  const startMs = Date.now();
  const requestId = generateRequestId();

  try {
    // ── Step 1: Nano inference ──
    const step1Start = Date.now();
    const nanoPrompt = buildNanoPrompt(siteConfig, locale);
    let raw = await callModel(openai, "gpt-5.4-nano", image, nanoPrompt);
    let modelUsed: "nano" | "mini" = "nano";
    let escalated = false;
    const step1Ms = Date.now() - step1Start;

    // ── Step 2: Escalate to mini if needed ──
    const step2Start = Date.now();
    let step2Ms = 0;
    if (shouldEscalate(raw, meta)) {
      escalated = true;
      try {
        const miniPrompt = buildClassificationPrompt(siteConfig, locale);
        const miniRaw = await callModel(
          openai,
          "gpt-5.4-mini",
          image,
          miniPrompt
        );
        // Only use mini result if it's actually better
        if (
          miniRaw.confidence > raw.confidence ||
          miniRaw.isCompound ||
          raw.wasteStream === "needs_review"
        ) {
          raw = miniRaw;
          modelUsed = "mini"; // Only mark as mini if we actually used its result
        }
      } catch (miniErr) {
        // Mini failed — use nano result as-is, keep modelUsed = "nano"
        console.warn("[classify] Mini escalation failed, using nano result:", miniErr);
      }
      step2Ms = Date.now() - step2Start;
    }

    // ── Step 3: Build final result ──
    const step3Start = Date.now();
    const result = buildClassificationResult(raw, siteConfig);
    result.modelUsed = modelUsed;
    const step3Ms = Date.now() - step3Start;

    // ── Step 4: Upload frame to Blob + log entry (fire-and-forget, non-blocking) ──
    // Blob upload previously blocked the response (~1-3s on Vercel). Moving it to
    // waitUntil means imageUrl won't be in the classify response, but it is only
    // used in the feedback payload (not displayed in the UI), so this is fine.
    const logTimestamp = new Date().toISOString();
    const totalServerMs = Date.now() - startMs;

    console.log(`[${requestId}] TIMING BREAKDOWN:`, {
      step1_nano_ms: step1Ms,
      step2_mini_escalation_ms: step2Ms,
      step3_build_result_ms: step3Ms,
      totalServerMs,
    });
    console.log(`[${requestId}] classified`, {
      modelUsed,
      escalated,
      itemName: result.itemName,
      confidence: result.confidence,
      wasteStream: result.wasteStream,
      latencyMs: totalServerMs,
    });

    waitUntil(
      uploadFrameToBlob(image, result.itemName, result.wasteStream, logTimestamp)
        .then((imageUrl) =>
          logPilotEntry({
            timestamp: logTimestamp,
            modelUsed,
            escalated,
            itemName: result.itemName,
            wasteStream: result.wasteStream,
            confidence: result.confidence,
            requiresVerification: result.needsReview,
            latencyMs: totalServerMs,
            imageUrl,
            blobUploadFailed: !imageUrl,
            requestId,
            meta: meta as ClassifyMeta | undefined,
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
