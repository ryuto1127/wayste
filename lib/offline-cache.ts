import type { ClassificationResponse } from "./types";

const CACHE_KEY = "recycling-buddy-cache";
const MAX_CACHE_SIZE = 50;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

interface CacheEntry {
  result: ClassificationResponse;
  originalItemName: string;
  timestamp: number;
  hitCount: number;
}

interface CacheStore {
  entries: Record<string, CacheEntry>;
}

/**
 * Normalize cache key for deduplication.
 * - Lowercase, trim, collapse spaces, remove leading articles.
 * - Does NOT remove descriptive adjectives like "empty" or "used" — they
 *   meaningfully affect classification (e.g., "empty bottle" vs "bottle"
 *   may route differently when contamination matters).
 */
export function normalizeKey(itemName: string, locale?: string): string {
  let key = itemName.toLowerCase().trim();
  key = key.replace(/\s+/g, " ");
  key = key.replace(/^(a |an |the )/, "");
  // Prepend locale to prevent cross-language collisions
  // (e.g., "bottle" in en vs "ボトル" in ja are different API results)
  if (locale) key = `${locale}::${key}`;
  return key;
}

/**
 * Compute token-based similarity between two normalized cache keys.
 * Returns 0.0–1.0 where 1.0 is identical.
 * Used for fuzzy cache lookups when exact match fails.
 */
function tokenSimilarity(a: string, b: string): number {
  // Strip locale prefix for comparison
  const stripLocale = (s: string) => s.includes("::") ? s.split("::").slice(1).join("::") : s;
  const tokA = new Set(stripLocale(a).split(" ").filter(Boolean));
  const tokB = new Set(stripLocale(b).split(" ").filter(Boolean));
  if (tokA.size === 0 || tokB.size === 0) return 0;
  let overlap = 0;
  for (const t of tokA) {
    if (tokB.has(t)) overlap++;
  }
  // Jaccard similarity
  const union = new Set([...tokA, ...tokB]).size;
  return union > 0 ? overlap / union : 0;
}

function loadCache(): CacheStore {
  if (typeof window === "undefined") return { entries: {} };
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return { entries: {} };
    return JSON.parse(raw) as CacheStore;
  } catch {
    return { entries: {} };
  }
}

function saveCache(store: CacheStore): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(store));
  } catch {
    // localStorage full or unavailable — silently ignore
  }
}

export function getCachedResult(
  itemName: string,
  locale?: string,
): ClassificationResponse | null {
  const store = loadCache();
  const key = normalizeKey(itemName, locale);
  let entry = store.entries[key];

  // Fuzzy match: if exact key miss, try token-based similarity
  if (!entry) {
    const FUZZY_THRESHOLD = 0.7;
    let bestScore = 0;
    let bestKey: string | null = null;
    for (const candidateKey of Object.keys(store.entries)) {
      // Only match within same locale
      if (locale && !candidateKey.startsWith(`${locale}::`)) continue;
      const score = tokenSimilarity(key, candidateKey);
      if (score > bestScore && score >= FUZZY_THRESHOLD) {
        bestScore = score;
        bestKey = candidateKey;
      }
    }
    if (bestKey) {
      entry = store.entries[bestKey];
    }
    if (!entry) return null;
  }

  // Check TTL
  if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
    delete store.entries[key];
    saveCache(store);
    return null;
  }

  // Only return cached results that are high confidence
  if (entry.result.confidence < 0.75) return null;

  // Update hit count
  entry.hitCount++;
  saveCache(store);

  return entry.result;
}

export function cacheResult(result: ClassificationResponse, locale?: string): void {
  // Only cache high-confidence, non-review results
  if (result.confidence < 0.75 || result.needsReview) return;

  const store = loadCache();
  const key = normalizeKey(result.itemName, locale);

  store.entries[key] = {
    result,
    originalItemName: result.itemName,
    timestamp: Date.now(),
    hitCount: 0,
  };

  // Evict old entries if cache is too large
  const entries = Object.entries(store.entries);
  if (entries.length > MAX_CACHE_SIZE) {
    // Remove oldest, least-used entries
    entries.sort(
      (a, b) => a[1].hitCount - b[1].hitCount || a[1].timestamp - b[1].timestamp
    );
    const toRemove = entries.slice(0, entries.length - MAX_CACHE_SIZE);
    for (const [k] of toRemove) {
      delete store.entries[k];
    }
  }

  saveCache(store);
}

export function getCacheStats(): {
  size: number;
  items: string[];
} {
  const store = loadCache();
  return {
    size: Object.keys(store.entries).length,
    items: Object.keys(store.entries),
  };
}
