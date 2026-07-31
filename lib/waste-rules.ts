import { readFileSync } from "fs";
import { join } from "path";
import type {
  SiteConfig,
  LocalModelCandidate,
  MaterialHint,
} from "./types";
import { MATERIAL_VISUAL_CUES } from "./material-vocabulary";

// Re-export all pure functions from the browser-safe core module.
// Server-side consumers (API routes, tests) continue to import from this file.
export {
  matchesPattern,
  applyOverrides,
  applyCompounds,
  getStreamDefinition,
  buildClassificationResult,
} from "./waste-rules-core";
export type { OverrideResult } from "./waste-rules-core";

/** Cache TTL in milliseconds — config is re-read from disk after this period. */
const CONFIG_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

interface CachedConfig {
  config: SiteConfig;
  loadedAt: number;
}

const configCache = new Map<string, CachedConfig>();

export function loadSiteConfig(siteId: string = "japan-office"): SiteConfig {
  // siteId can arrive from the client (classify request body). Constrain it
  // to slug characters BEFORE it reaches the filesystem path — otherwise
  // "../../package" reads arbitrary .json files relative to cwd.
  if (!/^[a-z0-9-]{1,64}$/.test(siteId)) {
    siteId = "japan-office";
  }
  const now = Date.now();
  const cached = configCache.get(siteId);
  if (cached && now - cached.loadedAt < CONFIG_CACHE_TTL_MS) {
    return cached.config;
  }

  const configPath = join(process.cwd(), "config", "sites", `${siteId}.json`);
  let config: SiteConfig;

  try {
    const raw = readFileSync(configPath, "utf-8");
    config = JSON.parse(raw) as SiteConfig;
  } catch {
    if (siteId !== "japan-office") {
      console.warn(
        `Site config "${siteId}" not found, falling back to japan-office.`
      );
      return loadSiteConfig("japan-office");
    }
    throw new Error("japan-office site config not found.");
  }

  configCache.set(siteId, { config, loadedAt: now });
  return config;
}

// ── GPT prompt builders ──
// @legacy-cloud-path — the default kiosk never calls these; alive only behind NEXT_PUBLIC_CLOUD_FALLBACK=1 (pilot experiments)

/**
 * Classification prompt for GPT-5.4 mini — handles compound items, detailed reasoning.
 */
export function buildClassificationPrompt(
  siteConfig: SiteConfig,
  locale = "en",
  options?: { localCandidates?: LocalModelCandidate[]; materialHint?: MaterialHint },
): string {
  const streamIds = siteConfig.streams.map((s) => s.id);
  const streamList = siteConfig.streams
    .map((s) => `- "${s.id}" (${s.label}): ${s.description}`)
    .join("\n");

  const overridesSection =
    siteConfig.overrides && siteConfig.overrides.length > 0
      ? `\nItem rules — these override your general knowledge:\n${siteConfig.overrides.map((o) => `- ${o.pattern} → ${o.stream}${o.note ? ` (${o.note})` : ""}`).join("\n")}\n`
      : "";

  const canonicalSection =
    siteConfig.canonicalNames && siteConfig.canonicalNames.length > 0
      ? `\nPreferred item names (use one of these when the item matches; only use a different name if none fit):\n${siteConfig.canonicalNames.join(", ")}\n`
      : "";

  const candidatesSection = formatLocalCandidates(options?.localCandidates);
  const materialSection = formatMaterialHint(options?.materialHint);

  return `You are a waste sorting assistant installed at "${siteConfig.siteName}". A camera is pointed at a waste disposal area. Identify the item being held or presented to the camera and classify it.

Available waste streams at this location:
${streamList}
${overridesSection}${canonicalSection}
Rules:
1. Identify the most prominent item being held or shown.
2. wasteStream must be exactly one of: ${streamIds.join(", ")}. If the item does not clearly fit any stream, use "needs_review".
3. If the image is unclear, blurry, too dark, shows no item, or shows only a person without a discernible waste item, set confidence to 0 and itemName to "nothing detected".
4. Be honest about confidence. Do NOT inflate confidence when the item is ambiguous or partially occluded. When genuinely uncertain, use a low confidence value (below 0.5).
5. Consider the material composition of the item, not just its name.
6. If the item appears to be a compound object with multiple separable parts (e.g., a coffee cup with a plastic lid and cardboard sleeve, a lunch container with food inside, a device with batteries), set isCompound to true and list the components with individual disposal instructions.

If the item appears transparent or translucent, identify the specific material (clear PET, clear glass, clear PP, etc.).
Assess whether the item is clean enough for recycling or contaminated with food residue. If contaminated, classify to the stream for soiled items and note contamination in reasoning.
For utensils (forks, knives, spoons, chopsticks, straws, stirrers, etc.), always include the material in itemName (e.g., "wooden knife", "plastic fork", "metal spoon", "bamboo chopsticks"). The material determines the correct waste stream: wooden/bamboo → compost, plastic → landfill, metal → recycling.
${candidatesSection}${materialSection}
Respond with ONLY a JSON object in this exact format, no other text:
{
  "itemName": "short name of the identified item",
  "wasteStream": "one of: ${streamIds.join(", ")}",
  "confidence": 0.0 to 1.0,
  "reasoning": "one sentence explaining why this item goes in this stream",
  "preAction": "",
  "isCompound": false,
  "components": []
}

If the user should do something before disposing (empty contents, remove lid/cap, rinse, disassemble), put a short instruction in preAction. Otherwise leave it as an empty string.

If isCompound is true, populate components like:
"components": [
  { "partName": "plastic lid", "wasteStream": "recycling", "instruction": "Remove lid and recycle separately" },
  { "partName": "paper cup", "wasteStream": "landfill", "instruction": "Lined cup goes to landfill" }
]${
    locale === "ja"
      ? '\n\nIMPORTANT: Write itemName, reasoning, and component partName/instruction fields in Japanese (日本語). wasteStream values must remain English stream IDs.'
      : ""
  }`;
}

/**
 * Multi-item classification prompt for GPT-5.4 — used when both YOLO models
 * return zero waste detections but foreground blobs exist (something is there
 * but unrecognized). Asks GPT to identify ALL visible items (up to 4).
 */
export function buildMultiItemPrompt(
  siteConfig: SiteConfig,
  locale = "en",
): string {
  const streamIds = siteConfig.streams.map((s) => s.id);
  const streamList = siteConfig.streams
    .map((s) => `- "${s.id}" (${s.label}): ${s.description}`)
    .join("\n");

  const overridesSection =
    siteConfig.overrides && siteConfig.overrides.length > 0
      ? `\nItem rules — these override your general knowledge:\n${siteConfig.overrides.map((o) => `- ${o.pattern} → ${o.stream}${o.note ? ` (${o.note})` : ""}`).join("\n")}\n`
      : "";

  const canonicalSection =
    siteConfig.canonicalNames && siteConfig.canonicalNames.length > 0
      ? `\nPreferred item names (use one of these when the item matches; only use a different name if none fit):\n${siteConfig.canonicalNames.join(", ")}\n`
      : "";

  return `You are a waste sorting assistant installed at "${siteConfig.siteName}". A camera is pointed at a waste disposal area. Identify ALL visible waste items being held or presented to the camera and classify each one.

Available waste streams at this location:
${streamList}
${overridesSection}${canonicalSection}
Rules:
1. Identify ALL distinct waste items visible in the image (up to 4 items).
2. wasteStream must be exactly one of: ${streamIds.join(", ")}. If an item does not clearly fit any stream, use "needs_review".
3. If the image is unclear, blurry, too dark, shows no item, or shows only a person without discernible waste items, return an empty items array.
4. Assess each item's confidence INDEPENDENTLY. If you can clearly identify an item and its material, give it high confidence (0.8+) regardless of how many other items are in the image. Only use low confidence (below 0.5) when an item is genuinely ambiguous or unidentifiable.
5. Consider the material composition of each item, not just its name.
6. If an item appears to be a compound object with multiple separable parts (e.g., a coffee cup with a plastic lid and cardboard sleeve), set isCompound to true and list the components with individual disposal instructions.

If an item appears transparent or translucent, identify the specific material (clear PET, clear glass, clear PP, etc.).
Assess whether each item is clean enough for recycling or contaminated with food residue. If contaminated, classify to the stream for soiled items and note contamination in reasoning.
For utensils (forks, knives, spoons, chopsticks, straws, stirrers, etc.), always include the material in itemName (e.g., "wooden knife", "plastic fork", "metal spoon", "bamboo chopsticks"). The material determines the correct waste stream: wooden/bamboo → compost, plastic → landfill, metal → recycling.

Respond with ONLY a JSON object in this exact format, no other text:
{
  "items": [
    {
      "itemName": "short name of the identified item",
      "wasteStream": "one of: ${streamIds.join(", ")}",
      "confidence": 0.0 to 1.0,
      "reasoning": "one sentence explaining why this item goes in this stream",
      "preAction": "",
      "isCompound": false,
      "components": [],
      "horizontalPosition": "left" or "center" or "right"
    }
  ]
}

Order items from LEFT to RIGHT as they appear in the image. Set horizontalPosition to where the item is located horizontally in the image ("left", "center", or "right").

If no waste items are visible, return: { "items": [] }

If the user should do something before disposing (empty contents, remove lid/cap, rinse, disassemble), put a short instruction in preAction. Otherwise leave it as an empty string.

If isCompound is true, populate components like:
"components": [
  { "partName": "plastic lid", "wasteStream": "recycling", "instruction": "Remove lid and recycle separately" },
  { "partName": "paper cup", "wasteStream": "landfill", "instruction": "Lined cup goes to landfill" }
]${
    locale === "ja"
      ? '\n\nIMPORTANT: Write itemName, reasoning, and component partName/instruction fields in Japanese (日本語). wasteStream values must remain English stream IDs.'
      : ""
  }`;
}

/**
 * Material-identification prompt — Tier-2 sub-classification path.
 *
 * Fired when Tier-1 (YOLO) confidently identifies the item *type* but the
 * material is still ambiguous (e.g. paper vs. plastic cup). GPT is asked
 * to decide the MATERIAL only, using the cropped image and the visual
 * cues defined in lib/material-vocabulary.ts.
 */
export function buildMaterialIdentificationPrompt(
  siteConfig: SiteConfig,
  locale: string,
  tier1Class: string,
  tier1Confidence: number,
  /** Legacy slot for prior-tier results (kept for callers; pass [] in the current pipeline). */
  tier2Results: { className: string; confidence: number }[],
): string {
  const streamIds = siteConfig.streams.map((s) => s.id);
  const streamList = siteConfig.streams
    .map((s) => `- "${s.id}" (${s.label}): ${s.description}`)
    .join("\n");

  const overridesSection =
    siteConfig.overrides && siteConfig.overrides.length > 0
      ? `\nItem rules — these override your general knowledge:\n${siteConfig.overrides.map((o) => `- ${o.pattern} → ${o.stream}${o.note ? ` (${o.note})` : ""}`).join("\n")}\n`
      : "";

  const canonicalSection =
    siteConfig.canonicalNames && siteConfig.canonicalNames.length > 0
      ? `\nPreferred item names (use one of these when the item matches; only use a different name if none fit):\n${siteConfig.canonicalNames.join(", ")}\n`
      : "";

  // Tier 2 results section
  const tier2Section = tier2Results.length > 0
    ? `\nSub-classification model results (inconclusive):\n${tier2Results.map((r) => `  - ${r.className}: ${Math.round(r.confidence * 100)}%`).join("\n")}\n`
    : "\nSub-classification model returned no results.\n";

  // Material visual cues for the Tier 1 class
  const cues = MATERIAL_VISUAL_CUES[tier1Class];
  const materialsSection = cues
    ? `\nPossible materials for "${tier1Class}":\n${cues.map((c) => `  - ${c.material}: ${c.cues}`).join("\n")}\n`
    : "";

  return `A local detection model identified this item as: ${tier1Class} (${Math.round(tier1Confidence * 100)}%).
The image is cropped to show only this object.
${tier2Section}
Your task: Determine the MATERIAL of this ${tier1Class}.
${materialsSection}
Available waste streams at "${siteConfig.siteName}":
${streamList}
${overridesSection}${canonicalSection}
Rules:
1. You already know this is a ${tier1Class}. Focus ONLY on material.
2. confidence reflects certainty about the MATERIAL, not the item type.
3. Look for: transparency, surface texture, reflections, recycling symbols, pull-tabs, cap type, wall thickness.
4. For utensils (forks, knives, spoons, chopsticks, straws, stirrers), always include the material in itemName (e.g., "wooden knife", "plastic fork", "metal spoon", "bamboo chopsticks"). Wooden/bamboo → compost, plastic → landfill, metal → recycling.
5. If genuinely uncertain about material, set confidence below 0.3.
6. preAction: if the user should do something before disposal, include a short instruction.
7. Use the item rules above to determine the correct wasteStream for the identified material.
8. wasteStream must be exactly one of: ${streamIds.join(", ")}.

Respond with ONLY a JSON object in this exact format, no other text:
{
  "itemName": "material-specific name (e.g. PET Bottle, Glass Bottle, Plastic Cup)",
  "wasteStream": "one of: ${streamIds.join(", ")}",
  "confidence": 0.0 to 1.0,
  "reasoning": "one sentence explaining the material identification",
  "preAction": "",
  "isCompound": false,
  "components": []
}${
    locale === "ja"
      ? '\n\nIMPORTANT: Write itemName, reasoning, preAction, and component fields in Japanese (日本語). wasteStream values must remain English stream IDs.'
      : ""
  }`;
}

// ── Prompt formatting helpers ──

function formatLocalCandidates(candidates?: LocalModelCandidate[]): string {
  if (!candidates || candidates.length === 0) return "";
  const lines = candidates
    .slice(0, 3)
    .map((c, i) => `  ${i + 1}. ${c.className} (${Math.round(c.confidence * 100)}%)`)
    .join("\n");
  return `\nLocal model candidates (may be inaccurate):\n${lines}\n`;
}

function formatMaterialHint(hint?: MaterialHint): string {
  if (!hint) return "";
  const hueNames: Record<number, string> = {
    0: "red", 30: "orange", 60: "yellow", 120: "green",
    180: "cyan", 240: "blue", 270: "purple", 300: "magenta",
  };
  const closestHueName = Object.entries(hueNames).reduce(
    (best, [h, name]) =>
      Math.abs(Number(h) - hint.dominantHue) < Math.abs(Number(best[0]) - hint.dominantHue)
        ? [h, name]
        : best,
    ["0", "red"],
  )[1];

  const lines = [
    `  - Dominant hue: ${hint.dominantHue}° (${closestHueName})`,
    `  - Saturation: ${hint.saturation.toFixed(2)} (${hint.saturation > 0.5 ? "high" : hint.saturation > 0.2 ? "medium" : "low"})`,
    `  - Metallic reflections: ${hint.isMetallic ? "detected" : "not detected"}`,
    `  - Bbox aspect ratio (w/h): ${hint.bboxAspectRatio.toFixed(2)}`,
  ];
  if (hint.texture) {
    lines.push(
      `  - Texture uniformity: ${hint.texture.uniformity.toFixed(2)} (${hint.texture.uniformity > 0.7 ? "high/matte" : hint.texture.uniformity < 0.5 ? "low/specular" : "medium"})`,
      `  - Texture surface: ${hint.texture.suggestedSurface}`,
    );
  }
  return `\nLocal analysis of detected region:\n${lines.join("\n")}\nUse these physical properties to determine the exact material and correct disposal stream.\n`;
}
