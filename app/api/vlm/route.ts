import { NextResponse } from "next/server";
import { verifyKioskRequest } from "@/lib/kiosk-auth";
import { serverFaceDetected } from "@/lib/face-detect-server";
import { loadSiteConfig } from "@/lib/waste-rules";
import { buildVlmPrompt, parseVlmResponse } from "@/lib/vlm-client";

/**
 * POST /api/vlm — Tier 1.5 server proxy for web-hosted kiosks.
 *
 * When a kiosk has no local VLM runtime (site config `localVlm.endpoint:
 * "server"`), unresolved-item crops are judged here instead. The REAL VLM
 * endpoint lives in server env vars — never in the client-readable site
 * config — so a tampered config cannot redirect frames anywhere:
 *
 *   VLM_ENDPOINT   OpenAI-compatible base URL (required to enable)
 *   VLM_MODEL      model identifier (required to enable)
 *   VLM_API_KEY    bearer token (optional)
 *   VLM_TIMEOUT_MS per-judgment timeout (default 8000)
 *
 * Privacy: this is the one VLM mode where a crop leaves the kiosk device.
 * The client face-gates before sending; this route re-checks with the
 * server-side detector (authoritative floor, same pattern as /api/pilot-log)
 * and refuses to forward crops containing faces. Nothing is stored.
 *
 * Both env vars unset (the default) → 503, tier disabled — the default
 * kiosk path stays fully on-device per the local-first rule.
 */

/** Data-URL size cap (~1.5 MB of JPEG after base64). */
const MAX_IMAGE_CHARS = 2_000_000;
const DEFAULT_TIMEOUT_MS = 8_000;

export async function POST(request: Request) {
  const auth = await verifyKioskRequest(request);
  if (!auth.ok) return auth.response;

  const endpoint = process.env.VLM_ENDPOINT;
  const model = process.env.VLM_MODEL;
  if (!endpoint || !model) {
    return NextResponse.json(
      { error: "Server VLM is not configured." },
      { status: 503 },
    );
  }

  let body: { image?: unknown; locale?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }

  const image = typeof body.image === "string" ? body.image : "";
  const locale = body.locale === "ja" ? "ja" : "en";
  const base64 = image.startsWith("data:image/jpeg;base64,")
    ? image.slice("data:image/jpeg;base64,".length)
    : null;
  if (!base64 || image.length > MAX_IMAGE_CHARS) {
    return NextResponse.json({ error: "Invalid image." }, { status: 400 });
  }

  // ── Server-side face re-check (fail-closed): never forward a face ──
  try {
    if (await serverFaceDetected(base64)) {
      return NextResponse.json({ judgment: null, faceBlocked: true });
    }
  } catch {
    return NextResponse.json({ judgment: null, faceBlocked: true });
  }

  const siteConfig = loadSiteConfig(process.env.SITE_ID ?? "japan-office");
  const prompt = buildVlmPrompt(
    siteConfig.streams,
    siteConfig.canonicalNames ?? [],
    locale,
  );

  try {
    const timeoutMs = Number(process.env.VLM_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;
    const res = await fetch(`${endpoint.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(process.env.VLM_API_KEY && {
          Authorization: `Bearer ${process.env.VLM_API_KEY}`,
        }),
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        max_tokens: 200,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: prompt },
              { type: "image_url", image_url: { url: image } },
            ],
          },
        ],
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      console.warn(`[api/vlm] upstream HTTP ${res.status}`);
      return NextResponse.json({ judgment: null });
    }
    const data = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const content = data.choices?.[0]?.message?.content;
    const judgment = content
      ? parseVlmResponse(
          content,
          new Set(siteConfig.streams.map((s) => s.id as string)),
        )
      : null;
    return NextResponse.json({ judgment });
  } catch (err) {
    console.warn("[api/vlm] upstream call failed:", err);
    return NextResponse.json({ judgment: null });
  }
}
