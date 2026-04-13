/**
 * Tests for YOLO → waste stream resolution (Tier 1).
 *
 * Verifies that:
 * 1. YOLO 39-class detections resolve to the correct waste stream
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
      { id: "recycling", label: "Recycling", color: "#2563EB", description: "" },
      { id: "compost", label: "Compost", color: "#16A34A", description: "" },
      { id: "landfill", label: "Landfill", color: "#525252", description: "" },
      { id: "special", label: "Special", color: "#DC2626", description: "" },
      { id: "needs_review", label: "Needs Review", color: "#D97706", description: "" },
    ],
    overrides: [],
    defaultStream: "landfill",
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
// Tier 1: YOLO 39-class custom model → waste stream
// ═══════════════════════════════════════════════════════════════════

describe("Tier 1: YOLO 39-class detection → waste stream", () => {
  const config = makeSiteConfig();

  describe("recycling items", () => {
    it.each([
      ["plastic_bottle", "recycling"],
      ["can", "recycling"],
      ["glass_bottle", "recycling"],
      ["cardboard", "recycling"],
      ["paper", "recycling"],
      ["paper_bag", "recycling"],
      ["tetra_pak", "recycling"],
    ])("%s → %s", (className, expectedStream) => {
      const result = resolveYoloDetection(makeDetection(className), config);
      expect(result).not.toBeNull();
      expect(result!.wasteStream).toBe(expectedStream);
      expect(result!.modelUsed).toBe("yolo-local");
    });
  });

  describe("compost items (food waste)", () => {
    it.each([
      ["bone", "compost"],
      ["vegetable", "compost"],
      ["egg_shell", "compost"],
      ["orange", "compost"],
      ["orange_peel", "compost"],
      ["apple_peel", "compost"],
      ["apple", "compost"],
      ["pear", "compost"],
      ["meat", "compost"],
      ["bread", "compost"],
      ["rice", "compost"],
      ["egg_yolk", "compost"],
      ["apple_core", "compost"],
      ["bone_fish", "compost"],
      ["noodle", "compost"],
      ["pear_peel", "compost"],
      ["pastry", "compost"],
      ["tomato", "compost"],
      ["fish", "compost"],
      ["cucumber", "compost"],
      ["carrot", "compost"],
      ["banana", "compost"],
      ["chicken", "compost"],
      ["potato", "compost"],
      ["pizza", "compost"],
      ["cake", "compost"],
      ["hamburger", "compost"],
    ])("%s → %s", (className, expectedStream) => {
      const result = resolveYoloDetection(makeDetection(className), config);
      expect(result).not.toBeNull();
      expect(result!.wasteStream).toBe(expectedStream);
    });
  });

  describe("landfill items", () => {
    it.each([
      ["paper_cup", "landfill"],
      ["plastic_cup", "landfill"],
      ["plastic_bag", "landfill"],
      ["styrofoam", "landfill"],
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
    expect(result!.preAction).toBe("Empty and rinse before recycling");
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
  it("site override changes pizza from compost to landfill", () => {
    const config = makeSiteConfig({
      streams: [
        { id: "recycling", label: "Recycling", color: "#2563EB", description: "" },
        { id: "compost", label: "Compost", color: "#16A34A", description: "" },
        { id: "landfill", label: "Landfill", color: "#525252", description: "" },
        { id: "special", label: "Special", color: "#DC2626", description: "" },
        { id: "needs_review", label: "Needs Review", color: "#D97706", description: "" },
      ],
      overrides: [{ pattern: "Pizza", stream: "landfill", note: "Greasy pizza goes to landfill here" }],
    });

    const result = resolveYoloDetection(makeDetection("pizza"), config);
    expect(result).not.toBeNull();
    expect(result!.wasteStream).toBe("landfill");
  });
});

// ═══════════════════════════════════════════════════════════════════
// Rules JSON integrity
// ═══════════════════════════════════════════════════════════════════

describe("Rules JSON integrity", () => {
  it("YOLO rules covers all 39 custom classes", () => {
    expect(Object.keys(yoloRules.rules)).toHaveLength(39);
  });

  it("every YOLO rule has required fields", () => {
    for (const [, rule] of Object.entries(yoloRules.rules)) {
      expect(rule.itemName).toBeTruthy();
      expect(rule.wasteStream).toBeTruthy();
      expect(rule.reasoning).toBeTruthy();
    }
  });

  it("all waste streams in rules are valid", () => {
    const validStreams = new Set(["recycling", "compost", "landfill", "special", "plastic", "needs_review", "not_waste"]);
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

    // Default sensitivity (0.5): lerp(0.85, 0.65, 0.5) = 0.75
    expect(YOLO_FALLBACK_THRESHOLD).toBeCloseTo(0.75, 4);
  });
});
