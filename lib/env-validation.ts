/**
 * Server-side environment variable validation.
 *
 * Called once at startup (via the root layout's server component) to ensure
 * all required secrets are present before the app starts serving requests.
 * Fails fast with a clear error message rather than crashing on first request.
 */

/** Env vars required for the classification API to function. */
const REQUIRED_VARS = [
  "OPENAI_API_KEY",
  "KV_REST_API_URL",
  "KV_REST_API_TOKEN",
  "BLOB_READ_WRITE_TOKEN",
] as const;

/** Env vars required only in production (Vercel). */
const PRODUCTION_ONLY_VARS = [
  "ADMIN_API_KEY",
  "CRON_SECRET",
  // Without this the kiosk gate has no secret to validate sessions against;
  // middleware would deny all kiosk access (the dev bypass is dev-only).
  "KIOSK_API_TOKEN",
] as const;

let validated = false;

export function validateEnv(): void {
  if (validated) return;

  const missing: string[] = [];

  for (const key of REQUIRED_VARS) {
    if (!process.env[key]) {
      missing.push(key);
    }
  }

  const isProduction = process.env.VERCEL === "1" || process.env.NODE_ENV === "production";
  if (isProduction) {
    for (const key of PRODUCTION_ONLY_VARS) {
      if (!process.env[key]) {
        missing.push(`${key} (required in production)`);
      }
    }
  }

  if (missing.length > 0) {
    const msg = `Missing required environment variables:\n  - ${missing.join("\n  - ")}`;
    console.error(`[env-validation] ${msg}`);

    // In production, fail hard. In dev, warn but continue.
    if (isProduction) {
      throw new Error(msg);
    }
  }

  validated = true;
}
