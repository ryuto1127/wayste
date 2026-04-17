/**
 * Material sub-classification vocabulary and confidence pooling.
 *
 * Maps COCO-80 Tier 1 classes to narrowed YOLO World vocabularies for
 * material identification. Used by:
 *   - KioskDisplay.tsx (Tier 2 routing: filter YOLO World detections)
 *   - waste-rules.ts (Tier 3 prompt: list possible materials with visual cues)
 *
 * LIMITATION: The YOLO World ONNX model is exported with pre-baked class
 * embeddings (53 classes). Dynamic vocabulary injection at runtime is not
 * feasible without model re-export. Instead, the full 53-class vocabulary
 * runs and results are filtered to the relevant material subset here.
 * Classes marked with (*) are NOT in the current YOLO World model and can
 * only be resolved via Tier 3 (GPT material identification prompt).
 */

/**
 * YOLO World classes relevant to each Tier 1 COCO class.
 * All classes listed here exist in the re-exported YOLO World model (53 classes).
 */
export const MATERIAL_VOCABULARY: Record<string, string[]> = {
  bottle:       ["plastic bottle", "glass bottle", "glass jar", "aluminium beverage can", "steel beverage can"],
  cup:          ["paper cup", "plastic cup", "styrofoam cup", "ceramic mug", "coffee cup"],
  bowl:         ["plastic container", "ceramic bowl", "paper bowl", "glass jar"],
  fork:         ["metal fork", "plastic fork", "wooden fork", "wooden chopsticks"],
  knife:        ["metal knife", "plastic knife", "wooden knife"],
  spoon:        ["metal spoon", "plastic spoon", "wooden spoon"],
  "wine glass": ["glass wine glass", "plastic wine glass"],
};

/**
 * Visual cue descriptions per Tier 1 class, used in the Tier 3
 * material identification prompt.
 */
export const MATERIAL_VISUAL_CUES: Record<string, { material: string; cues: string }[]> = {
  bottle: [
    { material: "PET plastic", cues: "clear or colored, lightweight, crinkles when squeezed, recycling symbol ♳" },
    { material: "Glass", cues: "heavy, rigid, thick walls, slight color tint, smooth surface" },
    { material: "Aluminium metal", cues: "lightweight, pull-tab, printed graphics wrap around" },
    { material: "Steel metal", cues: "similar to aluminium, matte finish, may be magnetic" },
  ],
  cup: [
    { material: "Paper with plastic lining", cues: "lightweight, printed cardboard, waxy interior" },
    { material: "Clear plastic", cues: "transparent, thin-walled, may have a recycling number on bottom" },
    { material: "Styrofoam/EPS", cues: "white, porous, very lightweight, squeaks when rubbed" },
    { material: "Ceramic", cues: "heavy, opaque, often has a handle, glazed surface" },
  ],
  bowl: [
    { material: "Plastic", cues: "lightweight, may be transparent or colored, flexible" },
    { material: "Ceramic or glass", cues: "heavy, rigid, smooth glazed surface" },
    { material: "Paper", cues: "lightweight, flexible, may be wax-coated" },
  ],
  fork: [
    { material: "Metal", cues: "reflective, heavy, rigid, may have decorative pattern" },
    { material: "Plastic", cues: "lightweight, often white/clear/colored, may be flimsy" },
    { material: "Wood or bamboo", cues: "natural grain, light brown, lightweight" },
  ],
  knife: [
    { material: "Metal", cues: "reflective, heavy, rigid, may have decorative pattern" },
    { material: "Plastic", cues: "lightweight, often white/clear/colored, may be flimsy" },
    { material: "Wood or bamboo", cues: "natural grain, light brown, lightweight" },
  ],
  spoon: [
    { material: "Metal", cues: "reflective, heavy, rigid, may have decorative pattern" },
    { material: "Plastic", cues: "lightweight, often white/clear/colored, may be flimsy" },
    { material: "Wood or bamboo", cues: "natural grain, light brown, lightweight" },
  ],
  "wine glass": [
    { material: "Glass", cues: "clear, thin, fragile, may have a stem" },
    { material: "Plastic/acrylic", cues: "lighter, less fragile, may be slightly cloudy" },
  ],
};

/**
 * Confidence pooling groups: YOLO World classes that represent the same
 * material category and should have their confidence pooled.
 *
 * When Tier 2 returns multiple detections from the same group, their
 * confidence is combined using the complement method:
 *   pooled = 1 - ∏(1 - d.confidence)
 * The class name of the highest-confidence member is used.
 */
export const CONFIDENCE_POOL_GROUPS: string[][] = [
  ["aluminium beverage can", "steel beverage can"],
  ["glass bottle", "glass jar"],
  ["steel beverage can", "steel food can"],
];

/**
 * Pool YOLO World detections that belong to the same confidence group.
 * Returns a new array with pooled detections replacing individual members.
 * Non-grouped detections are passed through unchanged.
 */
export function poolConfidence<T extends { className: string; confidence: number }>(
  detections: T[],
): T[] {
  const used = new Set<number>();
  const result: T[] = [];

  for (const group of CONFIDENCE_POOL_GROUPS) {
    const groupSet = new Set(group);
    const members: { detection: T; index: number }[] = [];
    for (let i = 0; i < detections.length; i++) {
      if (groupSet.has(detections[i].className)) {
        members.push({ detection: detections[i], index: i });
      }
    }
    if (members.length < 2) continue; // pooling only applies with 2+ members

    // Complement method: pooled = 1 - ∏(1 - confidence)
    let complementProduct = 1;
    let bestMember = members[0];
    for (const m of members) {
      complementProduct *= (1 - m.detection.confidence);
      if (m.detection.confidence > bestMember.detection.confidence) {
        bestMember = m;
      }
      used.add(m.index);
    }
    const pooledConfidence = 1 - complementProduct;

    result.push({
      ...bestMember.detection,
      confidence: pooledConfidence,
    });
  }

  // Pass through detections not in any pool group
  for (let i = 0; i < detections.length; i++) {
    if (!used.has(i)) result.push(detections[i]);
  }

  // Re-sort by confidence descending
  result.sort((a, b) => b.confidence - a.confidence);
  return result;
}
