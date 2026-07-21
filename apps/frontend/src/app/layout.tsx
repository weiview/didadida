import type { Metadata } from "next";
import "./globals.css";
import ScrollOptimizer from "@/components/ScrollOptimizer";

export const metadata: Metadata = {
  title: "DidaDida | 滴答生活",
  description: "您的專屬相簿空間",
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
      </body>
    </html>
  );
}
