"use client";

/**
 * 右上角「★ 精選 n」。點開是一格縮圖，點一張就直接進那本相簿、打開那一張。
 *
 * 清單全站只有一份（0029 `Photo.featured_at`），由可管理全站內容的人在燈箱
 * 左上角那顆 ★ 挑；**累積到手動清空**（這裡的「清空精選」或逐張 ×），
 * 不會自己過期。
 *
 * ⚠️ 看得到的人比「誰在線上」多：**訪客也看得到**（那是給全家看的東西）。
 *    後端照同一套可見規則過濾（不開放的、訪客看不到的相簿與影片都不會出現），
 *    所以這裡不必再判斷一次。
 *
 * ⚠️ 一張都沒有、或還沒抓回來之前**整顆不畫** —— 空著一顆「★ 0」只是雜訊。
 *
 * ⚠️ 請求只有兩個時機：身分確定的那一刻抓一次，以及**每次點開**再抓一次
 *    （別人剛挑的要看得到）。不開輪詢 —— 精選是幾天才動一次的東西。
 */

import Link from "next/link";
import { useEffect, useState } from "react";
import { useAdmin } from "@/lib/useAdmin";
import { clearAllFeatured, loadFeatured, toggleFeatured, useFeatured } from "@/lib/featured";
import { useRevealedRestricted } from "@/lib/restrictedReveal";
import { isVideo, photoThumbSrc } from "@/lib/api";
import PhotoImage from "./PhotoImage";
import styles from "./FeaturedBar.module.css";

export default function FeaturedBar() {
  const { checking, hasAccess, user, canManageOthers, restrictedBlur } = useAdmin();
  const { ready, items } = useFeatured();
  const revealed = useRevealedRestricted();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  /*
   * 身分一換就重抓：訪客與成員看得到的不一樣（不開放的、訪客看不到的相簿），
   * 登出時 useAdmin 已經 resetFeatured() 過了。
   */
  useEffect(() => {
    if (checking || !hasAccess) return;
    void loadFeatured();
  }, [checking, hasAccess, user?.id, canManageOthers]);

  // 名單開著的時候 Esc 收起來（同帳號牌、誰在線上那兩顆的約定）
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  // 最後一張被移掉時整顆就不畫了，open 要跟著收，不然下一次有精選時會自己彈開
  useEffect(() => {
    if (items.length === 0) setOpen(false);
  }, [items.length]);

  if (checking || !hasAccess || !ready || items.length === 0) return null;

  const toggle = () => {
    setOpen((v) => {
      if (!v) void loadFeatured();
      return !v;
    });
  };

  const remove = async (id: number) => {
    setBusy(true);
    const ok = await toggleFeatured(id, false);
    setBusy(false);
    if (!ok) alert("移除失敗，請稍後再試");
  };

  const clearAll = async () => {
    if (!window.confirm(`確定要清空本次精選（${items.length} 項）嗎？\n照片與影片本身不會被刪除。`)) return;
    setBusy(true);
    const ok = await clearAllFeatured();
    setBusy(false);
    if (!ok) alert("清空失敗，請稍後再試");
  };

  return (
    <>
      {open && <div className={styles.catcher} onClick={() => setOpen(false)} />}
      <div className={`${styles.wrap} ${open ? styles.wrapOpen : ""}`}>
        <button
          type="button"
          className={styles.pill}
          onClick={toggle}
          aria-expanded={open}
          title={`本次精選 ${items.length} 項`}
        >
          <span className={styles.star} aria-hidden>★</span>
          <span className={styles.label}>精選</span>
          <span className={styles.count}>{items.length}</span>
        </button>

        {open && (
          <div className={styles.panel} role="dialog" aria-label="本次精選">
            <div className={styles.head}>
              <span className={styles.title}>本次精選（{items.length}）</span>
              {canManageOthers && (
                <button type="button" className={styles.clearBtn} disabled={busy} onClick={clearAll}>
                  清空精選
                </button>
              )}
            </div>
            <div className={styles.grid}>
              {items.map((item) => {
                const blurred = restrictedBlur && item.restricted === 1 && !revealed.has(item.id);
                return (
                  <div key={item.id} className={styles.cell}>
                    <Link
                      href={`/album?id=${item.album_id}&photo=${item.id}`}
                      className={`${styles.thumb} ${blurred ? styles.thumbBlur : ""}`}
                      title={`${item.album_name} · ${item.title}`}
                      onClick={() => setOpen(false)}
                    >
                      <PhotoImage
                        src={photoThumbSrc(item, "sm")}
                        alt={item.title}
                        className={styles.img}
                        lazy
                      />
                      {isVideo(item) && <span className={styles.play} aria-hidden>▶</span>}
                    </Link>
                    {canManageOthers && (
                      <button
                        type="button"
                        className={styles.remove}
                        disabled={busy}
                        title="移出本次精選"
                        aria-label="移出本次精選"
                        onClick={() => remove(item.id)}
                      >
                        ×
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </>
  );
}
