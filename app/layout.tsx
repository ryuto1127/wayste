import type { Metadata } from "next";
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
  title: "wayste — ゴミ箱に近づくだけで正しい捨て先がわかるAI分別キオスク",
  description:
    "余計な手間を一切かけず、普段通りのプロセスで正しくゴミを捨てられる社会へ。オフィス・大学・空港・公共空間向けのAI分別キオスク wayste。",
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
        <SiteStreamsProvider>{children}</SiteStreamsProvider>
      </body>
    </html>
  );
}
