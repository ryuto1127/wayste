/**
 * Tests for lib/continuous-cards.ts — card-sync layer for continuous mode.
 *
 * Each scenario feeds tracker-shaped tracks/events plus the previous cycle's
 * cards and asserts the sync produces the right card map and actions:
 * instant resolution, needs_review after the grace period, needs_review →
 * resolved upgrades, class-swap replacement, removal on lost/parked tracks,
 * and session end when all items leave the scene.
 */

import {
  syncContinuousCards,
  type CardSyncResolvers,
  type CardSyncThresholds,
} from "@/lib/continuous-cards";
import type { Track, TrackerEvent } from "@/lib/detection-tracker";
import type { ClassificationResponse, TrackedResult } from "@/lib/types";

/** Instant bar matching the default-sensitivity YOLO_FALLBACK_THRESHOLD. */
const TH: CardSyncThresholds = { instantConfidence: 0.725, needsReviewMs: 1500 };
/** Same thresholds with a steadiness gate (as the kiosk passes in). */
const TH_GATED: CardSyncThresholds = {
  ...TH,
  needsReviewGate: (t) => t.travelEma <= 8,
};

function track(overrides: Partial<Track> = {}): Track {
  return {
    id: 1,
    bbox: [100, 100, 120, 200],
    className: "plastic_bottle",
    classId: 0,
    confidence: 0.8,
    state: "confirmed",
    hitRing: [1, 1, 1],
    missStreak: 0,
    firstSeenAt: 0,
    confirmedAt: 0,
    lastMatchedAt: 0,
    parked: false,
    anchorCenter: [160, 200],
    anchorSince: 0,
    swapClassName: null,
    swapClassId: -1,
    swapCount: 0,
    swapSince: 0,
    travelEma: 0,
    lastRawCenter: [160, 200],
    ...overrides,
  };
}

/** Fake site rules: two resolvable classes, everything else has no rule. */
const RULES: Record<string, string> = {
  plastic_bottle: "recycling",
  paper_cup: "compost",
};

const resolvers: CardSyncResolvers = {
  resolveTrack: (t): ClassificationResponse | null => {
    const stream = RULES[t.className];
    if (!stream) return null;
    return {
      itemName: t.className,
      wasteStream: stream,
      confidence: t.confidence,
      reasoning: "yolo rule",
      binColor: "#2563EB",
      binLabel: stream,
      needsReview: false,
      isCompound: false,
      modelUsed: "T1",
    };
  },
  buildNeedsReview: (): ClassificationResponse => ({
    itemName: "uncertain",
    wasteStream: "needs_review",
    confidence: 0.3,
    reasoning: "local fallback",
    binColor: "#D97706",
    binLabel: "Needs Verification",
    needsReview: true,
    isCompound: false,
    modelUsed: "T1",
  }),
};

function sync(
  tracks: Track[],
  cards: ReadonlyMap<number, TrackedResult> = new Map(),
  opts: { events?: TrackerEvent[]; now?: number } = {},
) {
  return syncContinuousCards(tracks, opts.events ?? [], cards, TH, opts.now ?? 0, resolvers);
}

describe("syncContinuousCards", () => {
  describe("instant resolution", () => {
    it("resolves a confident confirmed track on-device immediately", () => {
      const t = track({ confidence: 0.8 });
      const { cards, changed, actions } = sync([t]);

      const card = cards.get(t.id)!;
      expect(card.wasteStream).toBe("recycling");
      expect(card._locked).toBe(true);
      expect(card._trackId).toBe(t.id);
      expect(card._trackBbox).toEqual(t.bbox);
      expect(changed).toBe(true);
      expect(actions).toEqual([
        expect.objectContaining({ type: "instantHit", card }),
      ]);
    });

    it("ignores tentative (unconfirmed) tracks", () => {
      const { cards, changed, actions } = sync([
        track({ state: "tentative", confirmedAt: null, confidence: 0.9 }),
      ]);
      expect(cards.size).toBe(0);
      expect(changed).toBe(false);
      expect(actions).toHaveLength(0);
    });

    it("shows nothing for a below-bar track still inside the grace period", () => {
      const { cards, changed } = sync(
        [track({ confidence: 0.5 })],
        new Map(),
        { now: TH.needsReviewMs - 1 },
      );
      expect(cards.size).toBe(0);
      expect(changed).toBe(false);
    });
  });

  describe("needs_review after the grace period", () => {
    it("resolves a below-bar track as needs_review once the grace period elapses", () => {
      const t = track({ confidence: 0.5, confirmedAt: 0 });
      const { cards, actions } = sync([t], new Map(), { now: TH.needsReviewMs });

      const card = cards.get(t.id)!;
      expect(card.wasteStream).toBe("needs_review");
      expect(card._locked).toBe(false);
      expect(actions).toEqual([
        expect.objectContaining({ type: "needsReview", card }),
      ]);
    });

    it("falls back to needs_review for a confident class with no site rule", () => {
      const t = track({ className: "mystery_object", confidence: 0.9 });
      // Above the bar but unresolvable — must not stay silent forever.
      const early = sync([t]);
      expect(early.cards.size).toBe(0);

      const late = sync([t], new Map(), { now: TH.needsReviewMs });
      expect(late.cards.get(t.id)!.wasteStream).toBe("needs_review");
    });
  });

  describe("needs_review → resolved upgrade", () => {
    it("upgrades an unlocked card once confidence clears the instant bar", () => {
      const t = track({ confidence: 0.5 });
      const { cards: withReview } = sync([t], new Map(), { now: TH.needsReviewMs });

      const firm = track({ confidence: 0.8 });
      const { cards, changed, actions } = sync([firm], withReview, {
        now: TH.needsReviewMs + 100,
      });

      const card = cards.get(firm.id)!;
      expect(card.wasteStream).toBe("recycling");
      expect(card._locked).toBe(true);
      expect(changed).toBe(true);
      expect(actions).toEqual([
        expect.objectContaining({ type: "upgraded", card }),
      ]);
    });

    it("never re-resolves a locked card", () => {
      const t = track({ confidence: 0.8 });
      const { cards: first } = sync([t]);

      // Same track now reads as a different (resolvable) class.
      const reread = track({ className: "paper_cup", classId: 2, confidence: 0.9 });
      const { cards, changed, actions } = sync([reread], first, { now: 100 });

      expect(cards.get(t.id)!.wasteStream).toBe("recycling");
      expect(changed).toBe(false);
      expect(actions).toHaveLength(0);
    });

    it("keeps an unresolvable unlocked card as needs_review without churn", () => {
      const t = track({ className: "mystery_object", confidence: 0.5 });
      const { cards: withReview } = sync([t], new Map(), { now: TH.needsReviewMs });

      const firm = track({ className: "mystery_object", confidence: 0.9 });
      const { cards, changed } = sync([firm], withReview, { now: TH.needsReviewMs + 100 });
      expect(cards.get(t.id)!.wasteStream).toBe("needs_review");
      expect(changed).toBe(false);
    });
  });

  describe("class swap (item replaced at same location)", () => {
    it("replaces the card when the tracker votes a confident class swap", () => {
      const bottle = track({ confidence: 0.8 });
      const { cards: first } = sync([bottle]);

      const cup = track({ className: "paper_cup", classId: 2, confidence: 0.8 });
      const { cards, actions } = sync([cup], first, {
        events: [{ type: "classChanged", track: cup, previousClassName: "plastic_bottle" }],
        now: 500,
      });

      const card = cards.get(cup.id)!;
      expect(card.wasteStream).toBe("compost");
      expect(actions).toContainEqual(
        expect.objectContaining({ type: "classSwapped", previousClassName: "plastic_bottle" }),
      );
    });

    it("replaces with needs_review when the new class is low-confidence", () => {
      const bottle = track({ confidence: 0.8 });
      const { cards: first } = sync([bottle]);

      const cup = track({ className: "paper_cup", classId: 2, confidence: 0.5 });
      const { cards } = sync([cup], first, {
        events: [{ type: "classChanged", track: cup, previousClassName: "plastic_bottle" }],
        now: 500,
      });
      const card = cards.get(cup.id)!;
      expect(card.wasteStream).toBe("needs_review");
      expect(card._locked).toBe(false);
    });

    it("ignores a swap event for a track that has no card yet", () => {
      const cup = track({ className: "paper_cup", classId: 2, confidence: 0.5 });
      const { cards, changed } = sync([cup], new Map(), {
        events: [{ type: "classChanged", track: cup, previousClassName: "plastic_bottle" }],
        now: 500,
      });
      expect(cards.size).toBe(0);
      expect(changed).toBe(false);
    });
  });

  describe("card removal and session end", () => {
    it("drops the card when its track vanishes, ending the session", () => {
      const t = track({ confidence: 0.8 });
      const { cards: first } = sync([t]);

      const { cards, changed, sessionEnded } = sync([], first, { now: 3000 });
      expect(cards.size).toBe(0);
      expect(changed).toBe(true);
      expect(sessionEnded).toBe(true);
    });

    it("drops the card when the track is parked-suppressed (leftover trash)", () => {
      const t = track({ confidence: 0.8 });
      const { cards: first } = sync([t]);

      const parked = track({ parked: true });
      const { cards, sessionEnded } = sync([parked], first, { now: 200_000 });
      expect(cards.size).toBe(0);
      expect(sessionEnded).toBe(true);
    });

    it("keeps the card while the track is merely coasting (occlusion)", () => {
      const t = track({ confidence: 0.8 });
      const { cards: first } = sync([t]);

      const coasting = track({ state: "coasting" });
      const { cards, changed, sessionEnded } = sync([coasting], first, { now: 500 });
      expect(cards.get(t.id)!.wasteStream).toBe("recycling");
      expect(changed).toBe(false);
      expect(sessionEnded).toBe(false);
    });

    it("does not end the session while another item is still displayed", () => {
      const bottle = track({ id: 1, confidence: 0.8 });
      const cup = track({
        id: 2, className: "paper_cup", classId: 2, confidence: 0.8,
        bbox: [400, 100, 100, 150],
      });
      const { cards: first } = sync([bottle, cup]);
      expect(first.size).toBe(2);

      const { cards, changed, sessionEnded } = sync([cup], first, { now: 3000 });
      expect([...cards.keys()]).toEqual([2]);
      expect(changed).toBe(true);
      expect(sessionEnded).toBe(false);
    });

    it("does not end a session that never showed results", () => {
      const { changed, sessionEnded } = sync([], new Map(), { now: 3000 });
      expect(changed).toBe(false);
      expect(sessionEnded).toBe(false);
    });
  });

  describe("purity and bbox follow", () => {
    it("never mutates the input card map or its cards", () => {
      const t = track({ confidence: 0.8 });
      const { cards: first } = sync([t]);
      const original = first.get(t.id)!;
      const originalBbox = [...original._trackBbox];

      const moved = track({ bbox: [150, 120, 120, 200] });
      const next = sync([moved], first, { now: 100 });

      expect(first.size).toBe(1);
      expect(first.get(t.id)).toBe(original);
      expect(original._trackBbox).toEqual(originalBbox);
      // The returned card follows the track's new box...
      expect(next.cards.get(t.id)!._trackBbox).toEqual([150, 120, 120, 200]);
      // ...but a bbox follow alone must not re-render the card list.
      expect(next.changed).toBe(false);
    });
  });

  describe("needsReviewGate (steadiness)", () => {
    it("blocks a needs_review card for a fast-moving track (clothing on a walker)", () => {
      const moving = track({ className: "mystery", classId: -1, confidence: 0.5, travelEma: 30 });
      const out = syncContinuousCards([moving], [], new Map(), TH_GATED, 2000, resolvers);
      expect(out.cards.size).toBe(0);
    });

    it("allows the card once the track settles", () => {
      const steady = track({ className: "mystery", classId: -1, confidence: 0.5, travelEma: 3 });
      const out = syncContinuousCards([steady], [], new Map(), TH_GATED, 2000, resolvers);
      expect(out.cards.size).toBe(1);
      expect(out.cards.get(1)!.needsReview).toBe(true);
    });

    it("never gates instant hits", () => {
      const movingConfident = track({ confidence: 0.9, travelEma: 30 });
      const out = syncContinuousCards([movingConfident], [], new Map(), TH_GATED, 2000, resolvers);
      expect(out.cards.size).toBe(1);
      expect(out.cards.get(1)!.needsReview).toBe(false);
    });
  });
});
