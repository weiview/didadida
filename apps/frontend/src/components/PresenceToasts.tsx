'use client';

/**
 * 「XXX 上線囉」，以及**全站唯一開輪詢的地方**。
 *
 * 兩件事綁在同一個元件上是刻意的：輪詢只能有一份，而這個元件掛在 layout.tsx，
 * 每一頁都在。頭像上那些燈只是 usePresence() 看同一份快照，不會各自開計時器。
 *
 * ⚠️ **訪客整個不掛**（`user` 是 null）—— 他沒有 User 那一列，後端也只會回空清單，
 *    開計時器等於每分鐘白打一次請求。
 */

import { useEffect, useState } from 'react';
import { useAdmin } from '@/lib/useAdmin';
import { PresenceToast, subscribePresenceToasts, usePresencePoll } from '@/lib/presence';
import styles from './PresenceToasts.module.css';

/**
 * 一則留幾秒。
 *
 * 本來是 4 秒，使用者反映「來不及看」—— 提示跳在左下角，而人多半正在看照片或
 * 捲相簿，視線移過去就已經過了一半。拉到 10 秒：還是會自己收掉（不需要有人按），
 * 但足夠瞄一眼再回去做原本的事。整疊本來就不吃點擊，賴久一點也擋不到任何東西。
 */
const TOAST_MS = 10000;

export default function PresenceToasts() {
  const { user } = useAdmin();
  const [toasts, setToasts] = useState<PresenceToast[]>([]);

  usePresencePoll(user?.id != null);

  useEffect(() => {
    const off = subscribePresenceToasts((t) => {
      setToasts((prev) => [...prev, t]);
      // 到時間自己收。key 是遞增的流水號，不會撞到（見 lib/presence.ts）
      setTimeout(() => {
        setToasts((prev) => prev.filter((x) => x.key !== t.key));
      }, TOAST_MS);
    });
    return off;
  }, []);

  if (toasts.length === 0) return null;

  return (
    <div className={styles.stack} aria-live="polite">
      {toasts.map((t) => (
        <div key={t.key} className={styles.toast}>
          <span className={styles.dot} />
          <span><span className={styles.name}>{t.name}</span> 上線囉</span>
        </div>
      ))}
    </div>
  );
}
