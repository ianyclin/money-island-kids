import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import "./globals.css";

export const viewport: Viewport = {
  themeColor: "#f4f0e7",
};

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("host") ?? "localhost:3000";
  const protocol = requestHeaders.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  const base = new URL(`${protocol}://${host}`);
  const title = "小小理財島｜先存一點，夢想長大";
  const description = "給家庭一起使用的兒童零用錢 App：先留一部分給未來、練習記錄與選擇，並為夢想慢慢累積。";

  return {
    metadataBase: base,
    title,
    description,
    applicationName: "小小理財島",
    manifest: "/manifest.webmanifest",
    appleWebApp: {
      capable: true,
      statusBarStyle: "default",
      title: "小小理財島",
    },
    openGraph: {
      title,
      description,
      type: "website",
      locale: "zh_TW",
    },
    twitter: {
      card: "summary",
      title,
      description,
    },
  };
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-Hant">
      <body>{children}</body>
    </html>
  );
}
