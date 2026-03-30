/**
 * GET /api/pilot-image?url=<blobUrl>
 * For private blobs: generates a short-lived signed URL via head() and redirects.
 * For public blobs: redirects directly (no token needed).
 */

import { NextResponse } from "next/server";
import { head } from "@vercel/blob";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const blobUrl = searchParams.get("url");

  if (!blobUrl) {
    return NextResponse.json({ error: "Missing url parameter." }, { status: 400 });
  }

  // Public store blobs can be redirected directly
  if (blobUrl.includes(".public.blob.vercel-storage.com")) {
    return NextResponse.redirect(blobUrl);
  }

  try {
    const blob = await head(blobUrl, {
      token: process.env.PRIVATE_BLOB_READ_WRITE_TOKEN,
    });
    return NextResponse.redirect(blob.downloadUrl);
  } catch {
    return NextResponse.json({ error: "Image not found." }, { status: 404 });
  }
}
