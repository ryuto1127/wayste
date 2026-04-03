/**
 * GET /api/pilot-image?url=<blobUrl>
 *
 * Generates a temporary signed download URL for a private Vercel Blob image.
 * Protected by admin auth (middleware.ts).
 */

import { NextResponse } from "next/server";
import { getSignedImageUrl } from "@/lib/blob-store";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const blobUrl = searchParams.get("url");

  if (!blobUrl) {
    return NextResponse.json({ error: "Missing url parameter." }, { status: 400 });
  }

  const signedUrl = getSignedImageUrl(blobUrl);
  if (!signedUrl) {
    return NextResponse.json({ error: "Failed to generate signed URL." }, { status: 500 });
  }

  return NextResponse.redirect(signedUrl);
}
