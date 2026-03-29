import { readFileSync } from "fs";
import { join } from "path";
import type {
  SiteConfig,
  WasteStream,
  StreamDefinition,
  ClassificationResponse,
  ComponentPart,
  ItemOverride,
} from "./types";
import { redis } from "./redis";

/** Cache TTL in milliseconds — config is re-read from disk after this period. */
const CONFIG_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

interface CachedConfig {
  config: SiteConfig;
  loadedAt: number;
}

const configCache = new Map<string, CachedConfig>();

export function loadSiteConfig(siteId: string = "default"): SiteConfig {
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
    if (siteId !== "default") {
      console.warn(
        `Site config "${siteId}" not found, falling back to default.`
      );
      return loadSiteConfig("default");
    }
    throw new Error("Default site config not found.");
  }

  configCache.set(siteId, { config, loadedAt: now });
  return config;
}

export async function loadDynamicOverrides(siteId: string): Promise<ItemOverride[]> {
  try {
    const key = `recycling:dynamic-overrides:${siteId}`;
    const raw = await redis.get(key);
    if (!raw) return [];
    return (typeof raw === "string" ? JSON.parse(raw) : raw) as ItemOverride[];
  } catch {
    return [];
  }
}

export async function loadSiteConfigWithDynamic(siteId: string = "default"): Promise<SiteConfig> {
  const config = { ...loadSiteConfig(siteId) };
  const dynamicOverrides = await loadDynamicOverrides(siteId);
  if (dynamicOverrides.length > 0) {
    config.overrides = [...config.overrides, ...dynamicOverrides];
  }
  return config;
}

/**
 * Check if `pattern` matches `itemName` using word-boundary-aware logic.
 *
 * Rules:
 * 1. Both strings are lowercased and split into words.
 * 2. A match occurs when ALL words in the pattern appear in the item name.
 *    This prevents "cup" from matching "cupcake" because "cup" is not a
 *    standalone word in "cupcake".
 * 3. Single-word patterns also match as substring with word boundaries:
 *    "battery" matches "AA battery" but not "combattery".
 *
 * This replaces the old bidirectional substring matching which caused
 * false positives (e.g. "cup" → "cupcake", "pen" → "open").
 */
export function matchesPattern(itemName: string, pattern: string): boolean {
  const lowerItem = itemName.toLowerCase();
  const lowerPattern = pattern.toLowerCase();

  // Fast path: exact match
  if (lowerItem === lowerPattern) return true;

  // Word-boundary match: all pattern words must appear as whole words in the item name.
  // Split on non-alphanumeric characters to get word tokens.
  const patternWords = lowerPattern.split(/[^a-z0-9]+/).filter(Boolean);
  const itemWords = lowerItem.split(/[^a-z0-9]+/).filter(Boolean);

  if (patternWords.length === 0) return false;

  // Every word in the pattern must be present as a word in the item name.
  const allPatternWordsMatch = patternWords.every((pw) =>
    itemWords.some((iw) => iw === pw)
  );
  if (allPatternWordsMatch) return true;

  // Fallback for compound words and hyphenated patterns:
  // Check if the full pattern appears as a word-boundary substring in the item.
  // Uses \b word boundaries to prevent "cup" matching inside "cupcake".
  try {
    const escaped = lowerPattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`\\b${escaped}\\b`);
    if (re.test(lowerItem)) return true;
  } catch {
    // Malformed regex — fall through
  }

  return false;
}

export function applyOverrides(
  itemName: string,
  claudeStream: WasteStream,
  siteConfig: SiteConfig
): { stream: WasteStream; overrideApplied: boolean; note?: string } {
  // Sort overrides by pattern length descending — more specific patterns match first.
  // This ensures "coffee cup" is checked before "cup".
  const sorted = [...siteConfig.overrides].sort(
    (a, b) => b.pattern.length - a.pattern.length
  );

  for (const override of sorted) {
    if (matchesPattern(itemName, override.pattern)) {
      return {
        stream: override.stream,
        overrideApplied: true,
        note: override.note,
      };
    }
  }

  return { stream: claudeStream, overrideApplied: false };
}

export function applySiteRules(
  itemName: string,
  siteConfig: SiteConfig
): { siteNote?: string; requiresStaff: boolean; streamOverride?: WasteStream } {
  // Check staff-handling items
  if (siteConfig.staffHandlingItems) {
    for (const pattern of siteConfig.staffHandlingItems) {
      if (matchesPattern(itemName, pattern)) {
        return {
          siteNote: `In ${siteConfig.siteName}, this item requires staff handling.`,
          requiresStaff: true,
          streamOverride: "needs_review",
        };
      }
    }
  }

  // Check site-specific rules (sorted by specificity)
  if (siteConfig.siteRules) {
    const sorted = [...siteConfig.siteRules].sort(
      (a, b) => b.pattern.length - a.pattern.length
    );
    for (const rule of sorted) {
      if (matchesPattern(itemName, rule.pattern)) {
        return {
          siteNote: `In ${siteConfig.siteName}: ${rule.instruction}`,
          requiresStaff: rule.requiresStaff ?? false,
          streamOverride: rule.stream,
        };
      }
    }
  }

  return { requiresStaff: false };
}

export function getStreamDefinition(
  stream: WasteStream,
  siteConfig: SiteConfig
): StreamDefinition | undefined {
  return siteConfig.streams.find((s) => s.id === stream);
}

const REVIEW_THRESHOLD_DEFAULT = 0.55;

export function buildClassificationResult(
  raw: {
    itemName: string;
    wasteStream: string;
    confidence: number;
    reasoning: string;
    preAction?: string;
    isCompound?: boolean;
    components?: ComponentPart[];
  },
  siteConfig: SiteConfig
): ClassificationResponse {
  const threshold = siteConfig.reviewThreshold ?? REVIEW_THRESHOLD_DEFAULT;
  const confidence = Math.max(0, Math.min(1, raw.confidence));

  // Validate the model's stream against the site's known streams.
  // If the model returned a stream ID not in the config, fall back to needs_review.
  const knownStreamIds = new Set(siteConfig.streams.map((s) => s.id));
  if (raw.wasteStream && !knownStreamIds.has(raw.wasteStream)) {
    console.warn(
      `[waste-rules] Model returned unknown stream "${raw.wasteStream}" — falling back to needs_review`
    );
    raw = { ...raw, wasteStream: "needs_review" };
  }

  // Apply item overrides
  const { stream: overriddenStream, note: overrideNote } = applyOverrides(
    raw.itemName,
    raw.wasteStream,
    siteConfig
  );

  // Apply site-specific rules
  const { siteNote, requiresStaff, streamOverride: siteStreamOverride } =
    applySiteRules(raw.itemName, siteConfig);

  const isNothingDetected =
    raw.itemName.toLowerCase() === "nothing detected" ||
    raw.itemName.toLowerCase() === "unknown";

  // Determine if this needs review
  const needsReview =
    confidence < threshold || requiresStaff || isNothingDetected;

  // Final stream priority:
  // 1. Site rules with explicit stream (e.g. staff-handling → "special")
  // 2. Item overrides from config
  // 3. If low confidence and no override, → "needs_review" (don't guess landfill)
  // 4. Model prediction as-is
  let finalStream: WasteStream;
  if (siteStreamOverride) {
    finalStream = siteStreamOverride;
  } else if (confidence < threshold && !overrideNote) {
    // Low confidence without a known override → don't pretend to know
    finalStream = "needs_review";
  } else {
    finalStream = overriddenStream;
  }

  const streamDef = getStreamDefinition(finalStream, siteConfig);

  // needs_review has its own styling
  const isReview = finalStream === "needs_review";
  const binColor = isReview
    ? "#D97706"
    : (streamDef?.color ?? "#525252");
  const binLabel = isReview
    ? "Needs Verification"
    : (streamDef?.label ?? "Landfill");

  // Build component disposal guidance if compound
  const isCompound = raw.isCompound ?? false;
  let components = raw.components;
  if (isCompound && components) {
    components = components.map((c) => {
      const cStreamDef = getStreamDefinition(c.wasteStream, siteConfig);
      return {
        ...c,
        wasteStream: cStreamDef ? c.wasteStream : finalStream,
      };
    });
  }

  return {
    itemName: raw.itemName,
    wasteStream: finalStream,
    confidence,
    reasoning: overrideNote ?? siteNote ?? raw.reasoning,
    binColor,
    binLabel,
    specialInstructions: overrideNote,
    preAction: raw.preAction || undefined,
    needsReview,
    isCompound,
    components: isCompound ? components : undefined,
    siteNote,
  };
}

/**
 * Concise prompt for GPT-5.4 nano — focused on fast, structured classification.
 * No compound-item handling; that escalates to mini.
 */
export function buildNanoPrompt(siteConfig: SiteConfig, locale = "en"): string {
  const streams = siteConfig.streams
    .map((s) => `"${s.id}" (${s.label})`)
    .join(", ");

  const langNote =
    locale === "ja"
      ? "\nIMPORTANT: Write itemName and reasoning in Japanese (日本語). wasteStream must remain the English stream_id."
      : "";

  return `You are a waste sorting camera at "${siteConfig.siteName}".
Identify the item being held in front of the camera and classify it.

Streams: ${streams}

Respond with ONLY this JSON:
{"itemName":"short name","wasteStream":"stream_id","confidence":0.0-1.0,"reasoning":"one sentence","preAction":""}

If the user should do something before disposing (empty contents, remove lid, rinse, disassemble), put a short instruction in preAction. Otherwise leave it as an empty string.
If the image is unclear, blurry, or shows no item, set confidence to 0 and itemName to "nothing detected".
Be honest about confidence — do not inflate it when uncertain.${langNote}`;
}

/**
 * Detailed prompt for GPT-5.4 mini — handles compound items, detailed reasoning.
 */
export function buildClassificationPrompt(siteConfig: SiteConfig, locale = "en"): string {
  const streamList = siteConfig.streams
    .map((s) => `- "${s.id}" (${s.label}): ${s.description}`)
    .join("\n");

  const siteRulesSection =
    siteConfig.siteRules && siteConfig.siteRules.length > 0
      ? `\nSite-specific rules for "${siteConfig.siteName}":\n${siteConfig.siteRules.map((r) => `- Items matching "${r.pattern}": ${r.instruction}`).join("\n")}\n`
      : "";

  return `You are a waste sorting assistant installed at "${siteConfig.siteName}". A camera is pointed at a waste disposal area. Identify the item being held or presented to the camera and classify it.

Available waste streams at this location:
${streamList}
${siteRulesSection}
Rules:
1. Identify the most prominent item being held or shown.
2. Classify it into exactly one of the waste streams listed above.
3. If the image is unclear, blurry, too dark, shows no item, or shows only a person without a discernible waste item, set confidence to 0 and itemName to "nothing detected".
4. Be honest about confidence. Do NOT inflate confidence when the item is ambiguous or partially occluded. When genuinely uncertain, use a low confidence value (below 0.5).
5. Consider the material composition of the item, not just its name.
6. If the item appears to be a compound object with multiple separable parts (e.g., a coffee cup with a plastic lid and cardboard sleeve, a lunch container with food inside, a device with batteries), set isCompound to true and list the components with individual disposal instructions.

Respond with ONLY a JSON object in this exact format, no other text:
{
  "itemName": "short name of the identified item",
  "wasteStream": "one of: ${siteConfig.streams.map((s) => s.id).join(", ")}",
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
