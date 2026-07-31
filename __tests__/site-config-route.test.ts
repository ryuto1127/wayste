/**
 * Tests for app/api/site-config/route.ts.
 *
 * This route is the kiosk's SOLE source of routing rules — the browser
 * builds classification results locally from this payload. If a future
 * edit trims the payload again (the exact regression fixed in 80fabba:
 * missing `overrides` crashed buildClassificationResult and killed the
 * YOLO loop), these tests fail loudly.
 */
import { readdirSync } from "fs";
import { join } from "path";
import { GET } from "@/app/api/site-config/route";

const SITE_IDS = readdirSync(join(process.cwd(), "config", "sites"))
  .filter((f) => f.endsWith(".json"))
  .map((f) => f.replace(/\.json$/, ""));

const ORIGINAL_SITE_ID = process.env.SITE_ID;

afterEach(() => {
  if (ORIGINAL_SITE_ID === undefined) delete process.env.SITE_ID;
  else process.env.SITE_ID = ORIGINAL_SITE_ID;
});

describe("GET /api/site-config", () => {
  it("serves every field the on-device classification path needs", async () => {
    delete process.env.SITE_ID; // default: japan-office
    const res = await GET();
    const body = await res.json();

    // Fields buildClassificationResult / KioskDisplay consume client-side.
    expect(typeof body.siteId).toBe("string");
    expect(typeof body.siteName).toBe("string");
    expect(Array.isArray(body.streams)).toBe(true);
    expect(body.streams.length).toBeGreaterThan(0);
    expect(typeof body.sensitivity).toBe("number");
    expect(typeof body.reviewThreshold).toBe("number");
    expect(typeof body.defaultStream).toBe("string");
    expect(Array.isArray(body.overrides)).toBe(true);
    expect(body.overrides.length).toBeGreaterThan(0);
    expect(Array.isArray(body.compounds)).toBe(true);
    expect(Array.isArray(body.staffHandlingItems)).toBe(true);
  });

  it.each(SITE_IDS)("returns a coherent payload for the %s preset", async (siteId) => {
    process.env.SITE_ID = siteId;
    const res = await GET();
    const body = await res.json();

    expect(body.siteId).toBe(siteId);
    const streamIds = new Set(body.streams.map((s: { id: string }) => s.id));
    // Every override must target a stream that exists on this site.
    for (const o of body.overrides) {
      if (o.stream) {
        expect(streamIds.has(o.stream)).toBe(true);
      }
    }
    // yoloStreamMap targets must also be real streams.
    if (body.yoloStreamMap) {
      for (const target of Object.values(body.yoloStreamMap)) {
        expect(streamIds.has(target as string)).toBe(true);
      }
    }
  });
});
