/**
 * Tests that OnnxBackend.init() loads the YOLO model correctly.
 */

// Track call order
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

describe("Model loading", () => {
  it("loads YOLO26m with init then warmup", async () => {
    const backend = await getInferenceBackend();

    expect(callOrder).toEqual([
      "yolo26m:init",
      "yolo26m:warmup",
    ]);
    expect(backend.isReady()).toBe(true);
  });

  it("returns false if YOLO26m fails", async () => {
    const yoloMod = await import("@/lib/yolo-inference");
    (yoloMod.initYolo as jest.Mock).mockImplementationOnce(async () => {
      callOrder.push("yolo26m:init");
      return false;
    });

    await getInferenceBackend();

    expect(callOrder).toEqual(["yolo26m:init"]);
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
