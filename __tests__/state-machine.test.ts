/**
 * Tests for the state machine logic in KioskDisplay.
 *
 * The state machine runs inside a React component, so we test the transition
 * logic by extracting and simulating the rules used in KioskDisplay.tsx.
 */

import type { PipelineState, FrameAnalysis } from "@/lib/types";
import { ROI_FG_THRESHOLD, MOTION_RATIO_THRESHOLD } from "@/lib/frame-analyzer";

// Constants matching KioskDisplay.tsx
const FG_PERSIST_FRAMES = 4;
const OBJECT_DETECTED_TIMEOUT = 8;
const STABILITY_REQUIRED = 5;
const STABILIZING_MAX_FRAMES = 28;
const RESULT_TIMEOUT_MS = 10_000;
const OBJECT_GONE_FRAMES = 3;
const ROI_BLOB_THRESHOLD = 0.05;
const STABILIZE_MOTION_THRESHOLD = 0.06;
const COOLDOWN_MS = 2500;

function makeAnalysis(overrides: Partial<FrameAnalysis> = {}): FrameAnalysis {
  return {
    foregroundRatio: 0.2,
    roiForegroundRatio: 0.15,
    roiLargestBlobRatio: 0.1,
    motionScore: 0.02,
    skinRatio: 0.1,
    sharpnessScore: 500,
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
  stableCount = 0;
  stabilizingFrames = 0;
  resultEnterTime = 0;
  cooldownStart = 0;
  classifyTriggered = false;

  tick(analysis: FrameAnalysis): void {
    if (!analysis.isSettled) return;

    const roiHasFg =
      analysis.roiForegroundRatio >= ROI_FG_THRESHOLD &&
      analysis.roiLargestBlobRatio >= ROI_BLOB_THRESHOLD;
    const isStable = analysis.motionScore < MOTION_RATIO_THRESHOLD;

    if (this.state === "idle") {
      if (roiHasFg) {
        this.fgPersist++;
        if (this.fgPersist >= FG_PERSIST_FRAMES) {
          this.fgPersist = 0;
          this.stableCount = 0;
          this.goneCount = 0;
          this.objectDetectedFrames = 0;
          this.stabilizingFrames = 0;
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
      this.objectDetectedFrames++;

      if (isStable || this.objectDetectedFrames >= OBJECT_DETECTED_TIMEOUT) {
        this.stableCount = 0;
        this.objectDetectedFrames = 0;
        this.stabilizingFrames = 0;
        this.state = "stabilizing";
      }
      return;
    }

    if (this.state === "stabilizing") {
      if (!roiHasFg) {
        this.goneCount++;
        if (this.goneCount >= OBJECT_GONE_FRAMES) {
          this.stabilizingFrames = 0;
          this.state = "idle";
        }
        return;
      }
      this.goneCount = 0;
      this.stabilizingFrames++;

      const isQualityFrame =
        analysis.sharpnessScore > 150 &&
        analysis.skinRatio < 0.5 &&
        analysis.motionScore < STABILIZE_MOTION_THRESHOLD;
      if (isQualityFrame) {
        this.stableCount++;
      }

      if (
        this.stableCount >= STABILITY_REQUIRED ||
        this.stabilizingFrames >= STABILIZING_MAX_FRAMES
      ) {
        this.stabilizingFrames = 0;
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
  it("idle -> object_detected after OBJECT_DETECT_CONSECUTIVE_FRAMES", () => {
    const sim = new StateMachineSimulator();
    expect(sim.state).toBe("idle");

    const objectFrame = makeAnalysis();

    // Need FG_PERSIST_FRAMES (4) consecutive frames
    for (let i = 0; i < FG_PERSIST_FRAMES; i++) {
      sim.tick(objectFrame);
    }

    expect(sim.state).toBe("object_detected");
  });

  it("object_detected -> idle on timeout (OBJECT_DETECTED_TIMEOUT frames) when object disappears", () => {
    const sim = new StateMachineSimulator();
    sim.state = "object_detected";
    sim.objectDetectedFrames = 0;

    // Object disappears
    const emptyFrame = makeAnalysis({
      roiForegroundRatio: 0,
      roiLargestBlobRatio: 0,
    });

    for (let i = 0; i < OBJECT_GONE_FRAMES; i++) {
      sim.tick(emptyFrame);
    }

    expect(sim.state).toBe("idle");
  });

  it("stabilizing -> classifying after QUALITY_FRAMES_NEEDED good frames", () => {
    const sim = new StateMachineSimulator();
    sim.state = "stabilizing";
    sim.stableCount = 0;
    sim.stabilizingFrames = 0;

    const goodFrame = makeAnalysis({
      sharpnessScore: 500,
      skinRatio: 0.1,
      motionScore: 0.02,
    });

    for (let i = 0; i < STABILITY_REQUIRED; i++) {
      sim.tick(goodFrame);
    }

    expect(sim.state).toBe("classifying");
    expect(sim.classifyTriggered).toBe(true);
  });

  it("stabilizing -> classifying on escape hatch (STABILIZING_MAX_FRAMES)", () => {
    const sim = new StateMachineSimulator();
    sim.state = "stabilizing";
    sim.stableCount = 0;
    sim.stabilizingFrames = 0;

    // Poor quality frames that don't increment stableCount
    const poorFrame = makeAnalysis({
      sharpnessScore: 50,
      skinRatio: 0.6,
      motionScore: 0.1,
    });

    for (let i = 0; i < STABILIZING_MAX_FRAMES; i++) {
      sim.tick(poorFrame);
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

  it("result -> cooldown when object leaves", () => {
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
});
