/**
 * Tests for YOLO → waste stream resolution (Tier 1 + Tier 2).
 *
 * Verifies that:
 * 1. YOLO 39-class detections resolve to the correct waste stream
 * 2. YOLO World (recycling-specific) detections resolve correctly
 * 3. Unknown classes return null (trigger API fallback)
 * 4. Site overrides are applied on top of YOLO rules
 * 5. modelUsed is correctly tagged
 */

import {
  resolveYoloDetection,
  resolveYoloWorldDetection,
  resolvePetBottleCompound,
  _setRulesCache,
  _setWorldRulesCache,
} from "@/lib/yolo-rules";
import type { SiteConfig, YoloDetection, YoloRulesConfig } from "@/lib/types";
import * as fs from "fs";
import * as path from "path";

// ── Load real rules JSON files ──
const yoloRules: YoloRulesConfig = JSON.parse(
  fs.readFileSync(path.join(__dirname, "../public/models/yolo-rules.json"), "utf8")
);
const worldRules: YoloRulesConfig = JSON.parse(
  fs.readFileSync(path.join(__dirname, "../public/models/yolo-world-rules.json"), "utf8")
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
  _setWorldRulesCache(worldRules);
});

afterAll(() => {
  _setRulesCache(null);
  _setWorldRulesCache(null);
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
// Tier 2: YOLO World (recycling-specific) → waste stream
// ═══════════════════════════════════════════════════════════════════

describe("Tier 2: YOLO World detection → waste stream", () => {
  const config = makeSiteConfig();

  describe("recycling items", () => {
    it.each([
      ["aluminium beverage can", "recycling"],
      ["steel food can", "recycling"],
      ["plastic bottle", "recycling"],
      ["glass bottle", "recycling"],
      ["cardboard", "recycling"],
      ["paper bag", "recycling"],
      ["milk carton", "recycling"],
      ["juice box", "recycling"],
      ["aluminum foil", "landfill"],
      ["egg carton", "recycling"],
      ["plastic bottle cap", "recycling"],
      ["glass jar", "recycling"],
      ["yogurt cup", "recycling"],
      ["newspaper", "recycling"],
    ])("%s → %s", (className, expectedStream) => {
      const result = resolveYoloWorldDetection(makeDetection(className), config);
      expect(result).not.toBeNull();
      expect(result!.wasteStream).toBe(expectedStream);
      expect(result!.modelUsed).toBe("yolo-world");
    });
  });

  describe("compost items", () => {
    it.each([
      ["napkin", "compost"],
      ["paper plate", "compost"],
      ["paper towel", "compost"],
      ["coffee cup sleeve", "compost"],
      ["banana peel", "compost"],
      ["apple core", "compost"],
    ])("%s → %s", (className, expectedStream) => {
      const result = resolveYoloWorldDetection(makeDetection(className), config);
      expect(result).not.toBeNull();
      expect(result!.wasteStream).toBe(expectedStream);
    });
  });

  describe("landfill items", () => {
    it.each([
      ["plastic bag", "landfill"],
      ["plastic wrapper", "landfill"],
      ["plastic straw", "landfill"],
      ["styrofoam cup", "landfill"],
      ["styrofoam container", "landfill"],
      ["plastic food container", "landfill"],
      ["plastic cup", "landfill"],
      ["plastic utensil", "landfill"],
      ["paper cup", "landfill"],
      ["coffee cup", "landfill"],
      ["chip bag", "landfill"],
      ["pizza box", "landfill"],
      ["cigarette butt", "landfill"],
      ["pen", "landfill"],
    ])("%s → %s", (className, expectedStream) => {
      const result = resolveYoloWorldDetection(makeDetection(className), config);
      expect(result).not.toBeNull();
      expect(result!.wasteStream).toBe(expectedStream);
    });
  });

  describe("special items", () => {
    it("battery → special", () => {
      const result = resolveYoloWorldDetection(makeDetection("battery"), config);
      expect(result).not.toBeNull();
      expect(result!.wasteStream).toBe("special");
      expect(result!.preAction).toBe("Tape the terminals before disposing");
    });
  });

  it("plastic bottle label → plastic", () => {
    const configWithPlastic = makeSiteConfig({
      streams: [
        { id: "recycling", label: "Recycling", color: "#2563EB", description: "" },
        { id: "plastic", label: "Plastic", color: "#F59E0B", description: "" },
        { id: "landfill", label: "Landfill", color: "#525252", description: "" },
      ],
    });
    const result = resolveYoloWorldDetection(makeDetection("plastic bottle label"), configWithPlastic);
    expect(result).not.toBeNull();
    expect(result!.wasteStream).toBe("plastic");
    expect(result!.modelUsed).toBe("yolo-world");
  });

  it("returns null for unknown class names", () => {
    const result = resolveYoloWorldDetection(makeDetection("spaceship"), config);
    expect(result).toBeNull();
  });

  it("tags modelUsed as yolo-world", () => {
    const result = resolveYoloWorldDetection(makeDetection("aluminium beverage can"), config);
    expect(result!.modelUsed).toBe("yolo-world");
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

  it("site override changes aluminium beverage can stream for YOLO World", () => {
    const config = makeSiteConfig({
      overrides: [{ pattern: "Aluminium Beverage Can", stream: "special", note: "Special recycling bin for cans" }],
    });

    const result = resolveYoloWorldDetection(makeDetection("aluminium beverage can"), config);
    expect(result).not.toBeNull();
    expect(result!.wasteStream).toBe("special");
  });
});

// ═══════════════════════════════════════════════════════════════════
// Rules JSON integrity
// ═══════════════════════════════════════════════════════════════════

describe("Rules JSON integrity", () => {
  it("YOLO rules covers all 39 custom classes", () => {
    expect(Object.keys(yoloRules.rules)).toHaveLength(39);
  });

  it("YOLO World rules has all 53 recycling classes", () => {
    expect(Object.keys(worldRules.rules)).toHaveLength(53);
  });

  it("every YOLO rule has required fields", () => {
    for (const [, rule] of Object.entries(yoloRules.rules)) {
      expect(rule.itemName).toBeTruthy();
      expect(rule.wasteStream).toBeTruthy();
      expect(rule.reasoning).toBeTruthy();
    }
  });

  it("every YOLO World rule has required fields", () => {
    for (const [, rule] of Object.entries(worldRules.rules)) {
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
    for (const rule of Object.values(worldRules.rules)) {
      expect(validStreams.has(rule.wasteStream)).toBe(true);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════
// PET bottle compound detection
// ═══════════════════════════════════════════════════════════════════

describe("PET bottle compound detection", () => {
  const configWithPlastic = makeSiteConfig({
    streams: [
      { id: "recycling", label: "Recycling", color: "#2563EB", description: "" },
      { id: "plastic", label: "Plastic", color: "#F59E0B", description: "" },
      { id: "landfill", label: "Landfill", color: "#525252", description: "" },
    ],
  });

  it("bottle + cap → compound result with separation instructions", () => {
    const detections = [
      makeDetection("plastic bottle", 0.9),
      makeDetection("plastic bottle cap", 0.8),
    ];
    const result = resolvePetBottleCompound(detections, configWithPlastic);
    expect(result).not.toBeNull();
    expect(result!.isCompound).toBe(true);
    expect(result!.components).toHaveLength(2);
    expect(result!.components![0].partName).toBe("PET bottle");
    expect(result!.components![1].partName).toBe("Bottle cap");
    expect(result!.modelUsed).toBe("yolo-world");
  });

  it("bottle + label → compound result", () => {
    const detections = [
      makeDetection("plastic bottle", 0.9),
      makeDetection("plastic bottle label", 0.75),
    ];
    const result = resolvePetBottleCompound(detections, configWithPlastic);
    expect(result).not.toBeNull();
    expect(result!.isCompound).toBe(true);
    expect(result!.components).toHaveLength(2);
    expect(result!.components![1].partName).toBe("Bottle label");
  });

  it("bottle + cap + label → compound result with 3 components", () => {
    const detections = [
      makeDetection("plastic bottle", 0.9),
      makeDetection("plastic bottle cap", 0.8),
      makeDetection("plastic bottle label", 0.7),
    ];
    const result = resolvePetBottleCompound(detections, configWithPlastic);
    expect(result).not.toBeNull();
    expect(result!.isCompound).toBe(true);
    expect(result!.components).toHaveLength(3);
  });

  it("bottle alone → null (no compound)", () => {
    const detections = [makeDetection("plastic bottle", 0.9)];
    const result = resolvePetBottleCompound(detections, configWithPlastic);
    expect(result).toBeNull();
  });

  it("cap alone → null (no bottle)", () => {
    const detections = [makeDetection("plastic bottle cap", 0.8)];
    const result = resolvePetBottleCompound(detections, configWithPlastic);
    expect(result).toBeNull();
  });

  it("non-bottle items → null", () => {
    const detections = [
      makeDetection("aluminium beverage can", 0.9),
      makeDetection("plastic bag", 0.8),
    ];
    const result = resolvePetBottleCompound(detections, configWithPlastic);
    expect(result).toBeNull();
  });

  it("uses Japanese labels when locale is ja", () => {
    const detections = [
      makeDetection("plastic bottle", 0.9),
      makeDetection("plastic bottle cap", 0.8),
    ];
    const result = resolvePetBottleCompound(detections, configWithPlastic, "ja");
    expect(result).not.toBeNull();
    expect(result!.itemName).toBe("ペットボトル");
    expect(result!.components![0].partName).toBe("ペットボトル本体");
    expect(result!.components![1].partName).toBe("キャップ");
  });

  it("cap stream falls back to recycling when no plastic stream exists", () => {
    const configNoPlastic = makeSiteConfig();
    const detections = [
      makeDetection("plastic bottle", 0.9),
      makeDetection("plastic bottle cap", 0.8),
    ];
    const result = resolvePetBottleCompound(detections, configNoPlastic);
    expect(result).not.toBeNull();
    expect(result!.components![1].wasteStream).toBe("recycling");
  });
});

// ═══════════════════════════════════════════════════════════════════
// Tiered fallback thresholds
// ═══════════════════════════════════════════════════════════════════

describe("Tiered fallback thresholds", () => {
  it("YOLO_FALLBACK_THRESHOLD, YOLO_API_PARALLEL_THRESHOLD, YOLO_WORLD_ACCEPT_THRESHOLD are correctly exported", () => {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const {
      YOLO_FALLBACK_THRESHOLD,
      YOLO_API_PARALLEL_THRESHOLD,
      YOLO_WORLD_ACCEPT_THRESHOLD,
    } = require("@/lib/inference-backend");
    /* eslint-enable @typescript-eslint/no-require-imports */

    // Default sensitivity (0.5): lerp(0.85, 0.65, 0.5) = 0.75, lerp(0.80, 0.60, 0.5) = 0.70
    expect(YOLO_FALLBACK_THRESHOLD).toBeCloseTo(0.75, 4);
    expect(YOLO_API_PARALLEL_THRESHOLD).toBe(0.3);
    expect(YOLO_WORLD_ACCEPT_THRESHOLD).toBeCloseTo(0.70, 4);

    // Tier ordering: API parallel < World accept <= YOLO fallback
    expect(YOLO_API_PARALLEL_THRESHOLD).toBeLessThan(YOLO_WORLD_ACCEPT_THRESHOLD);
    expect(YOLO_WORLD_ACCEPT_THRESHOLD).toBeLessThanOrEqual(YOLO_FALLBACK_THRESHOLD);
  });
});
