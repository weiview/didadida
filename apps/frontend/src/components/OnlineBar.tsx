"use client";

/**
 * 右上角「現在誰在線上」。
 *
 * 收起來是一排小頭像 ＋ 一個數字，點開才是完整名單（在線上的在前面，離線的
 * 寫上最後一次出現是什麼時候）。
 *
 * ⚠️ **這裡不開輪詢** —— 全站只有 <PresenceToasts /> 那一個地方開
 * （見 lib/presence.ts）。這支只是 `usePresence()` 看同一份快照，
 * 所以多掛這一條在每一頁**不會多打任何一次 API**。
 *
 * ⚠️ **訪客整個不畫。** 他沒有 User 那一列，後端回的本來就是空清單；而且
 *    「家裡誰現在在線上」是作息，比照片座標敏感（同 lib/presence.ts 的取捨）。
 *
 * ⚠️ 第一次抓回來之前（`ready` 是 false）也不畫 —— 先畫一排灰的再跳綠，
 *    看起來像每個人都剛上線，跟頭像上那些燈「不知道就不要畫」的約定一致。
 */

import { useEffect, useMemo, useState } from "react";
import { useAdmin } from "@/lib/useAdmin";
import { isOnline, usePresence, type PresencePerson } from "@/lib/presence";
import Avatar from "./Avatar";
import styles from "./OnlineBar.module.css";

/** 收起來時最多露幾顆頭。再多就是「+N」，不然這條會頂到帳號牌 */
const MAX_HEADS = 3;

/** 「最後出現」寫成人看得懂的相對時間。null ＝ 這個帳號還沒回來過 */
function lastSeenText(t: number | null): string {
  if (t == null) return "還沒登入過";
  const m = Math.floor((Date.now() - t) / 60000);
  if (m < 1) return "剛剛";
  if (m < 60) return `${m} 分鐘前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小時前`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d} 天前`;
  return new Date(t).toLocaleDateString();
}

export default function OnlineBar() {
  const { isAdmin, checking, user } = useAdmin();
  const snap = usePresence();
  const [open, setOpen] = useState(false);

  // 名單開著的時候 Esc 收起來（同帳號牌那顆的約定）
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  /*
   * 在線上的排前面（自己排在最後 —— 「誰在線上」問的是別人）；
   * 離線的照最後出現的時間由近而遠，還沒登入過的墊底。
   */
  const { online, offline } = useMemo(() => {
    const all: PresencePerson[] = [];
    snap.people.forEach((p) => all.push(p));
    const on = all.filter((p) => isOnline(p.id, snap));
    const off = all.filter((p) => !isOnline(p.id, snap));
    on.sort((a, b) => (a.id === snap.self ? 1 : 0) - (b.id === snap.self ? 1 : 0));
    off.sort((a, b) => (b.lastSeen ?? -1) - (a.lastSeen ?? -1));
    return { online: on, offline: off };
  }, [snap]);

  // 還在問「這張 token 算不算數」、訪客、還沒抓回來過 —— 三種都不畫
  if (checking || !isAdmin || user?.id == null || !snap.ready) return null;
  if (snap.people.size === 0) return null;

  /*
   * 收起來那排頭像**不畫自己** —— 自己就在旁邊那顆帳號牌上，而「誰在線上」
   * 問的是別人。都沒有別人的時候畫一顆灰點 ＋「只有你在線上」，
   * 空著一條會讓人以為壞了。
   */
  const others = online.filter((p) => p.id !== snap.self);
  // 露幾顆頭是版面問題，真正的人數一律看旁邊那個數字（所以這裡不必再畫「+N」）
  const heads = others.slice(0, MAX_HEADS);

  return (
    <>
      {open && <div className={styles.catcher} onClick={() => setOpen(false)} />}
      <div className={styles.wrap}>
        <button
          type="button"
          className={styles.pill}
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          title={others.length > 0 ? `${others.length} 位家人在線上` : "只有你在線上"}
        >
          {heads.length > 0 ? (
            <span className={styles.heads}>
              {heads.map((p) => (
                <span key={p.id} className={styles.head}>
                  <Avatar src={p.avatar} name={p.name} color={p.color} size={26} />
                </span>
              ))}
            </span>
          ) : (
            <span className={`${styles.dot} ${styles.dotIdle}`} />
          )}
          <span className={styles.count}>
            {/* 只有自己的時候寫「只有你在線上」比寫一個 0 誠實 */}
            {others.length > 0
              ? `${others.length} 人在線上`
              : "只有你在線上"}
          </span>
        </button>

        {open && (
          <div className={styles.panel} role="dialog" aria-label="誰在線上">
            <div className={styles.title}>
              {others.length > 0 ? `${others.length} 位家人在線上` : "目前只有你在線上"}
            </div>
            {online.map((p) => (
              <div key={p.id} className={styles.row}>
                <Avatar src={p.avatar} name={p.name} color={p.color} size={28} presence="online" />
                <span className={styles.name}>
                  {p.name}
                  {p.id === snap.self && <span className={styles.me}>你自己</span>}
                </span>
                <span className={`${styles.when} ${styles.online}`}>上線中</span>
              </div>
            ))}
            {offline.map((p) => (
              <div key={p.id} className={`${styles.row} ${styles.rowOffline}`}>
                <Avatar src={p.avatar} name={p.name} color={p.color} size={28} presence="offline" />
                <span className={styles.name}>{p.name}</span>
                <span className={styles.when}>{lastSeenText(p.lastSeen)}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
