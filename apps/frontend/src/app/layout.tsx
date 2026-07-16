import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "DidaDida | 質感相簿",
  description: "您的專屬質感相簿空間",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-TW">
      <body>
        <main>{children}</main>
      </body>
    </html>
  );
}
