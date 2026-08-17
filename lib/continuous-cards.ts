/**
 * Card-sync logic for continuous detection mode.
 *
 * Bridges DetectionTracker output (stable tracks + events) to the result
 * cards the kiosk displays. Decides, per cycle:
 *
 *   - instant on-device resolution when a track's smoothed confidence clears
 *     the instant bar (YOLO_FALLBACK_THRESHOLD)
 *   - needs_review after a grace period below the bar — the kiosk must
 *     always answer, never scan silently
 *   - needs_review → resolved upgrade once confidence firms up
 *   - card replacement when the tracker votes a class swap (item swapped at
 *     the same location)
 *   - card removal when a track vanishes or is parked-suppressed
 *   - session end (all cards gone after results were shown) so the caller
 *     can record a completed sort
 *
 * Pure logic, browser-safe, no side effects — unit-tested without a DOM.
 * KioskDisplay is a thin adapter: it feeds tracker output in, swaps in the
 * returned card map, and performs the logging the returned actions describe.
 */

import type { ClassificationResponse, TrackedResult } from "./types";
import { DetectionTracker, type Track, type TrackerEvent } from "./detection-tracker";

export interface CardSyncThresholds {
  /** Smoothed confidence needed for instant on-device resolution
   *  (YOLO_FALLBACK_THRESHOLD from threshold-config). */
  instantConfidence: number;
  /** How long a confirmed track may stay below the instant bar before it is
   *  resolved on-device as needs_review. */
  needsReviewMs: number;
  /** Optional gate consulted before CREATING a needs_review card. Lets the
   *  caller require e.g. a steady track (low travelEma) so patterns riding
   *  on moving clothing/hands never surface as cards. Instant hits and
   *  upgrades are unaffected. Absent → always allowed. */
  needsReviewGate?: (track: Track) => boolean;
}

/** Resolution hooks the caller provides — site rules and locale live there. */
export interface CardSyncResolvers {
  /** Resolve a track's class via YOLO rules, or null when this site has no
   *  rule for the class. */
  resolveTrack(track: Track): ClassificationResponse | null;
  /** Build the on-device needs_review result. */
  buildNeedsReview(): ClassificationResponse;
}

/** What happened this cycle — the adapter turns these into logs/uploads. */
export type CardSyncAction =
  | { type: "instantHit"; card: TrackedResult; track: Track }
  | { type: "needsReview"; card: TrackedResult; track: Track }
  | { type: "upgraded"; card: TrackedResult; track: Track }
  | { type: "classSwapped"; card: TrackedResult; track: Track; previousClassName: string };

export interface CardSyncResult {
  /** The new card map — the input map is never mutated. */
  cards: Map<number, TrackedResult>;
  /** True when the card set or content changed. A bbox follow alone does NOT
   *  count — the adapter re-renders result cards only when this is true. */
  changed: boolean;
  actions: CardSyncAction[];
  /** All cards vanished after results were shown → the sort session is over
   *  and the caller should record it. */
  sessionEnded: boolean;
}

/** Stamp a resolved response with the track's identity so the card follows
 *  its box on screen. `locked` cards never re-resolve. */
function toCard(r: ClassificationResponse, t: Track, locked: boolean): TrackedResult {
  return {
    ...r,
    _trackBbox: [...t.bbox] as [number, number, number, number],
    _trackId: t.id,
    _locked: locked,
  };
}

/**
 * One continuous-mode sync step: reconcile the previous cycle's cards with
 * the tracker's current tracks and events.
 */
export function syncContinuousCards(
  tracks: Track[],
  events: TrackerEvent[],
  existingCards: ReadonlyMap<number, TrackedResult>,
  thresholds: CardSyncThresholds,
  now: number,
  resolvers: CardSyncResolvers,
): CardSyncResult {
  const cards = new Map(existingCards);
  const actions: CardSyncAction[] = [];
  let changed = false;

  const displayable = tracks.filter((t) => DetectionTracker.isDisplayable(t));
  const displayableIds = new Set(displayable.map((t) => t.id));

  // ── Drop cards whose track vanished or was parked-suppressed ──
  for (const id of [...cards.keys()]) {
    if (!displayableIds.has(id)) {
      cards.delete(id);
      changed = true;
    }
  }

  const resolveTrack = (t: Track): TrackedResult | null => {
    const r = resolvers.resolveTrack(t);
    // A needsReview-flagged result is by definition NOT final: the rule
    // matched but confidence sat below the site's review bar. Locking it
    // would freeze the card at 確認が必要 with no way out — the upgrade
    // path skips locked cards and so does the VLM judge. Leave it unlocked
    // so rising confidence re-resolves it and the VLM may name it.
    return r ? toCard(r, t, !r.needsReview) : null;
  };
  const needsReviewCard = (t: Track): TrackedResult =>
    toCard(resolvers.buildNeedsReview(), t, false);

  for (const t of displayable) {
    const existing = cards.get(t.id);
    if (!existing) {
      // Confident → instant on-device resolution via YOLO rules.
      if (t.confidence >= thresholds.instantConfidence) {
        const card = resolveTrack(t);
        if (card) {
          cards.set(t.id, card);
          changed = true;
          actions.push({ type: "instantHit", card, track: t });
          continue;
        }
      }
      // Below the instant bar (or no rule): give confidence a moment to
      // firm up, then resolve on-device as needs_review.
      if (
        now - (t.confirmedAt ?? now) >= thresholds.needsReviewMs &&
        (thresholds.needsReviewGate?.(t) ?? true)
      ) {
        const card = needsReviewCard(t);
        cards.set(t.id, card);
        changed = true;
        actions.push({ type: "needsReview", card, track: t });
      }
    } else {
      // Follow the track's box without re-rendering the card list.
      cards.set(t.id, {
        ...existing,
        _trackBbox: [...t.bbox] as [number, number, number, number],
      });
      // needs_review cards upgrade once confidence clears the instant bar.
      if (!existing._locked && t.confidence >= thresholds.instantConfidence) {
        const card = resolveTrack(t);
        if (card) {
          cards.set(t.id, card);
          changed = true;
          actions.push({ type: "upgraded", card, track: t });
        }
      }
    }
  }

  // ── Item swapped at the same location → replace the card ──
  for (const ev of events) {
    if (ev.type !== "classChanged") continue;
    const t = ev.track;
    if (!cards.has(t.id) || !displayableIds.has(t.id)) continue;
    const card =
      (t.confidence >= thresholds.instantConfidence ? resolveTrack(t) : null) ??
      needsReviewCard(t);
    cards.set(t.id, card);
    changed = true;
    actions.push({
      type: "classSwapped",
      card,
      track: t,
      previousClassName: ev.previousClassName,
    });
  }

  const sessionEnded = changed && cards.size === 0 && existingCards.size > 0;

  return { cards, changed, actions, sessionEnded };
}
