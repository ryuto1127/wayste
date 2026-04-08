"use client";

import Link from "next/link";
import type { Locale } from "@/lib/i18n";
import { t } from "@/lib/i18n";

interface AdminNavProps {
  locale: Locale;
  onToggleLocale: () => void;
}

export function AdminNav({ locale, onToggleLocale }: AdminNavProps) {
  const T = (key: Parameters<typeof t>[1]) => t(locale, key);

  return (
    <nav className="flex items-center gap-2 flex-wrap">
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
