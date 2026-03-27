/**
 * Uploads a base64-encoded JPEG frame to Vercel Blob.
 * Returns the public URL, or undefined if the upload fails.
 * Always best-effort — never throws.
 */

import { put } from "@vercel/blob";

export async function uploadFrameToBlob(
  base64Image: string,
  itemName: string,
  wasteStream: string,
  timestamp: string
): Promise<string | undefined> {
  try {
    const buffer = Buffer.from(base64Image, "base64");
    // e.g. pilot-images/2026-03-27T10-00-00-plastic-bottle-recycling.jpg
    const safe = (s: string) => s.replace(/[^a-z0-9]/gi, "-").toLowerCase();
    const filename = `pilot-images/${timestamp.replace(/[:.]/g, "-")}-${safe(itemName)}-${safe(wasteStream)}.jpg`;

    const blob = await put(filename, buffer, {
      access: "private",
      contentType: "image/jpeg",
    });

    return blob.url;
  } catch (err) {
    console.error("[blob-store] upload failed:", err);
    return undefined;
  }
}
