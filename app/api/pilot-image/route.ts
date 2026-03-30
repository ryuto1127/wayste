/**
 * GET /api/pilot-image?url=<blobUrl>
 * Redirects to a public Vercel Blob URL.
 */

import { NextResponse } from "next/server";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const blobUrl = searchParams.get("url");

  if (!blobUrl) {
    return NextResponse.json({ error: "Missing url parameter." }, { status: 400 });
  }

  return NextResponse.redirect(blobUrl);
}
