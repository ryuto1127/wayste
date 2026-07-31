/**
 * YOLO class-name → waste-stream lookup.
 *
 * Loads rules from /models/yolo-rules.json and produces a full
 * ClassificationResponse by running the same override/site-rule
 * pipeline as the server-side API route.
 */
import type {
  ClassificationResponse,
  SiteConfig,
  YoloDetection,
  YoloRulesConfig,
} from "./types";
import { buildClassificationResult } from "./waste-rules-core";

let rulesCache: YoloRulesConfig | null = null;
let rulesLoading: Promise<YoloRulesConfig | null> | null = null;

/** Inject rules cache directly (for testing). */
export function _setRulesCache(config: YoloRulesConfig | null): void {
  rulesCache = config;
}

/**
 * Check if a class name maps to "not_waste" in the loaded rules.
 * Forward-compat guard for models that emit non-waste classes (person,
 * furniture, vehicles, etc.) so they don't block waste detection via the API.
 * NOTE: the shipped 15-class model (`public/models/yolo-rules.json`) has no
 * "not_waste" entries, so this currently always returns false — a no-op kept
 * for when a broader model is loaded.
 */
export function isYoloClassNotWaste(className: string): boolean {
  if (!rulesCache) return false;
  const rule = rulesCache.rules[className];
  return rule?.wasteStream === "not_waste";
}

/**
 * Load yolo-rules.json from the public directory. Cached after first fetch.
 */
export function loadYoloRules(): Promise<YoloRulesConfig | null> {
  if (rulesCache) return Promise.resolve(rulesCache);
  if (rulesLoading) return rulesLoading;

  rulesLoading = fetch("/models/yolo-rules.json")
    .then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json() as Promise<YoloRulesConfig>;
    })
    .then((config) => {
      rulesCache = config;
      console.log(
        `[yolo-rules] Loaded ${Object.keys(config.rules).length} class rules`
      );
      return config;
    })
    .catch((err) => {
      console.warn("[yolo-rules] Failed to load rules:", err);
      return null;
    });

  return rulesLoading;
}

/**
 * Attempt to resolve a YOLO detection into a full ClassificationResponse
 * using the rules file and the site's override pipeline.
 *
 * Returns `null` if the detected class has no rule — in the default
 * local-only mode the caller resolves the item on-device as needs_review
 * (lib/local-fallback.ts); the cloud API is only consulted when the
 * NEXT_PUBLIC_CLOUD_FALLBACK=1 pilot flag is set.
 */
export function resolveYoloDetection(
  detection: YoloDetection,
  siteConfig: SiteConfig,
  locale: string = "en",
): ClassificationResponse | null {
  if (!rulesCache) return null;

  const rule = rulesCache.rules[detection.className];
  if (!rule) return null;

  // Non-waste items (person, car, furniture, etc.) → instant "nothing detected"
  if (rule.wasteStream === "not_waste") {
    return {
      itemName: "nothing_detected",
      wasteStream: "landfill",
      confidence: 0,
      reasoning: rule.reasoning,
      binColor: "#525252",
      binLabel: "",
      needsReview: false,
      isCompound: false,
      modelUsed: "T1",
    };
  }

  // Translate the rule's stream id into this site's naming when the site
  // provides a mapping (e.g. recyclable -> recycling for US-style configs).
  // Unmapped unknown streams still fall back to needs_review downstream.
  const wasteStream = siteConfig.yoloStreamMap?.[rule.wasteStream] ?? rule.wasteStream;

  // Run through the same override/site-rule pipeline as the API route
  const ja = locale === "ja";
  const result = buildClassificationResult(
    {
      itemName: (ja && rule.itemName_ja) ? rule.itemName_ja : rule.itemName,
      wasteStream,
      confidence: detection.confidence,
      reasoning: (ja && rule.reasoning_ja) ? rule.reasoning_ja : rule.reasoning,
      preAction: (ja && rule.preAction_ja) ? rule.preAction_ja : rule.preAction,
    },
    siteConfig,
    locale,
  );

  result.modelUsed = "T1";
  return result;
}
