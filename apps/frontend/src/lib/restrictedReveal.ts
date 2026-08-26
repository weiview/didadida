"use client";

import { useSyncExternalStore } from "react";

/**
 * 「不開放的照片先糊著，點一下才暫時看得到」那個遮罩的掀開狀態。
 *
 * 為什麼是一份 module 層的 store 而不是某一頁的 state：同一張照片會出現在
 * 相簿格線、首頁搜尋結果、燈箱、補地點視窗裡。掀開之後在燈箱裡又要再點一次
 * 才看得到，那不是「暫時解開」，那是壞掉。
 *
 * **暫時的定義：活在記憶體裡，重整或關掉分頁就沒了。**
 * 刻意不寫 localStorage —— 這個遮罩要擋的就是「別人剛好看著螢幕」那一下，
 * 存起來等於下次打開又整片攤在那裡。也刻意不設定時器自動收回：
 * 看照片看到一半畫面自己糊掉，比沒有遮罩還難用。
 *
 * 這裡完全不管「誰看得到」—— 那是後端 SQL 的事（見 migrations/0020）。
 * 沒權限的人手上根本沒有這幾張，遮罩只作用在看得到的人自己那一份。
 */

const EMPTY: ReadonlySet<number> = new Set<number>();

let revealed: ReadonlySet<number> = EMPTY;
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((l) => l());
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => { listeners.delete(l); };
}

/**
 * 掀開這一張（已經掀開就什麼都不做）。
 *
 * ⚠️ 一律「複本做好再換掉」，不要就地 add／delete ——
 * useSyncExternalStore 比的是參考，原地改的話畫面不會重畫。
 */
export function revealRestricted(id: number) {
  if (revealed.has(id)) return;
  const next = new Set(revealed);
  next.add(id);
  revealed = next;
  emit();
}

/** 收回這一張 */
export function hideRestricted(id: number) {
  if (!revealed.has(id)) return;
  const next = new Set(revealed);
  next.delete(id);
  revealed = next;
  emit();
}

export function toggleRestrictedReveal(id: number) {
  if (revealed.has(id)) hideRestricted(id);
  else revealRestricted(id);
}

/**
 * 目前掀開了哪幾張。
 *
 * 回的是整份集合而不是「這一張掀了沒」，因為呼叫端多半是在 `.map()` 裡逐格判斷
 * —— hook 不能寫在迴圈裡。
 */
export function useRevealedRestricted(): ReadonlySet<number> {
  return useSyncExternalStore(subscribe, () => revealed, () => EMPTY);
}
