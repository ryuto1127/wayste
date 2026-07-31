/**
 * CJK pattern matching in matchesPattern / applyOverrides.
 *
 * Regression guard: pure-Japanese patterns used to match ONLY by exact
 * string equality (the word-split produced zero ASCII words and bailed),
 * which silently disabled overrides AND the staffHandlingItems safety
 * gate for any name variation (「蛍光灯（直管）」, 「空のペットボトル」...).
 */
import { matchesPattern, applyOverrides } from "@/lib/waste-rules-core";
import { loadSiteConfig } from "@/lib/waste-rules";

describe("matchesPattern — CJK substring matching", () => {
  it("matches Japanese patterns inside longer item names", () => {
    expect(matchesPattern("蛍光灯（直管）", "蛍光灯")).toBe(true);
    expect(matchesPattern("スプレー缶（未使用）", "スプレー缶")).toBe(true);
    expect(matchesPattern("空のペットボトル", "ペットボトル")).toBe(true);
    expect(matchesPattern("ガラス瓶", "びん")).toBe(false); // 瓶≠びん — no false positive
    expect(matchesPattern("茶色びん", "びん")).toBe(true);
  });

  it("still matches exact Japanese names", () => {
    expect(matchesPattern("アルミ缶", "アルミ缶")).toBe(true);
    expect(matchesPattern("電池", "電池")).toBe(true);
  });

  it("does not regress English word-boundary behavior", () => {
    expect(matchesPattern("paper cup", "cup")).toBe(true);
    expect(matchesPattern("cupcake", "cup")).toBe(false);
    expect(matchesPattern("AA battery", "battery")).toBe(true);
    expect(matchesPattern("combattery", "battery")).toBe(false);
  });
});

describe("applyOverrides — Japanese safety gate", () => {
  const config = loadSiteConfig("japan-office");

  it("staffHandlingItems fires on name variations (スプレー缶)", () => {
    const r = applyOverrides("スプレー缶（中身あり）", "recyclable", config, "ja");
    expect(r.stream).toBe("needs_review");
    expect(r.requiresStaff).toBe(true);
  });

  it("overrides fire on prefixed item names (空のペットボトル)", () => {
    const r = applyOverrides("空のペットボトル", "burnable", config, "ja");
    expect(r.overrideApplied).toBe(true);
    expect(r.stream).toBe("recyclable");
  });
});
