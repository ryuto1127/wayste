/**
 * Tests for YOLO → waste stream resolution (Tier 1 + Tier 2).
 *
 * Verifies that:
 * 1. YOLO26m (COCO-80) detections resolve to the correct waste stream
 * 2. YOLO World (recycling-specific) detections resolve correctly
 * 3. Unknown classes return null (trigger API fallback)
 * 4. Site overrides are applied on top of YOLO rules
 * 5. modelUsed is correctly tagged
 */

import {
  resolveYoloDetection,
  resolveYoloWorldDetection,
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
// Tier 1: YOLO26m (COCO-80) → waste stream
// ═══════════════════════════════════════════════════════════════════

describe("Tier 1: YOLO26m detection → waste stream", () => {
  const config = makeSiteConfig();

  describe("recycling items", () => {
    it.each([
      ["bottle", "recycling"],
      ["wine glass", "recycling"],
      ["book", "recycling"],
    ])("%s → %s", (className, expectedStream) => {
      const result = resolveYoloDetection(makeDetection(className), config);
      expect(result).not.toBeNull();
      expect(result!.wasteStream).toBe(expectedStream);
      expect(result!.modelUsed).toBe("yolo-local");
    });
  });

  describe("compost items", () => {
    it.each([
      ["banana", "compost"],
      ["apple", "compost"],
      ["orange", "compost"],
      ["broccoli", "compost"],
      ["carrot", "compost"],
      ["sandwich", "compost"],
      ["pizza", "compost"],
      ["donut", "compost"],
      ["cake", "compost"],
      ["hot dog", "compost"],
    ])("%s → %s", (className, expectedStream) => {
      const result = resolveYoloDetection(makeDetection(className), config);
      expect(result).not.toBeNull();
      expect(result!.wasteStream).toBe(expectedStream);
    });
  });

  describe("landfill items", () => {
    it.each([
      ["cup", "landfill"],
      ["fork", "landfill"],
      ["knife", "landfill"],
      ["spoon", "landfill"],
      ["bowl", "landfill"],
      ["toothbrush", "landfill"],
    ])("%s → %s", (className, expectedStream) => {
      const result = resolveYoloDetection(makeDetection(className), config);
      expect(result).not.toBeNull();
      expect(result!.wasteStream).toBe(expectedStream);
    });
  });

  describe("special/e-waste items", () => {
    it.each([
      ["cell phone", "special"],
      ["remote", "special"],
      ["keyboard", "special"],
      ["mouse", "special"],
      ["laptop", "special"],
    ])("%s → %s", (className, expectedStream) => {
      const result = resolveYoloDetection(makeDetection(className), config);
      expect(result).not.toBeNull();
      expect(result!.wasteStream).toBe(expectedStream);
    });
  });

  describe("non-waste COCO classes return nothing_detected (instant rejection)", () => {
    it.each([
      "person", "car", "dog", "cat", "chair", "couch",
      "bed", "dining table",
    ])("%s → nothing_detected", (className) => {
      const result = resolveYoloDetection(makeDetection(className), config);
      expect(result).not.toBeNull();
      expect(result!.itemName).toBe("nothing_detected");
      expect(result!.modelUsed).toBe("yolo-local");
    });
  });

  describe("electronics/appliances COCO classes resolve to special", () => {
    it.each([
      ["tv", "special"],
      ["microwave", "special"],
      ["toaster", "special"],
      ["hair drier", "special"],
      ["clock", "special"],
    ])("%s → %s", (className, expectedStream) => {
      const result = resolveYoloDetection(makeDetection(className), config);
      expect(result).not.toBeNull();
      expect(result!.wasteStream).toBe(expectedStream);
    });
  });

  describe("newly added COCO items resolve correctly", () => {
    it.each([
      ["backpack", "landfill"],
      ["umbrella", "landfill"],
      ["scissors", "landfill"],
      ["teddy bear", "landfill"],
      ["vase", "landfill"],
    ])("%s → %s", (className, expectedStream) => {
      const result = resolveYoloDetection(makeDetection(className), config);
      expect(result).not.toBeNull();
      expect(result!.wasteStream).toBe(expectedStream);
    });
  });

  it("includes preAction when defined in rules", () => {
    const result = resolveYoloDetection(makeDetection("bottle"), config);
    expect(result).not.toBeNull();
    expect(result!.preAction).toBe("Empty and rinse before recycling");
  });

  it("preserves detection confidence in result", () => {
    const result = resolveYoloDetection(makeDetection("bottle", 0.92), config);
    expect(result).not.toBeNull();
    expect(result!.confidence).toBe(0.92);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Tier 2: YOLO World (recycling-specific) → waste stream
// ═══════════════════════════════════════════════════════════════════

describe("Tier 2: YOLO World detection → waste stream", () => {
  const config = makeSiteConfig();

  describe("recycling items (not in COCO-80)", () => {
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
  it("site override changes pizza from compost to special stream", () => {
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
  it("YOLO rules covers all 80 COCO classes", () => {
    expect(Object.keys(yoloRules.rules)).toHaveLength(80);
  });

  it("YOLO World rules has all 35 recycling classes", () => {
    expect(Object.keys(worldRules.rules)).toHaveLength(35);
  });

  it("every YOLO rule has required fields", () => {
    for (const [className, rule] of Object.entries(yoloRules.rules)) {
      expect(rule.itemName).toBeTruthy();
      expect(rule.wasteStream).toBeTruthy();
      expect(rule.reasoning).toBeTruthy();
    }
  });

  it("every YOLO World rule has required fields", () => {
    for (const [className, rule] of Object.entries(worldRules.rules)) {
      expect(rule.itemName).toBeTruthy();
      expect(rule.wasteStream).toBeTruthy();
      expect(rule.reasoning).toBeTruthy();
    }
  });

  it("no overlap between YOLO and YOLO World class names", () => {
    const yoloClasses = new Set(Object.keys(yoloRules.rules));
    const worldClasses = new Set(Object.keys(worldRules.rules));
    const overlap = [...yoloClasses].filter((c) => worldClasses.has(c));
    expect(overlap).toEqual([]);
  });

  it("all waste streams in rules are valid", () => {
    const validStreams = new Set(["recycling", "compost", "landfill", "special", "needs_review", "not_waste"]);
    for (const rule of Object.values(yoloRules.rules)) {
      expect(validStreams.has(rule.wasteStream)).toBe(true);
    }
    for (const rule of Object.values(worldRules.rules)) {
      expect(validStreams.has(rule.wasteStream)).toBe(true);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════
// Tiered fallback thresholds
// ═══════════════════════════════════════════════════════════════════

describe("Tiered fallback thresholds", () => {
  it("YOLO_FALLBACK_THRESHOLD, YOLO_API_PARALLEL_THRESHOLD, YOLO_WORLD_ACCEPT_THRESHOLD are correctly exported", () => {
    const {
      YOLO_FALLBACK_THRESHOLD,
      YOLO_API_PARALLEL_THRESHOLD,
      YOLO_WORLD_ACCEPT_THRESHOLD,
    } = require("@/lib/inference-backend");

    expect(YOLO_FALLBACK_THRESHOLD).toBe(0.65);
    expect(YOLO_API_PARALLEL_THRESHOLD).toBe(0.3);
    expect(YOLO_WORLD_ACCEPT_THRESHOLD).toBe(0.45);

    // Tier ordering: API parallel < World accept < YOLO fallback
    expect(YOLO_API_PARALLEL_THRESHOLD).toBeLessThan(YOLO_WORLD_ACCEPT_THRESHOLD);
    expect(YOLO_WORLD_ACCEPT_THRESHOLD).toBeLessThan(YOLO_FALLBACK_THRESHOLD);
  });
});
