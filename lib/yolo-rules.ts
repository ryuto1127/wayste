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
  Tier1SubclassContext,
  YoloDetection,
  YoloRulesConfig,
} from "./types";
import { buildClassificationResult } from "./waste-rules-core";
import { poolConfidence } from "./material-vocabulary";

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

/** Confidence threshold for focused material sub-classification routing (80%).
 *  Above this: T2 material vocabulary path.
 *  Below this: general T2/T3 escalation (T1 rules skipped). */
const SUBCLASS_CONFIDENCE_THRESHOLD = 0.80;

/**
 * Result of resolving a YOLO detection.
 *
 * - `{ result }` — fully resolved classification
 * - `{ needsSubclassification, subclassContext }` — high-confidence detection
 *   of a class that requires material identification; caller must route to
 *   Tier 2 material vocabulary.
 * - `null` — no rule matched OR material-ambiguous class below threshold;
 *   caller falls back to YOLO World / API.
 */
export type YoloResolution =
  | { result: ClassificationResponse; needsSubclassification?: false }
  | { result: null; needsSubclassification: true; subclassContext: Tier1SubclassContext };

/**
 * Attempt to resolve a YOLO detection into a full ClassificationResponse
 * using the rules file and the site's override pipeline.
 *
 * Returns `null` if the detected class has no rule — caller should fall
 * back to the OpenAI API.
 *
 * When the rule has `needsSubclassification: true` and confidence ≥ 0.80,
 * returns a `YoloResolution` with `needsSubclassification: true` so the
 * caller can route to the material-focused Tier 2/3 path.
 *
 * When `needsSubclassification: true` but confidence < 0.80, returns `null`
 * so the caller routes to general T2 (YOLO World) → T3 (GPT mini).
 */
export function resolveYoloDetection(
  detection: YoloDetection,
  siteConfig: SiteConfig,
  locale?: string,
): ClassificationResponse | null;
/**
 * Overload that returns the full resolution object including sub-classification
 * context. Pass `returnResolution: true` to use this form.
 */
export function resolveYoloDetection(
  detection: YoloDetection,
  siteConfig: SiteConfig,
  locale: string,
  returnResolution: true,
): YoloResolution | null;
export function resolveYoloDetection(
  detection: YoloDetection,
  siteConfig: SiteConfig,
  locale: string = "en",
  returnResolution?: boolean,
): ClassificationResponse | YoloResolution | null {
  if (!rulesCache) return null;

  const rule = rulesCache.rules[detection.className];
  if (!rule) return null;

  // Non-waste items (person, car, furniture, etc.) → instant "nothing detected"
  // so the pipeline doesn't waste time falling through to YOLO World / API.
  if (rule.wasteStream === "not_waste") {
    const result: ClassificationResponse = {
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
    return returnResolution ? { result } : result;
  }

  // Sub-classification routing: material-ambiguous class (bottle, cup, bowl,
  // cutlery, wine glass).
  //   ≥ 80%: focused material sub-classification via T2 material vocabulary
  //   < 80%: skip T1 rules entirely → general T2 (YOLO World) → T3 (GPT mini)
  if (rule.needsSubclassification) {
    if (detection.confidence >= SUBCLASS_CONFIDENCE_THRESHOLD) {
      if (returnResolution) {
        return {
          result: null,
          needsSubclassification: true,
          subclassContext: {
            className: detection.className,
            confidence: detection.confidence,
            bbox: detection.bbox,
          },
        };
      }
    }
    // Below threshold or legacy call: return null → general T2/T3 escalation
    return null;
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
    locale,
  );

  result.modelUsed = "yolo-local";
  return returnResolution ? { result } : result;
}

/**
 * Resolve a YOLO World detection into a ClassificationResponse.
 * Uses yolo-world-rules.json for the class→stream mapping.
 */
export function resolveYoloWorldDetection(
  detection: YoloDetection,
  siteConfig: SiteConfig,
  locale: string = "en",
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
    locale,
  );

  result.modelUsed = "yolo-world";
  return result;
}

/**
 * Apply confidence pooling to YOLO World detections, then attempt resolution.
 * Pooling combines same-stream material classes (e.g., aluminium + steel cans)
 * so split confidence doesn't cause unnecessary fallback to Tier 3.
 *
 * @param detections Raw YOLO World detections (pre-sorted by confidence desc).
 * @param siteConfig Site configuration for stream mapping.
 * @param locale Current locale.
 * @returns Pooled detections and the best resolved result (if any).
 */
export function resolveYoloWorldWithPooling(
  detections: YoloDetection[],
  siteConfig: SiteConfig,
  locale: string = "en",
): {
  pooledDetections: YoloDetection[];
  bestResult: ClassificationResponse | null;
  bestDetection: YoloDetection | null;
} {
  const pooled = poolConfidence(detections);

  let bestResult: ClassificationResponse | null = null;
  let bestDetection: YoloDetection | null = null;

  for (const det of pooled) {
    const result = resolveYoloWorldDetection(det, siteConfig, locale);
    if (result && (!bestResult || det.confidence > (bestDetection?.confidence ?? 0))) {
      bestResult = result;
      bestDetection = det;
    }
  }

  return { pooledDetections: pooled, bestResult, bestDetection };
}

/** Class names that indicate PET bottle components. */
const PET_BOTTLE_CLASSES = new Set(["plastic bottle"]);
const PET_ACCESSORY_CLASSES = new Set(["plastic bottle cap", "plastic bottle label"]);

/**
 * Check if YOLO World detections contain a PET bottle with cap/label still
 * attached. If so, build a compound ClassificationResponse with per-component
 * separation instructions.
 *
 * Returns `null` when the detections don't match the PET-compound pattern —
 * caller should proceed with normal resolution.
 */
export function resolvePetBottleCompound(
  detections: YoloDetection[],
  siteConfig: SiteConfig,
  locale: string = "en",
): ClassificationResponse | null {
  const bottle = detections.find((d) => PET_BOTTLE_CLASSES.has(d.className));
  if (!bottle) return null;

  const accessories = detections.filter((d) => PET_ACCESSORY_CLASSES.has(d.className));
  if (accessories.length === 0) return null;

  // We have bottle + at least one accessory → compound result
  const ja = locale === "ja";

  const components: { partName: string; wasteStream: string; instruction: string }[] = [
    {
      partName: ja ? "ペットボトル本体" : "PET bottle",
      wasteStream: "recycling",
      instruction: ja ? "中を空にして洗い、資源ゴミへ" : "Empty, rinse, and recycle",
    },
  ];

  for (const acc of accessories) {
    if (acc.className === "plastic bottle cap") {
      components.push({
        partName: ja ? "キャップ" : "Bottle cap",
        wasteStream: siteConfig.streams.find((s) => s.id === "plastic") ? "plastic" : "recycling",
        instruction: ja ? "キャップを外してプラスチックへ" : "Remove cap and place in plastic waste",
      });
    } else if (acc.className === "plastic bottle label") {
      components.push({
        partName: ja ? "ラベル" : "Bottle label",
        wasteStream: siteConfig.streams.find((s) => s.id === "plastic") ? "plastic" : "recycling",
        instruction: ja ? "ラベルを剥がしてプラスチックへ" : "Peel off label and place in plastic waste",
      });
    }
  }

  const bottleStream = siteConfig.streams.find((s) => s.id === "recycling");

  return {
    itemName: ja ? "ペットボトル" : "PET Bottle",
    wasteStream: "recycling",
    confidence: bottle.confidence,
    reasoning: ja
      ? "キャップやラベルを外してから分別してください"
      : "Remove cap and label before recycling the bottle",
    preAction: ja
      ? "キャップとラベルを外してください"
      : "Remove the cap and label",
    binColor: bottleStream?.color ?? "#3B82F6",
    binLabel: bottleStream?.label ?? "Recycling",
    needsReview: false,
    isCompound: true,
    components,
    modelUsed: "yolo-world",
  };
}
