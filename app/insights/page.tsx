import { Suspense } from "react";
import { InsightsView } from "@/components/insights/InsightsView";

/**
 * Operations dashboard for admins.
 *
 * Routing/auth: this path is gated by `middleware.ts` (admin Basic Auth →
 * 4-hour session cookie). Unauthenticated requests never reach this server
 * component.
 *
 * Data: fetched client-side from `GET /api/dashboard-metrics?period=...`. We
 * keep the data fetching inside the client component so the period selector
 * can re-fetch without round-tripping through SSR.
 */
export const dynamic = "force-dynamic";

export default function InsightsPage() {
  return (
    <Suspense
      fallback={
        <div className="h-full bg-neutral-950 text-white flex items-center justify-center">
          <p className="text-neutral-400">Loading...</p>
        </div>
      }
    >
      <InsightsView />
    </Suspense>
  );
}
