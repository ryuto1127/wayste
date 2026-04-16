/**
 * localStorage-based forest growth state for kiosk gamification.
 * Each successful sort plants a seedling or grows a tree.
 * Resets daily at midnight.
 */

export type TreeStage = 0 | 1 | 2 | 3 | 4;
// 0 = empty, 1 = seedling, 2 = small, 3 = medium, 4 = large

export interface ForestState {
  date: string; // "YYYY-MM-DD" — daily reset trigger
  sortCount: number; // all successful sorts today
  trees: TreeStage[]; // length 8
}

const FOREST_LS_KEY = "rb-forest";
export const TREE_POSITIONS = 8;

function todayString(): string {
  return new Date().toISOString().slice(0, 10);
}

function freshState(): ForestState {
  return {
    date: todayString(),
    sortCount: 0,
    trees: Array(TREE_POSITIONS).fill(0) as TreeStage[],
  };
}

function readLS(): ForestState | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(FOREST_LS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (
      typeof parsed.date !== "string" ||
      typeof parsed.sortCount !== "number" ||
      !Array.isArray(parsed.trees) ||
      parsed.trees.length !== TREE_POSITIONS
    ) {
      return null;
    }
    return parsed as ForestState;
  } catch {
    return null;
  }
}

function writeLS(state: ForestState): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(FOREST_LS_KEY, JSON.stringify(state));
  } catch {
    // localStorage full or unavailable — silently ignore
  }
}

/** Read current forest state. Resets if date has changed. */
export function getForestState(): ForestState {
  const saved = readLS();
  if (!saved || saved.date !== todayString()) {
    const fresh = freshState();
    writeLS(fresh);
    return fresh;
  }
  return saved;
}

/**
 * Record a successful sort. Advances one tree:
 * - If any position is empty (stage 0) → plant seedling (→ stage 1)
 * - Else → grow the first tree not at stage 4 by one stage
 *
 * Returns the new state and the index of the tree that advanced (null if forest full).
 */
export function recordSort(): {
  newState: ForestState;
  advancedIndex: number | null;
} {
  const state = getForestState();
  state.sortCount++;

  let advancedIndex: number | null = null;

  // Phase 1: plant seedlings in empty positions
  const emptyIdx = state.trees.indexOf(0 as TreeStage);
  if (emptyIdx !== -1) {
    state.trees[emptyIdx] = 1 as TreeStage;
    advancedIndex = emptyIdx;
  } else {
    // Phase 2: grow the first tree that isn't fully grown
    const growIdx = state.trees.findIndex((t) => t > 0 && t < 4);
    if (growIdx !== -1) {
      state.trees[growIdx] = (state.trees[growIdx] + 1) as TreeStage;
      advancedIndex = growIdx;
    }
    // All trees at stage 4 → forest complete, no advancement
  }

  writeLS(state);
  return { newState: state, advancedIndex };
}

/** Check if all 8 trees are at maximum stage. */
export function isForestComplete(state: ForestState): boolean {
  return state.trees.every((t) => t === 4);
}
