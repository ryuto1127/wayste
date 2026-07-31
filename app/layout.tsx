import type { Metadata } from "next";
import { Noto_Sans_JP } from "next/font/google";
import "./globals.css";

const notoSansJP = Noto_Sans_JP({
  subsets: ["latin"],
  variable: "--font-noto-sans-jp",
  weight: ["400", "500", "700", "900"],
  display: "swap",
});

const SITE_URL = "https://wayste.vercel.app";
const SITE_TITLE =
  "wayste — ゴミ箱に近づくだけで正しい捨て先がわかるAI分別キオスク";
const SITE_DESCRIPTION =
  "余計な手間を一切かけず、普段通りのプロセスで正しくゴミを捨てられる社会へ。オフィス・大学・空港・公共空間向けのAI分別キオスク wayste。";
const OG_IMAGE = "/marketing/og-card.png";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: SITE_TITLE,
  description: SITE_DESCRIPTION,
  openGraph: {
    type: "website",
    locale: "ja_JP",
    url: SITE_URL,
    siteName: "wayste",
    title: SITE_TITLE,
    description: SITE_DESCRIPTION,
    images: [
      {
        url: OG_IMAGE,
        width: 1200,
        height: 630,
        alt: "wayste — ゴミ箱に近づくだけで、正しい捨て先がわかる。AI分別キオスク",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: SITE_TITLE,
    description: SITE_DESCRIPTION,
    images: [OG_IMAGE],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ja" className={notoSansJP.variable}>
      <body
        suppressHydrationWarning
        className="bg-white text-neutral-900 antialiased font-sans"
      >
        {children}
      </body>
    </html>
  );
}
