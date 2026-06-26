/**
 * Cloud-vs-local shadow comparison (pilot mechanism).
 *
 * During a pilot we want to know how a local/candidate VLM would have classified
 * the SAME frame the cloud GPT just handled — without manual pre-labelling. When
 * `LOCAL_VLM_ENDPOINT` is set, the classify route calls this on the escalated
 * frame (server-side, inside the existing background logging so it never delays
 * the kiosk response) and records the result as `localModel` on the pilot-log
 * entry. Disabled by default → zero effect on normal operation.
 *
 * Deployment-agnostic by design: this server-side producer is the pragmatic way
 * to gather comparison data during the experiment. The pilot-log `localModel`
 * field is just "a local model's prediction", so when the VLM later moves
 * on-device (browser/WebGPU) the same field and comparison views still apply —
 * the privacy end-state (images never leave the device) is not foreclosed.
 *
 * The endpoint is any OpenAI-compatible vision chat server (vLLM / Ollama /
 * LM Studio / llama.cpp), so any locally-hosted VLM can be the candidate.
 */
import type { LocalModelPrediction } from "@/lib/types";
import { buildVlmPrompt, parseStreamFromOutput } from "@/lib/benchmark/adapters/prompt";

export function isShadowEnabled(): boolean {
  return !!process.env.LOCAL_VLM_ENDPOINT;
}

export interface ShadowInput {
  /** Base64 JPEG (same image sent to the cloud model). */
  imageBase64: string;
  /** Disposal stream ids the model may choose from. */
  allowedStreams: string[];
  /** The cloud model's chosen stream, for the agreement flag. */
  cloudStream: string;
  yoloCandidates?: { itemName: string; confidence: number }[];
  /** Injectable fetch + clock for tests. */
  fetchImpl?: typeof fetch;
  now?: () => number;
}

interface ChatResponse {
  choices?: { message?: { content?: string } }[];
}

/**
 * Run the local VLM on a frame. Returns null when shadow mode is disabled.
 * Never throws — failures resolve to a `localModel` carrying an `error` so the
 * surrounding pilot-log write is unaffected.
 */
export async function runLocalVlmShadow(input: ShadowInput): Promise<LocalModelPrediction | null> {
  const endpoint = process.env.LOCAL_VLM_ENDPOINT;
  if (!endpoint) return null;

  const model = process.env.LOCAL_VLM_MODEL ?? "qwen2.5-vl";
  const apiKey = process.env.LOCAL_VLM_API_KEY;
  const fetchImpl = input.fetchImpl ?? fetch;
  const now = input.now ?? Date.now;
  const start = now();

  try {
    const prompt = buildVlmPrompt(input.allowedStreams, { yoloCandidates: input.yoloCandidates });
    const res = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: prompt },
              { type: "image_url", image_url: { url: `data:image/jpeg;base64,${input.imageBase64}` } },
            ],
          },
        ],
      }),
    });
    if (!res.ok) throw new Error(`model server status ${res.status}`);

    const data = (await res.json()) as ChatResponse;
    const text = data.choices?.[0]?.message?.content ?? "";
    const stream = parseStreamFromOutput(text, input.allowedStreams);
    const latencyMs = now() - start;

    if (!stream) {
      return { model, wasteStream: "", latencyMs, agreesWithCloud: false, error: "unparseable output" };
    }
    return { model, wasteStream: stream, latencyMs, agreesWithCloud: stream === input.cloudStream };
  } catch (err) {
    return {
      model,
      wasteStream: "",
      latencyMs: now() - start,
      agreesWithCloud: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
