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
      onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
      style={{
        position: "fixed",
        // 右下角。左下角在手機上會撞到系統的返回手勢區
        right: "max(16px, env(safe-area-inset-right))",
        bottom: "max(16px, env(safe-area-inset-bottom))",
        width: 44,
        height: 44,
        borderRadius: "50%",
        border: "1px solid rgba(148, 163, 184, 0.4)",
        background: "rgba(255, 255, 255, 0.88)",
        backdropFilter: "blur(8px)",
        WebkitBackdropFilter: "blur(8px)",
        boxShadow: "0 4px 14px rgba(15, 23, 42, 0.18)",
        color: "#334155",
        fontSize: 18,
        lineHeight: 1,
        cursor: "pointer",
        zIndex: 900,
        // 淡入淡出而不是直接 unmount：突然出現／消失的按鈕會讓人以為誤觸了什麼。
        // 藏起來時一併關掉 pointer-events，否則會擋住底下右下角的東西
        opacity: show ? 1 : 0,
        transform: show ? "translateY(0)" : "translateY(8px)",
        pointerEvents: show ? "auto" : "none",
        transition: "opacity 0.18s ease, transform 0.18s ease",
      }}
    >
      ↑
    </button>
  );
}
