"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { Locale } from "@/lib/i18n";
import { t } from "@/lib/i18n";

interface AdminNavProps {
  locale: Locale;
  onToggleLocale: () => void;
}

/**
 * Top-right admin navigation bar shared across admin pages (/review, /insights).
 *
 * Buttons are kept compact and visually neutral so the *page content* (review
 * grid, dashboard charts) stays the focus. The cross-page link adapts to the
 * current path so admins always have a one-click bridge between the two
 * primary admin views.
 */
export function AdminNav({ locale, onToggleLocale }: AdminNavProps) {
  const T = (key: Parameters<typeof t>[1]) => t(locale, key);
  const pathname = usePathname() ?? "";

  // Decide the cross-link target so /review ↔ /insights are always reachable
  // in one click. We treat any path under /insights as "currently on insights"
  // (so the button points back to /review) and everything else as "show
  // insights" (so the button points to /insights).
  const onInsights = pathname.startsWith("/insights");
  const crossLink = onInsights
    ? { href: "/review", label: T("backToReview") }
    : { href: "/insights", label: T("openInsights") };

  return (
    <nav className="flex items-center gap-2 flex-wrap">
      <button
        onClick={onToggleLocale}
        className="px-2.5 py-1.5 rounded-lg bg-neutral-800 hover:bg-neutral-700 text-xs transition-colors text-neutral-300 whitespace-nowrap"
      >
        {T("switchLang")}
      </button>
      <Link
        href={crossLink.href}
        className="px-2.5 py-1.5 rounded-lg bg-neutral-800 hover:bg-neutral-700 text-xs transition-colors text-neutral-300 whitespace-nowrap"
      >
        {crossLink.label}
      </Link>
      <Link
        href="/kiosk"
        className="px-2.5 py-1.5 rounded-lg bg-neutral-800 hover:bg-neutral-700 text-xs transition-colors text-neutral-300 whitespace-nowrap"
      >
        {T("backToKiosk")}
      </Link>
    </nav>
  );
}
