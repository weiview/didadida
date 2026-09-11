"use client";

import { useSyncExternalStore } from "react";
import { clearFeatured, fetchFeatured, setPhotosFeatured, type FeaturedItem } from "./api";

/**
 * 本次精選（0029）的清單。全站只有一份，右上角那顆「★ 精選」與燈箱裡那顆 ★
 * **共用同一份** —— 在燈箱按完，右上角的數字當場就要跟著變。
 *
 * module 層 store ＋ useSyncExternalStore，同 restrictedReveal／presence 那一套。
 * ⚠️ 換值一定要「複本做好再換掉」，useSyncExternalStore 比的是參考。
 *
 * 寫入那兩支（PUT /photos/featured、DELETE /featured）回的是**寫完之後的整份清單**，
 * 所以按完直接換上，不另外重抓一次。
 */

export interface FeaturedState {
  /** 抓回來過至少一次。還沒之前右上角那顆不畫（不知道就不要畫） */
  ready: boolean;
  items: FeaturedItem[];
}

const EMPTY: FeaturedState = { ready: false, items: [] };

let state: FeaturedState = EMPTY;
const listeners = new Set<() => void>();

function set(next: FeaturedState) {
  state = next;
  listeners.forEach((l) => l());
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => { listeners.delete(l); };
}

export function useFeatured(): FeaturedState {
  return useSyncExternalStore(subscribe, () => state, () => EMPTY);
}

/**
 * 抓一次清單。⚠️ 失敗保留手上那份，不要清空 ——
 * 清了右上角那顆會一下消失一下出現，看起來像精選被人清掉了。
 */
export async function loadFeatured(): Promise<void> {
  const items = await fetchFeatured();
  if (items) set({ ready: true, items });
}

/** 放進／移出精選。成功回 true，清單換成後端回來的那份 */
export async function toggleFeatured(photoId: number, next: boolean): Promise<boolean> {
  const items = await setPhotosFeatured([photoId], next);
  if (!items) return false;
  set({ ready: true, items });
  return true;
}

/** 清空整份精選 */
export async function clearAllFeatured(): Promise<boolean> {
  const items = await clearFeatured();
  if (!items) return false;
  set({ ready: true, items });
  return true;
}

/**
 * 登出時清掉。留著的話下一個登入的人（可能是看不到某幾張的訪客）
 * 會先看到上一個人那份清單，直到下一次抓回來。
 */
export function resetFeatured() {
  if (state !== EMPTY) set(EMPTY);
}
