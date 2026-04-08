/**
 * Uploads a base64-encoded JPEG frame to Vercel Blob.
 * Returns the blob URL, or undefined if the upload fails or is disabled.
 * Always best-effort — never throws.
 *
 * PRIVACY: @vercel/blob v2 does not support server-side download of private
 * blobs, so images use public access. Security is enforced at the app layer:
 *   - URLs include a random suffix (non-guessable / non-enumerable)
 *   - URLs are only exposed through admin-authenticated routes (/review)
 *   - Images are auto-deleted after BLOB_RETENTION_DAYS (default: 90)
 *   - Set BLOB_ENABLED=false to disable image uploads entirely
 */

import { put, head } from "@vercel/blob";

/** Set BLOB_ENABLED=false to disable all image uploads. */
const BLOB_ENABLED = process.env.BLOB_ENABLED !== "false";

export async function uploadFrameToBlob(
  base64Image: string,
  itemName: string,
  wasteStream: string,
  timestamp: string
): Promise<string | undefined> {
  if (!BLOB_ENABLED) return undefined;

  try {
    const buffer = Buffer.from(base64Image, "base64");
    // e.g. pilot-images/2026-03-27T10-00-00-plastic-bottle-recycling.jpg
    const safe = (s: string) => s.replace(/[^a-z0-9]/gi, "-").toLowerCase();
    const filename = `pilot-images/${timestamp.replace(/[:.]/g, "-")}-${safe(itemName)}-${safe(wasteStream)}.jpg`;

    const blob = await put(filename, buffer, {
      access: "public",
      contentType: "image/jpeg",
      addRandomSuffix: true,
    });

    return blob.url;
  } catch (err) {
    console.error("[blob-store] upload failed:", err);
    return undefined;
  }
}

/**
 * Verify that a blob URL is valid and accessible.
 * Returns true if the blob exists, false otherwise.
 */
export async function verifyBlobExists(url: string): Promise<boolean> {
  try {
    await head(url);
    return true;
  } catch {
    return false;
  }
}
