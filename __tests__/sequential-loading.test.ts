/**
 * Tests that OnnxBackend.init() loads models sequentially:
 * YOLO26m init → YOLO26m warmup → YOLO World init → YOLO World warmup
 *
 * Verifies no parallel/fire-and-forget loading occurs.
 */

// Track call order across both mocked modules
const callOrder: string[] = [];

// ── Mock yolo-inference ──
jest.mock("@/lib/yolo-inference", () => ({
  initYolo: jest.fn(async () => {
    callOrder.push("yolo26m:init");
    return true;
  }),
  warmUpYolo: jest.fn(async () => {
    callOrder.push("yolo26m:warmup");
  }),
  isYoloReady: jest.fn(() => true),
  getYoloProvider: jest.fn(() => "wasm"),
  runYoloInference: jest.fn(async () => []),
}));

// ── Mock yolo-world-inference ──
jest.mock("@/lib/yolo-world-inference", () => ({
  initYoloWorld: jest.fn(async () => {
    callOrder.push("yoloWorld:init");
    return true;
  }),
  warmUpYoloWorld: jest.fn(async () => {
    callOrder.push("yoloWorld:warmup");
  }),
  isYoloWorldReady: jest.fn(() => true),
  runYoloWorldInference: jest.fn(async () => []),
}));

import {
  getInferenceBackend,
  resetInferenceBackend,
  subscribeSystemStatus,
  type SystemStatus,
} from "@/lib/inference-backend";

beforeEach(() => {
  callOrder.length = 0;
  resetInferenceBackend();
});

describe("Sequential model loading", () => {
  it("loads YOLO26m before YOLO World, strictly sequential", async () => {
    const backend = await getInferenceBackend();

    expect(callOrder).toEqual([
      "yolo26m:init",
      "yolo26m:warmup",
      "yoloWorld:init",
      "yoloWorld:warmup",
    ]);
    expect(backend.isReady()).toBe(true);
    expect(backend.isYoloWorldReady()).toBe(true);
  });

  it("returns false immediately if YOLO26m fails (skips World)", async () => {
    const yoloMod = await import("@/lib/yolo-inference");
    (yoloMod.initYolo as jest.Mock).mockImplementationOnce(async () => {
      callOrder.push("yolo26m:init");
      return false;
    });

    const backend = await getInferenceBackend();

    expect(callOrder).toEqual(["yolo26m:init"]);
    // YOLO World never attempted — no point loading Tier 2 without Tier 1
    expect(callOrder).not.toContain("yoloWorld:init");
  });

  it("returns true with warning if YOLO World fails", async () => {
    const worldMod = await import("@/lib/yolo-world-inference");
    (worldMod.initYoloWorld as jest.Mock).mockImplementationOnce(async () => {
      callOrder.push("yoloWorld:init");
      return false;
    });
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});

    const backend = await getInferenceBackend();

    expect(callOrder).toEqual([
      "yolo26m:init",
      "yolo26m:warmup",
      "yoloWorld:init",
    ]);
    expect(backend.isReady()).toBe(true);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("YOLO World unavailable")
    );
    warnSpy.mockRestore();
  });

  it("sets overallReady only after YOLO26m is ready", async () => {
    const statusUpdates: SystemStatus[] = [];
    const unsub = subscribeSystemStatus((s) => {
      statusUpdates.push({ ...s });
    });

    await getInferenceBackend();
    unsub();

    // First status emission (subscribe immediate) should have overallReady false
    expect(statusUpdates[0].overallReady).toBe(false);
    // After YOLO26m warmup, overallReady should become true
    const readyUpdate = statusUpdates.find((s) => s.overallReady);
    expect(readyUpdate).toBeDefined();
    expect(readyUpdate!.yolo26m).toBe("ready");
  });
});
