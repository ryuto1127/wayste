/**
 * Every shipped site preset must be able to display on-device YOLO results.
 *
 * Regression guard: yolo-rules.json uses Japan-style stream ids
 * (recyclable/burnable/plastic/special). Sites with different stream naming
 * (airport, office-hq) previously received ONLY needs_review from the
 * instant path because the unknown stream fell back — the on-device tier
 * was silently dead on 2 of 4 presets. `yoloStreamMap` fixes the routing;
 * this test pins it for every preset and every YOLO class.
 */
import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import { loadSiteConfig } from "@/lib/waste-rules";
import { resolveYoloDetection, _setRulesCache } from "@/lib/yolo-rules";
import type { YoloRulesConfig, YoloDetection } from "@/lib/types";

const rules: YoloRulesConfig = JSON.parse(
  readFileSync(join(process.cwd(), "public", "models", "yolo-rules.json"), "utf-8"),
);

const SITE_IDS = readdirSync(join(process.cwd(), "config", "sites"))
  .filter((f) => f.endsWith(".json"))
  .map((f) => f.replace(/\.json$/, ""));

beforeAll(() => _setRulesCache(rules));
afterAll(() => _setRulesCache(null));

function makeDetection(className: string): YoloDetection {
  return { classId: 0, className, confidence: 0.92, bbox: [100, 100, 200, 300] };
}

describe.each(SITE_IDS)("site preset: %s", (siteId) => {
  const config = loadSiteConfig(siteId);
  const streamIds = new Set(config.streams.map((s) => s.id));
  const classNames = Object.keys(rules.rules);

  it("maps every yolo-rules stream to a stream that exists on this site", () => {
    for (const [className, rule] of Object.entries(rules.rules)) {
      if (rule.wasteStream === "not_waste") continue;
      const mapped = config.yoloStreamMap?.[rule.wasteStream] ?? rule.wasteStream;
      expect({ className, mapped, known: streamIds.has(mapped) }).toEqual({
        className,
        mapped,
        known: true,
      });
    }
  });

  it("confident detections do not all collapse to needs_review", () => {
    const resolvedStreams = classNames.map((c) => {
      const r = resolveYoloDetection(makeDetection(c), config, config.defaultLocale ?? "en");
      return r?.wasteStream;
    });
    const nonReview = resolvedStreams.filter((s) => s && s !== "needs_review");
    // Overrides/staff rules may legitimately send SOME items to review,
    // but the instant path must be alive: most classes resolve to a bin.
    expect(nonReview.length).toBeGreaterThanOrEqual(classNames.length / 2);
  });
});
