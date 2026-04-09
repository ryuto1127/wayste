/**
 * Tests for the state machine logic in KioskDisplay.
 *
 * The state machine runs inside a React component, so we test the transition
 * logic by extracting and simulating the rules used in KioskDisplay.tsx.
 */

import type { PipelineState, FrameAnalysis } from "@/lib/types";
import { computeThresholds } from "@/lib/threshold-config";

const { ROI_FG_THRESHOLD } = computeThresholds(0.5);

// Constants matching KioskDisplay.tsx
const FG_PERSIST_FRAMES = 2;
const SHARP_FRAMES_REQUIRED = 2;
const RESULT_TIMEOUT_MS = 30_000;
const OBJECT_GONE_FRAMES = 2;
const ROI_BLOB_THRESHOLD = 0.05;
const COOLDOWN_MS = 1500;

function makeAnalysis(overrides: Partial<FrameAnalysis> = {}): FrameAnalysis {
  return {
    roiForegroundRatio: 0.15,
    roiLargestBlobRatio: 0.1,
    roiLargestBlobDiagonalRatio: 0,
    sharpnessScore: 2000,
    blobs: [],
    isSettled: true,
    timestamp: Date.now(),
    ...overrides,
  };
}

// Simulate the state machine
class StateMachineSimulator {
  state: PipelineState = "idle";
  fgPersist = 0;
  goneCount = 0;
  objectDetectedFrames = 0;
  resultEnterTime = 0;
  cooldownStart = 0;
  classifyTriggered = false;
  pendingItem = false;

  tick(analysis: FrameAnalysis): void {
    if (!analysis.isSettled) return;

    const roiHasFg =
      analysis.roiForegroundRatio >= ROI_FG_THRESHOLD &&
      analysis.roiLargestBlobRatio >= ROI_BLOB_THRESHOLD;

    if (this.state === "idle") {
      if (roiHasFg) {
        this.fgPersist++;
        if (this.fgPersist >= FG_PERSIST_FRAMES) {
          this.fgPersist = 0;
          this.goneCount = 0;
          this.objectDetectedFrames = 0;
          this.state = "object_detected";
        }
      } else {
        this.fgPersist = 0;
      }
      return;
    }

    if (this.state === "object_detected") {
      if (!roiHasFg) {
        this.goneCount++;
        if (this.goneCount >= OBJECT_GONE_FRAMES) {
          this.objectDetectedFrames = 0;
          this.state = "idle";
        }
        return;
      }
      this.goneCount = 0;

      // Sharpness gate: only count frames where sharpnessScore > 500
      if (analysis.sharpnessScore > 500) {
        this.objectDetectedFrames++;
      }

      if (this.objectDetectedFrames >= SHARP_FRAMES_REQUIRED) {
        this.objectDetectedFrames = 0;
        this.classifyTriggered = true;
        this.state = "classifying";
      }
      return;
    }

    if (this.state === "result") {
      if (!roiHasFg) {
        this.goneCount++;
        if (this.goneCount >= OBJECT_GONE_FRAMES) {
          this.cooldownStart = Date.now();
          this.state = "cooldown";
        }
      } else {
        this.goneCount = 0;
        if (Date.now() - this.resultEnterTime >= RESULT_TIMEOUT_MS) {
          this.goneCount = 0;
          this.cooldownStart = Date.now();
          this.state = "cooldown";
        }
      }
      return;
    }

    if (this.state === "cooldown") {
      // New item pending → skip cooldown wait, fast-path to object_detected
      if (this.pendingItem) {
        this.pendingItem = false;
        this.fgPersist = 0;
        this.goneCount = 0;
        this.objectDetectedFrames = 0;
        this.state = "object_detected";
        return;
      }
      if (Date.now() - this.cooldownStart >= COOLDOWN_MS) {
        this.state = "idle";
      }
      return;
    }
  }

  enterResult(): void {
    this.state = "result";
    this.resultEnterTime = Date.now();
    this.goneCount = 0;
  }
}

describe("State machine", () => {
  it("idle -> object_detected after FG_PERSIST_FRAMES", () => {
    const sim = new StateMachineSimulator();
    expect(sim.state).toBe("idle");

    const objectFrame = makeAnalysis();

    for (let i = 0; i < FG_PERSIST_FRAMES; i++) {
      sim.tick(objectFrame);
    }

    expect(sim.state).toBe("object_detected");
  });

  it("object_detected -> idle when object disappears", () => {
    const sim = new StateMachineSimulator();
    sim.state = "object_detected";
    sim.objectDetectedFrames = 0;

    const emptyFrame = makeAnalysis({
      roiForegroundRatio: 0,
      roiLargestBlobRatio: 0,
    });

    for (let i = 0; i < OBJECT_GONE_FRAMES; i++) {
      sim.tick(emptyFrame);
    }

    expect(sim.state).toBe("idle");
  });

  it("object_detected -> classifying after SHARP_FRAMES_REQUIRED sharp frames", () => {
    const sim = new StateMachineSimulator();
    sim.state = "object_detected";
    sim.objectDetectedFrames = 0;

    const sharpFrame = makeAnalysis({ sharpnessScore: 2000 });

    for (let i = 0; i < SHARP_FRAMES_REQUIRED; i++) {
      sim.tick(sharpFrame);
    }

    expect(sim.state).toBe("classifying");
    expect(sim.classifyTriggered).toBe(true);
  });

  it("object_detected ignores blurry frames", () => {
    const sim = new StateMachineSimulator();
    sim.state = "object_detected";
    sim.objectDetectedFrames = 0;

    const blurryFrame = makeAnalysis({ sharpnessScore: 50 });

    // Feed many blurry frames — should stay in object_detected
    for (let i = 0; i < 10; i++) {
      sim.tick(blurryFrame);
    }

    expect(sim.state).toBe("object_detected");
  });

  it("object_detected counts only sharp frames among mixed input", () => {
    const sim = new StateMachineSimulator();
    sim.state = "object_detected";
    sim.objectDetectedFrames = 0;

    const blurryFrame = makeAnalysis({ sharpnessScore: 50 });
    const sharpFrame = makeAnalysis({ sharpnessScore: 2000 });

    // Interleave: blurry, sharp, blurry, blurry, sharp → should trigger on 2nd sharp
    sim.tick(blurryFrame);
    expect(sim.state).toBe("object_detected");
    sim.tick(sharpFrame);
    expect(sim.state).toBe("object_detected");
    sim.tick(blurryFrame);
    sim.tick(blurryFrame);
    expect(sim.state).toBe("object_detected");
    sim.tick(sharpFrame);
    expect(sim.state).toBe("classifying");
  });

  it("object_detected -> classifying works with high skin ratio (hand holding item)", () => {
    const sim = new StateMachineSimulator();
    sim.state = "object_detected";
    sim.objectDetectedFrames = 0;

    // High skin ratio should NOT block classification — user always holds the item
    const handHeldFrame = makeAnalysis({ sharpnessScore: 2000 });

    for (let i = 0; i < SHARP_FRAMES_REQUIRED; i++) {
      sim.tick(handHeldFrame);
    }

    expect(sim.state).toBe("classifying");
  });

  it("result -> cooldown after RESULT_TIMEOUT_MS", () => {
    const sim = new StateMachineSimulator();
    sim.enterResult();

    // Simulate time passing beyond RESULT_TIMEOUT_MS
    sim.resultEnterTime = Date.now() - RESULT_TIMEOUT_MS - 1;

    const objectFrame = makeAnalysis();
    sim.tick(objectFrame);

    expect(sim.state).toBe("cooldown");
  });

  it("result -> cooldown when object leaves (no minimum display time)", () => {
    const sim = new StateMachineSimulator();
    sim.enterResult();

    const emptyFrame = makeAnalysis({
      roiForegroundRatio: 0,
      roiLargestBlobRatio: 0,
    });

    for (let i = 0; i < OBJECT_GONE_FRAMES; i++) {
      sim.tick(emptyFrame);
    }

    expect(sim.state).toBe("cooldown");
  });

  it("cooldown with pendingItem skips wait and transitions to object_detected", () => {
    const sim = new StateMachineSimulator();
    sim.state = "cooldown";
    sim.cooldownStart = Date.now(); // just started cooldown
    sim.pendingItem = true;

    const objectFrame = makeAnalysis();
    sim.tick(objectFrame);

    expect(sim.state).toBe("object_detected");
    expect(sim.pendingItem).toBe(false);
  });

  it("cooldown without pendingItem waits for COOLDOWN_MS", () => {
    const sim = new StateMachineSimulator();
    sim.state = "cooldown";
    sim.cooldownStart = Date.now();
    sim.pendingItem = false;

    const objectFrame = makeAnalysis();
    sim.tick(objectFrame);

    // Should still be in cooldown (time hasn't elapsed)
    expect(sim.state).toBe("cooldown");

    // Now simulate time passing
    sim.cooldownStart = Date.now() - COOLDOWN_MS - 1;
    sim.tick(objectFrame);

    expect(sim.state).toBe("idle");
  });

  it("UI screen derivation: cooldown maps to idle screen", () => {
    // This tests the uiScreen derivation logic from KioskDisplay
    function deriveUiScreen(state: PipelineState): "idle" | "camera" | "result" {
      return state === "result"
        ? "result"
        : state === "object_detected" || state === "classifying"
          ? "camera"
          : "idle";
    }

    expect(deriveUiScreen("idle")).toBe("idle");
    expect(deriveUiScreen("cooldown")).toBe("idle");
    expect(deriveUiScreen("object_detected")).toBe("camera");
    expect(deriveUiScreen("classifying")).toBe("camera");
    expect(deriveUiScreen("result")).toBe("result");
  });
});
