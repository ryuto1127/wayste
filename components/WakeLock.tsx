"use client";

import { useEffect } from "react";

/**
 * Keeps the display awake while the kiosk page is open, via the Screen Wake
 * Lock API. A kiosk that lets the OS blank the screen mid-demo (or mid-shift)
 * looks dead — this is the app-side guarantee, independent of whatever the
 * host machine's sleep settings happen to be.
 *
 * The browser silently releases the lock whenever the tab is hidden, so it is
 * re-acquired on every return to visibility. Renders nothing.
 */
export default function WakeLock() {
  useEffect(() => {
    let sentinel: WakeLockSentinel | null = null;
    let cancelled = false;

    const acquire = async () => {
      try {
        if (!("wakeLock" in navigator)) return;
        const s = await navigator.wakeLock.request("screen");
        if (cancelled) {
          s.release().catch(() => {});
          return;
        }
        sentinel = s;
      } catch {
        // Not fatal — OS-level sleep settings are the fallback.
      }
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") acquire();
    };

    acquire();
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisibilityChange);
      sentinel?.release().catch(() => {});
    };
  }, []);

  return null;
}
