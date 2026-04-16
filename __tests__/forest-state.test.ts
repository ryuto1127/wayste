/**
 * Tests for lib/forest-state.ts
 *
 * The forest state uses localStorage which is not available in Node.
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

import {
  getForestState,
  recordSort,
  isForestComplete,
  TREE_POSITIONS,
  type ForestState,
} from "@/lib/forest-state";

beforeEach(() => {
  localStorageMock.clear();
  jest.clearAllMocks();
});

describe("forest-state", () => {
  describe("getForestState", () => {
    it("returns fresh state when no data exists", () => {
      const state = getForestState();
      expect(state.sortCount).toBe(0);
      expect(state.trees).toHaveLength(TREE_POSITIONS);
      expect(state.trees.every((t) => t === 0)).toBe(true);
      expect(state.date).toBe(new Date().toISOString().slice(0, 10));
    });

    it("returns saved state when date matches today", () => {
      const today = new Date().toISOString().slice(0, 10);
      const saved: ForestState = {
        date: today,
        sortCount: 5,
        trees: [1, 1, 1, 1, 1, 0, 0, 0],
      };
      store["rb-forest"] = JSON.stringify(saved);

      const state = getForestState();
      expect(state.sortCount).toBe(5);
      expect(state.trees[0]).toBe(1);
      expect(state.trees[5]).toBe(0);
    });

    it("resets state when date differs from today", () => {
      const saved: ForestState = {
        date: "2020-01-01",
        sortCount: 50,
        trees: [4, 4, 4, 4, 4, 4, 4, 4],
      };
      store["rb-forest"] = JSON.stringify(saved);

      const state = getForestState();
      expect(state.sortCount).toBe(0);
      expect(state.trees.every((t) => t === 0)).toBe(true);
    });

    it("handles invalid JSON gracefully", () => {
      store["rb-forest"] = "not json";
      const state = getForestState();
      expect(state.sortCount).toBe(0);
    });

    it("handles missing fields gracefully", () => {
      store["rb-forest"] = JSON.stringify({ date: "today" });
      const state = getForestState();
      expect(state.sortCount).toBe(0);
    });
  });

  describe("recordSort", () => {
    it("plants a seedling in the first empty position", () => {
      const { newState, advancedIndex } = recordSort();
      expect(newState.sortCount).toBe(1);
      expect(newState.trees[0]).toBe(1);
      expect(advancedIndex).toBe(0);
    });

    it("plants seedlings left to right", () => {
      // Plant 3 seedlings
      recordSort();
      recordSort();
      const { newState } = recordSort();

      expect(newState.sortCount).toBe(3);
      expect(newState.trees[0]).toBe(1);
      expect(newState.trees[1]).toBe(1);
      expect(newState.trees[2]).toBe(1);
      expect(newState.trees[3]).toBe(0);
    });

    it("grows trees after all positions have seedlings", () => {
      // Plant all 8 seedlings
      for (let i = 0; i < TREE_POSITIONS; i++) {
        recordSort();
      }

      // Next sort should grow the first tree
      const { newState, advancedIndex } = recordSort();
      expect(newState.trees[0]).toBe(2); // seedling → small
      expect(advancedIndex).toBe(0);
    });

    it("grows one tree fully before moving to the next", () => {
      // Plant all 8 seedlings
      for (let i = 0; i < TREE_POSITIONS; i++) recordSort();

      // Growth targets the first incomplete tree until it reaches stage 4
      recordSort(); // tree[0] 1→2
      recordSort(); // tree[0] 2→3
      const { newState } = recordSort(); // tree[0] 3→4

      expect(newState.trees[0]).toBe(4); // fully grown
      expect(newState.trees[1]).toBe(1); // still seedling — hasn't started growing
    });

    it("completes forest after 32 sorts", () => {
      // 8 planting + 24 growing (8 trees × 3 growth stages each)
      for (let i = 0; i < 32; i++) {
        recordSort();
      }

      const state = getForestState();
      expect(state.sortCount).toBe(32);
      expect(state.trees.every((t) => t === 4)).toBe(true);
      expect(isForestComplete(state)).toBe(true);
    });

    it("returns null advancedIndex when forest is complete", () => {
      // Complete the forest
      for (let i = 0; i < 32; i++) recordSort();

      const { advancedIndex, newState } = recordSort();
      expect(advancedIndex).toBeNull();
      expect(newState.sortCount).toBe(33);
    });

    it("increments sortCount even when forest is complete", () => {
      for (let i = 0; i < 35; i++) recordSort();
      const state = getForestState();
      expect(state.sortCount).toBe(35);
    });
  });

  describe("isForestComplete", () => {
    it("returns false for fresh state", () => {
      expect(isForestComplete(getForestState())).toBe(false);
    });

    it("returns false when some trees are not fully grown", () => {
      const state: ForestState = {
        date: new Date().toISOString().slice(0, 10),
        sortCount: 20,
        trees: [4, 4, 4, 3, 1, 1, 1, 1],
      };
      expect(isForestComplete(state)).toBe(false);
    });

    it("returns true when all trees at stage 4", () => {
      const state: ForestState = {
        date: new Date().toISOString().slice(0, 10),
        sortCount: 32,
        trees: [4, 4, 4, 4, 4, 4, 4, 4],
      };
      expect(isForestComplete(state)).toBe(true);
    });
  });

  describe("daily reset", () => {
    it("preserves today's state across calls", () => {
      recordSort();
      recordSort();
      const state = getForestState();
      expect(state.sortCount).toBe(2);
    });
  });
});
