/**
 * localStorage-based kiosk counter.
 *
 * Tracks two numbers, incremented on every successful classification:
 *  - `today` — resets at midnight (local date)
 *  - `cumulative` — never resets
 *
 * Used by IdleScreen to show rotating stats (today's sorts, bag equivalent,
 * cumulative total). Per-kiosk; not synced to server.
 */

export interface KioskCounters {
  /** "YYYY-MM-DD" — daily reset trigger for `today`. */
  date: string;
  today: number;
  cumulative: number;
}

const KIOSK_COUNTER_LS_KEY = "wayste-kiosk-counter";

/** Items per trash-bag equivalent for environmental impact display. */
export const ITEMS_PER_BAG = 20;

function todayString(): string {
  return new Date().toISOString().slice(0, 10);
}

function freshState(): KioskCounters {
  return { date: todayString(), today: 0, cumulative: 0 };
}

function readLS(): KioskCounters | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(KIOSK_COUNTER_LS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (
      typeof parsed.date !== "string" ||
      typeof parsed.today !== "number" ||
      typeof parsed.cumulative !== "number"
    ) {
      return null;
    }
    return parsed as KioskCounters;
  } catch {
    return null;
  }
}

function writeLS(state: KioskCounters): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(KIOSK_COUNTER_LS_KEY, JSON.stringify(state));
  } catch {
    // localStorage full or unavailable — silently ignore
  }
}

/**
 * Read current counters. Resets `today` to 0 when the date rolls over,
 * preserving `cumulative`.
 */
export function getCounters(): KioskCounters {
  const saved = readLS();
  const today = todayString();
  if (!saved) {
    const fresh = freshState();
    writeLS(fresh);
    return fresh;
  }
  if (saved.date !== today) {
    const rolled: KioskCounters = {
      date: today,
      today: 0,
      cumulative: saved.cumulative,
    };
    writeLS(rolled);
    return rolled;
  }
  return saved;
}

/** Record a successful sort. Increments `today` and `cumulative` by 1. */
export function recordSort(): KioskCounters {
  const state = getCounters();
  const next: KioskCounters = {
    ...state,
    today: state.today + 1,
    cumulative: state.cumulative + 1,
  };
  writeLS(next);
  return next;
}

/** Convert a sort count into trash-bag equivalents (floor). */
export function bagsEquivalent(sorts: number): number {
  return Math.floor(sorts / ITEMS_PER_BAG);
}
