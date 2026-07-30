/**
 * i18n key-parity test.
 *
 * The kiosk falls back to English when a JA key is missing (t() uses `??`),
 * so a missing translation never crashes — it silently ships English text.
 * This test makes that drift loud: EN and JA must expose the exact same keys.
 */

import { translations } from "@/lib/i18n";

describe("i18n translations", () => {
  const enKeys = Object.keys(translations.en).sort();
  const jaKeys = Object.keys(translations.ja).sort();

  it("EN and JA have identical key sets", () => {
    // toEqual on the sorted arrays gives a readable diff naming the
    // missing/extra keys when this fails.
    expect(jaKeys).toEqual(enKeys);
  });

  it("every translation value is a non-empty string", () => {
    for (const locale of ["en", "ja"] as const) {
      for (const [key, value] of Object.entries(translations[locale])) {
        expect(typeof value).toBe("string");
        expect((value as string).length).toBeGreaterThan(0);
        if ((value as string).length === 0) {
          throw new Error(`Empty translation: ${locale}.${key}`);
        }
      }
    }
  });
});
