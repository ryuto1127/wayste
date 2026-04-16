/**
 * Next.js instrumentation hook — runs once when the server starts.
 * Used for environment variable validation so missing secrets are caught
 * at deploy time, not on the first user request.
 *
 * See: https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation
 */

export async function register() {
  // Only validate on the server (not during build or in the browser)
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { validateEnv } = await import("@/lib/env-validation");
    validateEnv();
  }
}
