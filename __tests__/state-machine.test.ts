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
const SHARP_FG_FRAMES_REQUIRED = 3;
const FG_SETTLE_THRESHOLD = 0.15;
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
  prevFgRatio = 0;

  tick(analysis: FrameAnalysis): void {
    if (!analysis.isSettled) return;

    const roiHasFg =
      analysis.roiForegroundRatio >= ROI_FG_THRESHOLD &&
      analysis.roiLargestBlobRatio >= ROI_BLOB_THRESHOLD;
    const isGood = analysis.sharpnessScore > 1500;

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
      const currFg = analysis.roiForegroundRatio;
      const prevFg = this.prevFgRatio;
      const fgDelta = prevFg > 0.001
        ? Math.abs(currFg - prevFg) / prevFg
        : (currFg > 0.001 ? 1 : 0);
      const sceneSettled = fgDelta < FG_SETTLE_THRESHOLD;
      this.prevFgRatio = currFg;

      if (roiHasFg && isGood && sceneSettled) {
        this.fgPersist++;
        if (this.fgPersist >= SHARP_FG_FRAMES_REQUIRED) {
          this.fgPersist = 0;
          this.goneCount = 0;
          this.classifyTriggered = true;
          this.state = "classifying";
        }
      } else if (roiHasFg) {
        // FG present but not settled or not sharp — reset count
        this.fgPersist = 0;
      } else {
        this.fgPersist = 0;
        this.prevFgRatio = 0;
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
        if (roiHasFg && isGood) {
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
  it("idle -> classifying after scene settled + SHARP_FG_FRAMES_REQUIRED", () => {
    const sim = new StateMachineSimulator();
    expect(sim.state).toBe("idle");

    const stableFrame = makeAnalysis(); // sharpness 2000, fgRatio 0.15

    // Frame 1: FG appears (prevFgRatio=0 → delta=1 → not settled) — no count
    sim.tick(stableFrame);
    expect(sim.state).toBe("idle");
    expect(sim.fgPersist).toBe(0);

    // Frames 2–4: FG stable (delta≈0 → settled) — counts 1,2,3 → trigger
    for (let i = 0; i < SHARP_FG_FRAMES_REQUIRED; i++) {
      sim.tick(stableFrame);
    }

    expect(sim.state).toBe("classifying");
    expect(sim.classifyTriggered).toBe(true);
  });

  it("idle defers trigger while FG area is growing (hand entering frame)", () => {
    const sim = new StateMachineSimulator();

    // Simulate hand entering: FG area grows each frame
    const growingFrames = [0.03, 0.06, 0.10, 0.15, 0.18].map(fg =>
      makeAnalysis({ roiForegroundRatio: fg, roiLargestBlobRatio: fg * 0.8 }),
    );

    for (const frame of growingFrames) {
      sim.tick(frame);
    }

    // Still idle — FG was growing rapidly each frame
    expect(sim.state).toBe("idle");
    expect(sim.fgPersist).toBe(0);

    // Now hand stops — stable FG
    const settled = makeAnalysis({ roiForegroundRatio: 0.18, roiLargestBlobRatio: 0.14 });
    for (let i = 0; i < SHARP_FG_FRAMES_REQUIRED; i++) {
      sim.tick(settled);
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

    // Seed prevFgRatio, then count 1 settled frame, then object disappears
    sim.tick(objectFrame); // delta=1, not settled
    sim.tick(objectFrame); // settled, fgPersist=1
    sim.tick(emptyFrame);  // gone

    expect(sim.state).toBe("idle");
    expect(sim.fgPersist).toBe(0);
  });

  it("idle ignores blurry frames for classification trigger", () => {
    const sim = new StateMachineSimulator();
    const blurryFrame = makeAnalysis({ sharpnessScore: 50 });

    // Many blurry frames — should NOT trigger classification (quality != good)
    for (let i = 0; i < 10; i++) {
      sim.tick(blurryFrame);
    }

    expect(sim.state).toBe("idle");
  });

  it("idle requires 'good' quality — 'fair' frames do not count", () => {
    const sim = new StateMachineSimulator();
    const fairFrame = makeAnalysis({ sharpnessScore: 1200 }); // fair, not good

    // Seed prevFgRatio
    sim.tick(fairFrame);
    // Fair frames: settled but not good quality — no count
    for (let i = 0; i < 10; i++) {
      sim.tick(fairFrame);
    }

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

  it("cooldown with pendingItem + blurry frame transitions to idle", () => {
    const sim = new StateMachineSimulator();
    sim.state = "cooldown";
    sim.cooldownStart = Date.now();
    sim.pendingItem = true;

    const blurryFrame = makeAnalysis({ sharpnessScore: 50 });
    sim.tick(blurryFrame);

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
    function deriveUiScreen(state: PipelineState): "idle" | "camera" | "result" {
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
