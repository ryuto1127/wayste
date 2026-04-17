/**
 * Email notification module for operator alerts.
 *
 * Sends error notifications (health-check failures) and milestone
 * notifications (every 100 items classified) via Resend.
 *
 * Requires env vars:
 *   RESEND_API_KEY  — Resend API key
 *   NOTIFY_EMAIL    — Recipient email address
 *
 * Degrades gracefully: if either env var is missing or the email
 * service is unavailable, logs a warning but never crashes.
 */

import { Resend } from "resend";
import { redis } from "./redis";

// ── Redis key helpers ──

const REDIS_PREFIX = "recycling:notify";

/** Returns the Redis key for error dedup. TTL is set externally. */
function errorKey(errorType: string): string {
  return `${REDIS_PREFIX}:last-error:${errorType}`;
}

/** Redis key that stores the last milestone number we notified about. */
const MILESTONE_KEY = `${REDIS_PREFIX}:last-milestone`;

// ── Dedup windows ──

/** Don't re-notify for the same error type within this window (seconds). */
const ERROR_DEDUP_TTL_SEC = 30 * 60; // 30 minutes

// ── Lazy singleton ──

let resendClient: Resend | null = null;

function getResend(): Resend | null {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    return null;
  }
  if (!resendClient) {
    resendClient = new Resend(apiKey);
  }
  return resendClient;
}

function getRecipient(): string | null {
  return process.env.NOTIFY_EMAIL || null;
}

/**
 * Check whether notifications are properly configured.
 * Returns true only when both RESEND_API_KEY and NOTIFY_EMAIL are set.
 */
export function isNotificationConfigured(): boolean {
  return !!process.env.RESEND_API_KEY && !!process.env.NOTIFY_EMAIL;
}

// ── Core send helper ──

async function sendEmail(
  subject: string,
  html: string,
): Promise<boolean> {
  const resend = getResend();
  const to = getRecipient();

  if (!resend || !to) {
    console.warn(
      "[notifications] Email not configured — missing RESEND_API_KEY or NOTIFY_EMAIL",
    );
    return false;
  }

  try {
    await resend.emails.send({
      from: "wayste Kiosk <onboarding@resend.dev>",
      to,
      subject,
      html,
    });
    return true;
  } catch (err) {
    console.error("[notifications] Failed to send email:", err);
    return false;
  }
}

// ── Public API ──

/**
 * Send an error notification for a service failure.
 *
 * Deduplicates: the same `errorType` won't re-notify within 30 minutes.
 * Set `force` to true to bypass dedup (e.g. when called from a test).
 */
export async function sendErrorNotification(
  errorType: string,
  details: string,
  options?: { force?: boolean },
): Promise<boolean> {
  if (!isNotificationConfigured()) {
    console.warn("[notifications] Skipping error notification — not configured");
    return false;
  }

  // ── Dedup check ──
  if (!options?.force) {
    try {
      const existing = await redis.get(errorKey(errorType));
      if (existing) {
        console.log(
          `[notifications] Suppressed duplicate error notification: ${errorType}`,
        );
        return false;
      }
    } catch (err) {
      // Redis failure shouldn't block the notification
      console.warn("[notifications] Redis dedup check failed:", err);
    }
  }

  const timestamp = new Date().toISOString();
  const subject = `wayste Kiosk Alert: ${errorType}`;
  const html = `
    <div style="font-family: sans-serif; max-width: 600px;">
      <h2 style="color: #dc2626;">Service Alert</h2>
      <p><strong>Error:</strong> ${escapeHtml(errorType)}</p>
      <p><strong>Details:</strong> ${escapeHtml(details)}</p>
      <p><strong>Time:</strong> ${timestamp}</p>
      <hr style="border: none; border-top: 1px solid #e5e7eb;" />
      <p style="color: #6b7280; font-size: 12px;">
        This is an automated alert from the wayste Kiosk monitoring system.
        You will not receive another alert for this error type within 30 minutes.
      </p>
    </div>
  `;

  const sent = await sendEmail(subject, html);

  // ── Record dedup marker ──
  if (sent) {
    try {
      await redis.set(errorKey(errorType), timestamp, {
        ex: ERROR_DEDUP_TTL_SEC,
      });
    } catch (err) {
      console.warn("[notifications] Failed to set dedup marker:", err);
    }
  }

  return sent;
}

/**
 * Send a milestone notification when the classification count
 * crosses a 100-item boundary.
 *
 * Deduplicates: the same milestone number won't re-notify.
 */
export async function sendMilestoneNotification(data: {
  total: number;
  accuracy?: number;
  mostCommonItem?: string;
}): Promise<boolean> {
  if (!isNotificationConfigured()) {
    console.warn("[notifications] Skipping milestone notification — not configured");
    return false;
  }

  const milestoneNumber = Math.floor(data.total / 100) * 100;
  if (milestoneNumber === 0) return false;

  // ── Dedup check ──
  try {
    const lastMilestone = await redis.get(MILESTONE_KEY);
    if (lastMilestone !== null && Number(lastMilestone) >= milestoneNumber) {
      console.log(
        `[notifications] Suppressed duplicate milestone notification: ${milestoneNumber}`,
      );
      return false;
    }
  } catch (err) {
    console.warn("[notifications] Redis milestone dedup check failed:", err);
  }

  const timestamp = new Date().toISOString();
  const accuracyLine = data.accuracy != null
    ? `<p><strong>Accuracy:</strong> ${(data.accuracy * 100).toFixed(1)}%</p>`
    : "";
  const commonItemLine = data.mostCommonItem
    ? `<p><strong>Most common item:</strong> ${escapeHtml(data.mostCommonItem)}</p>`
    : "";

  const subject = `wayste Kiosk: ${milestoneNumber} items classified!`;
  const html = `
    <div style="font-family: sans-serif; max-width: 600px;">
      <h2 style="color: #059669;">Milestone Reached!</h2>
      <p>The wayste Kiosk has classified <strong>${milestoneNumber}</strong> items.</p>
      <p><strong>Total items:</strong> ${data.total}</p>
      ${accuracyLine}
      ${commonItemLine}
      <p><strong>Time:</strong> ${timestamp}</p>
      <hr style="border: none; border-top: 1px solid #e5e7eb;" />
      <p style="color: #6b7280; font-size: 12px;">
        This is an automated notification from the wayste Kiosk pilot system.
      </p>
    </div>
  `;

  const sent = await sendEmail(subject, html);

  // ── Record milestone marker ──
  if (sent) {
    try {
      await redis.set(MILESTONE_KEY, milestoneNumber.toString());
    } catch (err) {
      console.warn("[notifications] Failed to set milestone marker:", err);
    }
  }

  return sent;
}

// ── Utilities ──

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
