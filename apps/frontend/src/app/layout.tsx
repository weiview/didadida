import type { Metadata } from "next";
import "./globals.css";
import ScrollOptimizer from "@/components/ScrollOptimizer";
import ScrollToTopButton from "@/components/ScrollToTopButton";
import AccessGate from "@/components/AccessGate";
import AccountBadge from "@/components/AccountBadge";
import PresenceToasts from "@/components/PresenceToasts";
import { AuthProvider } from "@/lib/useAdmin";

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
        {/*
          身分狀態放在最外層只有一份（AuthProvider），底下的 AccessGate 與各頁面
          共用它。**不能讓 AccessGate 與頁面各跑一次身分檢查** —— 登入回呼的
          token 藏在網址 fragment 裡，收走的人會立刻擦掉網址，兩份 state 會互搶。
        */}
        <AuthProvider>
          <AccessGate>
            {/* 右上角的帳號牌。跟回到頂端鈕一樣掛在這裡而不是各頁自己做一顆 ——
                「我現在是誰、怎麼登出」在每一頁都該問得到 */}
            <AccountBadge />
            {/* 「XXX 上線囉」。它同時是全站唯一開上線輪詢的地方（見 lib/presence.ts）
                —— 掛在這裡才每一頁都在，頭像上那些燈只是看同一份快照 */}
            <PresenceToasts />
            <main>{children}</main>
            <ScrollToTopButton />
          </AccessGate>
        </AuthProvider>
      </body>
    </html>
  );
}
