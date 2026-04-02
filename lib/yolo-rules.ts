/**
 * YOLO class-name → waste-stream lookup.
 *
 * Loads rules from /models/yolo-rules.json and produces a full
 * ClassificationResponse by running the same override/site-rule pipeline
 * as the server-side API route.
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
 * back to the OpenAI API.
 */
export function resolveYoloDetection(
  detection: YoloDetection,
  siteConfig: SiteConfig,
): ClassificationResponse | null {
  if (!rulesCache) return null;

  const rule = rulesCache.rules[detection.className];
  if (!rule) return null;

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
