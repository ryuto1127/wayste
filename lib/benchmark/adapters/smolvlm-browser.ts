/**
 * In-browser / transformers.js VLM adapter (Phase 1 candidate).
 *
 * The purest-privacy / zero-infra deployment: the model runs in the browser via
 * WebGPU (or in Node with the same package), so images never leave the device
 * and there is no server to host. Good fit for SmolVLM-256M/500M or FastVLM.
 *
 * Dependency is loaded ONLY when this adapter runs — we intentionally do NOT add
 * `@huggingface/transformers` to package.json (Phase 1 hasn't picked a model;
 * adding a large dep speculatively is premature). To use this adapter:
 *
 *     npm i @huggingface/transformers
 *
 * The dynamic import uses a variable specifier so the project still type-checks
 * and builds without the package installed. The exact pipeline call may need a
 * tweak for the installed transformers.js version — this is a scaffold.
 */
import type { VlmAdapter, VlmClassification, VlmClassifyInput } from "../vlm-adapter";
import { buildVlmPrompt, parseStreamFromOutput } from "./prompt";

const TRANSFORMERS_PKG = "@huggingface/transformers";

type GenerationPipeline = (input: unknown, opts?: Record<string, unknown>) => Promise<unknown>;
interface TransformersModule {
  pipeline(task: string, model?: string, opts?: Record<string, unknown>): Promise<GenerationPipeline>;
}

export interface SmolVlmOptions {
  /** HF model id. Default a small SmolVLM instruct checkpoint. */
  model?: string;
  /** "webgpu" (browser/GPU) or "wasm" (CPU fallback). Default "webgpu". */
  device?: "webgpu" | "wasm";
  maxNewTokens?: number;
}

/** Pull readable text out of transformers.js generation output (shape varies by version). */
function extractText(out: unknown): string {
  if (typeof out === "string") return out;
  if (Array.isArray(out) && out.length > 0) return extractText(out[0]);
  if (out && typeof out === "object") {
    const o = out as Record<string, unknown>;
    if (typeof o.generated_text === "string") return o.generated_text;
    if (Array.isArray(o.generated_text)) return extractText(o.generated_text.at(-1));
  }
  return JSON.stringify(out);
}

export function makeSmolVlmAdapter(opts: SmolVlmOptions = {}): VlmAdapter {
  const model = opts.model ?? "HuggingFaceTB/SmolVLM-500M-Instruct";
  const device = opts.device ?? "webgpu";
  const maxNewTokens = opts.maxNewTokens ?? 64;

  let pipePromise: Promise<GenerationPipeline> | null = null;
  const getPipe = async (): Promise<GenerationPipeline> => {
    if (!pipePromise) {
      const mod = (await import(/* webpackIgnore: true */ TRANSFORMERS_PKG)) as unknown as TransformersModule;
      pipePromise = mod.pipeline("image-text-to-text", model, { device });
    }
    return pipePromise;
  };

  return {
    name: `transformers:${model}`,
    async classify({ imageUrl, allowedStreams, sample }: VlmClassifyInput): Promise<VlmClassification> {
      const pipe = await getPipe();
      const prompt = buildVlmPrompt(allowedStreams, sample);
      const messages = [
        { role: "user", content: [{ type: "image", image: imageUrl }, { type: "text", text: prompt }] },
      ];
      const out = await pipe(messages, { max_new_tokens: maxNewTokens, do_sample: false });
      const text = extractText(out);
      const stream = parseStreamFromOutput(text, allowedStreams);
      if (!stream) throw new Error(`could not parse a stream from model output: ${text.slice(0, 120)}`);
      return { stream, raw: text };
    },
  };
}
