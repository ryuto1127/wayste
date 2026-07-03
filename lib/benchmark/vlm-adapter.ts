/**
 * The pluggable seam between the benchmark harness and a concrete VLM.
 *
 * Phase 1 plugs candidate models in here (e.g. SmolVLM via transformers.js, or
 * Qwen2.5-VL via an on-device HTTP server / onnxruntime-node). The SAME
 * interface is intended to become the Tier-1.5 backend in Phase 2, so a model
 * that wins the benchmark can be promoted into the live path without a rewrite.
 *
 * Keep adapters dependency-light at the type level — concrete model deps live
 * in the adapter implementation files, never imported by app/client code.
 */
import type { EvalSample } from "./eval-set";

export interface VlmClassifyInput {
  imageUrl: string;
  /** The disposal streams valid for this site (constrains the VLM's output). */
  allowedStreams: string[];
  /** The full sample, for adapters that want YOLO hints, item name, etc. */
  sample: EvalSample;
}

export interface VlmClassification {
  /** Must be one of allowedStreams; harness treats anything else as a miss. */
  stream: string;
  /** Optional raw model text, for debugging / error analysis. */
  raw?: string;
}

export interface VlmAdapter {
  readonly name: string;
  classify(input: VlmClassifyInput): Promise<VlmClassification>;
}

/**
 * Deterministic stub adapter for harness unit tests — never touches a model.
 * `decide` maps a sample to a stream; defaults to echoing the predicted stream.
 */
export function makeStubAdapter(
  name = "stub",
  decide: (sample: EvalSample) => string = (s) => s.predictedStream,
): VlmAdapter {
  return {
    name,
    async classify({ sample }) {
      return { stream: decide(sample), raw: "stub" };
    },
  };
}
