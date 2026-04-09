import { NextResponse } from "next/server";
import { loadSiteConfig } from "@/lib/waste-rules";

export async function GET() {
  const siteId = process.env.SITE_ID ?? "default";
  const config = loadSiteConfig(siteId);

  return NextResponse.json({
    defaultLocale: config.defaultLocale ?? "en",
    streams: config.streams,
    overrides: config.overrides,
    staffHandlingItems: config.staffHandlingItems ?? [],
    reviewThreshold: config.reviewThreshold,
    defaultStream: config.defaultStream,
    siteName: config.siteName,
    siteId: config.siteId,
    tips: config.tips ?? [],
  });
}
