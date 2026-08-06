"use client";

import { useEffect } from "react";

/**
 * 右下角是共用的地盤：浮動操作鈕（FabMenu）與編輯模式的動作列都佔那裡，
 * 而「回到頂端」鈕掛在 RootLayout、不知道當下的頁面放了什麼。
 *
 * 誰佔用了右下角，就自己登記需要抬高多少，這裡把最大值寫進 CSS 變數，
 * 回到頂端鈕只要讀 `--corner-stack-bottom` 就會疊在它們上面。
 */
const VAR = "--corner-stack-bottom";

/** 沒有人佔用時的落點，跟 ScrollToTopButton 的預設值一致 */
const BASE = "max(16px, env(safe-area-inset-bottom))";

/** BASE 的下限，量測式的佔用者要拿它換算相對抬升量 */
export const CORNER_BASE_PX = 16;

const lifts = new Map<symbol, number>();

function apply() {
  let max = 0;
  lifts.forEach(px => { if (px > max) max = px; });
  const root = document.documentElement;
  // 清掉變數而不是寫回 BASE：讓 ScrollToTopButton 的 fallback 值成為唯一的權威
  if (max <= 0) root.style.removeProperty(VAR);
  else root.style.setProperty(VAR, `calc(${BASE} + ${max}px)`);
}

/**
 * 佔用右下角期間，把上面的東西往上推 `px`（自己的高度 + 間距）。
 * `active` 為 false 就不登記 —— 用來處理「這一頁這個當下沒有浮動鈕」的情況。
 *
 * 用 Map 而不是單一變數：卸載與掛載的順序在同一次 commit 裡不見得如預期，
 * 兩個佔用者短暫並存時取最大值才不會互相把對方的登記抹掉。
 */
export function useCornerStackLift(px: number, active = true) {
  useEffect(() => {
    if (!active) return;
    const key = Symbol();
    lifts.set(key, px);
    apply();
    return () => {
      lifts.delete(key);
      apply();
    };
  }, [px, active]);
}
