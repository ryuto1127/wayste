import { readFileSync } from "fs";
import { join } from "path";
import type {
  SiteConfig,
  ClassificationResponse,
  ComponentPart,
  ItemOverride,
} from "./types";
import { redis } from "./redis";

// Re-export all pure functions from the browser-safe core module.
// Server-side consumers (API routes, tests) continue to import from this file.
export {
  matchesPattern,
  applyOverrides,
  applySiteRules,
  getStreamDefinition,
  buildClassificationResult,
} from "./waste-rules-core";

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
 * Concise prompt for GPT-5.4 nano — focused on fast, structured classification.
 * No compound-item handling; that escalates to mini.
 */
export function buildNanoPrompt(siteConfig: SiteConfig, locale = "en"): string {
  const streamIds = siteConfig.streams.map((s) => s.id);
  const streams = siteConfig.streams
    .map((s) => `"${s.id}" (${s.label})`)
    .join(", ");

  const overridesSection =
    siteConfig.overrides && siteConfig.overrides.length > 0
      ? `\nItem rules — these override your general knowledge:\n${siteConfig.overrides.map((o) => `- ${o.pattern} → ${o.stream}`).join("\n")}\n`
      : "";

  const langNote =
    locale === "ja"
      ? "\nIMPORTANT: Write itemName and reasoning in Japanese (日本語). wasteStream must remain the English stream_id."
      : "";

  return `You are a waste sorting camera at "${siteConfig.siteName}".
Identify the item being held in front of the camera and classify it.

Streams: ${streams}
${overridesSection}
wasteStream must be exactly one of: ${streamIds.join(", ")}
If the item does not clearly fit any stream, use "needs_review".

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
  const streamIds = siteConfig.streams.map((s) => s.id);
  const streamList = siteConfig.streams
    .map((s) => `- "${s.id}" (${s.label}): ${s.description}`)
    .join("\n");

  const overridesSection =
    siteConfig.overrides && siteConfig.overrides.length > 0
      ? `\nItem rules — these override your general knowledge:\n${siteConfig.overrides.map((o) => `- ${o.pattern} → ${o.stream}${o.note ? ` (${o.note})` : ""}`).join("\n")}\n`
      : "";

  const siteRulesSection =
    siteConfig.siteRules && siteConfig.siteRules.length > 0
      ? `\nSite-specific rules for "${siteConfig.siteName}":\n${siteConfig.siteRules.map((r) => `- Items matching "${r.pattern}": ${r.instruction}`).join("\n")}\n`
      : "";

  return `You are a waste sorting assistant installed at "${siteConfig.siteName}". A camera is pointed at a waste disposal area. Identify the item being held or presented to the camera and classify it.

Available waste streams at this location:
${streamList}
${overridesSection}${siteRulesSection}
Rules:
1. Identify the most prominent item being held or shown.
2. wasteStream must be exactly one of: ${streamIds.join(", ")}. If the item does not clearly fit any stream, use "needs_review".
3. If the image is unclear, blurry, too dark, shows no item, or shows only a person without a discernible waste item, set confidence to 0 and itemName to "nothing detected".
4. Be honest about confidence. Do NOT inflate confidence when the item is ambiguous or partially occluded. When genuinely uncertain, use a low confidence value (below 0.5).
5. Consider the material composition of the item, not just its name.
6. If the item appears to be a compound object with multiple separable parts (e.g., a coffee cup with a plastic lid and cardboard sleeve, a lunch container with food inside, a device with batteries), set isCompound to true and list the components with individual disposal instructions.

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
