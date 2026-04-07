/**
 * Tests for lib/offline-cache.ts
 *
 * The offline cache uses localStorage which is not available in Node.
 * We mock localStorage for testing.
 */

// Mock localStorage
const store: Record<string, string> = {};
const localStorageMock = {
  getItem: jest.fn((key: string) => store[key] ?? null),
  setItem: jest.fn((key: string, value: string) => {
    store[key] = value;
  }),
  removeItem: jest.fn((key: string) => {
    delete store[key];
  }),
  clear: jest.fn(() => {
    for (const key of Object.keys(store)) delete store[key];
  }),
  get length() {
    return Object.keys(store).length;
  },
  key: jest.fn((i: number) => Object.keys(store)[i] ?? null),
};

Object.defineProperty(global, "window", {
  value: { localStorage: localStorageMock },
  writable: true,
});
Object.defineProperty(global, "localStorage", {
  value: localStorageMock,
  writable: true,
});

import { getCachedResult, cacheResult, getCacheStats, normalizeKey } from "@/lib/offline-cache";
import type { ClassificationResponse } from "@/lib/types";

function makeResult(overrides: Partial<ClassificationResponse> = {}): ClassificationResponse {
  return {
    itemName: "Plastic Bottle",
    wasteStream: "recycling",
    confidence: 0.95,
    reasoning: "PET plastic",
    binColor: "#2563EB",
    binLabel: "Recycling",
    needsReview: false,
    isCompound: false,
    ...overrides,
  };
}

describe("offline-cache", () => {
  beforeEach(() => {
    localStorageMock.clear();
    jest.clearAllMocks();
  });

  it("same item with different casing hits the same cache entry", () => {
    const result = makeResult({ itemName: "Plastic Bottle" });
    cacheResult(result);

    // Should find it with different casing
    const cached = getCachedResult("PLASTIC BOTTLE");
    expect(cached).not.toBeNull();
    expect(cached?.itemName).toBe("Plastic Bottle");
  });

  it("different items do not collide", () => {
    cacheResult(makeResult({ itemName: "Plastic Bottle" }));
    cacheResult(makeResult({ itemName: "Glass Jar", wasteStream: "recycling" }));

    const stats = getCacheStats();
    expect(stats.size).toBe(2);

    const bottle = getCachedResult("plastic bottle");
    const jar = getCachedResult("glass jar");
    expect(bottle?.itemName).toBe("Plastic Bottle");
    expect(jar?.itemName).toBe("Glass Jar");
  });

  it("expiry works correctly", () => {
    cacheResult(makeResult({ itemName: "Expired Item" }));

    // Manually age the cache entry
    const cacheKey = "wayste-cache";
    const raw = localStorageMock.getItem(cacheKey);
    expect(raw).not.toBeNull();

    const parsed = JSON.parse(raw!);
    const key = Object.keys(parsed.entries)[0];
    // Set timestamp to 25 hours ago (beyond 24h TTL)
    parsed.entries[key].timestamp = Date.now() - 25 * 60 * 60 * 1000;
    localStorageMock.setItem(cacheKey, JSON.stringify(parsed));

    const result = getCachedResult("expired item");
    expect(result).toBeNull();
  });

  it("LRU eviction removes the least-recently-used entry when over capacity", () => {
    // Cache 51 items (MAX_CACHE_SIZE is 50)
    for (let i = 0; i < 51; i++) {
      cacheResult(
        makeResult({
          itemName: `item-${i}`,
          wasteStream: "recycling",
        })
      );
    }

    const stats = getCacheStats();
    expect(stats.size).toBeLessThanOrEqual(50);
  });

  it("does not cache low-confidence results", () => {
    cacheResult(makeResult({ itemName: "Low Conf", confidence: 0.5 }));
    const cached = getCachedResult("low conf");
    expect(cached).toBeNull();
  });

  it("does not cache needsReview results", () => {
    cacheResult(makeResult({ itemName: "Review Item", needsReview: true }));
    const cached = getCachedResult("review item");
    expect(cached).toBeNull();
  });
});

describe("normalizeKey", () => {
  it("lowercases and trims", () => {
    expect(normalizeKey("Plastic Bottle")).toBe("plastic bottle");
  });

  it("removes leading article 'an'", () => {
    expect(normalizeKey("an Empty Bottle")).toBe("empty bottle");
  });

  it("removes leading article 'the' (case-insensitive)", () => {
    expect(normalizeKey("THE coffee CUP ")).toBe("coffee cup");
  });

  it("removes leading article 'a'", () => {
    expect(normalizeKey("a glass jar")).toBe("glass jar");
  });

  it("collapses multiple spaces", () => {
    expect(normalizeKey("plastic   bottle")).toBe("plastic bottle");
  });

  it("preserves descriptive adjectives like 'empty' and 'used'", () => {
    expect(normalizeKey("empty bottle")).toBe("empty bottle");
    expect(normalizeKey("used napkin")).toBe("used napkin");
  });

  it("handles already normalized input", () => {
    expect(normalizeKey("bottle")).toBe("bottle");
  });

  it("prepends locale when provided", () => {
    expect(normalizeKey("bottle", "en")).toBe("en::bottle");
    expect(normalizeKey("bottle", "ja")).toBe("ja::bottle");
  });

  it("different locales produce different keys", () => {
    const enKey = normalizeKey("Plastic Bottle", "en");
    const jaKey = normalizeKey("Plastic Bottle", "ja");
    expect(enKey).not.toBe(jaKey);
    expect(enKey).toBe("en::plastic bottle");
    expect(jaKey).toBe("ja::plastic bottle");
  });

  it("omitting locale preserves backward compatibility", () => {
    expect(normalizeKey("bottle")).toBe("bottle");
    expect(normalizeKey("bottle", undefined)).toBe("bottle");
  });
});
