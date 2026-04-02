/**
 * Pure, browser-safe waste-rules functions.
 *
 * Extracted from waste-rules.ts so they can be imported in client components
 * (waste-rules.ts imports `fs` which breaks in the browser).
 * Server-side code continues to import from waste-rules.ts which re-exports
 * everything here.
 */
import type {
  SiteConfig,
  WasteStream,
  StreamDefinition,
  ClassificationResponse,
  ComponentPart,
} from "./types";

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
 */
export function matchesPattern(itemName: string, pattern: string): boolean {
  const lowerItem = itemName.toLowerCase();
  const lowerPattern = pattern.toLowerCase();

  // Fast path: exact match
  if (lowerItem === lowerPattern) return true;

  const patternWords = lowerPattern.split(/[^a-z0-9]+/).filter(Boolean);
  const itemWords = lowerItem.split(/[^a-z0-9]+/).filter(Boolean);

  if (patternWords.length === 0) return false;

  const allPatternWordsMatch = patternWords.every((pw) =>
    itemWords.some((iw) => iw === pw)
  );
  if (allPatternWordsMatch) return true;

  // Fallback for compound words and hyphenated patterns
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

  const knownStreamIds = new Set(siteConfig.streams.map((s) => s.id));
  if (raw.wasteStream && !knownStreamIds.has(raw.wasteStream)) {
    console.warn(
      `[waste-rules] Model returned unknown stream "${raw.wasteStream}" — falling back to needs_review`
    );
    raw = { ...raw, wasteStream: "needs_review" };
  }

  const { stream: overriddenStream, note: overrideNote } = applyOverrides(
    raw.itemName,
    raw.wasteStream,
    siteConfig
  );

  const { siteNote, requiresStaff, streamOverride: siteStreamOverride } =
    applySiteRules(raw.itemName, siteConfig);

  const isNothingDetected =
    raw.itemName.toLowerCase() === "nothing detected" ||
    raw.itemName.toLowerCase() === "unknown";

  const needsReview =
    confidence < threshold || requiresStaff || isNothingDetected;

  let finalStream: WasteStream;
  if (siteStreamOverride) {
    finalStream = siteStreamOverride;
  } else if (confidence < threshold && !overrideNote) {
    finalStream = "needs_review";
  } else {
    finalStream = overriddenStream;
  }

  const streamDef = getStreamDefinition(finalStream, siteConfig);

  const isReview = finalStream === "needs_review";
  const binColor = isReview
    ? "#D97706"
    : (streamDef?.color ?? "#525252");
  const binLabel = isReview
    ? "Needs Verification"
    : (streamDef?.label ?? "Landfill");

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
