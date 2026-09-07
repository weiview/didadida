"use client";

import { useState } from "react";
import { scanMotionPhotos, type MotionScanItem } from "@/lib/api";
import AdminSection from "./AdminSection";
import styles from "./admin.module.css";

/*
 * Android 動態照片的補掃（見 migrations/0024）。
 *
 * 2026-08-31 之後上傳的照片在瀏覽器裡就掃過了（位元組本來就在使用者手上，
 * 那時候讀是免費的）。在那之前傳上來的每一張 `motion_offset` 都是 NULL ——
 * 「還沒看過」，於是站上不知道哪幾張有動畫。這一格把它們的原始檔從 Drive
 * 讀回檔頭那 128KB，算出動畫的起點寫回 D1。
 *
 * ⚠️⚠️ 同 VideoMetaCard：**這是前端的迴圈，不是一次請求**。Workers 免費版
 *    單次呼叫上限 50 個 subrequest，而一張照片至少要一次 Drive 讀取，
 *    所以後端一趟只做十張，由這裡推 cursor 直到 done。
 * ⚠️ 一般照片**只花一次讀取**就結束（檔頭裡沒有那段 XMP 就直接回 0），
 *    所以整批掃一遍的成本是「每張一次」，不是每張兩三次。
 */

const PER_CALL = 10;
/** 保險絲：10 張一輪，600 輪＝6000 張。壞掉時不要讓迴圈永遠打下去。 */
const MAX_ROUNDS = 600;
/** 明細留在畫面上的上限 —— 只列掃出動畫的與讀不到的，兩種都很少 */
const MAX_ITEMS = 300;

export default function MotionScanCard() {
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [items, setItems] = useState<MotionScanItem[]>([]);
  const [more, setMore] = useState(0);
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null);

  const run = async () => {
    setBusy(true);
    setItems([]);
    setMore(0);
    setMessage(null);
    setProgress(null);
    try {
      let cursor = 0;
      let total = 0;
      let already = 0;
      let scanned = 0;
      let found = 0;
      let rounds = 0;
      const collected: MotionScanItem[] = [];
      let extra = 0;

      for (;;) {
        const res = await scanMotionPhotos(cursor, PER_CALL);
        if (rounds === 0) {
          total = res.remaining_before;
          already = res.found_total_before;
        }
        rounds++;
        scanned += res.scanned;
        found += res.found;
        cursor = res.next_cursor;

        for (const it of res.items) {
          // 掃過了、不是動態照片的那些不列 —— 那是絕大多數，列出來只會淹掉重點
          if (!it.error && !(it.offset > 0)) continue;
          if (collected.length < MAX_ITEMS) collected.push(it);
          else extra++;
        }
        setItems([...collected]);
        setMore(extra);
        setProgress({ done: Math.min(scanned, total || scanned), total: total || scanned });

        if (res.done) break;
        if (rounds >= MAX_ROUNDS) {
          setMessage({
            text: `已掃描 ${MAX_ROUNDS} 輪仍未完成，暫停處理。再按一次會從中斷處繼續。`,
            ok: false,
          });
          break;
        }
      }

      const failed = collected.filter((it) => it.error).length;
      /*
       * 讀不到的那幾張**刻意留成沒掃過**（後端不寫 D1），下次按會再試一次 ——
       * Drive 抖一下就把一張動態照片永久記成「沒有動畫」太可惜了。
       * 所以這句話要講清楚「再按一次會重試」，不然使用者會以為那幾張沒救了。
       */
      setMessage({
        text: `已掃描 ${scanned} 張照片，其中 ${found} 張含動態影片`
          + (already ? `（含先前掃描結果，全站共 ${already + found} 張）` : "")
          + (failed ? `。${failed} 張無法讀取，詳見下方，再按一次會重試` : "")
          + "。"
          + (scanned === 0 ? "所有照片皆已掃描完成。" : ""),
        ok: failed === 0,
      });
    } catch (e) {
      setMessage({ text: e instanceof Error ? e.message : "掃描失敗", ok: false });
    } finally {
      setBusy(false);
    }
  };

  return (
    <AdminSection id="motion-scan" title="Android 動態照片">
      <p className={styles.hint}>
        部分 Android 手機拍照時會在照片中附帶一段一至兩秒的短片。
        站上不另外儲存這段影片，播放時直接從 Drive 上的原始檔即時擷取。
      </p>
      <p className={styles.hint}>
        新上傳的照片會自動偵測，此功能用於掃描先前上傳的照片：
        從 Drive 讀取原始檔的檔頭，找出含有動態影片的照片。
        已掃描過的不會重複處理，中途離開也可於下次繼續。
      </p>

      <div className={styles.formRow}>
        <button
          className={`${styles.button} ${styles.primary}`}
          onClick={run}
          disabled={busy}
        >
          {busy ? "掃描中…" : "掃描動態照片"}
        </button>
      </div>

      {progress && (
        <div className={styles.progressTrack}>
          <div
            className={styles.progressBar}
            style={{ width: `${progress.total ? Math.round((progress.done / progress.total) * 100) : 100}%` }}
          />
        </div>
      )}

      {message && (
        <p className={`${styles.message} ${message.ok ? styles.ok : styles.err}`}>{message.text}</p>
      )}

      {items.length > 0 && (
        <div className={styles.detail}>
          <div className={styles.detailHead}>
            含動態影片與無法讀取的項目（{items.length}{more ? ` / 另有 ${more} 張未列出` : ""}）
          </div>
          {items.map((it) => (
            <div key={it.id} className={styles.detailRow}>
              {/*
                * ⚠️⚠️ 相簿頁是 `/album?id=<相簿>`，**不是** `/album/<相簿>`。
                *    前端是 `output: "export"` 的純靜態站，`src/app/album/` 底下
                *    沒有 `[id]` 這一層，多打一段路徑就是實實在在的 404。
                */}
              <a
                className={styles.detailName}
                href={`/album?id=${it.album_id}&photo=${it.id}`}
                target="_blank"
                rel="noreferrer"
                title="在新分頁開啟這張照片"
              >
                {it.title || `#${it.id}`}
              </a>
              <span className={styles.detailNote}>
                {it.error ? `無法讀取：${it.error}` : `含動態影片（起始位元組 ${it.offset.toLocaleString()}）`}
              </span>
            </div>
          ))}
        </div>
      )}
    </AdminSection>
  );
}
