/**
 * Default-configuration gate test for app/api/classify/route.ts.
 *
 * The privacy promise "no frame is sent to a cloud AI by default" is enforced
 * server-side: unless NEXT_PUBLIC_CLOUD_FALLBACK=1 is explicitly set, the
 * route must refuse with 403 before touching rate limits, budget, or OpenAI.
 *
 * __tests__/classify.test.ts pins the flag to "1" at module scope to exercise
 * the legacy cloud path; this file runs with the flag UNSET (the production
 * default) instead. The route reads the flag at request time (inside POST),
 * so we control it via process.env around each request rather than needing
 * jest.isolateModules.
 */

// ── Mock OpenAI (never reached — the gate must fire first) ──
const mockCreate = jest.fn();
jest.mock("openai", () => {
  return jest.fn().mockImplementation(() => ({
    chat: { completions: { create: mockCreate } },
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

// ── Mock Vercel Blob / waitUntil (imported at module scope by the route) ──
jest.mock("@vercel/blob", () => ({
  put: jest.fn().mockResolvedValue({ url: "https://blob.test/image.jpg" }),
}));
jest.mock("@vercel/functions", () => ({
  waitUntil: jest.fn((p: Promise<unknown>) => p.catch(() => {})),
}));

// ── Mock face-detect-server (avoids loading the ONNX runtime in tests) ──
jest.mock("@/lib/face-detect-server", () => ({
  serverFaceDetected: jest.fn().mockResolvedValue(false),
}));

// Env for module-scope imports. Deliberately NO NEXT_PUBLIC_CLOUD_FALLBACK and
// NO KIOSK_API_TOKEN (localhost dev bypass lets us reach the cloud gate).
process.env.KV_REST_API_URL = "https://fake-redis.upstash.io";
process.env.KV_REST_API_TOKEN = "fake-token";
process.env.OPENAI_API_KEY = "fake-key";
delete process.env.NEXT_PUBLIC_CLOUD_FALLBACK;
delete process.env.KIOSK_API_TOKEN;

import { POST } from "@/app/api/classify/route";

function makeRequest(body: Record<string, unknown>) {
  return new Request("http://localhost/api/classify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/classify with default env (no cloud fallback)", () => {
  beforeEach(() => {
    delete process.env.NEXT_PUBLIC_CLOUD_FALLBACK;
    mockCreate.mockReset();
  });

  afterAll(() => {
    delete process.env.NEXT_PUBLIC_CLOUD_FALLBACK;
  });

  it("returns 403 when NEXT_PUBLIC_CLOUD_FALLBACK is unset", async () => {
    const res = await POST(makeRequest({ image: "a".repeat(200) }));
    expect(res.status).toBe(403);
    const data = await res.json();
    expect(data.error).toMatch(/disabled/i);
    // The OpenAI client must never be invoked on the default path.
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("returns 403 for any value other than exactly '1'", async () => {
    for (const value of ["0", "true", "yes", ""]) {
      process.env.NEXT_PUBLIC_CLOUD_FALLBACK = value;
      const res = await POST(makeRequest({ image: "a".repeat(200) }));
      expect(res.status).toBe(403);
    }
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("reads the flag at request time, not import time", async () => {
    // Same imported module: flag off → 403; flag on → the gate passes and the
    // (deliberately invalid) body is rejected with 400 instead.
    const res403 = await POST(makeRequest({ image: "a".repeat(200) }));
    expect(res403.status).toBe(403);

    process.env.NEXT_PUBLIC_CLOUD_FALLBACK = "1";
    const res400 = await POST(makeRequest({ not: "a valid body" }));
    expect(res400.status).toBe(400);
    expect(mockCreate).not.toHaveBeenCalled();
  });
});
