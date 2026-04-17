import { NextResponse } from "next/server";
import { loadSiteConfig } from "@/lib/waste-rules";

/**
 * GET /api/site-config
 *
 * Returns the subset of site configuration needed by the kiosk UI.
 * Only public-safe fields are included — internal rules (overrides,
 * staffHandlingItems, reviewThreshold) are omitted to avoid exposing
 * classification logic to unauthenticated clients.
 */
export async function GET() {
  const siteId = process.env.SITE_ID ?? "japan-office";
  const config = loadSiteConfig(siteId);

  return NextResponse.json({
    defaultLocale: config.defaultLocale ?? "en",
    voiceEnabled: config.voiceEnabled ?? false,
    streams: config.streams,
    sensitivity: config.sensitivity,
    tips: config.tips ?? [],
  });
}
