"use client";

import ErrorBoundary from "@/components/ErrorBoundary";
import KioskDisplay from "@/components/KioskDisplay";

export default function Page() {
  return (
    <ErrorBoundary>
      <KioskDisplay />
    </ErrorBoundary>
  );
}
