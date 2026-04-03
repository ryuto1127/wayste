import ErrorBoundary from "@/components/ErrorBoundary";
import KioskDisplay from "@/components/KioskDisplay";
import { loadSiteConfig } from "@/lib/waste-rules";
import { generateSessionToken } from "@/lib/session-token";

export default async function Page() {
  const siteId = process.env.SITE_ID ?? "default";
  const config = loadSiteConfig(siteId);
  const defaultLocale = (config.defaultLocale ?? "en") as "en" | "ja";
  const sessionToken = generateSessionToken();
  return (
    <ErrorBoundary>
      <KioskDisplay defaultLocale={defaultLocale} sessionToken={sessionToken} />
    </ErrorBoundary>
  );
}
