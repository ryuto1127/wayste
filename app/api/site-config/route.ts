import { NextResponse } from "next/server";
import { loadSiteConfig } from "@/lib/waste-rules";

/**
 * GET /api/site-config
 *
 * Returns the site configuration needed by the kiosk UI.
 *
 * Since classification is resolved on-device by default (no cloud call),
 * the browser needs the full routing rules — overrides, compounds,
 * staffHandlingItems, reviewThreshold — to build results locally via
 * buildClassificationResult(). These are waste-sorting rules, not secrets;
 * server-only fields (e.g. GPT prompt scaffolding) stay out of the payload.
 */
export async function GET() {
  const siteId = process.env.SITE_ID ?? "japan-office";
  const config = loadSiteConfig(siteId);

  return NextResponse.json({
    siteId: config.siteId,
    siteName: config.siteName,
    defaultLocale: config.defaultLocale ?? "en",
    voiceEnabled: config.voiceEnabled ?? false,
    ...(typeof config.mirrorCamera === "boolean" && { mirrorCamera: config.mirrorCamera }),
    streams: config.streams,
    ...(config.detectionMode && { detectionMode: config.detectionMode }),
    ...(typeof config.showDetectionOverlay === "boolean" && {
      showDetectionOverlay: config.showDetectionOverlay,
    }),
    ...(typeof config.showBinMap === "boolean" && {
      showBinMap: config.showBinMap,
    }),
    ...(config.trackerTuning && { trackerTuning: config.trackerTuning }),
    ...(config.localVlm && { localVlm: config.localVlm }),
    sensitivity: config.sensitivity,
    reviewThreshold: config.reviewThreshold,
    defaultStream: config.defaultStream,
    ...(config.yoloStreamMap && { yoloStreamMap: config.yoloStreamMap }),
    overrides: config.overrides ?? [],
    compounds: config.compounds ?? [],
    staffHandlingItems: config.staffHandlingItems ?? [],
    tips: config.tips ?? [],
  });
}
