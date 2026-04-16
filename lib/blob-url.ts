/**
 * Blob URL allow-listing.
 *
 * The app fetches images from Vercel Blob by URL. Because those URLs can
 * originate from Redis entries (which were once writable by any client), a
 * malicious entry could point at an attacker-controlled blob store and steal
 * the `Authorization: Bearer <BLOB_READ_WRITE_TOKEN>` header when the server
 * follows it.
 *
 * Mitigation: pin the allowed host to our own store-specific subdomain via
 * the `BLOB_STORE_HOST` env var (e.g. `abc123.public.blob.vercel-storage.com`).
 * If the URL's host does not match exactly, refuse to fetch it.
 *
 * Fallback (dev only): if `BLOB_STORE_HOST` is unset, accept any
 * `*.public.blob.vercel-storage.com` host but emit a one-time warning.
 */

const VERCEL_BLOB_SUFFIX = ".public.blob.vercel-storage.com";
let warnedMissingHost = false;

export function isAllowedBlobUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;

  const configured = process.env.BLOB_STORE_HOST;
  if (configured) {
    // Strict: exact host match only
    return parsed.hostname === configured;
  }

  // Dev fallback — warn once
  if (!warnedMissingHost) {
    warnedMissingHost = true;
    console.warn(
      "[blob-url] BLOB_STORE_HOST is not set; falling back to suffix check. " +
        "Set BLOB_STORE_HOST=<store-id>.public.blob.vercel-storage.com in production.",
    );
  }
  return parsed.hostname.endsWith(VERCEL_BLOB_SUFFIX);
}
