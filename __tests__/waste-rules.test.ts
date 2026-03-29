/**
 * Tests for lib/waste-rules.ts
 */

import {
  applyOverrides,
  applySiteRules,
  buildClassificationResult,
  loadSiteConfig,
  matchesPattern,
} from "@/lib/waste-rules";
import type { SiteConfig } from "@/lib/types";

// Load real configs for integration-style tests
const defaultConfig = loadSiteConfig("default");
const officeConfig = loadSiteConfig("office-hq");

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

describe("applySiteRules", () => {
  it("returns 'needs_review' for staffHandlingItems", () => {
    const config = makeSiteConfig({
      staffHandlingItems: ["fluorescent", "chemical"],
    });
    const result = applySiteRules("fluorescent bulb", config);
    expect(result.requiresStaff).toBe(true);
    expect(result.streamOverride).toBe("needs_review");
  });

  it("matches siteRules with case-insensitive pattern", () => {
    const config = makeSiteConfig({
      siteRules: [
        {
          pattern: "toner",
          instruction: "Leave by copy room",
          stream: "special",
          requiresStaff: true,
        },
      ],
    });
    const result = applySiteRules("TONER cartridge", config);
    expect(result.requiresStaff).toBe(true);
    expect(result.streamOverride).toBe("special");
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
