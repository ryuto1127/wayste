import { readFileSync } from "fs";
import { join } from "path";
import type {
  SiteConfig,
  WasteStream,
  StreamDefinition,
  ClassificationResponse,
  ComponentPart,
} from "./types";

const configCache = new Map<string, SiteConfig>();

export function loadSiteConfig(siteId: string = "default"): SiteConfig {
  const cached = configCache.get(siteId);
  if (cached) return cached;

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

  configCache.set(siteId, config);
  return config;
}

export function applyOverrides(
  itemName: string,
  claudeStream: WasteStream,
  siteConfig: SiteConfig
): { stream: WasteStream; overrideApplied: boolean; note?: string } {
  const lowerItem = itemName.toLowerCase();

  for (const override of siteConfig.overrides) {
    const pattern = override.pattern.toLowerCase();
    if (lowerItem.includes(pattern) || pattern.includes(lowerItem)) {
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
  const lowerItem = itemName.toLowerCase();

  // Check staff-handling items
  if (siteConfig.staffHandlingItems) {
    for (const pattern of siteConfig.staffHandlingItems) {
      if (lowerItem.includes(pattern.toLowerCase())) {
        return {
          siteNote: `In ${siteConfig.siteName}, this item requires staff handling.`,
          requiresStaff: true,
          streamOverride: "needs_review",
        };
      }
    }
  }

  // Check site-specific rules
  if (siteConfig.siteRules) {
    for (const rule of siteConfig.siteRules) {
      const pattern = rule.pattern.toLowerCase();
      if (lowerItem.includes(pattern) || pattern.includes(lowerItem)) {
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
    isCompound?: boolean;
    components?: ComponentPart[];
  },
  siteConfig: SiteConfig
): ClassificationResponse {
  const threshold = siteConfig.reviewThreshold ?? REVIEW_THRESHOLD_DEFAULT;
  const confidence = Math.max(0, Math.min(1, raw.confidence));

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
{"itemName":"short name","wasteStream":"stream_id","confidence":0.0-1.0,"reasoning":"one sentence"}

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
  "isCompound": false,
  "components": []
}

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
