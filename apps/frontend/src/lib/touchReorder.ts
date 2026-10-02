"use client";

import { useEffect, useRef } from "react";

/**
 * 觸控版的拖曳排序（首頁相簿、相簿裡的照片共用）。
 *
 * ⚠️⚠️ HTML5 原生拖放（`draggable` ＋ `dragstart`／`dragenter`）**在 Android WebView 裡
 * 用手指根本不會觸發** —— 於是 App 裡長按一秒卡片會「舉起來」，但怎麼拖都不動。
 * 桌機的滑鼠照舊走原生拖放；手指舉起來之後改由這裡接手：
 * document 層的原生 touchmove（`passive: false`，React 的 onTouchMove 是被動的、
 * preventDefault 擋不住捲動），用 `elementFromPoint` 找手指底下那張卡片
 * （卡片要帶 `data-reorder-index`），再呼叫跟原生拖放同一組 start／enter／end。
 *
 * `liftedIndex` 只有「用手指舉起來的那一張」才給，其他時候給 null（整組不掛）。
 */
export function useTouchReorder(
  liftedIndex: number | null,
  handlers: { start: (i: number) => void; enter: (i: number) => void; end: () => void },
) {
  // 監聽器只在舉起來時掛一次，處理器每次 render 都換新的（裡面讀的是 state）
  const ref = useRef(handlers);
  ref.current = handlers;

  useEffect(() => {
    if (liftedIndex === null) return;
    let started = false;

    const onMove = (e: TouchEvent) => {
      if (e.touches.length !== 1) return;
      // 擋掉捲動：手指已經在拖卡片了
      e.preventDefault();
      if (!started) {
        started = true;
        ref.current.start(liftedIndex);
      }
      const t = e.touches[0];
      const el = document.elementFromPoint(t.clientX, t.clientY)?.closest("[data-reorder-index]");
      if (!el) return;
      const i = Number(el.getAttribute("data-reorder-index"));
      if (Number.isInteger(i)) ref.current.enter(i);
    };
    const onEnd = () => {
      if (!started) return;
      started = false;
      ref.current.end();
    };
    // 長按中系統可能叫出選單（或開始選字），那會把這次觸控整個取消掉
    const onContextMenu = (e: Event) => e.preventDefault();

    document.addEventListener("touchmove", onMove, { passive: false });
    document.addEventListener("touchend", onEnd);
    document.addEventListener("touchcancel", onEnd);
    document.addEventListener("contextmenu", onContextMenu);
    return () => {
      document.removeEventListener("touchmove", onMove);
      document.removeEventListener("touchend", onEnd);
      document.removeEventListener("touchcancel", onEnd);
      document.removeEventListener("contextmenu", onContextMenu);
    };
  }, [liftedIndex]);
}

/**
 * 可以拖的卡片上要加的樣式：長按時不選字、不跳系統選單。
 * Android 的長按一旦開始選字，瀏覽器就把手勢接管走（`pointercancel`），
 * 一秒的長按計時器根本等不到。
 */
export const NO_LONG_PRESS_STYLE = {
  WebkitUserSelect: "none",
  userSelect: "none",
  WebkitTouchCallout: "none",
} as const;
