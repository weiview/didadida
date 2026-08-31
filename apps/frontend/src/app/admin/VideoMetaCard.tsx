"use client";

import { useState } from "react";
import { backfillVideoMeta, type VideoMetaItem } from "@/lib/api";
import AdminSection from "./AdminSection";
import styles from "./admin.module.css";

/*
 * 影片的拍攝時間／座標回讀。
 *
 * 影片的封面圖是瀏覽器 canvas 畫的、不帶任何 metadata，所以 2026-08-31 之前傳上來的
 * 影片全都是 taken_at NULL（在相簿裡永遠排最前面）。這一格把那些影片的原始檔從 Drive
 * 上用 Range 讀回 moov box，解出時間與座標寫回 D1。
 *
 * ⚠️⚠️ 這是**前端的迴圈，不是一次請求** —— 同「比對全部相簿」那顆（見 DriveCompareCard）。
 * 一支影片要 1～3 次 Drive Range 請求，而 Workers 免費版單次呼叫上限 50 個 subrequest，
 * 所以後端一趟只做 VIDEO_META_DEFAULT_LIMIT 支，由這裡推 cursor 直到 done。
 */

const PER_CALL = 6;
/** 保險絲：6 支一輪，400 輪＝2400 支。壞掉時不要讓迴圈永遠打下去。 */
const MAX_ROUNDS = 400;
/** 明細留在畫面上的上限，超出的只計數 —— 幾百列沒有人看得完。 */
const MAX_ITEMS = 300;

const HOW_LABEL: Record<string, string> = {
  tagged: "檔案自己寫了時區",
  derived: "檔名交叉驗證推出時區",
  instant: "只有 UTC 瞬間",
  wall: "只有牆上時間（當 +8）",
  none: "讀不到時間",
};

export default function VideoMetaCard() {
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [items, setItems] = useState<VideoMetaItem[]>([]);
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
      let scanned = 0;
      let updated = 0;
      let rounds = 0;
      const collected: VideoMetaItem[] = [];
      let extra = 0;

      for (;;) {
        const res = await backfillVideoMeta(cursor, PER_CALL);
        if (rounds === 0) total = res.remaining_before;
        rounds++;
        scanned += res.scanned;
        updated += res.updated;
        cursor = res.next_cursor;

        for (const it of res.items) {
          if (collected.length < MAX_ITEMS) collected.push(it);
          else extra++;
        }
        setItems([...collected]);
        setMore(extra);
        setProgress({ done: Math.min(scanned, total || scanned), total: total || scanned });

        if (res.done) break;
        if (rounds >= MAX_ROUNDS) {
          setMessage({
            text: `跑了 ${MAX_ROUNDS} 輪還沒完，先停下來。再按一次會從頭接著跑。`,
            ok: false,
          });
          break;
        }
      }

      const failed = collected.filter((it) => it.error).length;
      setMessage({
        text: `看了 ${scanned} 支影片，補上 ${updated} 支`
          + (failed ? `，${failed} 支讀不到（見下面）` : "")
          + (updated === 0 && scanned === 0 ? "。沒有需要回讀的影片。" : "。"),
        ok: failed === 0,
      });
    } catch (e) {
      setMessage({ text: e instanceof Error ? e.message : "回讀失敗", ok: false });
    } finally {
      setBusy(false);
    }
  };

  return (
    <AdminSection id="video-meta" title="影片的拍攝時間與座標">
      <p className={styles.hint}>
        影片的封面圖是瀏覽器畫出來的，不帶任何拍攝資訊 —— 所以早期傳上來的影片沒有時間，
        在相簿裡會一直排在最前面。這顆按鈕會把那些影片的原始檔從 Google Drive 讀回來，
        解出檔案自己記著的拍攝時間與座標寫回站上。
      </p>
      <p className={styles.hint}>
        只補<strong>目前是空的</strong>那幾格：已經有時間的不動，手動改過座標的也不動。
        一次看幾支就回報一次，可以按著不管，跑完會講結果。
      </p>

      <div className={styles.formRow}>
        <button
          className={`${styles.button} ${styles.primary}`}
          onClick={run}
          disabled={busy}
        >
          {busy ? "回讀中..." : "回讀影片資訊"}
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
          <div className={styles.detailHead}>逐支結果（{items.length}{more ? ` / 另有 ${more} 支未列出` : ""}）</div>
          {items.map((it) => (
            <div key={it.id} className={styles.detailRow}>
              <a
                className={styles.detailName}
                href={`/album/${it.album_id}?photo=${it.id}`}
                target="_blank"
                rel="noreferrer"
                title="在新分頁看這支影片"
              >
                {it.title || `#${it.id}`}
              </a>
              <span className={styles.detailNote}>
                {it.error
                  ? `讀不到：${it.error}`
                  : [
                      it.wrote_time
                        ? `時間 ${it.taken_at_local ?? ""}（${it.time_source ?? ""}）`
                        : null,
                      it.wrote_geo && it.lat != null && it.lng != null
                        ? `座標 ${it.lat.toFixed(5)}, ${it.lng.toFixed(5)}`
                        : null,
                      !it.wrote_time && !it.wrote_geo
                        ? (HOW_LABEL[it.how] ?? it.how)
                        : null,
                    ]
                      .filter(Boolean)
                      .join("・")}
              </span>
            </div>
          ))}
        </div>
      )}
    </AdminSection>
  );
}
