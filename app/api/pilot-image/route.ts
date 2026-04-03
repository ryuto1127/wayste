/**
 * GET /api/pilot-image?url=<blobUrl>
 *
 * Proxies private Vercel Blob images through the server.
 * The server fetches the blob using BLOB_READ_WRITE_TOKEN and streams
 * the image bytes to the client. Protected by admin auth (middleware.ts).
 */

import { NextResponse } from "next/server";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const blobUrl = searchParams.get("url");

  if (!blobUrl) {
    return NextResponse.json({ error: "Missing url parameter." }, { status: 400 });
  }

  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (!token) {
    return NextResponse.json({ error: "Blob token not configured." }, { status: 500 });
  }

  try {
    const res = await fetch(blobUrl, {
      headers: { authorization: `Bearer ${token}` },
    });

    if (!res.ok) {
      return NextResponse.json(
        { error: `Blob fetch failed: ${res.status}` },
        { status: res.status },
      );
    }

    const body = res.body;
    if (!body) {
      return NextResponse.json({ error: "Empty response from blob." }, { status: 502 });
    }

    return new NextResponse(body, {
      status: 200,
      headers: {
        "content-type": res.headers.get("content-type") ?? "image/jpeg",
        "cache-control": "private, max-age=3600",
      },
    });
  } catch (err) {
    console.error("[pilot-image] Proxy error:", err);
    return NextResponse.json({ error: "Failed to fetch image." }, { status: 502 });
  }
}
