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
const FG_TRIGGER_FRAMES = 2;
const FG_PERSIST_FRAMES = 2;
const RESULT_TIMEOUT_MS = 20_000;
const RESULT_GONE_FRAMES = 5;
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

// Simulate the state machine (matches KioskDisplay.tsx after object_detected removal)
class StateMachineSimulator {
  state: PipelineState = "idle";
  fgPersist = 0;
  goneCount = 0;
  resultEnterTime = 0;
  cooldownStart = 0;
  classifyTriggered = false;
  pendingItem = false;
  nothingDetectedCount = 0;
  tick(analysis: FrameAnalysis): void {
    if (!analysis.isSettled) return;

    const roiHasFg =
      analysis.roiForegroundRatio >= ROI_FG_THRESHOLD &&
      analysis.roiLargestBlobRatio >= ROI_BLOB_THRESHOLD;

    // Pending-item queue (non-idle states only)
    if (this.state !== "idle") {
      if (roiHasFg) {
        this.fgPersist++;
        if (this.fgPersist >= FG_PERSIST_FRAMES) {
          this.pendingItem = true;
          this.fgPersist = 0;
        }
      } else {
        this.fgPersist = 0;
      }
    }

    if (this.state === "idle") {
      // Simple FG trigger — no quality or stabilization gate.
      // YOLO handles its own quality; FG is just the "someone is approaching" signal.
      if (roiHasFg) {
        this.fgPersist++;
        if (this.fgPersist >= FG_TRIGGER_FRAMES) {
          this.fgPersist = 0;
          this.goneCount = 0;
          this.classifyTriggered = true;
          this.state = "classifying";
        }
      } else {
        this.fgPersist = 0;
        this.nothingDetectedCount = 0;
      }
      return;
    }

    if (this.state === "classifying") {
      // Handled externally (API timeout check)
      return;
    }

    if (this.state === "result") {
      if (!roiHasFg) {
        this.goneCount++;
        if (this.goneCount >= RESULT_GONE_FRAMES) {
          this.cooldownStart = Date.now();
          this.state = "cooldown";
        }
      } else {
        // Re-classify: item was gone for ≥2 frames and came back
        if (this.goneCount >= 2 && roiHasFg) {
          this.goneCount = 0;
          this.fgPersist = 0;
          this.classifyTriggered = true;
          this.state = "classifying";
          return;
        }
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
      const effectiveCooldown = this.nothingDetectedCount > 1
        ? Math.min(COOLDOWN_MS * this.nothingDetectedCount, 2_500)
        : COOLDOWN_MS;

      // Pending item: classify immediately if sharp, otherwise return to idle
      if (this.pendingItem) {
        this.pendingItem = false;
        this.fgPersist = 0;
        this.goneCount = 0;
        if (roiHasFg) {
          this.classifyTriggered = true;
          this.state = "classifying";
        } else {
          this.state = "idle";
        }
        return;
      }

      if (Date.now() - this.cooldownStart >= effectiveCooldown) {
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
  it("idle -> classifying after FG_TRIGGER_FRAMES of foreground", () => {
    const sim = new StateMachineSimulator();
    expect(sim.state).toBe("idle");

    const objectFrame = makeAnalysis();

    for (let i = 0; i < FG_TRIGGER_FRAMES; i++) {
      sim.tick(objectFrame);
    }

    expect(sim.state).toBe("classifying");
    expect(sim.classifyTriggered).toBe(true);
  });

  it("idle triggers regardless of image quality (YOLO handles quality)", () => {
    const sim = new StateMachineSimulator();
    const blurryFrame = makeAnalysis({ sharpnessScore: 50 });

    // Blurry frames with FG present — should still trigger (YOLO decides quality)
    for (let i = 0; i < FG_TRIGGER_FRAMES; i++) {
      sim.tick(blurryFrame);
    }

    expect(sim.state).toBe("classifying");
  });

  it("idle stays idle when object disappears mid-count", () => {
    const sim = new StateMachineSimulator();
    const objectFrame = makeAnalysis();
    const emptyFrame = makeAnalysis({
      roiForegroundRatio: 0,
      roiLargestBlobRatio: 0,
    });

    sim.tick(objectFrame); // fgPersist=1
    sim.tick(emptyFrame);  // gone, fgPersist=0

    expect(sim.state).toBe("idle");
    expect(sim.fgPersist).toBe(0);
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

  it("result -> cooldown when object leaves", () => {
    const sim = new StateMachineSimulator();
    sim.enterResult();

    const emptyFrame = makeAnalysis({
      roiForegroundRatio: 0,
      roiLargestBlobRatio: 0,
    });

    for (let i = 0; i < RESULT_GONE_FRAMES; i++) {
      sim.tick(emptyFrame);
    }

    expect(sim.state).toBe("cooldown");
  });

  it("result does NOT re-classify after only 1 frame of absence (flicker protection)", () => {
    const sim = new StateMachineSimulator();
    sim.enterResult();

    const emptyFrame = makeAnalysis({
      roiForegroundRatio: 0,
      roiLargestBlobRatio: 0,
    });
    const objectFrame = makeAnalysis();

    // 1 frame gone, then back — should NOT re-classify
    sim.tick(emptyFrame);
    expect(sim.goneCount).toBe(1);
    sim.tick(objectFrame);
    expect(sim.state).toBe("result");
    expect(sim.classifyTriggered).toBe(false);
  });

  it("result re-classifies after ≥2 frames of absence then return", () => {
    const sim = new StateMachineSimulator();
    sim.enterResult();

    const emptyFrame = makeAnalysis({
      roiForegroundRatio: 0,
      roiLargestBlobRatio: 0,
    });
    const objectFrame = makeAnalysis();

    // 2 frames gone, then back — should re-classify
    sim.tick(emptyFrame);
    sim.tick(emptyFrame);
    expect(sim.goneCount).toBe(2);
    sim.tick(objectFrame);
    expect(sim.state).toBe("classifying");
    expect(sim.classifyTriggered).toBe(true);
  });

  it("cooldown with pendingItem + sharp frame transitions to classifying", () => {
    const sim = new StateMachineSimulator();
    sim.state = "cooldown";
    sim.cooldownStart = Date.now(); // just started cooldown
    sim.pendingItem = true;

    const sharpFrame = makeAnalysis();
    sim.tick(sharpFrame);

    expect(sim.state).toBe("classifying");
    expect(sim.pendingItem).toBe(false);
  });

  it("cooldown with pendingItem + no FG transitions to idle", () => {
    const sim = new StateMachineSimulator();
    sim.state = "cooldown";
    sim.cooldownStart = Date.now();
    sim.pendingItem = true;

    const emptyFrame = makeAnalysis({ roiForegroundRatio: 0, roiLargestBlobRatio: 0 });
    sim.tick(emptyFrame);

    expect(sim.state).toBe("idle");
    expect(sim.pendingItem).toBe(false);
  });

  it("cooldown without pendingItem waits for COOLDOWN_MS", () => {
    const sim = new StateMachineSimulator();
    sim.state = "cooldown";
    sim.cooldownStart = Date.now();
    sim.pendingItem = false;

    // Use empty frame to avoid triggering pending-item queue during cooldown
    const emptyFrame = makeAnalysis({
      roiForegroundRatio: 0,
      roiLargestBlobRatio: 0,
    });
    sim.tick(emptyFrame);

    // Should still be in cooldown (time hasn't elapsed)
    expect(sim.state).toBe("cooldown");

    // Now simulate time passing
    sim.cooldownStart = Date.now() - COOLDOWN_MS - 1;
    sim.tick(emptyFrame);

    expect(sim.state).toBe("idle");
  });

  it("progressive cooldown increases with nothingDetectedCount", () => {
    const sim = new StateMachineSimulator();
    sim.state = "cooldown";
    sim.nothingDetectedCount = 3; // 3 consecutive nothing_detected
    sim.cooldownStart = Date.now() - COOLDOWN_MS - 1; // just past normal cooldown

    // Use empty frame to avoid triggering pending-item queue during cooldown
    const emptyFrame = makeAnalysis({
      roiForegroundRatio: 0,
      roiLargestBlobRatio: 0,
    });
    sim.tick(emptyFrame);

    // Normal cooldown (1500ms) has elapsed but effective cooldown is 3×1500=4500ms
    expect(sim.state).toBe("cooldown");

    // Simulate full effective cooldown elapsed
    sim.cooldownStart = Date.now() - 4500 - 1;
    sim.tick(emptyFrame);

    expect(sim.state).toBe("idle");
  });

  it("UI screen derivation: cooldown maps to idle screen", () => {
    // This tests the uiScreen derivation logic from KioskDisplay
    function deriveUiScreen(
      state: PipelineState,
    ): "idle" | "camera" | "result" {
      return state === "result"
        ? "result"
        : state === "classifying"
          ? "camera"
          : "idle";
    }

    expect(deriveUiScreen("idle")).toBe("idle");
    expect(deriveUiScreen("cooldown")).toBe("idle");
    expect(deriveUiScreen("classifying")).toBe("camera");
    expect(deriveUiScreen("result")).toBe("result");
  });
});
