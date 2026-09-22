'use client';

/**
 * 進站跳出來的「你傳的照片還有幾張要補傳」小窗。
 *
 * 使用者拍板：**誰傳的就跳給誰**（管理全站的人在 /admin「Drive 比對」看整份），
 * **每上線一次就跳一次**（2026-09-22 使用者更正：不是「每次登入」——
 * 進站 token 有效 7 天，照登入算的話一週才跳一次）。
 * 「上線」跟「XXX 上線囉」同一個定義：**離開超過 150 秒再回來**
 * （`OFFLINE_AFTER_MS`，＝後端 PRESENCE_ONLINE_MS）。所以：
 *   - 打開網站、隔一陣子重開分頁、手機切回來、螢幕關掉再打開 → 跳；
 *   - 站內換頁、重新整理、同時開第二個分頁 → 不跳（人一直都在線上）。
 * 最後在線上的時間記在 localStorage（`ACTIVE_KEY + uid`，分頁之間共用），
 * 看得見的時候每 60 秒推一次、切到背景那一刻也推一次。
 *
 * - 張數跟著 `/api/auth/me` 回來（`drivePendingMine`，零額外請求）；
 *   零張就什麼都不做，**連清單都不抓**。清單在跳出來那一刻才打 `/me/drive-pending`。
 * - 點「看照片」會把小窗收成一顆藥丸（不是關掉）：人要去相簿確認是哪一張，
 *   看完還要回來看下一列。layout 在換頁時不重掛，所以藥丸一路跟著。
 * - 補的方法跟 /admin 那份一樣：**把同一個原始檔再拖進那本相簿一次**，
 *   上傳流程會認出同一個檔並只補缺的那一半（ingestSources 的 incompleteTwin）。
 * - ⚠️ 列得出來的只有「站上有這一格、Drive 缺一半」的。整張沒傳上去的、
 *   以及 Drive 失敗而被回滾掉的影片，站上根本沒有那一列 —— 那些在上傳當下
 *   就已經逐檔 alert 過了。
 */

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { useAdmin } from '@/lib/useAdmin';
import { DrivePendingPhoto, fetchMyDrivePending } from '@/lib/api';
import styles from './DrivePendingNotice.module.css';

const ACTIVE_KEY = 'drive_pending_notice_active:';
/** 離開多久算「下線了」。跟後端 PRESENCE_ONLINE_MS 同一個數字 */
const OFFLINE_AFTER_MS = 150 * 1000;
const TOUCH_MS = 60 * 1000;

function readActive(uid: number): number {
  try { return Number(localStorage.getItem(ACTIVE_KEY + uid)) || 0; } catch { return 0; }
}
function touchActive(uid: number) {
  try { localStorage.setItem(ACTIVE_KEY + uid, String(Date.now())); } catch { /* 存不了就每次都跳 */ }
}

function missingLabel(p: DrivePendingPhoto): string {
  if (p.media_type === 'video') return '影片缺原始檔';
  if (p.media_type === 'gif') return 'GIF 缺原始檔';
  if (!p.has_4k && !p.has_original) return '4K 與原始檔都缺';
  return p.has_4k ? '缺原始檔' : '缺 4K';
}

export default function DrivePendingNotice() {
  const { user, drivePendingMine } = useAdmin();
  const [mode, setMode] = useState<'hidden' | 'open' | 'pill'>('hidden');
  const [items, setItems] = useState<DrivePendingPhoto[] | null>(null);
  const [failed, setFailed] = useState(false);
  const uid = user?.id ?? null;
  // ⚠️ `/me` 還沒回來之前 user 也是 null —— 只有「本來有人、現在沒了」才算登出，
  // 不然每次重新整理都會把記號清掉、再跳一次。
  const prevUid = useRef<number | null>(null);

  // 張數只在 /me 那一趟更新（跟 user 同一次 setState 回來，所以效果跑的時候已經是新的）；
  // 回到前景時拿它判斷「值不值得打一次清單」
  const pendingRef = useRef(drivePendingMine);
  pendingRef.current = drivePendingMine;

  useEffect(() => {
    const wasUid = prevUid.current;
    prevUid.current = uid;
    if (uid == null) {
      if (wasUid == null) return;
      // 登出了：下一次登入（哪怕是同一個人、同一個分頁）要再跳一次
      try { localStorage.removeItem(ACTIVE_KEY + wasUid); } catch { /* 無痕模式之類的 */ }
      setMode('hidden');
      setItems(null);
      return;
    }

    let alive = true;
    const show = () => {
      if (pendingRef.current <= 0) return;
      setMode('open');
      setFailed(false);
      setItems(null);
      fetchMyDrivePending().then((list) => {
        if (!alive) return;
        if (list === null) setFailed(true);
        else if (list.length === 0) setMode('hidden'); // 在這中間補完了
        else setItems(list);
      });
    };
    // 「剛上線」＝上一次在線上是 150 秒以前（或從來沒有）
    const cameOnline = () => {
      const was = readActive(uid);
      touchActive(uid);
      if (Date.now() - was > OFFLINE_AFTER_MS) show();
    };

    if (document.visibilityState === 'visible') cameOnline();
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') touchActive(uid);
    }, TOUCH_MS);
    const onVis = () => {
      if (document.visibilityState === 'visible') cameOnline();
      else touchActive(uid); // 切走那一刻記下來，回來才算得出離開多久
    };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      alive = false;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [uid]);

  if (mode === 'hidden') return null;
  const count = items?.length ?? drivePendingMine;

  if (mode === 'pill') {
    return (
      <button type="button" className={styles.pill} onClick={() => setMode('open')}>
        ⚠️ 還有 {count} 個檔案要補傳
      </button>
    );
  }

  return (
    <div className={styles.panel} role="dialog" aria-label="需要補傳的檔案">
      <div className={styles.head}>
        <strong>你傳的檔案有 {count} 個還沒備份完整</strong>
        <button type="button" className={styles.close} onClick={() => setMode('hidden')} aria-label="關閉">×</button>
      </div>
      <p className={styles.note}>
        站上看得到，但 Google Drive 上的大圖或原始檔缺了一份。
        補的方法：<b>把同一個原始檔再拖進那本相簿一次</b>，
        網站會認出是同一個檔，只補缺的那一份（不會多出一張）。
      </p>
      {failed && <p className={styles.error}>清單讀取失敗，重新整理再試一次。</p>}
      {!items && !failed && <p className={styles.note}>讀取中…</p>}
      {items && (
        <ul className={styles.list}>
          {items.map((p) => (
            <li key={p.id} className={styles.row}>
              <div className={styles.rowText}>
                <span className={styles.name} title={p.title}>{p.title || p.file_name}</span>
                <span className={styles.meta}>
                  {p.album_name ?? '（相簿已不存在）'} · {missingLabel(p)}
                </span>
              </div>
              {p.album_id != null && (
                <Link
                  href={`/album?id=${p.album_id}&photo=${p.id}`}
                  className={styles.link}
                  onClick={() => setMode('pill')}
                >
                  看照片 ↗
                </Link>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
