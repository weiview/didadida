import type { Metadata } from "next";
import "./globals.css";
import ScrollOptimizer from "@/components/ScrollOptimizer";
import ScrollToTopButton from "@/components/ScrollToTopButton";

export const metadata: Metadata = {
  title: "DidaDida | 滴答生活",
  description: "您的專屬相簿空間",
};

export const viewport = {
  width: "device-width",
  initialScale: 1.0,
  maximumScale: 1.0,
  userScalable: false,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-TW">
      <body>
        <ScrollOptimizer />
        <main>{children}</main>
        <ScrollToTopButton />
      </body>
    </html>
  );
}
