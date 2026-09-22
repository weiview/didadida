'use client';

/**
 * 進站跳出來的「你傳的照片還有幾張要補傳」小窗。
 *
 * 使用者拍板：**誰傳的就跳給誰**（管理全站的人在 /admin「Drive 比對」看整份），
 * **每次登入都跳**。「每次」是以瀏覽器分頁的 session 算（sessionStorage）——
 * 同一個分頁裡換頁不會一直跳，重開網站／重新登入才會再跳一次。
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

const SEEN_KEY = 'drive_pending_notice_shown:';

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

  useEffect(() => {
    const wasUid = prevUid.current;
    prevUid.current = uid;
    if (uid == null) {
      if (wasUid == null) return;
      // 登出了：下一次登入（哪怕是同一個人、同一個分頁）要再跳一次
      try {
        for (let i = sessionStorage.length - 1; i >= 0; i--) {
          const k = sessionStorage.key(i);
          if (k?.startsWith(SEEN_KEY)) sessionStorage.removeItem(k);
        }
      } catch { /* 無痕模式之類的，當成沒記過 */ }
      setMode('hidden');
      setItems(null);
      return;
    }
    if (drivePendingMine <= 0) return;
    try {
      if (sessionStorage.getItem(SEEN_KEY + uid)) return;
      sessionStorage.setItem(SEEN_KEY + uid, '1');
    } catch { /* 存不了就每次都跳，也還可以接受 */ }
    setMode('open');
    let alive = true;
    fetchMyDrivePending().then((list) => {
      if (!alive) return;
      if (list === null) setFailed(true);
      else if (list.length === 0) setMode('hidden'); // 在這中間補完了
      else setItems(list);
    });
    return () => { alive = false; };
  }, [uid, drivePendingMine]);

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
