/**
 * On-device HTTP VLM adapter (Phase 1 candidate, dependency-free).
 *
 * Targets an OpenAI-compatible vision chat endpoint — the format served by
 * vLLM, Ollama, LM Studio, llama.cpp, etc. So the same code benchmarks any
 * locally-hosted VLM (Qwen2.5-VL recommended for its native JSON output).
 * This matches the repo's existing `HttpBackend` philosophy: a heavy model runs
 * on an on-device server, reached over localhost — images never leave the device.
 *
 * Runnable as soon as such a server is up; no new npm dependency. The image is
 * fetched and inlined as a base64 data URL, so the model server needs no access
 * to the blob store.
 */
import type { VlmAdapter, VlmClassification, VlmClassifyInput } from "../vlm-adapter";
import { buildVlmPrompt, parseStreamFromOutput } from "./prompt";

export interface QwenHttpOptions {
  /** OpenAI-compatible chat-completions URL, e.g. http://localhost:8000/v1/chat/completions */
  endpoint: string;
  /** Model name the server expects. Default "qwen2.5-vl". */
  model?: string;
  /** Bearer key for the model server, if it requires one. */
  apiKey?: string;
  /** Authorization header value for fetching private blob images (e.g. `Bearer <BLOB_READ_WRITE_TOKEN>`). */
  imageAuthHeader?: string;
  /** Injectable fetch (tests). Defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

interface ChatResponse {
  choices?: { message?: { content?: string } }[];
}

async function imageToDataUrl(
  url: string,
  fetchImpl: typeof fetch,
  authHeader?: string,
): Promise<string> {
  const res = await fetchImpl(url, authHeader ? { headers: { Authorization: authHeader } } : undefined);
  if (!res.ok) throw new Error(`image fetch failed: ${res.status}`);
  const contentType = res.headers?.get?.("content-type") || "image/jpeg";
  const base64 = Buffer.from(await res.arrayBuffer()).toString("base64");
  return `data:${contentType};base64,${base64}`;
}

export function makeQwenHttpAdapter(opts: QwenHttpOptions): VlmAdapter {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const model = opts.model ?? "qwen2.5-vl";

  return {
    name: `http:${model}`,
    async classify({ imageUrl, allowedStreams, sample }: VlmClassifyInput): Promise<VlmClassification> {
      const dataUrl = await imageToDataUrl(imageUrl, fetchImpl, opts.imageAuthHeader);
      const prompt = buildVlmPrompt(allowedStreams, sample);

      const res = await fetchImpl(opts.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(opts.apiKey ? { Authorization: `Bearer ${opts.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model,
          temperature: 0,
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: prompt },
                { type: "image_url", image_url: { url: dataUrl } },
              ],
            },
          ],
        }),
      });
      if (!res.ok) throw new Error(`model server error: ${res.status}`);

      const data = (await res.json()) as ChatResponse;
      const text = data.choices?.[0]?.message?.content ?? "";
      const stream = parseStreamFromOutput(text, allowedStreams);
      if (!stream) throw new Error(`could not parse a stream from model output: ${text.slice(0, 120)}`);
      return { stream, raw: text };
    },
  };
}
