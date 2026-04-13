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
 * Used to filter out non-waste detections (person, furniture, vehicles, etc.)
 * so they don't block waste detection via the API.
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
 * Returns `null` if the detected class has no rule — caller should fall
 * back to the API (GPT mini).
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
      modelUsed: "yolo-local",
    };
  }

  // Run through the same override/site-rule pipeline as the API route
  const ja = locale === "ja";
  const result = buildClassificationResult(
    {
      itemName: (ja && rule.itemName_ja) ? rule.itemName_ja : rule.itemName,
      wasteStream: rule.wasteStream,
      confidence: detection.confidence,
      reasoning: rule.reasoning,
      preAction: (ja && rule.preAction_ja) ? rule.preAction_ja : rule.preAction,
    },
    siteConfig,
    locale,
  );

  result.modelUsed = "yolo-local";
  return result;
}
