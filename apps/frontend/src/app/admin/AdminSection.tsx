"use client";

/**
 * 後台的一格，可以收折。
 *
 * 為什麼要收折：這一頁已經長到要捲好幾螢幕（訪客權限、不開放的照片、同遊門檻、
 * 白名單、Drive 比對、GPS 資料夾…），而**每一次進來通常只為了其中一件事**。
 * 全部攤開的代價是每次都要捲過一堆跟這次無關的說明。
 *
 * ⚠️ 開合狀態**存在 localStorage，不進 D1**。這是「這台裝置上的顯示偏好」，
 *    跟 lib/exifPref.ts 同一個取捨 —— 多一欄就是每次 /api/auth/me 多讀一列，
 *    而這件事不需要跨裝置。讀不到（無痕、被擋）就退回 defaultOpen，不會壞。
 *
 * ⚠️ 用 button + 自己控制展開，**不是 <details>** —— 收起來的時候裡面的內容
 *    要真的不渲染。details 只是視覺上收起來，裡面那些 useState／輪詢照樣活著，
 *    而這一頁的內容裡有會打 API 的東西。
 */

import { useCallback, useEffect, useState } from "react";
import styles from "./admin.module.css";

const KEY_PREFIX = "admin_section_open:";

function readOpen(id: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(KEY_PREFIX + id);
    return v === null ? fallback : v === "1";
  } catch {
    return fallback;
  }
}

export default function AdminSection({
  id, title, badge, defaultOpen = false, children,
}: {
  /** localStorage 的 key。改名等於把大家的開合狀態重設，不要隨手改 */
  id: string;
  title: string;
  /** 標題右邊那句灰字（例如「12 人」）。收起來的時候它是唯一的線索 */
  badge?: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  /*
   * 第一次 render 一律用 defaultOpen —— `output: "export"` 是靜態產生的，
   * 在 render 裡讀 localStorage 會讓伺服器那份跟瀏覽器這份對不起來（hydration
   * mismatch）。掛載之後再校正成使用者上次的選擇。
   */
  const [open, setOpen] = useState(defaultOpen);

  useEffect(() => { setOpen(readOpen(id, defaultOpen)); }, [id, defaultOpen]);

  const toggle = useCallback(() => {
    setOpen((prev) => {
      const next = !prev;
      try { localStorage.setItem(KEY_PREFIX + id, next ? "1" : "0"); } catch { /* 無痕模式，記不住就算了 */ }
      return next;
    });
  }, [id]);

  return (
    <section className={`glass-panel ${styles.card}`}>
      <button type="button" className={styles.sectionHeader} onClick={toggle} aria-expanded={open}>
        <span className={`${styles.chevron} ${open ? styles.chevronOpen : ""}`} aria-hidden>▸</span>
        <span className={styles.sectionTitle}>{title}</span>
        {badge && <span className={styles.sectionBadge}>{badge}</span>}
      </button>
      {open && <div className={styles.sectionBody}>{children}</div>}
    </section>
  );
}
