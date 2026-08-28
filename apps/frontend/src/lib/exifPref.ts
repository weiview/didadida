"use client";

import { useSyncExternalStore } from "react";

/**
 * 燈箱裡「顯示照片資訊 (EXIF)」那個開關。
 *
 * 為什麼是一份 module 層的 store 而不是燈箱自己的 useState：那個開關本來是
 * `useState(false)`，**每換一張照片、每關一次燈箱就回到收起來**。想一路看
 * 每張的相機參數就得一張按一次，看起來像開關沒作用。
 *
 * 使用者要的是「打開之後整本相簿都是展開的狀態」，所以它是一個**站台層級的
 * 偏好設定**，不是某一張照片的狀態：一次打開，之後每一張、每一本都展開。
 *
 * **存在 localStorage**（跟 [[restrictedReveal]] 刻意相反）—— 這是使用者自己
 * 挑的顯示偏好，不是為了遮誰的眼睛，重整之後回到收起來只會讓人再按一次。
 * 只活在這台瀏覽器裡，不進 D1：多一欄設定就是每次 `/api/auth/me` 多讀一列，
 * 而這件事完全不需要跨裝置同步。
 *
 * ⚠️ localStorage 在無痕視窗／擋 cookie 的瀏覽器會直接丟例外，讀寫都要包 try。
 */

const KEY = "exif_expanded";

// null ＝ 還沒從 localStorage 讀過。第一次問的時候才讀，避免在模組載入時
// 就碰 window（`output: "export"` 是靜態產生的，那時候沒有 window）
let expanded: boolean | null = null;

const listeners = new Set<() => void>();

function snapshot(): boolean {
  if (expanded === null) {
    try {
      expanded = localStorage.getItem(KEY) === "1";
    } catch {
      expanded = false;
    }
  }
  return expanded;
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => { listeners.delete(l); };
}

export function setExifExpanded(next: boolean) {
  if (snapshot() === next) return;
  expanded = next;
  try {
    localStorage.setItem(KEY, next ? "1" : "0");
  } catch {
    // 存不起來就只在這次瀏覽期間有效，功能照樣可用
  }
  listeners.forEach((l) => l());
}

/**
 * 目前是不是展開。
 *
 * 伺服器端（產靜態頁的時候）一律回 false —— 那邊沒有 localStorage，
 * 而 useSyncExternalStore 會在補水之後自己再讀一次真正的值。
 */
export function useExifExpanded(): boolean {
  return useSyncExternalStore(subscribe, snapshot, () => false);
}
