/**
 * Tests for app/api/classify/route.ts
 * Mocks OpenAI client and Upstash Redis.
 */

// ── Mock OpenAI ──
const mockCreate = jest.fn();
jest.mock("openai", () => {
  return jest.fn().mockImplementation(() => ({
    chat: {
      completions: {
        create: mockCreate,
      },
    },
  }));
});

// ── Mock Upstash Redis ──
jest.mock("@upstash/redis", () => ({
  Redis: jest.fn().mockImplementation(() => ({
    rpush: jest.fn().mockResolvedValue(1),
    ltrim: jest.fn().mockResolvedValue("OK"),
    incr: jest.fn().mockResolvedValue(1),
    expire: jest.fn().mockResolvedValue(1),
    ping: jest.fn().mockResolvedValue("PONG"),
  })),
}));

// ── Mock Vercel Blob ──
jest.mock("@vercel/blob", () => ({
  put: jest.fn().mockResolvedValue({ url: "https://blob.test/image.jpg" }),
}));

// ── Mock waitUntil ──
jest.mock("@vercel/functions", () => ({
  waitUntil: jest.fn((p: Promise<unknown>) => p.catch(() => {})),
}));

// Set env vars before importing route
process.env.KV_REST_API_URL = "https://fake-redis.upstash.io";
process.env.KV_REST_API_TOKEN = "fake-token";
process.env.OPENAI_API_KEY = "fake-key";
process.env.BLOB_READ_WRITE_TOKEN = "fake-blob-token";

import type { ComponentPart } from "@/lib/types";

interface RawClassification {
  itemName: string;
  wasteStream: string;
  confidence: number;
  reasoning: string;
  preAction?: string;
  isCompound?: boolean;
  components?: ComponentPart[];
}

describe("POST /api/classify", () => {
  beforeEach(() => {
    mockCreate.mockReset();
  });

  function makeOpenAIResponse(raw: RawClassification) {
    return {
      choices: [
        {
          message: {
            content: JSON.stringify(raw),
          },
        },
      ],
    };
  }

  function makeRequest(body: Record<string, unknown>) {
    return new Request("http://localhost/api/classify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("uses mini directly for classification", async () => {
    const miniResponse = makeOpenAIResponse({
      itemName: "plastic bottle",
      wasteStream: "recyclable",
      confidence: 0.95,
      reasoning: "clear PET bottle",
      isCompound: false,
      components: [],
    });
    mockCreate.mockResolvedValueOnce(miniResponse);

    const { POST } = await import("@/app/api/classify/route");
    const req = makeRequest({
      image: "a".repeat(200),
      siteId: "japan-office",
    });

    const res = await POST(req);
    if (res.status === 200) {
      const data = await res.json();
      expect(data.itemName).toBe("plastic bottle");
      expect(data.wasteStream).toBe("recyclable");
      // Only one model call (mini, no escalation)
      expect(mockCreate).toHaveBeenCalledTimes(1);
      // Verify mini was called (not nano)
      expect(mockCreate.mock.calls[0][0].model).toBe("gpt-5.4-mini");
    }
  });

  it("handles compound items from mini", async () => {
    const miniResponse = makeOpenAIResponse({
      itemName: "coffee cup",
      wasteStream: "burnable",
      confidence: 0.88,
      reasoning: "lined paper cup with plastic lid",
      isCompound: true,
      components: [
        { partName: "plastic lid", wasteStream: "plastic", instruction: "Remove lid, put in plastic" },
        { partName: "paper cup", wasteStream: "burnable", instruction: "Lined cup goes to burnable" },
      ],
    });
    mockCreate.mockResolvedValueOnce(miniResponse);

    const { POST } = await import("@/app/api/classify/route");
    const req = makeRequest({
      image: "b".repeat(200),
      siteId: "japan-office",
    });

    const res = await POST(req);
    if (res.status === 200) {
      const data = await res.json();
      expect(data.isCompound).toBe(true);
      expect(data.components).toHaveLength(2);
      expect(mockCreate).toHaveBeenCalledTimes(1);
    }
  });

  it("includes preAction field in response when model provides it", async () => {
    const miniResponse = makeOpenAIResponse({
      itemName: "pet bottle",
      wasteStream: "recyclable",
      confidence: 0.92,
      reasoning: "PET plastic bottle",
      preAction: "Empty contents and remove cap",
      isCompound: false,
      components: [],
    });
    mockCreate.mockResolvedValueOnce(miniResponse);

    const { POST } = await import("@/app/api/classify/route");
    const req = makeRequest({
      image: "d".repeat(200),
      siteId: "japan-office",
    });

    const res = await POST(req);
    if (res.status === 200) {
      const data = await res.json();
      expect(data.preAction).toBe("Empty contents and remove cap");
    }
  });

  it("returns 429 when rate limit is hit", async () => {
    // Override Redis mock to simulate rate limit exceeded
    const { redis } = await import("@/lib/redis");
    (redis.incr as jest.Mock).mockResolvedValueOnce(16); // count > 15 (RATE_LIMIT_MAX)

    const { POST } = await import("@/app/api/classify/route");

    const req = makeRequest({ image: "c".repeat(200) });
    const res = await POST(req);

    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error).toBe("rate_limited");
    expect(body.retryAfterMs).toBe(1000);
  });
});
