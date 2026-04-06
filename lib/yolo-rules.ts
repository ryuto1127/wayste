/**
 * YOLO class-name → waste-stream lookup.
 *
 * Loads rules from /models/yolo-rules.json (COCO-80) and
 * /models/yolo-world-rules.json (recycling-specific open-vocabulary classes).
 * Produces a full ClassificationResponse by running the same override/site-rule
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

let worldRulesCache: YoloRulesConfig | null = null;
let worldRulesLoading: Promise<YoloRulesConfig | null> | null = null;

/** Inject rules cache directly (for testing). */
export function _setRulesCache(config: YoloRulesConfig | null): void {
  rulesCache = config;
}

/** Inject YOLO World rules cache directly (for testing). */
export function _setWorldRulesCache(config: YoloRulesConfig | null): void {
  worldRulesCache = config;
}

/**
 * Check if a COCO-80 class name maps to "not_waste" in the loaded rules.
 * Used to filter out non-waste detections (person, furniture, vehicles, etc.)
 * so they don't block waste detection via Tier 2 / API.
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
 * Load yolo-world-rules.json for YOLO World classes. Cached after first fetch.
 */
export function loadYoloWorldRules(): Promise<YoloRulesConfig | null> {
  if (worldRulesCache) return Promise.resolve(worldRulesCache);
  if (worldRulesLoading) return worldRulesLoading;

  worldRulesLoading = fetch("/models/yolo-world-rules.json")
    .then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json() as Promise<YoloRulesConfig>;
    })
    .then((config) => {
      worldRulesCache = config;
      console.log(
        `[yolo-world-rules] Loaded ${Object.keys(config.rules).length} class rules`
      );
      return config;
    })
    .catch((err) => {
      console.warn("[yolo-world-rules] Failed to load rules:", err);
      return null;
    });

  return worldRulesLoading;
}

/**
 * Attempt to resolve a YOLO detection into a full ClassificationResponse
 * using the rules file and the site's override pipeline.
 *
 * Returns `null` if the detected class has no rule — caller should fall
 * back to the OpenAI API.
 */
export function resolveYoloDetection(
  detection: YoloDetection,
  siteConfig: SiteConfig,
): ClassificationResponse | null {
  if (!rulesCache) return null;

  const rule = rulesCache.rules[detection.className];
  if (!rule) return null;

  // Non-waste items (person, car, furniture, etc.) → instant "nothing detected"
  // so the pipeline doesn't waste time falling through to YOLO World / API.
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
  const result = buildClassificationResult(
    {
      itemName: rule.itemName,
      wasteStream: rule.wasteStream,
      confidence: detection.confidence,
      reasoning: rule.reasoning,
      preAction: rule.preAction,
    },
    siteConfig,
  );

  result.modelUsed = "yolo-local";
  return result;
}

/**
 * Resolve a YOLO World detection into a ClassificationResponse.
 * Uses yolo-world-rules.json for the class→stream mapping.
 */
export function resolveYoloWorldDetection(
  detection: YoloDetection,
  siteConfig: SiteConfig,
): ClassificationResponse | null {
  if (!worldRulesCache) return null;

  const rule = worldRulesCache.rules[detection.className];
  if (!rule) return null;

  const result = buildClassificationResult(
    {
      itemName: rule.itemName,
      wasteStream: rule.wasteStream,
      confidence: detection.confidence,
      reasoning: rule.reasoning,
      preAction: rule.preAction,
    },
    siteConfig,
  );

  result.modelUsed = "yolo-world";
  return result;
}
