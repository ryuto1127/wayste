import { NextResponse } from "next/server";
import { redis } from "@/lib/redis";
import { sendErrorNotification } from "@/lib/notifications";
import { runInBackground } from "@/lib/background-task";

interface CheckResult {
  status: "ok" | "error";
  latencyMs?: number;
  error?: string;
}

export async function GET() {
  const [redisResult, openaiResult, blobResult] = await Promise.allSettled([
    // Redis: ping and measure latency
    (async (): Promise<CheckResult> => {
      const start = Date.now();
      await redis.ping();
      return { status: "ok", latencyMs: Date.now() - start };
    })(),

    // OpenAI: check env var
    (async (): Promise<CheckResult> => {
      const key = process.env.OPENAI_API_KEY;
      if (!key || key.trim() === "") {
        return { status: "error", error: "OPENAI_API_KEY not set" };
      }
      return { status: "ok" };
    })(),

    // Blob: check env var
    (async (): Promise<CheckResult> => {
      const token = process.env.BLOB_READ_WRITE_TOKEN;
      if (!token || token.trim() === "") {
        return { status: "error", error: "BLOB_READ_WRITE_TOKEN not set" };
      }
      return { status: "ok" };
    })(),
  ]);

  const redisCheck: CheckResult =
    redisResult.status === "fulfilled"
      ? redisResult.value
      : { status: "error", error: String(redisResult.reason) };

  const openaiCheck: CheckResult =
    openaiResult.status === "fulfilled"
      ? openaiResult.value
      : { status: "error", error: String(openaiResult.reason) };

  const blobCheck: CheckResult =
    blobResult.status === "fulfilled"
      ? blobResult.value
      : { status: "error", error: String(blobResult.reason) };

  // Status rules
  let status: "ok" | "degraded" | "down";
  let httpStatus: number;

  if (openaiCheck.status === "error" || blobCheck.status === "error") {
    status = "down";
    httpStatus = 503;
  } else if (redisCheck.status === "error") {
    status = "degraded";
    httpStatus = 200;
  } else {
    status = "ok";
    httpStatus = 200;
  }

  // ── Notify on failures (non-blocking) ──
  // Each failed service triggers its own deduped notification.
  // Notifications run in the background via waitUntil so they never block the response.
  const failedChecks: { type: string; error: string }[] = [];
  if (redisCheck.status === "error") {
    failedChecks.push({ type: "Redis Down", error: redisCheck.error ?? "Redis unreachable" });
  }
  if (openaiCheck.status === "error") {
    failedChecks.push({ type: "OpenAI API Down", error: openaiCheck.error ?? "OpenAI unavailable" });
  }
  if (blobCheck.status === "error") {
    failedChecks.push({ type: "Blob Storage Down", error: blobCheck.error ?? "Blob storage unavailable" });
  }

  if (failedChecks.length > 0) {
    runInBackground(
      Promise.allSettled(
        failedChecks.map((check) =>
          sendErrorNotification(check.type, check.error)
        ),
      ).then(() => undefined),
    );
  }

  return NextResponse.json(
    {
      status,
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
      checks: {
        redis: redisCheck,
        openai: openaiCheck,
        blob: blobCheck,
      },
    },
    {
      status: httpStatus,
      headers: { "Cache-Control": "no-store" },
    }
  );
}
