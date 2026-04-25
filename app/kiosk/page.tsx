import { connection } from "next/server";
import ErrorBoundary from "@/components/ErrorBoundary";
import KioskDisplay from "@/components/KioskDisplay";
import { loadSiteConfig } from "@/lib/waste-rules";

export default async function Page() {
  // Force dynamic rendering so the per-request CSP nonce from middleware
  // reaches Next.js's HTML emitter. Without this, the page is prerendered
  // at build time and the nonce is missing from bootstrap scripts —
  // strict-dynamic then blocks hydration and the screen stays black.
  await connection();
  const siteId = process.env.SITE_ID ?? "japan-office";
  const config = loadSiteConfig(siteId);
  const defaultLocale = (config.defaultLocale ?? "en") as "en" | "ja";
  return (
    <ErrorBoundary locale={defaultLocale}>
      <KioskDisplay defaultLocale={defaultLocale} />
    </ErrorBoundary>
  );
}
