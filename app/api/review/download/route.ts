/**
 * GET /api/review/download — Server-side proxy for /api/review/export.
 *
 * Adds the ADMIN_API_KEY header server-side so the review page can trigger
 * ZIP image exports without exposing the key to the client.
 *
 * Accepts the same query params as /api/review/export:
 *   ?from=YYYY-MM-DD
 *   ?to=YYYY-MM-DD
 */

export async function GET(request: Request) {
  const apiKey = process.env.ADMIN_API_KEY ?? "";

  const incomingUrl = new URL(request.url);
  const exportUrl = new URL("/api/review/export", incomingUrl.origin);
  exportUrl.search = incomingUrl.search;

  const res = await fetch(exportUrl.toString(), {
    headers: { "x-api-key": apiKey },
  });

  return res;
}
