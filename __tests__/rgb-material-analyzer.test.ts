/**
 * Tests for lib/rgb-material-analyzer.ts
 */
import { refineClassName } from "@/lib/rgb-material-analyzer";
import type { MaterialHint } from "@/lib/types";

function makeHint(overrides: Partial<MaterialHint> = {}): MaterialHint {
  return {
    dominantHue: 0,
    saturation: 0.3,
    isMetallic: false,
    isTransparent: false,
    suggestedMaterial: null,
    ...overrides,
  };
}

describe("refineClassName", () => {
  it("keeps 'bottle' as-is when metallic (likely can misdetection)", () => {
    const hint = makeHint({ isMetallic: true });
    expect(refineClassName("bottle", hint)).toBe("bottle");
  });

  it("refines 'bottle' + transparent + green hue → 'glass bottle'", () => {
    const hint = makeHint({ isTransparent: true, dominantHue: 120 });
    expect(refineClassName("bottle", hint)).toBe("glass bottle");
  });

  it("does NOT refine 'bottle' + transparent + non-green hue", () => {
    const hint = makeHint({ isTransparent: true, dominantHue: 30 });
    expect(refineClassName("bottle", hint)).toBe("bottle");
  });

  it("refines 'cup' + opaque + low saturation → 'paper cup'", () => {
    const hint = makeHint({ isTransparent: false, saturation: 0.1 });
    expect(refineClassName("cup", hint)).toBe("paper cup");
  });

  it("refines 'coffee cup' + opaque + low saturation → 'paper cup'", () => {
    const hint = makeHint({ isTransparent: false, saturation: 0.1 });
    expect(refineClassName("coffee cup", hint)).toBe("paper cup");
  });

  it("does NOT refine 'plastic cup' to 'paper cup' even with low saturation", () => {
    const hint = makeHint({ isTransparent: false, saturation: 0.1 });
    expect(refineClassName("plastic cup", hint)).toBe("plastic cup");
  });

  it("keeps 'plastic cup' as-is when transparent", () => {
    const hint = makeHint({ isTransparent: true });
    expect(refineClassName("plastic cup", hint)).toBe("plastic cup");
  });

  it("returns original class when no refinement rule matches", () => {
    const hint = makeHint();
    expect(refineClassName("banana peel", hint)).toBe("banana peel");
    expect(refineClassName("cardboard", hint)).toBe("cardboard");
    expect(refineClassName("newspaper", hint)).toBe("newspaper");
  });

  it("handles case-insensitive matching", () => {
    const hint = makeHint({ isTransparent: true, dominantHue: 120 });
    expect(refineClassName("Bottle", hint)).toBe("glass bottle");
    expect(refineClassName("BOTTLE", hint)).toBe("glass bottle");
  });

  it("handles 'water bottle' with transparency + green hue", () => {
    const hint = makeHint({ isTransparent: true, dominantHue: 100 });
    expect(refineClassName("water bottle", hint)).toBe("glass bottle");
  });
});
