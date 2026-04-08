/**
 * Tests for lib/notifications.ts and lib/milestone-check.ts
 * Mocks Resend email client and Upstash Redis.
 */

// ── Mock Resend ──
const mockSend = jest.fn();
jest.mock("resend", () => ({
  Resend: jest.fn().mockImplementation(() => ({
    emails: {
      send: mockSend,
    },
  })),
}));

// ── Mock Upstash Redis ──
const mockGet = jest.fn();
const mockSet = jest.fn();
const mockLlen = jest.fn();
const mockLrange = jest.fn();
const mockHgetall = jest.fn();

jest.mock("@upstash/redis", () => ({
  Redis: jest.fn().mockImplementation(() => ({
    get: mockGet,
    set: mockSet,
    llen: mockLlen,
    lrange: mockLrange,
    hgetall: mockHgetall,
    rpush: jest.fn().mockResolvedValue(1),
    ltrim: jest.fn().mockResolvedValue("OK"),
    ping: jest.fn().mockResolvedValue("PONG"),
  })),
}));

// Set env vars before importing modules
process.env.KV_REST_API_URL = "https://fake-redis.upstash.io";
process.env.KV_REST_API_TOKEN = "fake-token";
process.env.RESEND_API_KEY = "re_test_fake_key";
process.env.NOTIFY_EMAIL = "operator@example.com";

import {
  sendErrorNotification,
  sendMilestoneNotification,
  isNotificationConfigured,
} from "@/lib/notifications";
import { checkAndSendMilestoneNotification } from "@/lib/milestone-check";

// ── Helpers ──

beforeEach(() => {
  jest.clearAllMocks();
  mockSend.mockResolvedValue({ id: "email_123" });
  mockGet.mockResolvedValue(null);
  mockSet.mockResolvedValue("OK");
});

// ── isNotificationConfigured ──

describe("isNotificationConfigured", () => {
  it("returns true when both env vars are set", () => {
    expect(isNotificationConfigured()).toBe(true);
  });

  it("returns false when RESEND_API_KEY is missing", () => {
    const orig = process.env.RESEND_API_KEY;
    delete process.env.RESEND_API_KEY;
    expect(isNotificationConfigured()).toBe(false);
    process.env.RESEND_API_KEY = orig;
  });

  it("returns false when NOTIFY_EMAIL is missing", () => {
    const orig = process.env.NOTIFY_EMAIL;
    delete process.env.NOTIFY_EMAIL;
    expect(isNotificationConfigured()).toBe(false);
    process.env.NOTIFY_EMAIL = orig;
  });
});

// ── sendErrorNotification ──

describe("sendErrorNotification", () => {
  it("sends an email for a new error type", async () => {
    mockGet.mockResolvedValue(null); // no dedup marker
    const result = await sendErrorNotification("OpenAI API Down", "Connection timed out", { force: true });
    expect(result).toBe(true);
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSend).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "operator@example.com",
        subject: expect.stringContaining("OpenAI API Down"),
      }),
    );
  });

  it("suppresses duplicate errors within the dedup window", async () => {
    mockGet.mockResolvedValue("2026-01-01T00:00:00.000Z"); // dedup marker exists
    const result = await sendErrorNotification("OpenAI API Down", "Connection timed out");
    expect(result).toBe(false);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("sets a dedup marker in Redis after sending", async () => {
    mockGet.mockResolvedValue(null);
    await sendErrorNotification("Redis Down", "Connection refused", { force: true });
    expect(mockSet).toHaveBeenCalledWith(
      "recycling:notify:last-error:Redis Down",
      expect.any(String),
      { ex: 1800 }, // 30 minutes
    );
  });

  it("handles Resend failures gracefully", async () => {
    mockSend.mockRejectedValue(new Error("Resend error"));
    const result = await sendErrorNotification("Blob Down", "Token invalid", { force: true });
    expect(result).toBe(false);
    // No dedup marker should be set
    expect(mockSet).not.toHaveBeenCalled();
  });

  it("handles Redis dedup check failures gracefully", async () => {
    mockGet.mockRejectedValue(new Error("Redis error"));
    // Should still attempt to send the email
    const result = await sendErrorNotification("OpenAI API Down", "Timeout");
    expect(result).toBe(true);
    expect(mockSend).toHaveBeenCalledTimes(1);
  });
});

// ── sendMilestoneNotification ──

describe("sendMilestoneNotification", () => {
  it("sends milestone email with all stats", async () => {
    mockGet.mockResolvedValue(null); // no previous milestone
    const result = await sendMilestoneNotification({
      total: 200,
      accuracy: 0.92,
      mostCommonItem: "plastic bottle",
    });
    expect(result).toBe(true);
    expect(mockSend).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "operator@example.com",
        subject: expect.stringContaining("200 items classified"),
        html: expect.stringContaining("92.0%"),
      }),
    );
  });

  it("sends milestone email without optional stats", async () => {
    mockGet.mockResolvedValue(null);
    const result = await sendMilestoneNotification({ total: 100 });
    expect(result).toBe(true);
    expect(mockSend).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: expect.stringContaining("100 items classified"),
      }),
    );
  });

  it("suppresses duplicate milestone notifications", async () => {
    mockGet.mockResolvedValue("200"); // already notified at 200
    const result = await sendMilestoneNotification({ total: 200 });
    expect(result).toBe(false);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("sends for a higher milestone even if lower was sent", async () => {
    mockGet.mockResolvedValue("100"); // notified at 100
    const result = await sendMilestoneNotification({
      total: 200,
      accuracy: 0.85,
    });
    expect(result).toBe(true);
  });

  it("does not send for total less than 100", async () => {
    mockGet.mockResolvedValue(null);
    const result = await sendMilestoneNotification({ total: 50 });
    expect(result).toBe(false);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("records milestone marker in Redis after sending", async () => {
    mockGet.mockResolvedValue(null);
    await sendMilestoneNotification({ total: 300, accuracy: 0.88 });
    expect(mockSet).toHaveBeenCalledWith(
      "recycling:notify:last-milestone",
      "300",
    );
  });
});

// ── checkAndSendMilestoneNotification ──

describe("checkAndSendMilestoneNotification", () => {
  it("sends milestone when total is exactly on a 100 boundary", async () => {
    mockLlen.mockResolvedValue(200);
    mockGet.mockResolvedValue(null); // no previous milestone
    mockLrange.mockResolvedValue([
      JSON.stringify({ timestamp: "2026-01-01T00:00:00Z", itemName: "bottle", requestId: "r1" }),
      JSON.stringify({ timestamp: "2026-01-01T00:01:00Z", itemName: "bottle", requestId: "r2" }),
      JSON.stringify({ timestamp: "2026-01-01T00:02:00Z", itemName: "can", requestId: "r3" }),
    ]);
    mockHgetall.mockResolvedValue({ r1: "correct", r2: "correct", r3: "wrong" });

    await checkAndSendMilestoneNotification();

    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSend).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: expect.stringContaining("200 items classified"),
        html: expect.stringContaining("bottle"),
      }),
    );
  });

  it("does not send when total is not on a 100 boundary", async () => {
    mockLlen.mockResolvedValue(150);
    await checkAndSendMilestoneNotification();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("does not send when total is 0", async () => {
    mockLlen.mockResolvedValue(0);
    await checkAndSendMilestoneNotification();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("computes accuracy from review verdicts", async () => {
    mockLlen.mockResolvedValue(100);
    mockGet.mockResolvedValue(null);
    mockLrange.mockResolvedValue([
      JSON.stringify({ timestamp: "2026-01-01T00:00:00Z", itemName: "cup", requestId: "r1" }),
      JSON.stringify({ timestamp: "2026-01-01T00:01:00Z", itemName: "cup", requestId: "r2" }),
    ]);
    // 1 correct, 1 wrong → 50% accuracy
    mockHgetall.mockResolvedValue({ r1: "correct", r2: "wrong" });

    await checkAndSendMilestoneNotification();

    expect(mockSend).toHaveBeenCalledWith(
      expect.objectContaining({
        html: expect.stringContaining("50.0%"),
      }),
    );
  });

  it("identifies the most common item", async () => {
    mockLlen.mockResolvedValue(100);
    mockGet.mockResolvedValue(null);
    mockLrange.mockResolvedValue([
      JSON.stringify({ timestamp: "2026-01-01T00:00:00Z", itemName: "bottle", requestId: "r1" }),
      JSON.stringify({ timestamp: "2026-01-01T00:01:00Z", itemName: "bottle", requestId: "r2" }),
      JSON.stringify({ timestamp: "2026-01-01T00:02:00Z", itemName: "can", requestId: "r3" }),
    ]);
    mockHgetall.mockResolvedValue(null);

    await checkAndSendMilestoneNotification();

    expect(mockSend).toHaveBeenCalledWith(
      expect.objectContaining({
        html: expect.stringContaining("bottle"),
      }),
    );
  });
});
