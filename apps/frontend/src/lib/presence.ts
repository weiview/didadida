'use client';

/**
 * 誰現在在線上。
 *
 * 一個 module 層的 store ＋ useSyncExternalStore，跟 lib/exifPref.ts 與
 * lib/restrictedReveal.ts 同一套寫法 —— 全站共用同一份，不管有幾個元件在看，
 * **輪詢只有一份**。
 *
 * ## 為什麼是輪詢，不是 WebSocket
 *
 * 常連線在 Cloudflare 上要 Durable Objects，那是另一個計費資源，而免費額度是
 * 這個站的最高宗旨。家用相簿同時在線最多幾個人，60 秒一次的代價是每人每小時
 * 60 次請求 —— 五個人各看兩小時 ≈ 600 次／天，在 10 萬次／天裡是零頭。
 * 後端那一趟也只是一次條件式 UPDATE ＋ 一次幾十列的 SELECT（見 migrations/0022）。
 *
 * ## 一支端點做兩件事
 *
 * `GET /api/presence` 同時「回報我還在」與「回誰在線上」。分成兩支等於每分鐘
 * 兩次請求，而它們本來就是同一個節奏。
 *
 * ## 訪客整個不參與
 *
 * 訪客沒有 User 那一列（跟留言同一個道理），而且「家裡誰現在在線上」是作息，
 * 比照片本身敏感。後端回空清單，這裡因此連計時器都不開。
 */

import { useEffect, useSyncExternalStore } from 'react';
import { fetchPresence } from './api';

/** 幾秒問一次。要小於後端 PRESENCE_ONLINE_MS（150 秒），不然自己都會閃成離線 */
const POLL_MS = 60 * 1000;

/**
 * 拿不到就用這個當「上線中」的門檻。後端每次都會回真正的值（online_ms），
 * 這個常數只在第一次還沒回來、或是舊後端沒有這個欄位時頂著。
 */
const DEFAULT_ONLINE_MS = 150 * 1000;

export interface PresenceSnapshot {
  /** uid → 最後一次心跳的毫秒數。沒有那個 key ＝ 不知道（不是離線） */
  seen: Map<number, number>;
  /** 名字，給「XXX 上線囉」用 */
  names: Map<number, string>;
  onlineMs: number;
  /** 我自己是誰。訪客是 null */
  self: number | null;
  /** 第一次抓回來之前是 false —— 在那之前不要跳任何「上線囉」 */
  ready: boolean;
}

const EMPTY: PresenceSnapshot = {
  seen: new Map(), names: new Map(), onlineMs: DEFAULT_ONLINE_MS, self: null, ready: false,
};

let snapshot: PresenceSnapshot = EMPTY;
const listeners = new Set<() => void>();

/**
 * ⚠️ 換值一定要「複本做好再換掉」 —— useSyncExternalStore 比的是參考，
 *    就地改 Map 不會讓任何人重畫。
 */
function publish(next: PresenceSnapshot) {
  snapshot = next;
  listeners.forEach((l) => l());
}

export function subscribePresence(l: () => void): () => void {
  listeners.add(l);
  return () => { listeners.delete(l); };
}

export const getPresence = (): PresenceSnapshot => snapshot;
/** SSR 快照。`output: "export"` 會在 build 時跑一次，這裡不能碰 window */
export const getPresenceServer = (): PresenceSnapshot => EMPTY;

/** 這個人現在算不算在線上。不知道（清單裡沒有他）一律當離線 */
export function isOnline(uid: number | null | undefined, snap: PresenceSnapshot = snapshot): boolean {
  if (uid == null) return false;
  const t = snap.seen.get(uid);
  if (t == null) return false;
  return Date.now() - t < snap.onlineMs;
}

/* ── 「XXX 上線囉」 ────────────────────────────────────────────────────────
 *
 * 誰從離線變成上線就跳一次。三條規則都是為了不吵人：
 *   ① 第一次抓回來不跳（不然一進站就被五個人的提示蓋滿）
 *   ② 自己不跳
 *   ③ **上一份快照裡明確是離線的**才跳 —— 上一份根本沒有這個人（新加入白名單、
 *      或是他之前 last_seen_at 是 NULL）不算「剛上線」，那只是我們第一次知道他
 */

export interface PresenceToast { key: number; name: string }

const toastListeners = new Set<(t: PresenceToast) => void>();
let toastSeq = 0;

export function subscribePresenceToasts(fn: (t: PresenceToast) => void): () => void {
  toastListeners.add(fn);
  return () => { toastListeners.delete(fn); };
}

/* ── 輪詢 ────────────────────────────────────────────────────────────────
 *
 * 全站只有一份。第一個掛上來的元件開，最後一個離開時關。
 */

let refCount = 0;
let timer: ReturnType<typeof setInterval> | null = null;
let inFlight = false;

async function poll() {
  // 同一時間只有一趟。visibilitychange 補問的那一下很容易跟計時器撞在一起
  if (inFlight) return;
  inFlight = true;
  try {
    const data = await fetchPresence();
    const users = data.users;

    const seen = new Map<number, number>();
    const names = new Map<number, string>();
    for (const u of users) {
      names.set(u.id, u.name);
      const t = u.last_seen_at ? Date.parse(u.last_seen_at) : NaN;
      if (Number.isFinite(t)) seen.set(u.id, t);
    }
    const onlineMs = data.online_ms ?? DEFAULT_ONLINE_MS;
    const { self } = data;

    const prev = snapshot;
    const next: PresenceSnapshot = { seen, names, onlineMs, self, ready: true };

    // 誰剛上線（規則見上面）
    if (prev.ready) {
      const now = Date.now();
      // forEach 不是 for…of：tsconfig 的 target 是 ES5，直接迭代 Map 過不了型別檢查
      seen.forEach((t, uid) => {
        if (uid === self) return;
        if (now - t >= onlineMs) return;                 // 現在就不在線上
        const before = prev.seen.get(uid);
        if (before == null) return;                      // 上一份不知道他 —— 不算剛上線
        if (now - before < prev.onlineMs) return;        // 上一份就已經在線上了
        const toast: PresenceToast = { key: ++toastSeq, name: names.get(uid) || '有人' };
        toastListeners.forEach((fn) => fn(toast));
      });
    }

    publish(next);
  } catch {
    /*
     * 網路抖一下就算了 —— 保留上一份快照。清空的話全站的燈會一起變灰再變回來，
     * 而且會在下一次抓回來時把所有人都當成「剛上線」。
     */
  } finally {
    inFlight = false;
  }
}

/** 回前景就補問一次：背景分頁的 setInterval 會被瀏覽器降頻到一分鐘一次 */
const onWake = () => { if (document.visibilityState === 'visible') void poll(); };

export function startPresence(): () => void {
  refCount++;
  if (refCount === 1) {
    void poll();
    timer = setInterval(() => { void poll(); }, POLL_MS);
    document.addEventListener('visibilitychange', onWake);
    window.addEventListener('focus', onWake);
  }
  return () => {
    refCount--;
    if (refCount === 0) {
      if (timer) clearInterval(timer);
      timer = null;
      document.removeEventListener('visibilitychange', onWake);
      window.removeEventListener('focus', onWake);
      // 快照留著：換頁（同一個 SPA）時燈不要先全滅再亮回來
    }
  };
}

/**
 * 登出時清乾淨。不清的話下一個登入的人會先看到上一個人的名單，
 * 而且第一次抓回來會把所有人都當成「剛上線」跳一排提示。
 */
export function resetPresence() {
  publish(EMPTY);
}

/* ── hooks ──────────────────────────────────────────────────────────────── */

/**
 * 目前的快照。**只是看，不會開輪詢** —— 開輪詢的是 usePresencePoll()，
 * 全站只有 <PresenceToasts /> 那一個地方掛它。
 *
 * 燈是每 60 秒跟著新快照一起更新的（isOnline 吃 Date.now()，但畫面要有新的
 * 參考才會重畫）。這對 150 秒的門檻夠用，不必為了燈另外開一個計時器。
 */
export function usePresence(): PresenceSnapshot {
  return useSyncExternalStore(subscribePresence, getPresence, getPresenceServer);
}

/** 開輪詢。掛在全站唯一的那個元件上（見 components/PresenceToasts.tsx） */
export function usePresencePoll(enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
    return startPresence();
  }, [enabled]);
}
