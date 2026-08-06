"use client";

import { useEffect, useState } from "react";

/**
 * 捲過這個高度才出現。一往下捲就冒出來會擋到內容，
 * 而捲不到一個螢幕的頁面本來就不需要「回到上方」
 */
const SHOW_AFTER_PX = 600;

/**
 * 回到頁面最上方的浮動按鈕。
 *
 * 掛在 RootLayout，所有頁面共用 —— 相簿頁動輒上百張縮圖，
 * 地圖頁下面還有一整區工具，每一頁都自己做一顆是白費力氣。
 */
export default function ScrollToTopButton() {
  const [show, setShow] = useState(false);

  useEffect(() => {
    // 捲動是每一幀都在發的事件，這裡只做一次比較，不必節流；
    // 真正貴的是 setState，所以只在跨過門檻的那一下才會觸發重繪
    const onScroll = () => setShow(window.scrollY > SHOW_AFTER_PX);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <button
      type="button"
      aria-label="回到頁面最上方"
      title="回到最上方"
      // floating-control：捲動中 globals.css 會把全站的 pointer-events 關掉，這是豁免票。
      //   只在按鈕真的看得到時才掛，藏起來時照樣不吃點擊。
      // glass-control：跟 FabMenu 同一片玻璃。這裡不加 glass-accent —— 留暖白，
      //   它是導覽而不是動作，不該跟正上方的 FAB 搶同一份注意力。
      className={`glass-control${show ? " floating-control" : ""}`}
      onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
      style={{
        position: "fixed",
        // 右下角。左下角在手機上會撞到系統的返回手勢區
        right: "max(16px, env(safe-area-inset-right))",
        // 同一個角落還會有浮動操作鈕／編輯模式動作列，它們會把 --corner-stack-bottom
        // 墊高（見 lib/cornerStack.ts）；沒人佔用時就回到角落本身
        bottom: "var(--corner-stack-bottom, max(16px, env(safe-area-inset-bottom)))",
        width: 44,
        height: 44,
        borderRadius: "50%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        cursor: "pointer",
        zIndex: 900,
        // 淡入淡出而不是直接 unmount：突然出現／消失的按鈕會讓人以為誤觸了什麼。
        // 藏起來時一併關掉 pointer-events，否則會擋住底下右下角的東西
        opacity: show ? 1 : 0,
        ["--glass-transform" as string]: show ? "translateY(0)" : "translateY(8px) scale(0.9)",
        pointerEvents: show ? "auto" : "none",
        // bottom 會隨 corner stack 變動（FAB／動作列出現時），跟著補一段過場
        transitionProperty: "transform, box-shadow, opacity, background-color, bottom",
      } as React.CSSProperties}
    >
      {/* 用線條圖示取代 ↑ 字元：字型的箭頭在不同平台粗細差很多，也對不準圓心 */}
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <line x1="12" y1="19" x2="12" y2="6" />
        <polyline points="6 12 12 6 18 12" />
      </svg>
    </button>
  );
}
