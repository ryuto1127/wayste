import type { Viewport } from "next";
import WakeLock from "@/components/WakeLock";

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
};

export default function KioskLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="fixed inset-0 overflow-hidden bg-neutral-950 text-white">
      <WakeLock />
      {children}
    </div>
  );
}
