import type { Metadata, Viewport } from "next";
import { Noto_Sans_JP } from "next/font/google";
import { SiteStreamsProvider } from "@/lib/site-streams-context";
import "./globals.css";

const notoSansJP = Noto_Sans_JP({
  subsets: ["latin"],
  variable: "--font-noto-sans-jp",
  weight: ["400", "500", "700", "900"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "wayste",
  description:
    "Smart waste sorting assistant — hold an item in front of the camera to find the right bin.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`h-full ${notoSansJP.variable}`}>
      <body suppressHydrationWarning className="h-full overflow-hidden bg-neutral-950 text-white antialiased font-sans">
        <SiteStreamsProvider>{children}</SiteStreamsProvider>
      </body>
    </html>
  );
}
