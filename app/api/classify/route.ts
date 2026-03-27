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

// ── Rate limiting ──
let lastRequestTime = 0;
const MIN_INTERVAL_MS = 500;

// ── Raw model response shape ──
interface RawClassification {
  itemName: string;
  wasteStream: string;
  confidence: number;
  reasoning: string;
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

  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error("No JSON found in response");

  return JSON.parse(jsonMatch[0]) as RawClassification;
}

// ── Escalation policy: should we re-query with mini? ──
function shouldEscalate(
  raw: RawClassification,
  meta?: ClassifyMeta
): boolean {
  const name = raw.itemName.toLowerCase();

  // Model is unsure
  if (raw.confidence < 0.5) return true;

  // Nothing detected / unknown
  if (name === "nothing detected" || name === "unknown") return false; // no point re-asking

  // Potentially hazardous — want higher-quality reasoning
  if (raw.wasteStream === "special") return true;

  // Nano flagged compound or review
  if (raw.isCompound) return true;
  if (raw.wasteStream === "needs_review") return true;

  // Client reported poor image quality
  if (meta?.imageQuality === "poor") return true;

  return false;
}

export async function POST(request: Request) {
  const now = Date.now();
  if (now - lastRequestTime < MIN_INTERVAL_MS) {
    return NextResponse.json(
      { error: "Too many requests. Please wait." },
      { status: 429 }
    );
  }
  lastRequestTime = now;

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

  try {
    // ── Step 1: Nano inference ──
    const nanoPrompt = buildNanoPrompt(siteConfig, locale);
    let raw = await callModel(openai, "gpt-5.4-nano", image, nanoPrompt);
    let modelUsed: "nano" | "mini" = "nano";
    let escalated = false;

    // ── Step 2: Escalate to mini if needed ──
    if (shouldEscalate(raw, meta)) {
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
        }
        modelUsed = "mini";
        escalated = true;
      } catch {
        // Mini failed — use nano result as-is
      }
    }

    // ── Step 3: Build final result ──
    const result = buildClassificationResult(raw, siteConfig);
    result.modelUsed = modelUsed;

    // ── Step 4: Upload frame to Blob (synchronous — URL is returned to client) ──
    const logTimestamp = new Date().toISOString();
    const imageUrl = await uploadFrameToBlob(
      image,
      result.itemName,
      result.wasteStream,
      logTimestamp
    );
    result.imageUrl = imageUrl;

    // ── Step 5: Log entry (fire-and-forget, non-blocking) ──
    waitUntil(logPilotEntry({
      timestamp: logTimestamp,
      modelUsed,
      escalated,
      itemName: result.itemName,
      wasteStream: result.wasteStream,
      confidence: result.confidence,
      requiresVerification: result.needsReview,
      latencyMs: Date.now() - startMs,
      imageUrl,
      meta: meta as ClassifyMeta | undefined,
    }));

    return NextResponse.json(result);
  } catch (err: unknown) {
    console.error("Classification error:", err);
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
