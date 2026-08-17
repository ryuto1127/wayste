/**
 * Web Worker for the in-browser VLM ("browser" mode of Tier 1.5).
 *
 * Runs the whole vision-language model inside the page via transformers.js
 * + WebGPU — nothing installed on the machine, nothing sent anywhere. The
 * worker keeps token generation off the main thread so the 30fps detection
 * overlay never stutters while a judgment is running.
 *
 * API follows the official onnx-community/Qwen3.5-0.8B-ONNX model-card
 * snippet (AutoProcessor + Qwen3_5ForConditionalGeneration + RawImage,
 * per-component dtype, 448×448 input). Non-Qwen3.5 model ids fall back to
 * AutoModelForVision2Seq so the model stays swappable via site config.
 *
 * Protocol (postMessage):
 *   in:  {type:"init", modelId, dtype?} | {type:"judge", id, image, prompt}
 *   out: {type:"progress", file, loaded, total}
 *        {type:"ready"} | {type:"init-error", error}
 *        {type:"result", id, text|null, error?}
 */

import {
  AutoProcessor,
  AutoModelForVision2Seq,
  Qwen3_5ForConditionalGeneration,
  RawImage,
} from "@huggingface/transformers";

/** Chat-template text with thinking DISABLED — Qwen3.5 defaults to a
 *  "thinking" preamble that burns seconds and the whole token budget
 *  before any JSON appears. Falls back for templates without the flag. */
function chatText(proc: { apply_chat_template: (c: unknown, o: unknown) => string }, conversation: unknown): string {
  try {
    return proc.apply_chat_template(conversation, {
      add_generation_prompt: true,
      enable_thinking: false,
    });
  } catch {
    return proc.apply_chat_template(conversation, { add_generation_prompt: true });
  }
}

type InMessage =
  | { type: "init"; modelId: string; dtype?: string }
  | { type: "judge"; id: number; image: string; prompt: string; maxNewTokens?: number };

const post = (m: unknown) =>
  (self as unknown as { postMessage(x: unknown): void }).postMessage(m);

// transformers.js types vary between minor versions — the processor/model
// pair is used exactly as in the official model-card snippet, so loose
// typing here is contained and intentional.
/* eslint-disable @typescript-eslint/no-explicit-any */
let processor: any = null;
let model: any = null;

/** Official recommended per-component quantization for Qwen3.5 ONNX. */
const QWEN35_DTYPE = {
  embed_tokens: "q4",
  vision_encoder: "fp16",
  decoder_model_merged: "q4",
};

async function handleInit(msg: Extract<InMessage, { type: "init" }>) {
  try {
    const progress_callback = (p: {
      status: string;
      file?: string;
      loaded?: number;
      total?: number;
    }) => {
      if (p.status === "initiate" || p.status === "progress" || p.status === "done") {
        post({
          type: "progress",
          file: p.file ?? "",
          loaded: p.loaded ?? (p.status === "done" ? p.total ?? 0 : 0),
          total: p.total ?? 0,
        });
      }
    };

    processor = await AutoProcessor.from_pretrained(msg.modelId, { progress_callback } as any);
    const isQwen35 = /qwen3[._-]?5/i.test(msg.modelId);
    const ModelClass: any = isQwen35
      ? Qwen3_5ForConditionalGeneration
      : AutoModelForVision2Seq;
    model = await ModelClass.from_pretrained(msg.modelId, {
      dtype: msg.dtype ?? (isQwen35 ? QWEN35_DTYPE : "q4"),
      device: "webgpu",
      progress_callback,
    });

    // Warmup: the FIRST generate pays WebGPU shader compilation (can be
    // 10s+). Run a throwaway judgment on a tiny gray image now, while the
    // gauge still shows "loading to GPU" — so "ready" means actually fast.
    try {
      const warm = new RawImage(new Uint8ClampedArray(64 * 64 * 3).fill(114), 64, 64, 3);
      const conv = [
        { role: "user", content: [{ type: "image" }, { type: "text", text: "ok" }] },
      ];
      const inputs = await processor(chatText(processor, conv), warm);
      await model.generate({ ...inputs, max_new_tokens: 2, do_sample: false });
    } catch (err) {
      console.warn("[vlm-worker] warmup failed (non-fatal):", err);
    }

    post({ type: "ready" });
  } catch (err) {
    post({ type: "init-error", error: String(err) });
  }
}

async function handleJudge(msg: Extract<InMessage, { type: "judge" }>) {
  try {
    if (!processor || !model) throw new Error("model not ready");
    const image = await (await RawImage.read(msg.image)).resize(448, 448);
    const conversation = [
      {
        role: "user",
        content: [
          { type: "image" },
          { type: "text", text: msg.prompt },
        ],
      },
    ];
    const text = chatText(processor, conversation);
    const inputs = await processor(text, image);
    const outputs = await model.generate({
      ...inputs,
      // The answer is one short JSON object (~40 tokens). Generation is
      // sequential, so every unused token in this budget is latency the
      // user waits through when the model rambles before stopping.
      max_new_tokens: msg.maxNewTokens ?? 96,
      do_sample: false,
    });
    const decoded = processor.batch_decode(
      outputs.slice(null, [inputs.input_ids.dims.at(-1), null]),
      { skip_special_tokens: true },
    );
    post({ type: "result", id: msg.id, text: decoded?.[0] ?? null });
  } catch (err) {
    post({ type: "result", id: msg.id, text: null, error: String(err) });
  }
}

self.addEventListener("message", (event) => {
  const msg = (event as MessageEvent).data as InMessage;
  if (msg.type === "init") void handleInit(msg);
  else if (msg.type === "judge") void handleJudge(msg);
});
