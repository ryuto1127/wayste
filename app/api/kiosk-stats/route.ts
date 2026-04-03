import { NextResponse } from "next/server";
import { getTodayKioskStats } from "@/lib/kiosk-stats";

const SAFE_DEFAULT = {
  totalClassifications: 0,
  wrongFeedbackCount: 0,
  successRate: 1.0,
};

export async function GET() {
  try {
    const siteId = process.env.SITE_ID ?? "default";
    const stats = await getTodayKioskStats(siteId);
    return NextResponse.json(stats);
  } catch (err) {
    console.warn("[kiosk-stats] Failed to compute stats:", err);
    return NextResponse.json(SAFE_DEFAULT);
  }
}
