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

export interface OverrideResult {
  stream: WasteStream;
  overrideApplied: boolean;
  note?: string;
  requiresStaff: boolean;
  /** Present when the matched override has a conditional stream. */
  conditionalStream?: WasteStream;
  /** The condition string (e.g. "clean") for conditional overrides. */
  condition?: string;
}

export function applyOverrides(
  itemName: string,
  claudeStream: WasteStream,
  siteConfig: SiteConfig,
  locale: string = "en",
): OverrideResult {
  // Check staffHandlingItems first — these always force needs_review
  if (siteConfig.staffHandlingItems) {
    for (const pattern of siteConfig.staffHandlingItems) {
      if (matchesPattern(itemName, pattern)) {
        return {
          stream: "needs_review",
          overrideApplied: true,
          note: `In ${siteConfig.siteName}, this item requires staff handling.`,
          requiresStaff: true,
        };
      }
    }
  }

  const sorted = [...siteConfig.overrides].sort(
    (a, b) => b.pattern.length - a.pattern.length
  );

  for (const override of sorted) {
    if (matchesPattern(itemName, override.pattern)) {
      const requiresStaff = override.requiresStaff ?? false;
      const stream = requiresStaff || !override.stream ? "needs_review" : override.stream;
      const note = (locale === "ja" && override.note_ja) ? override.note_ja : override.note;
      return {
        stream,
        overrideApplied: true,
        note,
        requiresStaff,
        conditionalStream: override.conditionalStream,
        condition: override.condition,
      };
    }
  }

  return { stream: claudeStream, overrideApplied: false, requiresStaff: false };
}

/**
 * Check if itemName matches a config-defined compound rule.
 * Config compounds take priority over AI-detected compound detection.
 * Longer patterns are checked first (more specific wins).
 */
export function applyCompounds(
  itemName: string,
  siteConfig: SiteConfig
): { isCompound: false } | { isCompound: true; components: ComponentPart[] } {
  if (!siteConfig.compounds || siteConfig.compounds.length === 0) {
    return { isCompound: false };
  }

  const sorted = [...siteConfig.compounds].sort(
    (a, b) => b.pattern.length - a.pattern.length
  );

  for (const compound of sorted) {
    if (matchesPattern(itemName, compound.pattern)) {
      return { isCompound: true, components: compound.components };
    }
  }

  return { isCompound: false };
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
  siteConfig: SiteConfig,
  locale: string = "en",
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

  const { stream: overriddenStream, note: overrideNote, requiresStaff } = applyOverrides(
    raw.itemName,
    raw.wasteStream,
    siteConfig,
    locale,
  );

  const isNothingDetected =
    raw.itemName.toLowerCase() === "nothing detected" ||
    raw.itemName.toLowerCase() === "unknown";

  const needsReview = confidence < threshold || requiresStaff || isNothingDetected;

  let finalStream: WasteStream;
  if (requiresStaff) {
    finalStream = "needs_review";
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

  // Config-driven compounds take priority over AI-detected compound detection
  const configCompound = applyCompounds(raw.itemName, siteConfig);
  const isCompound = configCompound.isCompound || (raw.isCompound ?? false);
  let components: ComponentPart[] | undefined =
    configCompound.isCompound ? configCompound.components : raw.components;

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
    reasoning: overrideNote ?? raw.reasoning,
    binColor,
    binLabel,
    specialInstructions: overrideNote,
    preAction: raw.preAction || undefined,
    needsReview,
    isCompound,
    components: isCompound ? components : undefined,
  };
}
