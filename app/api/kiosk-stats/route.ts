import { NextResponse } from "next/server";
import { getTodayKioskStats } from "@/lib/kiosk-stats";

const SAFE_DEFAULT = {
  totalClassifications: 0,
  wrongFeedbackCount: 0,
  successRate: 1.0,
  reviewedCount: 0,
};

/**
 * Returns today's kiosk telemetry (counts + accuracy) for the IdleScreen.
 *
 * Restricted to same-origin callers via the `Origin`/`Sec-Fetch-Site` headers.
 * Browsers always send these on cross-origin fetches; absent values mean a
 * top-level navigation or a same-origin tool, which we allow. This blocks
 * trivial telemetry scraping by other web pages without breaking legit
 * curl/server-to-server use.
 */
function isSameOrigin(request: Request): boolean {
  const sfs = request.headers.get("sec-fetch-site");
  if (sfs && sfs !== "same-origin" && sfs !== "none") return false;

  const origin = request.headers.get("origin");
  if (!origin) return true; // No Origin header → not a CORS request, allow
  try {
    const reqHost = new URL(request.url).host;
    return new URL(origin).host === reqHost;
  } catch {
    return false;
  }
}

export async function GET(request: Request) {
  if (!isSameOrigin(request)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  try {
    const siteId = process.env.SITE_ID ?? "japan-office";
    const stats = await getTodayKioskStats(siteId);
    return NextResponse.json(stats);
  } catch (err) {
    console.warn("[kiosk-stats] Failed to compute stats:", err);
    return NextResponse.json(SAFE_DEFAULT);
  }
}
