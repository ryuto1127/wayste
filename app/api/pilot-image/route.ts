/**
 * GET /api/pilot-image?url=<blobUrl>
 * Generates a short-lived signed URL for a private Vercel Blob and redirects to it.
 * This lets you view captured frames from the Upstash log without making the store public.
 */

import { NextResponse } from "next/server";
import { head } from "@vercel/blob";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const blobUrl = searchParams.get("url");

  if (!blobUrl) {
    return NextResponse.json({ error: "Missing url parameter." }, { status: 400 });
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
