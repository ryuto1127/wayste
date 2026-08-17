/**
 * Tests for lib/vlm-client.ts — Tier 1.5 local VLM plumbing.
 * Covers the pure parts: loopback-only endpoint guard, constrained-response
 * parsing, prompt construction, and model→video bbox mapping.
 */

import {
  isLocalVlmEndpointAllowed,
  getVlmMode,
  parseVlmResponse,
  buildVlmPrompt,
  modelBboxToVideoRect,
} from "@/lib/vlm-client";
import type { StreamDefinition } from "@/lib/types";

const STREAMS: StreamDefinition[] = [
  { id: "burnable", label: "可燃ゴミ", color: "#EF4444", description: "生ゴミなど" },
  { id: "recyclable", label: "資源ゴミ", color: "#3B82F6", description: "ペットボトルなど" },
  { id: "needs_review", label: "確認が必要", color: "#D97706", description: "不明" },
];
const VALID = new Set(STREAMS.map((s) => s.id as string));

describe("isLocalVlmEndpointAllowed", () => {
  it("allows loopback endpoints", () => {
    expect(isLocalVlmEndpointAllowed("http://localhost:11434/v1")).toBe(true);
    expect(isLocalVlmEndpointAllowed("http://127.0.0.1:1234/v1")).toBe(true);
    expect(isLocalVlmEndpointAllowed("https://localhost:8443/v1")).toBe(true);
  });

  it("rejects anything that could exfiltrate frames", () => {
    expect(isLocalVlmEndpointAllowed("https://evil.example.com/v1")).toBe(false);
    expect(isLocalVlmEndpointAllowed("http://192.168.1.10:11434/v1")).toBe(false);
    expect(isLocalVlmEndpointAllowed("ftp://localhost/v1")).toBe(false);
    expect(isLocalVlmEndpointAllowed("not a url")).toBe(false);
  });
});

describe("getVlmMode", () => {
  it("resolves local mode for a loopback endpoint with a model", () => {
    expect(getVlmMode({ endpoint: "http://localhost:11434/v1", model: "qwen2.5vl:3b" })).toBe("local");
  });

  it("resolves server mode for the literal \"server\" endpoint (no model needed)", () => {
    expect(getVlmMode({ endpoint: "server" })).toBe("server");
  });

  it("returns null for missing config, missing local model, or foreign URLs", () => {
    expect(getVlmMode(undefined)).toBeNull();
    expect(getVlmMode({ endpoint: "http://localhost:11434/v1" })).toBeNull();
    expect(getVlmMode({ endpoint: "https://evil.example.com/v1", model: "x" })).toBeNull();
  });
});

describe("parseVlmResponse", () => {
  it("parses a clean JSON verdict", () => {
    const out = parseVlmResponse(
      '{"item": "ペットボトル", "stream": "recyclable", "confidence": 0.9, "note": "中を洗って"}',
      VALID,
    );
    expect(out).toEqual({
      itemName: "ペットボトル",
      wasteStream: "recyclable",
      confidence: 0.9,
      reasoning: "中を洗って",
    });
  });

  it("extracts JSON from surrounding prose / markdown fences", () => {
    const out = parseVlmResponse(
      'Sure! Here is the answer:\n```json\n{"item": "紙コップ", "stream": "burnable", "confidence": 0.8}\n```',
      VALID,
    );
    expect(out?.itemName).toBe("紙コップ");
    expect(out?.wasteStream).toBe("burnable");
  });

  it("degrades an unknown stream to needs_review instead of failing", () => {
    const out = parseVlmResponse(
      '{"item": "謎の物体", "stream": "hazardous", "confidence": 0.7}',
      VALID,
    );
    expect(out?.wasteStream).toBe("needs_review");
  });

  it("clamps confidence into [0, 1]", () => {
    const out = parseVlmResponse(
      '{"item": "缶", "stream": "recyclable", "confidence": 1.7}',
      VALID,
    );
    expect(out?.confidence).toBe(1);
  });

  it("returns null for garbage or missing item name", () => {
    expect(parseVlmResponse("I cannot see the image.", VALID)).toBeNull();
    expect(parseVlmResponse('{"stream": "burnable"}', VALID)).toBeNull();
    expect(parseVlmResponse('{"item": "", "stream": "burnable"}', VALID)).toBeNull();
  });
});

describe("buildVlmPrompt", () => {
  it("names every stream id and pins the JSON contract", () => {
    const prompt = buildVlmPrompt(STREAMS, ["ペットボトル", "紙コップ"], "ja");
    for (const s of STREAMS) expect(prompt).toContain(`"${s.id}"`);
    expect(prompt).toContain("ペットボトル");
    expect(prompt).toContain("needs_review");
    expect(prompt).toContain('{"item"');
  });
});

describe("modelBboxToVideoRect", () => {
  it("maps the letterboxed content back to full video pixels", () => {
    // Full 16:9 content area [0, 140, 640, 360] → whole 1280×720 frame
    const rect = modelBboxToVideoRect([0, 140, 640, 360], 1280, 720, 0);
    expect(rect).toEqual({ x: 0, y: 0, w: 1280, h: 720 });
  });

  it("pads the crop and clamps to the frame", () => {
    const rect = modelBboxToVideoRect([0, 140, 100, 100], 1280, 720, 0.2);
    expect(rect.x).toBe(0); // padding clamped at the left edge
    expect(rect.y).toBe(0);
    expect(rect.w).toBeGreaterThan(200); // 100 model px ≈ 200 video px + pad
    expect(rect.w).toBeLessThanOrEqual(1280);
  });

  it("maps a centered box to centered video coords", () => {
    const rect = modelBboxToVideoRect([288, 302, 64, 36], 1280, 720, 0);
    expect(rect.x).toBeCloseTo(576, 0);
    expect(rect.y).toBeCloseTo(324, 0);
    expect(rect.w).toBeCloseTo(128, 0);
    expect(rect.h).toBeCloseTo(72, 0);
  });
});
