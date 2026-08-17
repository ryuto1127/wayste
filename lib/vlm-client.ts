/**
 * Tier 1.5 — local VLM client for continuous mode.
 *
 * When YOLO can't confidently resolve a tracked item (needs_review), the
 * kiosk can ask a vision-language model running ON THIS MACHINE to identify
 * it: the track's crop goes to an OpenAI-compatible local endpoint
 * (Ollama `/v1`, LM Studio, llama.cpp server, mlx-omni-server, ...) and the
 * constrained JSON verdict upgrades the card through the existing
 * needs_review→resolved path.
 *
 * Privacy: the endpoint is REQUIRED to be loopback (localhost/127.0.0.1).
 * A planted site config must not be able to exfiltrate frames — same
 * philosophy as the Blob URL allow-list. Frames never leave the machine;
 * the "判定のために外部AIへ送られない" claim stays true.
 *
 * The VLM's language ability is pointed at what YOLO can't do: naming
 * arbitrary items (constrained to canonicalNames when possible, so
 * word-boundary overrides keep working) and judging CONDITION (dirty vs
 * clean) which site rules already encode via conditionalStream.
 *
 * Pure helpers (prompt, parsing, endpoint validation, bbox mapping) are
 * exported for unit tests; only judgeCropWithVlm performs I/O.
 */

import type { StreamDefinition, SiteConfig } from "./types";
import { computeLetterbox, MODEL_INPUT_SIZE, type Bbox } from "./bbox-utils";

export interface LocalVlmConfig {
  /** Where judgments run:
   *  - an OpenAI-compatible LOOPBACK base URL, e.g. "http://localhost:11434/v1"
   *    (Ollama) — fully on-device, frames never leave the machine; or
   *  - the literal string "server" — crops go to this deployment's own
   *    `/api/vlm` proxy (same origin), which forwards to the VLM the
   *    operator configured in SERVER env vars. Works for web-hosted kiosks
   *    with no local runtime; crops leave the device, so they are
   *    face-gated client-side AND re-checked on the server. */
  endpoint: string;
  /** Model identifier for the LOCAL runtime, e.g. "qwen2.5vl:3b".
   *  Ignored in "server" mode (the server's env decides). */
  model?: string;
  /** Per-judgment timeout. Local small VLMs answer in 0.3–3s. */
  timeoutMs?: number;
}

export type VlmMode = "local" | "server" | "browser";

/** Literal endpoint value selecting the same-origin server proxy. */
export const SERVER_VLM_ENDPOINT = "server";
/** Literal endpoint value selecting the fully in-browser WebGPU model. */
export const BROWSER_VLM_ENDPOINT = "browser";
/** Default in-browser model: newest small multimodal Qwen with official
 *  ONNX export — strong Japanese, ~0.8B params, proven on WebGPU via
 *  transformers.js. Swappable via site config `localVlm.model`. */
export const DEFAULT_BROWSER_VLM_MODEL = "onnx-community/Qwen3.5-0.8B-ONNX";

/** Resolve the configured mode, or null when the config can't be used. */
export function getVlmMode(config: LocalVlmConfig | undefined): VlmMode | null {
  if (!config?.endpoint) return null;
  if (config.endpoint === SERVER_VLM_ENDPOINT) return "server";
  if (config.endpoint === BROWSER_VLM_ENDPOINT) return "browser";
  if (isLocalVlmEndpointAllowed(config.endpoint) && config.model) return "local";
  return null;
}

export interface VlmJudgment {
  itemName: string;
  wasteStream: string;
  confidence: number;
  reasoning?: string;
}

const DEFAULT_TIMEOUT_MS = 6_000;
/** In-browser judgments can include first-call shader compilation. */
const BROWSER_JUDGE_TIMEOUT_MS = 30_000;

/** Loopback-only endpoint guard — frames must never leave this machine. */
export function isLocalVlmEndpointAllowed(endpoint: string): boolean {
  try {
    const url = new URL(endpoint);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    return (
      url.hostname === "localhost" ||
      url.hostname === "127.0.0.1" ||
      url.hostname === "[::1]" ||
      url.hostname === "::1"
    );
  } catch {
    return false;
  }
}

/** Map a model-space bbox (letterboxed full frame) back to video pixels,
 *  padded by `marginRatio` on each side and clamped to the frame. */
export function modelBboxToVideoRect(
  bbox: Bbox,
  vw: number,
  vh: number,
  marginRatio = 0.2,
  modelSize = MODEL_INPUT_SIZE,
): { x: number; y: number; w: number; h: number } {
  const { dx, dy, dw, dh } = computeLetterbox(vw, vh, modelSize);
  const scaleX = vw / dw;
  const scaleY = vh / dh;
  let x = (bbox[0] - dx) * scaleX;
  let y = (bbox[1] - dy) * scaleY;
  let w = bbox[2] * scaleX;
  let h = bbox[3] * scaleY;
  x -= w * marginRatio;
  y -= h * marginRatio;
  w *= 1 + marginRatio * 2;
  h *= 1 + marginRatio * 2;
  const x0 = Math.max(0, Math.round(x));
  const y0 = Math.max(0, Math.round(y));
  return {
    x: x0,
    y: y0,
    w: Math.max(1, Math.min(vw - x0, Math.round(w))),
    h: Math.max(1, Math.min(vh - y0, Math.round(h))),
  };
}

/** Compact constrained prompt: JSON only, stream from the site's list,
 *  item name preferably from canonicalNames (keeps overrides matching). */
export function buildVlmPrompt(
  streams: StreamDefinition[],
  canonicalNames: string[],
  locale: string,
): string {
  const streamList = streams
    .map((s) => `"${s.id}" (${s.label}: ${s.description})`)
    .join(", ");
  // Every name here is prompt-prefill the user waits through on each
  // judgment (WebGPU prefill is the dominant latency term) — cap tight.
  const names = canonicalNames.slice(0, 24).join(", ");
  const lang = locale === "ja" ? "Japanese" : "English";
  return [
    `You are a waste-sorting assistant. Identify the single main item in the photo and assign it to exactly one stream.`,
    `Streams: ${streamList}.`,
    names.length > 0
      ? `If the item matches one of these known names, use that name verbatim: ${names}.`
      : "",
    `If you cannot identify the item or no stream clearly fits, use stream "needs_review".`,
    `Respond with ONLY a JSON object, no other text: {"item": "<short ${lang} item name>", "stream": "<stream id>", "confidence": <0..1>, "note": "<one short ${lang} handling note, optional>"}`,
  ]
    .filter(Boolean)
    .join("\n");
}

/** Tolerant JSON extraction + validation. Returns null when the response is
 *  unusable; an unknown stream degrades to needs_review rather than failing. */
export function parseVlmResponse(
  content: string,
  validStreamIds: Set<string>,
): VlmJudgment | null {
  // Thinking-mode models may prepend <think>…</think>; the braces inside
  // would corrupt extraction — use only what follows the reasoning block.
  const thinkClose = content.lastIndexOf("</think>");
  if (thinkClose !== -1) content = content.slice(thinkClose + "</think>".length);
  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(content.slice(start, end + 1));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;
  const itemName = typeof obj.item === "string" ? obj.item.trim() : "";
  if (!itemName) return null;
  const rawStream = typeof obj.stream === "string" ? obj.stream.trim() : "";
  const wasteStream = validStreamIds.has(rawStream) ? rawStream : "needs_review";
  const rawConf = typeof obj.confidence === "number" ? obj.confidence : 0;
  const confidence = Math.min(1, Math.max(0, rawConf));
  const reasoning = typeof obj.note === "string" && obj.note.trim().length > 0
    ? obj.note.trim()
    : undefined;
  return { itemName, wasteStream, confidence, reasoning };
}

/**
 * Ask the configured VLM to judge one JPEG crop (data URL). Returns null on
 * any failure — the caller keeps the needs_review card, never blocks on this.
 * "server" mode posts to the same-origin `/api/vlm` proxy; anything else
 * must be a loopback OpenAI-compatible endpoint.
 */
export async function judgeCropWithVlm(
  imageDataUrl: string,
  config: LocalVlmConfig,
  siteConfig: SiteConfig,
  locale: string,
  signal?: AbortSignal,
): Promise<VlmJudgment | null> {
  const mode = getVlmMode(config);
  if (mode === "server") {
    return judgeViaServerProxy(imageDataUrl, config, locale, signal);
  }
  if (mode === "browser") {
    // Fully in-page WebGPU model (worker) — nothing installed, nothing sent.
    const { judgeWithBrowserVlm, getBrowserVlmState } = await import("./vlm-browser");
    if (getBrowserVlmState() !== "ready") return null;
    const prompt = buildVlmPrompt(
      siteConfig.streams, siteConfig.canonicalNames ?? [], locale,
    );
    const text = await judgeWithBrowserVlm(
      imageDataUrl, prompt, config.timeoutMs ?? BROWSER_JUDGE_TIMEOUT_MS,
    );
    if (!text) return null;
    return parseVlmResponse(
      text, new Set(siteConfig.streams.map((s) => s.id as string)),
    );
  }
  if (mode !== "local") {
    console.warn("[vlm] endpoint rejected (loopback, \"server\", or \"browser\" only):", config.endpoint);
    return null;
  }

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
  const onOuterAbort = () => controller.abort();
  signal?.addEventListener("abort", onOuterAbort);

  try {
    const prompt = buildVlmPrompt(
      siteConfig.streams,
      siteConfig.canonicalNames ?? [],
      locale,
    );
    const res = await fetch(`${config.endpoint.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: config.model,
        temperature: 0,
        max_tokens: 200,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: prompt },
              { type: "image_url", image_url: { url: imageDataUrl } },
            ],
          },
        ],
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      console.warn(`[vlm] HTTP ${res.status} from local endpoint`);
      return null;
    }
    const data = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const content = data.choices?.[0]?.message?.content;
    if (!content) return null;
    return parseVlmResponse(
      content,
      new Set(siteConfig.streams.map((s) => s.id as string)),
    );
  } catch (err) {
    if (!(err instanceof DOMException && err.name === "AbortError")) {
      console.warn("[vlm] judgment failed:", err);
    }
    return null;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", onOuterAbort);
  }
}

// ── Browser-mode pure helpers (used by lib/vlm-browser.ts + its worker;
//    kept here so they are unit-testable without import.meta syntax) ──

/** Aggregate transformers.js per-file download progress into one gauge. */
export function aggregateProgress(
  files: Iterable<{ loaded: number; total: number }>,
): { fraction: number; loadedBytes: number; totalBytes: number } {
  let loadedBytes = 0;
  let totalBytes = 0;
  for (const f of files) {
    loadedBytes += f.loaded;
    totalBytes += f.total;
  }
  return {
    fraction: totalBytes > 0 ? Math.min(1, loadedBytes / totalBytes) : 0,
    loadedBytes,
    totalBytes,
  };
}

/** Extract the assistant's text from an image-text-to-text pipeline output.
 *  Tolerant across transformers.js output shapes: plain string, message
 *  arrays, and content-part arrays. Returns null when nothing usable. */
export function extractGeneratedText(output: unknown): string | null {
  const first = Array.isArray(output) ? output[0] : output;
  if (!first || typeof first !== "object") {
    return typeof first === "string" ? first : null;
  }
  const generated = (first as { generated_text?: unknown }).generated_text;
  if (typeof generated === "string") return generated;
  if (Array.isArray(generated)) {
    // Conversation form — the last message is the assistant's reply.
    const last = generated[generated.length - 1];
    const content =
      last && typeof last === "object"
        ? (last as { content?: unknown }).content
        : last;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      const text = content
        .map((part) =>
          part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"
            ? (part as { text: string }).text
            : "",
        )
        .join("");
      return text || null;
    }
  }
  return null;
}

/** "server" mode: same-origin proxy call. The server holds the real VLM
 *  endpoint in env vars (never in the client-readable site config), builds
 *  the same constrained prompt, re-checks the crop for faces, and returns a
 *  parsed judgment. */
async function judgeViaServerProxy(
  imageDataUrl: string,
  config: LocalVlmConfig,
  locale: string,
  signal?: AbortSignal,
): Promise<VlmJudgment | null> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
  const onOuterAbort = () => controller.abort();
  signal?.addEventListener("abort", onOuterAbort);
  try {
    const res = await fetch("/api/vlm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image: imageDataUrl, locale }),
      signal: controller.signal,
    });
    if (!res.ok) {
      console.warn(`[vlm] server proxy HTTP ${res.status}`);
      return null;
    }
    const data = (await res.json()) as { judgment?: VlmJudgment | null };
    return data.judgment ?? null;
  } catch (err) {
    if (!(err instanceof DOMException && err.name === "AbortError")) {
      console.warn("[vlm] server proxy failed:", err);
    }
    return null;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", onOuterAbort);
  }
}

/** Face gate for crops that will LEAVE the device ("server" mode): returns
 *  true when the crop contains a face — the caller must then skip the
 *  judgment entirely. Errors fail closed (treated as face present). */
export async function cropContainsFace(
  video: HTMLVideoElement,
  modelBbox: Bbox,
): Promise<boolean> {
  try {
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh) return true;
    const rect = modelBboxToVideoRect(modelBbox, vw, vh);
    const canvas = new OffscreenCanvas(rect.w, rect.h);
    const ctx = canvas.getContext("2d");
    if (!ctx) return true;
    ctx.drawImage(video, rect.x, rect.y, rect.w, rect.h, 0, 0, rect.w, rect.h);
    const { containsFace } = await import("./face-detect");
    return await containsFace(canvas);
  } catch {
    return true;
  }
}

/** Crop a track's region from the live video into a JPEG data URL (≤ maxSide). */
export async function cropTrackToDataUrl(
  video: HTMLVideoElement,
  modelBbox: Bbox,
  maxSide = 384,
): Promise<string | null> {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!vw || !vh) return null;
  const rect = modelBboxToVideoRect(modelBbox, vw, vh);
  const scale = Math.min(1, maxSide / Math.max(rect.w, rect.h));
  const cw = Math.max(1, Math.round(rect.w * scale));
  const ch = Math.max(1, Math.round(rect.h * scale));
  const canvas = new OffscreenCanvas(cw, ch);
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(video, rect.x, rect.y, rect.w, rect.h, 0, 0, cw, ch);
  const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.85 });
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result as string);
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(blob);
  });
}
