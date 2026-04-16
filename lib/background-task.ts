/**
 * Platform-agnostic background task runner.
 *
 * On Vercel: uses waitUntil() to keep the function alive after the response.
 * Self-hosted: fire-and-forget with error logging (the response has already
 * been sent, so the promise just runs to completion in the Node process).
 */

export function runInBackground(promise: Promise<unknown>): void {
  if (process.env.VERCEL) {
    // Dynamic import avoids bundling @vercel/functions in non-Vercel builds
    import("@vercel/functions")
      .then(({ waitUntil }) => waitUntil(promise))
      .catch(() => {
        // Fallback if import fails (shouldn't happen on Vercel)
        promise.catch((err) =>
          console.error("[background-task] Error (Vercel fallback):", err)
        );
      });
  } else {
    // Self-hosted: just let the promise run, log errors
    promise.catch((err) =>
      console.error("[background-task] Error:", err)
    );
  }
}

/**
 * Wrap a background promise so that a rejection only logs (with a label) and
 * resolves to `fallback`. Use for grouping independent operations under a
 * single `runInBackground(Promise.all([...]))` call when one's failure
 * MUST NOT short-circuit the others — e.g. a Blob upload error must not
 * skip the Redis log write that records the failure.
 */
export function isolated<T>(label: string, promise: Promise<T>, fallback: T): Promise<T> {
  return promise.catch((err) => {
    console.error(`[bg:${label}]`, err);
    return fallback;
  });
}
