/**
 * Tests for lib/kiosk-auth.ts — the HMAC-signed kiosk session round-trip.
 *
 * Covers the public surface: deriving the session-cookie value from the kiosk
 * token, and verifying requests via cookie, Bearer header, dev bypass, and the
 * misconfiguration path. Uses the real Web Crypto implementation (Node 22
 * exposes crypto.subtle globally).
 */

import {
  KIOSK_SESSION_COOKIE,
  makeKioskSessionToken,
  verifyKioskRequest,
} from "@/lib/kiosk-auth";

const TOKEN = "test-kiosk-token-abc123";

function makeRequest(
  url: string,
  headers: Record<string, string> = {},
): Request {
  return new Request(url, { method: "POST", headers });
}

describe("makeKioskSessionToken", () => {
  it("is deterministic for the same token", async () => {
    const a = await makeKioskSessionToken(TOKEN);
    const b = await makeKioskSessionToken(TOKEN);
    expect(a).toBe(b);
    // HMAC-SHA256 → 64 lowercase hex chars
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("differs for different tokens", async () => {
    const a = await makeKioskSessionToken(TOKEN);
    const b = await makeKioskSessionToken("another-token");
    expect(a).not.toBe(b);
  });
});

describe("verifyKioskRequest", () => {
  const originalToken = process.env.KIOSK_API_TOKEN;

  afterEach(() => {
    if (originalToken === undefined) {
      delete process.env.KIOSK_API_TOKEN;
    } else {
      process.env.KIOSK_API_TOKEN = originalToken;
    }
  });

  describe("with KIOSK_API_TOKEN configured", () => {
    beforeEach(() => {
      process.env.KIOSK_API_TOKEN = TOKEN;
    });

    it("accepts a valid session cookie", async () => {
      const session = await makeKioskSessionToken(TOKEN);
      const result = await verifyKioskRequest(
        makeRequest("http://localhost/api/classify", {
          cookie: `${KIOSK_SESSION_COOKIE}=${session}`,
        }),
      );
      expect(result.ok).toBe(true);
    });

    it("accepts the session cookie among other cookies", async () => {
      const session = await makeKioskSessionToken(TOKEN);
      const result = await verifyKioskRequest(
        makeRequest("http://localhost/api/classify", {
          cookie: `other=1; ${KIOSK_SESSION_COOKIE}=${session}; theme=dark`,
        }),
      );
      expect(result.ok).toBe(true);
    });

    it("rejects a tampered session cookie with 401", async () => {
      const session = await makeKioskSessionToken(TOKEN);
      const tampered = session.slice(0, -1) + (session.endsWith("0") ? "1" : "0");
      const result = await verifyKioskRequest(
        makeRequest("http://localhost/api/classify", {
          cookie: `${KIOSK_SESSION_COOKIE}=${tampered}`,
        }),
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.response.status).toBe(401);
    });

    it("rejects a cookie signed with a different token (rotation revokes sessions)", async () => {
      const staleSession = await makeKioskSessionToken("old-rotated-token");
      const result = await verifyKioskRequest(
        makeRequest("http://localhost/api/classify", {
          cookie: `${KIOSK_SESSION_COOKIE}=${staleSession}`,
        }),
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.response.status).toBe(401);
    });

    it("accepts a valid Bearer token", async () => {
      const result = await verifyKioskRequest(
        makeRequest("http://localhost/api/classify", {
          authorization: `Bearer ${TOKEN}`,
        }),
      );
      expect(result.ok).toBe(true);
    });

    it("rejects a wrong Bearer token with 401", async () => {
      const result = await verifyKioskRequest(
        makeRequest("http://localhost/api/classify", {
          authorization: "Bearer wrong-token",
        }),
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.response.status).toBe(401);
    });

    it("rejects a request with no credentials with 401 (even on localhost)", async () => {
      const result = await verifyKioskRequest(
        makeRequest("http://localhost/api/classify"),
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.response.status).toBe(401);
    });
  });

  describe("without KIOSK_API_TOKEN (dev / misconfiguration)", () => {
    beforeEach(() => {
      delete process.env.KIOSK_API_TOKEN;
    });

    it("allows localhost requests via dev bypass", async () => {
      const result = await verifyKioskRequest(
        makeRequest("http://localhost:3000/api/classify"),
      );
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.devBypass).toBe(true);
    });

    it("returns 500 for non-localhost requests (missing server config)", async () => {
      const result = await verifyKioskRequest(
        makeRequest("https://kiosk.example.com/api/classify"),
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.response.status).toBe(500);
    });
  });
});
