/**
 * Main-thread manager for the in-browser VLM ("browser" mode of Tier 1.5).
 *
 * Owns the worker lifecycle, aggregates model-download progress for the
 * kiosk's gauge, and provides a promise-based judge API. Perceived-wait
 * design: `initBrowserVlm` is called the moment site config arrives — the
 * download overlaps camera aiming and model warmup, so by the time the
 * operator presses start most (often all) of it is already cached. The
 * browser Cache API keeps the weights, so every later launch is instant.
 *
 * Nothing here blocks the detection pipeline: while the model is not ready,
 * judgments simply return null and needs_review stays the honest answer.
 */

import { aggregateProgress } from "./vlm-client";

export type BrowserVlmState = "idle" | "preparing" | "ready" | "error";

export interface BrowserVlmProgress {
  state: BrowserVlmState;
  /** 0–1 aggregate over all model files (stays ~1 during GPU load). */
  fraction: number;
  loadedBytes: number;
  totalBytes: number;
}

let worker: Worker | null = null;
let state: BrowserVlmState = "idle";
const files = new Map<string, { loaded: number; total: number }>();
const listeners = new Set<(p: BrowserVlmProgress) => void>();
const pending = new Map<number, { resolve: (text: string | null) => void; timer: ReturnType<typeof setTimeout> }>();
let nextRequestId = 1;

function snapshot(): BrowserVlmProgress {
  return { state, ...aggregateProgress(files.values()) };
}

function emit() {
  const p = snapshot();
  for (const fn of listeners) fn(p);
}

export function getBrowserVlmState(): BrowserVlmState {
  return state;
}

/** Subscribe to progress/state changes. Fires immediately with the current
 *  snapshot; returns an unsubscribe function. */
export function subscribeBrowserVlm(fn: (p: BrowserVlmProgress) => void): () => void {
  listeners.add(fn);
  fn(snapshot());
  return () => {
    listeners.delete(fn);
  };
}

/**
 * Start loading the model (idempotent). Call as early as possible — the
 * download runs in parallel with everything else the kiosk boots.
 */
export function initBrowserVlm(modelId: string, dtype?: string): void {
  if (worker || typeof window === "undefined") return;
  if (!("gpu" in navigator)) {
    console.warn("[vlm-browser] WebGPU unavailable — browser VLM disabled");
    state = "error";
    emit();
    return;
  }
  try {
    worker = new Worker(new URL("./vlm-browser.worker.ts", import.meta.url), {
      type: "module",
    });
  } catch (err) {
    console.warn("[vlm-browser] worker creation failed:", err);
    state = "error";
    emit();
    return;
  }

  state = "preparing";
  worker.onmessage = (e: MessageEvent) => {
    const msg = e.data as
      | { type: "progress"; file: string; loaded: number; total: number }
      | { type: "ready" }
      | { type: "init-error"; error: string }
      | { type: "result"; id: number; text: string | null; error?: string };
    if (msg.type === "progress") {
      if (msg.file) files.set(msg.file, { loaded: msg.loaded, total: msg.total });
      emit();
    } else if (msg.type === "ready") {
      state = "ready";
      console.log("[vlm-browser] model ready");
      emit();
    } else if (msg.type === "init-error") {
      state = "error";
      console.warn("[vlm-browser] model load failed:", msg.error);
      emit();
    } else if (msg.type === "result") {
      const req = pending.get(msg.id);
      if (req) {
        pending.delete(msg.id);
        clearTimeout(req.timer);
        if (msg.error) console.warn("[vlm-browser] judge error:", msg.error);
        req.resolve(msg.text);
      }
    }
  };
  worker.onerror = (err) => {
    console.warn("[vlm-browser] worker error:", err.message);
    state = "error";
    emit();
  };
  worker.postMessage({ type: "init", modelId, dtype });
  emit();
}

/** Ask the in-browser model to judge one JPEG crop. Resolves null on
 *  timeout, failure, or when the model isn't ready. */
export function judgeWithBrowserVlm(
  imageDataUrl: string,
  prompt: string,
  timeoutMs = 30_000,
): Promise<string | null> {
  if (!worker || state !== "ready") return Promise.resolve(null);
  const id = nextRequestId++;
  return new Promise<string | null>((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      console.warn(`[vlm-browser] judgment ${id} timed out`);
      resolve(null);
    }, timeoutMs);
    pending.set(id, { resolve, timer });
    worker!.postMessage({ type: "judge", id, image: imageDataUrl, prompt });
  });
}
