"use client";

import { useSyncExternalStore } from "react";
import { isNewAlbum, isNewMedia, postPhotosSeen } from "./api";

/**
 * NEW 角標的「看過了沒」（2026-09-29 使用者拍板）：
 *   * 一週內新增的才算新，超過一週不管看過沒一律不顯示。
 *   * **在燈箱點開那一張才算看過**，逐張、逐人。
 *   * 自己傳的不對自己顯示（後端 markSeen 直接回 seen=1）。
 *
 * 成員：後端每一列帶 `seen`（0／1），相簿帶 `new_unseen`。點開時先記在這份記憶體
 *   store（格線當場拿掉角標），攢一批再 `POST /api/photos/seen`。
 * 訪客：沒有 User 那一列，**整份記在自己的 localStorage**（換一台裝置就重來，可以接受）。
 *   相簿卡片沒有逐張的資訊，退而求其次：點進過那本、而且之後沒有更新的照片就不新。
 *
 * ⚠️ 燈箱自己那顆 NEW 要用 `isPhotoNew(photo, { ignoreLocal: true })` ——
 *    一點開就記成看過，不忽略的話那顆角標永遠只閃一下。
 * ⚠️ 一律「複本做好再換掉」，useSyncExternalStore 比的是參考。
 */

const GUEST_PHOTOS_KEY = "didadida:seen_photos";
const GUEST_ALBUMS_KEY = "didadida:album_opened";
const KEEP_MS = 8 * 24 * 60 * 60 * 1000;
const FLUSH_MS = 1500;

let localSeen: ReadonlySet<number> = new Set<number>();
let guestLoaded = false;
let guestAlbums: Record<string, string> = {};
let version = 0;
const listeners = new Set<() => void>();

let pending: number[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function emit() {
  version++;
  listeners.forEach((l) => l());
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => { listeners.delete(l); };
}

function readJson(key: string): Record<string, unknown> {
  try {
    const raw = localStorage.getItem(key);
    const v = raw ? JSON.parse(raw) : null;
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

function writeJson(key: string, v: unknown) {
  try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* 無痕、滿了：這一次就不記 */ }
}

/** 訪客那兩份第一次用到時才讀，順手清掉 8 天前的 */
function loadGuest() {
  if (guestLoaded || typeof window === "undefined") return;
  guestLoaded = true;
  const now = Date.now();
  const photos = readJson(GUEST_PHOTOS_KEY);
  const next = new Set(localSeen);
  const kept: Record<string, number> = {};
  for (const [id, at] of Object.entries(photos)) {
    if (typeof at === "number" && now - at < KEEP_MS) {
      kept[id] = at;
      next.add(Number(id));
    }
  }
  localSeen = next;
  writeJson(GUEST_PHOTOS_KEY, kept);
  const albums = readJson(GUEST_ALBUMS_KEY);
  for (const [id, at] of Object.entries(albums)) if (typeof at === "string") guestAlbums[id] = at;
}

function flush() {
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  if (pending.length === 0) return;
  const ids = pending;
  pending = [];
  void postPhotosSeen(ids);
}

if (typeof window !== "undefined") {
  // 關分頁、切到背景那一下把還沒送的送出去（postPhotosSeen 帶 keepalive）
  window.addEventListener("pagehide", flush);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flush();
  });
}

/** 燈箱點開這一張時叫。不是新的（超過一週、早就看過）什麼都不做，不白送請求 */
export function markPhotoSeen(photo: { id: number; created_at?: string | null; seen?: number }) {
  if (!isNewMedia(photo)) return;
  if (photo.seen === 1 || localSeen.has(photo.id)) return;
  const next = new Set(localSeen);
  next.add(photo.id);
  localSeen = next;
  if (photo.seen === undefined) {
    // 訪客（或舊版後端）：記在自己的瀏覽器
    loadGuest();
    const all = readJson(GUEST_PHOTOS_KEY);
    all[String(photo.id)] = Date.now();
    writeJson(GUEST_PHOTOS_KEY, all);
  } else {
    pending.push(photo.id);
    if (!flushTimer) flushTimer = setTimeout(flush, FLUSH_MS);
  }
  emit();
}

/** 關燈箱時叫：別讓人回首頁時那本相簿的 NEW 還掛著 */
export const flushSeen = flush;

/** 訪客點進一本相簿時叫，記下「當時最新那張」的時間 */
export function markAlbumOpened(album: { id: number; latest_photo_at?: string | null; new_unseen?: number }) {
  if (album.new_unseen !== undefined || !album.latest_photo_at) return;
  loadGuest();
  if (guestAlbums[String(album.id)] === album.latest_photo_at) return;
  guestAlbums = { ...guestAlbums, [String(album.id)]: album.latest_photo_at };
  writeJson(GUEST_ALBUMS_KEY, guestAlbums);
  emit();
}

export function isPhotoNew(
  photo: { id: number; created_at?: string | null; seen?: number },
  opts?: { ignoreLocal?: boolean },
): boolean {
  if (!isNewMedia(photo)) return false;
  if (photo.seen === 1) return false;
  if (opts?.ignoreLocal) return true;
  if (photo.seen === undefined) loadGuest();
  return !localSeen.has(photo.id);
}

export function isAlbumNew(album: { id: number; latest_photo_at?: string | null; new_unseen?: number }): boolean {
  if (album.new_unseen !== undefined) return album.new_unseen > 0;
  if (!isNewAlbum(album)) return false;
  loadGuest();
  const opened = guestAlbums[String(album.id)];
  // 同一個格式（D1 的 'YYYY-MM-DD HH:MM:SS'），字串比就是時間比
  return !opened || String(album.latest_photo_at) > opened;
}

/** 用到 isPhotoNew／isAlbumNew 的元件掛這一支，看過之後才會重畫 */
export function useSeenVersion(): number {
  return useSyncExternalStore(subscribe, () => version, () => 0);
}

/** 登出：送掉手上那批再清記憶體（訪客那份 localStorage 留著，那是這台裝置的） */
export function resetSeen() {
  flush();
  localSeen = new Set<number>();
  guestLoaded = false;
  guestAlbums = {};
  emit();
}
