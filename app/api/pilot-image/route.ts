/**
 * GET /api/pilot-image?url=<blobUrl>
 *
 * Proxies Vercel Blob images through the server so that Blob URLs
 * are never exposed to the browser. Private blobs are fetched using
 * the BLOB_READ_WRITE_TOKEN.
 *
 * Protected by admin auth (middleware.ts) — only accessible from /review.
 *
 * Security:
 *   - Only allows URLs whose host exactly matches BLOB_STORE_HOST (see
 *     lib/blob-url.ts). Prevents the Authorization header from ever being
 *     sent to an attacker-controlled blob store.
 *   - No unauthenticated fallback: if the token-authenticated fetch fails
 *     with 403, we fail closed rather than retrying without credentials.
 */

import { NextResponse } from "next/server";
import { isAllowedBlobUrl } from "@/lib/blob-url";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const blobUrl = searchParams.get("url");

  if (!blobUrl) {
    return NextResponse.json({ error: "Missing url parameter." }, { status: 400 });
  }

  if (!isAllowedBlobUrl(blobUrl)) {
    return NextResponse.json({ error: "URL not allowed." }, { status: 403 });
  }

  const token = process.env.BLOB_READ_WRITE_TOKEN;

  try {
    const headers: HeadersInit = {};
    if (token) {
      headers["Authorization"] = `Bearer ${token}`;
    }

    const upstream = await fetch(blobUrl, { headers });

    if (!upstream.ok) {
      return NextResponse.json(
        { error: "Image not found." },
        { status: upstream.status === 404 ? 404 : 502 },
      );
    }

    const contentType = upstream.headers.get("content-type") || "image/jpeg";

    return new NextResponse(upstream.body, {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "Cache-Control": "private, max-age=3600",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch {
    return NextResponse.json({ error: "Failed to fetch image." }, { status: 502 });
  }
}
