/**
 * Tests for lib/waste-rules.ts
 */

import {
  applyOverrides,
  applyCompounds,
  buildClassificationResult,
  loadSiteConfig,
  matchesPattern,
  buildClassificationPrompt,
  buildMultiItemPrompt,
} from "@/lib/waste-rules";
import type { MaterialHint, SiteConfig } from "@/lib/types";

// Load real configs for integration-style tests
const defaultConfig = loadSiteConfig("default");
const officeConfig = loadSiteConfig("office-hq");
const japanOfficeConfig = loadSiteConfig("japan-office");

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

describe("applyOverrides", () => {
  it("respects site-level overrides with case-insensitive pattern match", () => {
    const config = makeSiteConfig({
      overrides: [{ pattern: "Coffee Cup", stream: "landfill", note: "Lined cup" }],
    });
    const result = applyOverrides("COFFEE CUP", "recycling", config);
    expect(result.stream).toBe("landfill");
    expect(result.overrideApplied).toBe(true);
    expect(result.note).toBe("Lined cup");
  });

  it("returns original stream when no override matches", () => {
    const config = makeSiteConfig({ overrides: [] });
    const result = applyOverrides("water bottle", "recycling", config);
    expect(result.stream).toBe("recycling");
    expect(result.overrideApplied).toBe(false);
  });
});

describe("applyOverrides — requiresStaff handling", () => {
  it("returns 'needs_review' for staffHandlingItems", () => {
    const config = makeSiteConfig({
      staffHandlingItems: ["fluorescent", "chemical"],
    });
    const result = applyOverrides("fluorescent bulb", "recycling", config);
    expect(result.requiresStaff).toBe(true);
    expect(result.stream).toBe("needs_review");
    expect(result.overrideApplied).toBe(true);
  });

  it("forces needs_review when override has requiresStaff: true", () => {
    const config = makeSiteConfig({
      overrides: [
        { pattern: "toner", stream: "special", note: "Leave by copy room", requiresStaff: true },
      ],
    });
    const result = applyOverrides("TONER cartridge", "recycling", config);
    expect(result.requiresStaff).toBe(true);
    expect(result.stream).toBe("needs_review");
    expect(result.note).toBe("Leave by copy room");
  });

  it("staffHandlingItems takes priority over overrides", () => {
    const config = makeSiteConfig({
      staffHandlingItems: ["fluorescent"],
      overrides: [{ pattern: "fluorescent", stream: "special" }],
    });
    const result = applyOverrides("fluorescent bulb", "recycling", config);
    expect(result.requiresStaff).toBe(true);
    expect(result.stream).toBe("needs_review");
  });
});

describe("buildClassificationResult", () => {
  it("downgrades confidence when below site threshold", () => {
    const config = makeSiteConfig({ reviewThreshold: 0.6 });
    const result = buildClassificationResult(
      {
        itemName: "mystery item",
        wasteStream: "recycling",
        confidence: 0.45,
        reasoning: "not sure",
      },
      config
    );
    expect(result.needsReview).toBe(true);
    expect(result.wasteStream).toBe("needs_review");
  });

  it("uses model stream at high confidence with no overrides", () => {
    const config = makeSiteConfig({ reviewThreshold: 0.5 });
    const result = buildClassificationResult(
      {
        itemName: "aluminum can",
        wasteStream: "recycling",
        confidence: 0.95,
        reasoning: "clean aluminum",
      },
      config
    );
    expect(result.wasteStream).toBe("recycling");
    expect(result.needsReview).toBe(false);
  });
});

describe("matchesPattern — word-boundary matching", () => {
  it("matches exact words", () => {
    expect(matchesPattern("coffee cup", "coffee cup")).toBe(true);
    expect(matchesPattern("Coffee Cup", "coffee cup")).toBe(true);
  });

  it("matches pattern words within item name", () => {
    expect(matchesPattern("used paper coffee cup", "coffee cup")).toBe(true);
    expect(matchesPattern("old battery pack", "battery")).toBe(true);
  });

  it("does NOT match partial words (prevents cup → cupcake)", () => {
    expect(matchesPattern("cupcake", "cup")).toBe(false);
    expect(matchesPattern("open box", "pen")).toBe(false);
    expect(matchesPattern("tablecloth", "table")).toBe(false);
  });

  it("matches as word boundary substring", () => {
    expect(matchesPattern("AA battery", "battery")).toBe(true);
    expect(matchesPattern("plastic bag from store", "plastic bag")).toBe(true);
  });

  it("handles single-word items", () => {
    expect(matchesPattern("napkin", "napkin")).toBe(true);
    expect(matchesPattern("Napkin", "napkin")).toBe(true);
  });

  it("matches hyphenated and multi-word patterns", () => {
    expect(matchesPattern("old k-cup pod", "k-cup")).toBe(true);
  });

  it("does not match empty pattern", () => {
    expect(matchesPattern("something", "")).toBe(false);
  });
});

describe("applyCompounds", () => {
  it("returns isCompound: false when no compounds configured", () => {
    const config = makeSiteConfig();
    expect(applyCompounds("plastic bottle", config)).toEqual({ isCompound: false });
  });

  it("matches a compound pattern and returns components", () => {
    const config = makeSiteConfig({
      compounds: [
        {
          pattern: "plastic bottle",
          components: [
            { partName: "bottle", wasteStream: "recycling", instruction: "Rinse" },
            { partName: "cap", wasteStream: "landfill", instruction: "Separate", optional: true },
          ],
        },
      ],
    });
    const result = applyCompounds("plastic bottle", config);
    expect(result.isCompound).toBe(true);
    if (result.isCompound) {
      expect(result.components).toHaveLength(2);
      expect(result.components[1].optional).toBe(true);
    }
  });

  it("prefers longer compound patterns (more specific wins)", () => {
    const config = makeSiteConfig({
      compounds: [
        {
          pattern: "bottle",
          components: [{ partName: "generic bottle", wasteStream: "recycling", instruction: "" }],
        },
        {
          pattern: "plastic bottle",
          components: [{ partName: "plastic bottle body", wasteStream: "recyclable", instruction: "" }],
        },
      ],
    });
    const result = applyCompounds("plastic bottle", config);
    expect(result.isCompound).toBe(true);
    if (result.isCompound) {
      expect(result.components[0].partName).toBe("plastic bottle body");
    }
  });

  it("config compounds override AI compound detection in buildClassificationResult", () => {
    const config = makeSiteConfig({
      reviewThreshold: 0.5,
      compounds: [
        {
          pattern: "plastic bottle",
          components: [
            { partName: "bottle", wasteStream: "recycling", instruction: "Rinse" },
            { partName: "cap", wasteStream: "landfill", instruction: "Separate", optional: true },
          ],
        },
      ],
    });
    const result = buildClassificationResult(
      { itemName: "plastic bottle", wasteStream: "recycling", confidence: 0.9, reasoning: "clear plastic" },
      config
    );
    expect(result.isCompound).toBe(true);
    expect(result.components).toHaveLength(2);
    expect(result.components![1].optional).toBe(true);
  });
});

describe("applyOverrides specificity ordering", () => {
  it("prefers longer (more specific) patterns over shorter ones", () => {
    const config = makeSiteConfig({
      overrides: [
        { pattern: "cup", stream: "landfill", note: "Generic cup" },
        { pattern: "coffee cup", stream: "compost", note: "Compostable cup" },
      ],
    });
    // "coffee cup" should match the more specific "coffee cup" pattern, not "cup"
    const result = applyOverrides("coffee cup", "recycling", config);
    expect(result.stream).toBe("compost");
    expect(result.note).toBe("Compostable cup");
  });
});

describe("japan-office config", () => {
  it("loads japan-office config successfully", () => {
    expect(japanOfficeConfig.siteId).toBe("japan-office");
    expect(japanOfficeConfig.defaultLocale).toBe("ja");
    expect(japanOfficeConfig.streams.length).toBeGreaterThan(0);
  });

  it("has Japanese waste streams (burnable, non-burnable, recyclable, plastic)", () => {
    const streamIds = japanOfficeConfig.streams.map((s) => s.id);
    expect(streamIds).toContain("burnable");
    expect(streamIds).toContain("non-burnable");
    expect(streamIds).toContain("recyclable");
    expect(streamIds).toContain("plastic");
  });

  it("overrides for pet bottles route to recyclable", () => {
    const result = applyOverrides("ペットボトル", "burnable", japanOfficeConfig);
    expect(result.stream).toBe("recyclable");
    expect(result.overrideApplied).toBe(true);
  });

  it("overrides for coffee cup route to burnable", () => {
    const result = applyOverrides("coffee cup", "recyclable", japanOfficeConfig);
    expect(result.stream).toBe("burnable");
    expect(result.overrideApplied).toBe(true);
  });

  it("overrides for battery route to special", () => {
    const result = applyOverrides("電池", "burnable", japanOfficeConfig);
    expect(result.stream).toBe("special");
    expect(result.overrideApplied).toBe(true);
  });

  it("has staffHandlingItems for fluorescent and spray cans", () => {
    expect(japanOfficeConfig.staffHandlingItems).toContain("蛍光灯");
    expect(japanOfficeConfig.staffHandlingItems).toContain("スプレー缶");
  });
});

describe("loadSiteConfig merges default + site-specific config", () => {
  it("loads default config successfully", () => {
    expect(defaultConfig.siteId).toBe("default");
    expect(defaultConfig.streams.length).toBeGreaterThan(0);
    expect(defaultConfig.overrides.length).toBeGreaterThan(0);
  });

  it("office-hq has extra streams not in default", () => {
    const officeStreamIds = officeConfig.streams.map((s) => s.id);
    expect(officeStreamIds).toContain("ewaste");
  });

  it("office-hq has staffHandlingItems", () => {
    expect(officeConfig.staffHandlingItems).toBeDefined();
    expect(officeConfig.staffHandlingItems!.length).toBeGreaterThan(0);
  });

  it("falls back to default when site config not found", () => {
    const config = loadSiteConfig("nonexistent-site-xyz");
    expect(config.siteId).toBe("default");
  });
});

describe("conditional overrides", () => {
  it("returns conditionalStream and condition when override has them", () => {
    const config = makeSiteConfig({
      overrides: [
        {
          pattern: "lunch box",
          stream: "burnable",
          note: "Dirty → burnable; clean → plastic",
          conditionalStream: "plastic",
          condition: "clean",
        },
      ],
    });
    const result = applyOverrides("lunch box", "recycling", config);
    expect(result.stream).toBe("burnable");
    expect(result.overrideApplied).toBe(true);
    expect(result.conditionalStream).toBe("plastic");
    expect(result.condition).toBe("clean");
  });

  it("does not include conditionalStream for non-conditional overrides", () => {
    const config = makeSiteConfig({
      overrides: [
        { pattern: "newspaper", stream: "recyclable", note: "Recyclable" },
      ],
    });
    const result = applyOverrides("newspaper", "landfill", config);
    expect(result.stream).toBe("recyclable");
    expect(result.conditionalStream).toBeUndefined();
    expect(result.condition).toBeUndefined();
  });

  it("local tier (buildClassificationResult) uses base stream, not conditional", () => {
    const config = makeSiteConfig({
      reviewThreshold: 0.5,
      overrides: [
        {
          pattern: "food tray",
          stream: "burnable",
          conditionalStream: "plastic",
          condition: "clean",
          note: "Dirty → burnable",
        },
      ],
    });
    // Local tier: even with high confidence, uses base stream (burnable)
    const result = buildClassificationResult(
      { itemName: "food tray", wasteStream: "plastic", confidence: 0.9, reasoning: "clean plastic tray" },
      config,
    );
    expect(result.wasteStream).toBe("burnable");
  });

  it("pilot config has conditional overrides for 弁当容器", () => {
    const pilotConfig = loadSiteConfig("pilot");
    const result = applyOverrides("弁当容器", "plastic", pilotConfig);
    expect(result.stream).toBe("burnable");
    expect(result.conditionalStream).toBe("plastic");
    expect(result.condition).toBe("clean");
  });

  it("pilot config has new specific can overrides", () => {
    const pilotConfig = loadSiteConfig("pilot");

    const aluminum = applyOverrides("アルミ缶", "burnable", pilotConfig);
    expect(aluminum.stream).toBe("recyclable");
    expect(aluminum.overrideApplied).toBe(true);

    const steel = applyOverrides("スチール缶", "burnable", pilotConfig);
    expect(steel.stream).toBe("recyclable");
    expect(steel.overrideApplied).toBe(true);
  });

  it("pilot config has glass color variant overrides", () => {
    const pilotConfig = loadSiteConfig("pilot");

    const clear = applyOverrides("透明びん", "burnable", pilotConfig);
    expect(clear.stream).toBe("recyclable");

    const brown = applyOverrides("茶色びん", "burnable", pilotConfig);
    expect(brown.stream).toBe("recyclable");

    const other = applyOverrides("その他の色のびん", "burnable", pilotConfig);
    expect(other.stream).toBe("recyclable");
  });

  it("pilot config has foam tray color overrides", () => {
    const pilotConfig = loadSiteConfig("pilot");

    const white = applyOverrides("白色トレイ", "burnable", pilotConfig);
    expect(white.stream).toBe("plastic");

    const colored = applyOverrides("色付きトレイ", "burnable", pilotConfig);
    expect(colored.stream).toBe("burnable");
  });

  it("japan-office config has new specific overrides", () => {
    const result = applyOverrides("アルミ缶", "burnable", japanOfficeConfig);
    expect(result.stream).toBe("recyclable");

    const steel = applyOverrides("steel can", "burnable", japanOfficeConfig);
    expect(steel.stream).toBe("recyclable");

    const glass = applyOverrides("透明びん", "burnable", japanOfficeConfig);
    expect(glass.stream).toBe("recyclable");
  });
});

describe("buildClassificationPrompt — materialHint integration", () => {
  it("includes material data in prompt when materialHint is provided", () => {
    const hint: MaterialHint = {
      dominantHue: 120,
      saturation: 0.3,
      isMetallic: false,
      suggestedMaterial: null,
      bboxAspectRatio: 0.5,
      texture: { uniformity: 0.6, edgeDensity: 0.2, suggestedSurface: "plastic" },
    };
    const prompt = buildClassificationPrompt(defaultConfig, "en", { materialHint: hint });
    expect(prompt).toContain("Dominant hue: 120");
    expect(prompt).toContain("Metallic reflections: not detected");
    expect(prompt).toContain("Bbox aspect ratio");
    expect(prompt).toContain("Texture surface: plastic");
    expect(prompt).toContain("physical properties");
  });

  it("does NOT include material section when materialHint is absent", () => {
    const prompt = buildClassificationPrompt(defaultConfig, "en");
    expect(prompt).not.toContain("Local analysis of detected region");
    expect(prompt).not.toContain("Dominant hue");
  });
});

// ── buildMultiItemPrompt ──
describe("buildMultiItemPrompt", () => {
  it("instructs GPT to identify ALL visible items (not just the most prominent)", () => {
    const prompt = buildMultiItemPrompt(defaultConfig, "en");
    expect(prompt).toContain("ALL");
    expect(prompt).toContain("up to 4");
    expect(prompt).not.toContain("most prominent");
  });

  it("returns JSON schema with items array", () => {
    const prompt = buildMultiItemPrompt(defaultConfig, "en");
    expect(prompt).toContain('"items"');
    expect(prompt).toContain("items array");
  });

  it("includes empty-items instruction for no-item case", () => {
    const prompt = buildMultiItemPrompt(defaultConfig, "en");
    expect(prompt).toContain('{ "items": [] }');
  });

  it("includes stream IDs from site config", () => {
    const prompt = buildMultiItemPrompt(defaultConfig, "en");
    for (const stream of defaultConfig.streams) {
      expect(prompt).toContain(stream.id);
    }
  });

  it("includes overrides from site config", () => {
    const config = makeSiteConfig({
      overrides: [{ pattern: "Coffee Cup", stream: "landfill", note: "Lined cup" }],
    });
    const prompt = buildMultiItemPrompt(config, "en");
    expect(prompt).toContain("Coffee Cup");
    expect(prompt).toContain("landfill");
  });

  it("adds Japanese instruction when locale=ja", () => {
    const prompt = buildMultiItemPrompt(defaultConfig, "ja");
    expect(prompt).toContain("日本語");
  });

  it("includes compound object handling", () => {
    const prompt = buildMultiItemPrompt(defaultConfig, "en");
    expect(prompt).toContain("isCompound");
    expect(prompt).toContain("components");
  });
});
