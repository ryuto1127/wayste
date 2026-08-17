/**
 * Tests for YOLO → waste stream resolution (Tier 1).
 *
 * Verifies that:
 * 1. YOLO 15-class detections resolve to the correct waste stream
 * 2. Unknown classes return null (trigger API fallback)
 * 3. Site overrides are applied on top of YOLO rules
 * 4. modelUsed is correctly tagged
 */

import {
  resolveYoloDetection,
  _setRulesCache,
} from "@/lib/yolo-rules";
import type { SiteConfig, YoloDetection, YoloRulesConfig } from "@/lib/types";
import * as fs from "fs";
import * as path from "path";

// ── Load real rules JSON files ──
const yoloRules: YoloRulesConfig = JSON.parse(
  fs.readFileSync(path.join(__dirname, "../public/models/yolo-rules.json"), "utf8")
);

// ── Helpers ──
function makeSiteConfig(overrides: Partial<SiteConfig> = {}): SiteConfig {
  return {
    siteId: "test",
    siteName: "Test Site",
    streams: [
      { id: "burnable", label: "可燃ゴミ", color: "#EF4444", description: "" },
      { id: "non-burnable", label: "不燃ゴミ", color: "#6B7280", description: "" },
      { id: "recyclable", label: "資源ゴミ", color: "#3B82F6", description: "" },
      { id: "plastic", label: "プラスチック", color: "#F59E0B", description: "" },
      { id: "special", label: "特別収集", color: "#7C3AED", description: "" },
      { id: "needs_review", label: "確認が必要", color: "#D97706", description: "" },
    ],
    overrides: [],
    defaultStream: "burnable",
    ...overrides,
  };
}

function makeDetection(className: string, confidence = 0.85): YoloDetection {
  return {
    classId: 0,
    className,
    confidence,
    bbox: [100, 100, 200, 200],
  };
}

// ── Setup: inject real rules ──
beforeAll(() => {
  _setRulesCache(yoloRules);
});

afterAll(() => {
  _setRulesCache(null);
});

// ═══════════════════════════════════════════════════════════════════
// Tier 1: YOLO demo model (5 classes) → waste stream
// The deployed model is the few-class demo build; the 15-class rules are
// preserved at public/models/yolo-rules.15class.json for the older model.
// ═══════════════════════════════════════════════════════════════════

describe("Tier 1: YOLO demo detection → waste stream", () => {
  const config = makeSiteConfig();

  describe("recyclable items", () => {
    it.each([
      ["plastic_bottle", "recyclable"],
      ["can", "recyclable"],
    ])("%s → %s", (className, expectedStream) => {
      const result = resolveYoloDetection(makeDetection(className), config);
      expect(result).not.toBeNull();
      expect(result!.wasteStream).toBe(expectedStream);
      expect(result!.modelUsed).toBe("T1");
    });
  });

  describe("plastic items", () => {
    it.each([
      ["plastic_cup", "plastic"],
    ])("%s → %s", (className, expectedStream) => {
      const result = resolveYoloDetection(makeDetection(className), config);
      expect(result).not.toBeNull();
      expect(result!.wasteStream).toBe(expectedStream);
    });
  });

  describe("burnable items", () => {
    it.each([
      ["paper_cup", "burnable"],
    ])("%s → %s", (className, expectedStream) => {
      const result = resolveYoloDetection(makeDetection(className), config);
      expect(result).not.toBeNull();
      expect(result!.wasteStream).toBe(expectedStream);
    });
  });

  describe("special disposal items", () => {
    it("battery → special", () => {
      const result = resolveYoloDetection(makeDetection("battery"), config);
      expect(result).not.toBeNull();
      expect(result!.wasteStream).toBe("special");
    });
  });

  it("includes preAction when defined in rules", () => {
    const result = resolveYoloDetection(makeDetection("plastic_bottle", 0.85), config);
    expect(result).not.toBeNull();
    expect(result!.preAction).toBe("Empty, rinse, remove cap and label");
  });

  it("preserves detection confidence in result", () => {
    const result = resolveYoloDetection(makeDetection("can", 0.75), config);
    expect(result).not.toBeNull();
    expect(result!.confidence).toBe(0.75);
  });

  it("returns null for unknown class names", () => {
    const result = resolveYoloDetection(makeDetection("spaceship"), config);
    expect(result).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════
// Site overrides applied on top of YOLO rules
// ═══════════════════════════════════════════════════════════════════

describe("Site overrides applied to YOLO results", () => {
  it("site override changes paper_cup from burnable to non-burnable", () => {
    const config = makeSiteConfig({
      overrides: [{ pattern: "Paper Cup", stream: "non-burnable", note: "Paper cup override test" }],
    });

    const result = resolveYoloDetection(makeDetection("paper_cup"), config);
    expect(result).not.toBeNull();
    expect(result!.wasteStream).toBe("non-burnable");
  });
});

// ═══════════════════════════════════════════════════════════════════
// Rules JSON integrity
// ═══════════════════════════════════════════════════════════════════

describe("Rules JSON integrity", () => {
  it("rules cover exactly the deployed model's classes", () => {
    // The real invariant: a class the model emits with no rule silently
    // degrades to needs_review, and a rule for a class the model never
    // emits is dead config. Both directions must match.
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { WASTE_CLASSES } = require("@/lib/yolo-inference");
    /* eslint-enable @typescript-eslint/no-require-imports */
    expect(Object.keys(yoloRules.rules).sort()).toEqual([...WASTE_CLASSES].sort());
  });

  it("every YOLO rule has required fields", () => {
    for (const [, rule] of Object.entries(yoloRules.rules)) {
      expect(rule.itemName).toBeTruthy();
      expect(rule.wasteStream).toBeTruthy();
      expect(rule.reasoning).toBeTruthy();
    }
  });

  it("all waste streams in rules are valid", () => {
    const validStreams = new Set(["burnable", "non-burnable", "recyclable", "plastic", "special", "needs_review", "not_waste"]);
    for (const rule of Object.values(yoloRules.rules)) {
      expect(validStreams.has(rule.wasteStream)).toBe(true);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════
// Tiered fallback thresholds
// ═══════════════════════════════════════════════════════════════════

describe("Tiered fallback thresholds", () => {
  it("YOLO_FALLBACK_THRESHOLD is correctly exported", () => {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const {
      YOLO_FALLBACK_THRESHOLD,
    } = require("@/lib/inference-backend");
    /* eslint-enable @typescript-eslint/no-require-imports */

    // Default sensitivity (0.5): lerp(0.80, 0.65, 0.5) = 0.725
    expect(YOLO_FALLBACK_THRESHOLD).toBeCloseTo(0.725, 4);
  });
});
