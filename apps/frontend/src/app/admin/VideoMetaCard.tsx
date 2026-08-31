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

/** 「有沒有值」在這裡要看得出來 —— 空的那一邊寫「—」，不要留一片空白 */
function fmtTime(local?: string | null, source?: string | null): string {
  if (!local) return "—";
  return source ? `${local}（${source}）` : local;
}

function fmtGeo(lat?: number | null, lng?: number | null): string {
  if (lat == null || lng == null) return "—";
  return `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
}

export default function VideoMetaCard() {
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [items, setItems] = useState<VideoMetaItem[]>([]);
  const [more, setMore] = useState(0);
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null);
  /** 剛剛跑的是哪一種 —— 底下那份明細要照它換欄位 */
  const [mode, setMode] = useState<"fill" | "compare">("fill");

  const run = async (compare: boolean) => {
    setBusy(true);
    setItems([]);
    setMore(0);
    setMessage(null);
    setProgress(null);
    setMode(compare ? "compare" : "fill");
    try {
      let cursor = 0;
      let total = 0;
      let scanned = 0;
      let updated = 0;
      let rounds = 0;
      /** 全站的分母，只有第一輪回得到（後端每一趟都算得出來，但一樣的值不必重取） */
      let totals: { all: number; complete: number; noDrive: number } | null = null;
      const collected: VideoMetaItem[] = [];
      let extra = 0;

      for (;;) {
        const res = await backfillVideoMeta(cursor, PER_CALL, compare);
        if (rounds === 0) {
          total = res.remaining_before;
          totals = {
            all: res.total_videos ?? 0,
            complete: res.videos_complete ?? 0,
            noDrive: res.videos_without_drive ?? 0,
          };
        }
        rounds++;
        scanned += res.scanned;
        updated += res.updated;
        cursor = res.next_cursor;

        for (const it of res.items) {
          /*
           * 比對模式先把「兩邊一樣」的丟掉再收 —— 一百多支全收下來的話，
           * 300 這個上限會被沒事的那些吃光，真正不一樣的反而排不進來。
           */
          if (compare && !it.differs && !it.error) continue;
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
      /*
       * ⚠️⚠️ 「看了 0 支，補上 0 支。沒有需要回讀的影片。」是這一格上線當天就被
       *    回報的問題：站上明明有一百多支影片。**那句話沒有說謊，只是沒說完** ——
       *    補空格那條的條件是「時間或座標是空的」，而那些影片早就被人手動填過了
       *    （time_source = 'manual'），所以一支都沒命中。
       *    把分母講出來才答得完整：總共幾支、其中幾支已經有值、幾支沒有 Drive 備份。
       */
      const tail = totals && totals.all > 0
        ? `站上共 ${totals.all} 支影片，其中 ${totals.complete} 支的時間與座標都已經有值`
          + (totals.noDrive ? `、${totals.noDrive} 支沒有 Drive 備份（讀不到檔）` : "")
          + "。"
        : "站上目前沒有影片。";

      setMessage(
        compare
          ? {
              text: `重讀了 ${scanned} 支影片，其中 ${updated} 支跟站上存的不一樣`
                + (failed ? `，${failed} 支讀不到（見下面）` : "")
                + "。這一趟一個字都沒有寫進去。",
              ok: failed === 0,
            }
          : {
              text: `看了 ${scanned} 支影片，補上 ${updated} 支`
                + (failed ? `，${failed} 支讀不到（見下面）` : "")
                + "。"
                + (scanned === 0 ? `沒有需要回讀的影片：${tail}` : ""),
              ok: failed === 0,
            },
      );
    } catch (e) {
      setMessage({ text: e instanceof Error ? e.message : "回讀失敗", ok: false });
    } finally {
      setBusy(false);
    }
  };

  const shown = mode === "compare"
    ? items.filter((it) => it.differs || it.error)
    : items;

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

      <p className={styles.hint}>
        已經填好的那些想再確認一次，按<strong>重讀比對</strong> —— 它照樣去 Drive 讀，
        但<strong>一個字都不寫</strong>，只把「站上存的」跟「檔案裡寫的」並排列出來。
        要改哪一支自己到那張照片的燈箱按「指定時間」：手動填的是你自己的判斷，
        比檔案裡推出來的時間更算數。
      </p>

      <div className={styles.formRow}>
        <button
          className={`${styles.button} ${styles.primary}`}
          onClick={() => run(false)}
          disabled={busy}
        >
          {busy ? "處理中..." : "回讀影片資訊"}
        </button>
        <button
          className={styles.button}
          onClick={() => run(true)}
          disabled={busy}
        >
          重讀比對（不寫入）
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

      {/*
        * 比對模式只列「不一樣的」與「讀不到的」—— 一百多支影片逐支列出來沒有人
        * 看得完，而兩邊一樣的那幾支本來就沒有事情要做。
        */}
      {shown.length > 0 && (
        <div className={styles.detail}>
          <div className={styles.detailHead}>
            {mode === "compare"
              ? `跟站上不一樣的（${shown.length}${more ? ` / 另有 ${more} 支未列出` : ""}）`
              : `逐支結果（${shown.length}${more ? ` / 另有 ${more} 支未列出` : ""}）`}
          </div>
          {shown.map((it) => (
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
                  : mode === "compare"
                  ? [
                      // 站上存的 → 檔案裡讀到的。兩邊都攤開，改不改由使用者決定
                      `站上 ${fmtTime(it.stored_taken_at_local, it.stored_time_source)}`
                        + `／檔案 ${fmtTime(it.taken_at_local, it.time_source)}`,
                      `站上 ${fmtGeo(it.stored_lat, it.stored_lng)}`
                        + `／檔案 ${fmtGeo(it.lat, it.lng)}`,
                      HOW_LABEL[it.how] ?? it.how,
                    ].join("・")
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
