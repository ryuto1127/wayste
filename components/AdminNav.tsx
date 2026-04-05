"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { Locale } from "@/lib/i18n";
import { t } from "@/lib/i18n";

type Page = "dashboard" | "review";

interface AdminNavProps {
  locale: Locale;
  onToggleLocale: () => void;
}

function NavLink({
  href,
  active,
  children,
}: {
  href: string;
  active: boolean;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      className={`px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors whitespace-nowrap ${
        active
          ? "bg-neutral-600 text-white"
          : "bg-neutral-800 hover:bg-neutral-700 text-neutral-300"
      }`}
    >
      {children}
    </Link>
  );
}

export function AdminNav({ locale, onToggleLocale }: AdminNavProps) {
  const pathname = usePathname();

  const current: Page = pathname === "/dashboard" ? "dashboard" : "review";

  const T = (key: Parameters<typeof t>[1]) => t(locale, key);

  return (
    <nav className="flex items-center gap-2 flex-wrap">
      <NavLink href="/dashboard" active={current === "dashboard"}>
        {T("feedbackDashboard")}
      </NavLink>
      <NavLink href="/review" active={current === "review"}>
        {T("imageReview")}
      </NavLink>
      <span className="w-px h-5 bg-neutral-700 mx-1" />
      <button
        onClick={onToggleLocale}
        className="px-2.5 py-1.5 rounded-lg bg-neutral-800 hover:bg-neutral-700 text-xs transition-colors text-neutral-300 whitespace-nowrap"
      >
        {T("switchLang")}
      </button>
      <Link
        href="/"
        className="px-2.5 py-1.5 rounded-lg bg-neutral-800 hover:bg-neutral-700 text-xs transition-colors text-neutral-300 whitespace-nowrap"
      >
        {T("backToKiosk")}
      </Link>
    </nav>
  );
}
