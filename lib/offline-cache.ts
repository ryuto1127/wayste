import type { ClassificationResponse } from "./types";

const CACHE_KEY = "recycling-buddy-cache";
const MAX_CACHE_SIZE = 50;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

interface CacheEntry {
  result: ClassificationResponse;
  timestamp: number;
  hitCount: number;
}

interface CacheStore {
  entries: Record<string, CacheEntry>;
}

function normalizeKey(itemName: string): string {
  return itemName.toLowerCase().trim();
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
  itemName: string
): ClassificationResponse | null {
  const store = loadCache();
  const key = normalizeKey(itemName);
  const entry = store.entries[key];

  if (!entry) return null;

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

export function cacheResult(result: ClassificationResponse): void {
  // Only cache high-confidence, non-review results
  if (result.confidence < 0.75 || result.needsReview) return;

  const store = loadCache();
  const key = normalizeKey(result.itemName);

  store.entries[key] = {
    result,
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
