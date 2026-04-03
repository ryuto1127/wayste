/**
 * GET /api/pilot-image?url=<blobUrl>
 *
 * Redirects to a Vercel Blob image URL.
 * Protected by admin auth (middleware.ts) — only accessible from /review.
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
