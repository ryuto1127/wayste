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
// Tier 1: YOLO 15-class custom model → waste stream
// ═══════════════════════════════════════════════════════════════════

describe("Tier 1: YOLO 15-class detection → waste stream", () => {
  const config = makeSiteConfig();

  describe("recyclable items", () => {
    it.each([
      ["plastic_bottle", "recyclable"],
      ["can", "recyclable"],
      ["glass_bottle", "recyclable"],
      ["cardboard", "recyclable"],
      ["paper", "recyclable"],
      ["paper_bag", "recyclable"],
      ["tetra_pak", "recyclable"],
    ])("%s → %s", (className, expectedStream) => {
      const result = resolveYoloDetection(makeDetection(className), config);
      expect(result).not.toBeNull();
      expect(result!.wasteStream).toBe(expectedStream);
      expect(result!.modelUsed).toBe("T1");
    });
  });

  describe("plastic items", () => {
    it.each([
      ["plastic_bottle_cap", "plastic"],
      ["plastic_bottle_label", "plastic"],
      ["plastic_cup", "plastic"],
      ["plastic_bag", "plastic"],
      ["styrofoam", "plastic"],
    ])("%s → %s", (className, expectedStream) => {
      const result = resolveYoloDetection(makeDetection(className), config);
      expect(result).not.toBeNull();
      expect(result!.wasteStream).toBe(expectedStream);
    });
  });

  describe("burnable items", () => {
    it.each([
      ["paper_cup", "burnable"],
      ["food_waste", "burnable"],
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
    const result = resolveYoloDetection(makeDetection("cardboard", 0.75), config);
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
  it("site override changes food_waste from burnable to non-burnable", () => {
    const config = makeSiteConfig({
      overrides: [{ pattern: "Food Waste", stream: "non-burnable", note: "Food waste override test" }],
    });

    const result = resolveYoloDetection(makeDetection("food_waste"), config);
    expect(result).not.toBeNull();
    expect(result!.wasteStream).toBe("non-burnable");
  });
});

// ═══════════════════════════════════════════════════════════════════
// Rules JSON integrity
// ═══════════════════════════════════════════════════════════════════

describe("Rules JSON integrity", () => {
  it("YOLO rules covers all 15 custom classes", () => {
    expect(Object.keys(yoloRules.rules)).toHaveLength(15);
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

    // Default sensitivity (0.5): lerp(0.70, 0.50, 0.5) = 0.60
    expect(YOLO_FALLBACK_THRESHOLD).toBeCloseTo(0.60, 4);
  });
});
