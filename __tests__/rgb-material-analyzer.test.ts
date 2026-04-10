/**
 * Tests for lib/rgb-material-analyzer.ts
 */
import { refineClassName, computeLbpTexture, detectMetallicFromLuminance } from "@/lib/rgb-material-analyzer";
import type { MaterialHint, TextureHint } from "@/lib/types";

function makeHint(overrides: Partial<MaterialHint> = {}): MaterialHint {
  return {
    dominantHue: 0,
    saturation: 0.3,
    isMetallic: false,
    suggestedMaterial: null,
    bboxAspectRatio: 0.7,
    ...overrides,
  };
}

describe("refineClassName", () => {
  // ── Metallic + circular bbox → aluminum can ──

  it("refines 'bottle' + metallic + circular bbox → 'aluminum can'", () => {
    const hint = makeHint({ isMetallic: true, bboxAspectRatio: 0.8 });
    expect(refineClassName("bottle", hint)).toBe("aluminum can");
  });

  it("refines 'can' + metallic + circular bbox → 'aluminum can'", () => {
    const hint = makeHint({ isMetallic: true, bboxAspectRatio: 1.0 });
    expect(refineClassName("can", hint)).toBe("aluminum can");
  });

  it("refines 'cup' (exact) + metallic + circular bbox → 'aluminum can'", () => {
    const hint = makeHint({ isMetallic: true, bboxAspectRatio: 0.9, saturation: 0.3 });
    expect(refineClassName("cup", hint)).toBe("aluminum can");
  });

  it("keeps 'bottle' + metallic + elongated bbox as-is (not can-shaped)", () => {
    const hint = makeHint({ isMetallic: true, bboxAspectRatio: 0.3 });
    expect(refineClassName("bottle", hint)).toBe("bottle");
  });

  // ── Cup + low saturation → paper cup ──

  it("refines 'cup' + low saturation → 'paper cup'", () => {
    const hint = makeHint({ saturation: 0.1 });
    expect(refineClassName("cup", hint)).toBe("paper cup");
  });

  it("refines 'coffee cup' + low saturation → 'paper cup'", () => {
    const hint = makeHint({ saturation: 0.1 });
    expect(refineClassName("coffee cup", hint)).toBe("paper cup");
  });

  it("does NOT refine 'plastic cup' to 'paper cup' even with low saturation", () => {
    const hint = makeHint({ saturation: 0.1 });
    expect(refineClassName("plastic cup", hint)).toBe("plastic cup");
  });

  // ── No-match passthrough ──

  it("returns original class when no refinement rule matches", () => {
    const hint = makeHint();
    expect(refineClassName("banana peel", hint)).toBe("banana peel");
    expect(refineClassName("newspaper", hint)).toBe("newspaper");
  });

  it("handles case-insensitive matching", () => {
    const hint = makeHint({ isMetallic: true, bboxAspectRatio: 0.8 });
    expect(refineClassName("Bottle", hint)).toBe("aluminum can");
    expect(refineClassName("BOTTLE", hint)).toBe("aluminum can");
  });

  // ── White/low-saturation + rectangular → paper carton ──

  it("refines 'box' + low-sat + rectangular → 'paper carton'", () => {
    const hint = makeHint({ saturation: 0.1, bboxAspectRatio: 0.6 });
    expect(refineClassName("box", hint)).toBe("paper carton");
  });

  it("refines 'carton' + low-sat + tall → 'paper carton'", () => {
    const hint = makeHint({ saturation: 0.1, bboxAspectRatio: 0.5 });
    expect(refineClassName("carton", hint)).toBe("paper carton");
  });

  it("refines 'container' + low-sat + rectangular → 'paper carton'", () => {
    const hint = makeHint({ saturation: 0.1, bboxAspectRatio: 0.7 });
    expect(refineClassName("container", hint)).toBe("paper carton");
  });

  it("does NOT refine 'box' to paper carton if not rectangular (wide bbox)", () => {
    const hint = makeHint({ saturation: 0.1, bboxAspectRatio: 1.2 });
    // Falls to cardboard rule if hue matches, otherwise no refinement
    expect(refineClassName("box", hint)).not.toBe("paper carton");
  });

  // ── Brown hue + low saturation → cardboard ──

  it("refines 'box' + brown hue + low sat → 'cardboard'", () => {
    const hint = makeHint({ dominantHue: 25, saturation: 0.2, bboxAspectRatio: 1.0 });
    expect(refineClassName("box", hint)).toBe("cardboard");
  });

  it("refines 'cardboard' + brown hue → 'cardboard' (confirms)", () => {
    const hint = makeHint({ dominantHue: 30, saturation: 0.15 });
    expect(refineClassName("cardboard", hint)).toBe("cardboard");
  });

  it("refines 'package' + brown hue + low sat → 'cardboard'", () => {
    const hint = makeHint({ dominantHue: 35, saturation: 0.25 });
    expect(refineClassName("package", hint)).toBe("cardboard");
  });

  // ── Shiny + high saturation → plastic wrapper ──

  it("refines 'bag' + metallic + high saturation → 'plastic wrapper'", () => {
    const hint = makeHint({ isMetallic: true, saturation: 0.6, bboxAspectRatio: 1.5 });
    expect(refineClassName("bag", hint)).toBe("plastic wrapper");
  });

  it("refines 'wrapper' + metallic + high sat → 'plastic wrapper'", () => {
    const hint = makeHint({ isMetallic: true, saturation: 0.7, bboxAspectRatio: 1.5 });
    expect(refineClassName("wrapper", hint)).toBe("plastic wrapper");
  });

  it("refines 'snack' + metallic + high sat → 'plastic wrapper'", () => {
    const hint = makeHint({ isMetallic: true, saturation: 0.55, bboxAspectRatio: 1.5 });
    expect(refineClassName("snack", hint)).toBe("plastic wrapper");
  });

  it("does NOT refine 'bag' to wrapper if not metallic", () => {
    const hint = makeHint({ isMetallic: false, saturation: 0.7 });
    expect(refineClassName("bag", hint)).toBe("bag");
  });

  // ── Texture-enhanced disambiguation ──

  it("refines 'cup' + metal texture + metallic → 'aluminum can'", () => {
    const texture: TextureHint = { uniformity: 0.4, edgeDensity: 0.4, suggestedSurface: "metal" };
    const hint = makeHint({ saturation: 0.1, isMetallic: true, bboxAspectRatio: 0.9, texture });
    expect(refineClassName("cup", hint)).toBe("aluminum can");
  });

  it("refines 'cup' + paper texture → 'paper cup'", () => {
    const texture: TextureHint = { uniformity: 0.8, edgeDensity: 0.1, suggestedSurface: "paper" };
    const hint = makeHint({ saturation: 0.1, texture });
    expect(refineClassName("cup", hint)).toBe("paper cup");
  });
});

describe("detectMetallicFromLuminance", () => {
  it("detects metallic surface: high stddev + sharp highlights", () => {
    // Simulate aluminum can: body ~90, sharp highlights ~220
    const luminances = [
      ...Array(70).fill(90),   // dark body
      ...Array(20).fill(140),  // mid tones
      ...Array(10).fill(220),  // sharp specular highlights
    ];
    expect(detectMetallicFromLuminance(luminances)).toBe(true);
  });

  it("rejects plastic surface: low stddev + diffuse highlights", () => {
    // Simulate plastic bottle: body ~110, soft highlights ~140
    const luminances = [
      ...Array(60).fill(110),
      ...Array(25).fill(125),
      ...Array(15).fill(140),
    ];
    expect(detectMetallicFromLuminance(luminances)).toBe(false);
  });

  it("rejects uniform bright background (white wall)", () => {
    // Uniform ~220-240 — high brightness but no contrast
    const luminances = Array.from({ length: 100 }, (_, i) => 220 + (i % 20));
    expect(detectMetallicFromLuminance(luminances)).toBe(false);
  });

  it("detects colored metal (green Sprite can with highlights)", () => {
    // Green body ~80, printed areas ~60-100, specular ~200
    const luminances = [
      ...Array(40).fill(80),
      ...Array(30).fill(65),
      ...Array(15).fill(100),
      ...Array(15).fill(200),
    ];
    expect(detectMetallicFromLuminance(luminances)).toBe(true);
  });

  it("returns false for too-few pixels", () => {
    expect(detectMetallicFromLuminance([100, 200])).toBe(false);
  });
});

describe("computeLbpTexture", () => {
  function makeUniformImage(width: number, height: number, value: number): Uint8ClampedArray {
    // All pixels the same value → maximally uniform texture
    const data = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < data.length; i += 4) {
      data[i] = value;
      data[i + 1] = value;
      data[i + 2] = value;
      data[i + 3] = 255;
    }
    return data;
  }

  function makeCheckerboard(width: number, height: number): Uint8ClampedArray {
    // Alternating black/white pixels → high edge density
    const data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = (y * width + x) * 4;
        const val = (x + y) % 2 === 0 ? 255 : 0;
        data[idx] = val;
        data[idx + 1] = val;
        data[idx + 2] = val;
        data[idx + 3] = 255;
      }
    }
    return data;
  }

  function makeGradient(width: number, height: number): Uint8ClampedArray {
    // Smooth horizontal gradient → moderate uniformity
    const data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = (y * width + x) * 4;
        const val = Math.round((x / width) * 255);
        data[idx] = val;
        data[idx + 1] = val;
        data[idx + 2] = val;
        data[idx + 3] = 255;
      }
    }
    return data;
  }

  it("returns high uniformity for a solid-color image", () => {
    const data = makeUniformImage(16, 16, 128);
    const result = computeLbpTexture(data, 16, 16);
    // All interior pixels have the same LBP pattern (all neighbors equal)
    expect(result.uniformity).toBeGreaterThan(0.9);
    expect(result.edgeDensity).toBeLessThan(0.1);
  });

  it("returns low uniformity / high edge density for checkerboard", () => {
    const data = makeCheckerboard(16, 16);
    const result = computeLbpTexture(data, 16, 16);
    // Checkerboard: half pixels are uniform (value=0, all neighbors >=), half are not
    expect(result.uniformity).toBeLessThanOrEqual(0.5);
    expect(result.edgeDensity).toBeGreaterThan(0.2);
  });

  it("returns moderate uniformity for gradient", () => {
    const data = makeGradient(32, 32);
    const result = computeLbpTexture(data, 32, 32);
    // Gradient has consistent directional patterns
    expect(result.uniformity).toBeGreaterThan(0.3);
  });

  it("suggests 'paper' surface for uniform/matte texture", () => {
    const data = makeUniformImage(16, 16, 200);
    const result = computeLbpTexture(data, 16, 16);
    expect(result.suggestedSurface).toBe("paper");
  });

  it("returns valid TextureHint fields", () => {
    const data = makeGradient(16, 16);
    const result = computeLbpTexture(data, 16, 16);
    expect(result.uniformity).toBeGreaterThanOrEqual(0);
    expect(result.uniformity).toBeLessThanOrEqual(1);
    expect(result.edgeDensity).toBeGreaterThanOrEqual(0);
    expect(result.edgeDensity).toBeLessThanOrEqual(1);
    expect(["paper", "plastic", "metal", "unknown"]).toContain(result.suggestedSurface);
  });

  it("handles tiny images gracefully", () => {
    // 4x4 → interior is only 2x2 = 4 patterns
    const data = new Uint8ClampedArray(4 * 4 * 4).fill(128);
    const result = computeLbpTexture(data, 4, 4);
    expect(result).toBeDefined();
    expect(typeof result.uniformity).toBe("number");
  });
});
