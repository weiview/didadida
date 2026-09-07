"use client";

import { useState } from "react";
import styles from "./admin.module.css";
import AdminSection from "./AdminSection";
import { DrivePendingList } from "./DrivePendingCard";
import {
  DriveAuditAlbumReport, DriveAuditState,
  auditOneAlbum, fetchDriveAudit, runDriveAudit,
} from "@/lib/api";

/**
 * 後台那一格：**Drive 比對**。
 *
 * 站上一張照片，Drive 上就該有一份 4K ＋ 一份原始檔（影片與 GIF 只有原始檔一份）。
 * 上傳與刪除都可能在半路失敗，兩邊因此會慢慢走鐘，而走鐘是**安靜的**。
 * 這一格就是把它變成看得見的**兩份清單**：哪些檔缺備份、哪些檔被搬進 trash/。
 *
 * 2026-08-28 把原本的「Drive 備份對帳」與「缺 Drive 備份的檔案」兩格合併成這一格
 * —— 它們回答的本來就是同一件事的兩半（有沒有走鐘／到底是哪幾個檔），
 * 分成兩格的下場是使用者按完上面那顆按鈕，還要自己想到下面那格要再按一次。
 *
 * ⚠️⚠️ **「比對全部相簿」是前端的迴圈，不是後端一趟。**
 *    免費版 Workers 單次呼叫上限 50 個 subrequest，而對一本相簿要列 Drive 資料夾
 *    （會翻頁）＋ 追問不見的檔，所以後端把 `albums` 夾在 1–5 本。要對完整站
 *    只能一趟一趟打，由這裡負責重複呼叫直到 `finished_at` 出現。
 *    收工條件**只認 `finished_at`** —— `cursor` 歸零同時代表「還沒開始」與
 *    「剛對完一輪」，拿它當條件會在第一趟就以為結束了。
 */

/** 一趟對幾本。後端夾在 1–5（見上面的 subrequest 上限），這裡就用上限 */
const ALBUMS_PER_CALL = 5;

/**
 * 迴圈最多跑幾趟。純粹是**保險絲** —— 後端如果哪天不再推游標，這裡不能變成
 * 一個打不完的迴圈。400 趟 × 5 本 = 2000 本相簿，遠超這個站的規模。
 */
const MAX_ROUNDS = 400;

export default function DriveCompareCard() {
  /*
   * 整輪的報告。**這是唯讀的結果**，真正在跑的是 cron（十分鐘一本）與下面
   * 那顆按鈕。不在進頁時自動抓：這一頁平常是來加人、改權限的。
   */
  const [audit, setAudit] = useState<DriveAuditState | null>(null);
  const [busy, setBusy] = useState<null | "load" | "all" | "trash" | "one">(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  /** 迴圈跑到哪了。null ＝ 沒在跑 */
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  /**
   * 換一個數字就叫底下那份「缺備份」清單重讀。比對完那份清單一定變了，
   * 讓使用者自己再按一次「看清單」等於這一格只做了一半。
   */
  const [pendingToken, setPendingToken] = useState(0);

  /*
   * 「單獨對一本」的結果。跟整輪報告**是兩件事**，所以另外存一份：
   * 那一趟刻意不推游標、不累加 totals（見後端 /api/admin/drive-audit 的註解），
   * 混在一起會讓整輪的數字看起來被算了兩次。
   */
  const [albumId, setAlbumId] = useState<number | "">("");
  const [albumReport, setAlbumReport] = useState<DriveAuditAlbumReport | null>(null);

  /** 只把上一輪的結果拿回來看，不動任何東西 */
  const loadLatest = async () => {
    if (busy) return;
    setBusy("load"); setError(null); setNote(null);
    try {
      setAudit(await fetchDriveAudit());
      setPendingToken((t) => t + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : "載入失敗");
    } finally {
      setBusy(null);
    }
  };

  /** 從第一本開始把全站對完（迴圈的理由見檔頭） */
  const compareAll = async () => {
    if (busy) return;
    setBusy("all"); setError(null); setNote(null); setAlbumReport(null);
    try {
      /*
       * 先 GET 一次拿相簿清單 —— 一來進度條要有分母，二來下面「單獨對一本」
       * 的選單就是這一份（POST 的回應不含 albums 與 trash）。
       */
      const before = await fetchDriveAudit();
      const total = before.albums?.length ?? 0;
      setAudit(before);
      setProgress({ done: 0, total });

      let state = await runDriveAudit({ reset: true, albums: ALBUMS_PER_CALL });
      let rounds = 0;
      while (!state.finished_at && rounds < MAX_ROUNDS) {
        rounds++;
        setProgress({ done: state.albums_done, total });
        state = await runDriveAudit({ albums: ALBUMS_PER_CALL });
      }
      setProgress({ done: state.albums_done, total });

      // POST 的回應沒有 trash 與 albums，最後補一趟 GET 才是完整的那一份
      const full = await fetchDriveAudit();
      setAudit(full);
      setPendingToken((t) => t + 1);
      setNote(
        state.finished_at
          ? `比對完成：${full.totals.albums} 本相簿、${full.totals.photos} 張照片。`
          : `本輪比對至第 ${state.albums_done} 本相簿，再按一次會重新開始。`,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "比對失敗");
    } finally {
      setBusy(null);
      setProgress(null);
    }
  };

  const runOneAlbum = async () => {
    if (busy || albumId === "") return;
    setBusy("one"); setError(null); setNote(null);
    try {
      setAlbumReport(await auditOneAlbum(Number(albumId)));
    } catch (e) {
      setAlbumReport(null);
      setError(e instanceof Error ? e.message : "比對失敗");
    } finally {
      setBusy(null);
    }
  };

  /** 把三次都失敗、已經放棄的待搬項目丟回佇列 */
  const retryTrash = async () => {
    if (busy) return;
    setBusy("trash"); setError(null); setNote(null);
    try {
      const state = await runDriveAudit({ retryTrash: true });
      setNote(state.revived ? `已將 ${state.revived} 筆重新排入待移動佇列。` : "目前沒有失敗的待移動項目。");
      // 救回來的是待搬佇列的事，報告本身沒變 —— 重抓一次才看得到新的數字
      setAudit(await fetchDriveAudit());
    } catch (e) {
      setError(e instanceof Error ? e.message : "重試失敗");
    } finally {
      setBusy(null);
    }
  };

  const trashed = audit?.trashed ?? [];
  const missing = audit ? audit.totals.missing_4k + audit.totals.missing_original : 0;

  return (
    <AdminSection
      id="drive-compare"
      title="Drive 比對"
      badge={audit ? (missing > 0 ? `缺 ${missing} 份備份` : "備份齊全") : undefined}
    >
      <p className={styles.hint}>
        每張照片在 Google Drive 上應有一份 4K 與一份原始檔（影片與 GIF 只有原始檔）。
        系統每十分鐘自動比對一本相簿，按下按鈕可立即重新比對全部相簿。
        完成後會列出「缺少備份的檔案」與「已移入 trash/ 的檔案」兩份清單。
      </p>

      <div className={styles.formRow}>
        <button
          className={`${styles.button} ${styles.primary}`}
          disabled={busy !== null}
          onClick={compareAll}
        >
          {busy === "all" ? "比對中…" : "比對全部相簿"}
        </button>
        <button className={styles.button} disabled={busy !== null} onClick={loadLatest}>
          {busy === "load" ? "載入中…" : "查看上次結果"}
        </button>
      </div>

      {/* 全站對一遍要好幾分鐘，沒有進度的話那顆按鈕看起來就是卡死了 */}
      {progress && (
        <>
          <div className={styles.progressTrack}>
            <div
              className={styles.progressBar}
              style={{
                width: progress.total > 0
                  ? `${Math.min(100, Math.round((progress.done / progress.total) * 100))}%`
                  : "100%",
              }}
            />
          </div>
          <p className={styles.hint}>
            已比對 {progress.done}{progress.total > 0 ? ` / ${progress.total}` : ""} 本，
            需要數分鐘，請保持此頁開啟。
          </p>
        </>
      )}

      {error && <p className={`${styles.message} ${styles.err}`}>{error}</p>}
      {note && <p className={`${styles.message} ${styles.ok}`}>{note}</p>}

      {audit && (
        <>
          <p className={styles.hint}>
            {audit.finished_at
              ? `上次完成於 ${new Date(audit.finished_at).toLocaleString("zh-TW")}`
              : audit.cursor > 0
                ? `進行中（已比對 ${audit.albums_done} 本）`
                : "尚未比對"}
          </p>

          <div className={styles.detail}>
            <div className={styles.detailRow}>
              <span className={styles.detailName}>已比對相簿 / 照片</span>
              <span className={styles.detailNum}>{audit.totals.albums} / {audit.totals.photos}</span>
            </div>
            <div className={styles.detailRow}>
              <span className={styles.detailName}>備份完整</span>
              <span className={styles.detailNum}>{audit.totals.ok ?? 0}</span>
            </div>
            <div className={styles.detailRow}>
              <span className={styles.detailName}>缺 4K / 缺原始檔</span>
              <span className={styles.detailNum}>
                {audit.totals.missing_4k} / {audit.totals.missing_original}
              </span>
            </div>
            <div className={styles.detailRow}>
              <span className={styles.detailName}>記錄遺漏，已自動修復</span>
              <span className={styles.detailNum}>{audit.totals.linked ?? 0}</span>
            </div>
            <div className={styles.detailRow}>
              <span className={styles.detailName}>無對應照片，已移入 trash/</span>
              <span className={styles.detailNum}>{audit.totals.orphans_queued}</span>
            </div>
          </div>

          {audit.last_error && (
            <p className={`${styles.message} ${styles.err}`}>上次錯誤：{audit.last_error}</p>
          )}
        </>
      )}

      {/* ── 清單一：缺 Drive 備份的檔 ─────────────────────────────────── */}
      <div className={styles.detailHead}>缺少 Drive 備份的檔案</div>
      <DrivePendingList reloadToken={pendingToken} />

      {/* ── 清單二：被搬進 trash/ 的檔 ────────────────────────────────
        ⚠️ 這是站上**唯一**查得到這件事的地方 —— DriveTrash 那張表搬成功就把列
           刪掉了。以前只有一個「孤兒 12」的數字，使用者看到數字也不知道被搬走
           的是什麼、要不要救回來。
      */}
      {audit && (
        <>
          <div className={styles.detailHead}>
            已移入 trash/ 的檔案（{trashed.length}{audit.trashed_more ? "＋" : ""}）
          </div>
          {trashed.length === 0 ? (
            <p className={styles.hint}>
              本輪沒有移動任何檔案。
              {audit.totals.orphans_queued > 0 && "（上方數字為先前幾輪的累計）"}
            </p>
          ) : (
            <>
              <p className={styles.hint}>
                以下是 Drive 上多出來、站上沒有任何照片對應的檔案（重複補傳的第二份、
                刪除照片後的殘檔）。移入 <span className={styles.mono}>didadida/trash/</span>
                並非刪除，可隨時在 Drive 中移回原相簿資料夾。
                {audit.trashed_more ? `另有 ${audit.trashed_more} 筆未列出。` : ""}
              </p>
              <div
                style={{
                  maxHeight: 300,
                  overflowY: "auto",
                  border: "1px solid var(--border-color)",
                  borderRadius: 10,
                  marginTop: "0.5rem",
                }}
              >
                {trashed.map((t) => (
                  <div
                    key={t.drive_id}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      flexWrap: "wrap",
                      gap: 4,
                      padding: "4px 6px 4px 10px",
                      borderBottom: "1px solid var(--border-color)",
                      fontSize: "0.78rem",
                    }}
                  >
                    <span
                      title={t.name}
                      style={{
                        flex: "1 1 200px", minWidth: 0, overflow: "hidden",
                        textOverflow: "ellipsis", whiteSpace: "nowrap",
                      }}
                    >
                      {t.name}
                    </span>
                    <span className={styles.detailNote} style={{ flex: "none" }}>
                      {t.album || "相簿不明"}
                    </span>
                    <a
                      href={`https://drive.google.com/file/d/${t.drive_id}/view`}
                      target="_blank"
                      rel="noopener noreferrer"
                      title="在 Drive 中開啟"
                      style={{ flex: "none", padding: "2px 6px", whiteSpace: "nowrap" }}
                    >
                      去 Drive 看 ↗
                    </a>
                  </div>
                ))}
              </div>
            </>
          )}
        </>
      )}

      {/*
        待搬佇列。刪照片時 Drive 那一下失敗會試三次，三次都失敗就永遠躺在表裡 ——
        以前站上沒有任何地方看得到它，「Drive 刪除失敗」跳完就再也沒有下文。
      */}
      {audit?.trash && audit.trash.gave_up > 0 && (
        <>
          <p className={styles.hint}>
            有 <strong style={{ color: "#b91c1c" }}>{audit.trash.gave_up}</strong> 筆待移動的檔案
            連續三次失敗，已暫停處理（另有 {audit.trash.remaining} 筆排隊中）。
          </p>
          <div className={styles.formRow}>
            <button
              className={`${styles.button} ${styles.primary}`}
              disabled={busy !== null}
              onClick={retryTrash}
            >
              {busy === "trash" ? "重試中…" : `重試這 ${audit.trash.gave_up} 筆`}
            </button>
          </div>
          <details className={styles.guide}>
            <summary className={styles.guideSummary}>查看失敗項目</summary>
            <div className={styles.guideBody}>
              {audit.trash.stuck.map((t) => (
                <div key={t.id} className={styles.detailRow}>
                  <span className={styles.mono}>{t.drive_id}</span>
                  <span className={styles.detailNote}>
                    已嘗試 {t.attempts} 次{t.last_error ? `：${t.last_error}` : ""}
                  </span>
                </div>
              ))}
            </div>
          </details>
        </>
      )}

      {/* ── 進階：單獨對一本、逐本結果 ──────────────────────────────────
        單獨對一本會列出**逐張明細**（哪幾張要補、哪幾張不用、站上有沒有重複的
        兩格），那是站在某一本相簿前面才會問的問題，所以收起來放。
      */}
      <details className={styles.guide}>
        <summary className={styles.guideSummary}>單獨比對一本相簿（含逐張明細）</summary>
        <div className={styles.guideBody}>
          {audit?.albums && audit.albums.length > 0 ? (
            <div className={styles.formRow}>
              <div className={styles.field}>
                <label htmlFor="audit-album">選擇相簿</label>
                <select
                  id="audit-album"
                  className={styles.select}
                  value={albumId}
                  disabled={busy !== null}
                  onChange={(e) => setAlbumId(e.target.value === "" ? "" : Number(e.target.value))}
                >
                  <option value="">請選擇相簿…</option>
                  {audit.albums.map((a) => (
                    <option key={a.id} value={a.id}>{a.name}</option>
                  ))}
                </select>
              </div>
              <button
                className={`${styles.button} ${styles.primary}`}
                disabled={busy !== null || albumId === ""}
                onClick={runOneAlbum}
              >
                {busy === "one" ? "比對中…" : "比對這本相簿"}
              </button>
            </div>
          ) : (
            <p className={styles.hint}>請先按上方「查看上次結果」或「比對全部相簿」載入相簿清單。</p>
          )}

          {albumReport && <AlbumAuditReport report={albumReport} />}

          {audit && audit.reports.length > 0 && (
            <>
              <div className={styles.detailHead}>各相簿結果（{audit.reports.length}）</div>
              {audit.reports.map((r) => (
                <div key={r.album_id} className={styles.detailRow}>
                  <span className={styles.detailName}>{r.name}</span>
                  <span className={styles.detailNote}>
                    {r.error
                      ? `錯誤：${r.error}`
                      : r.no_folder
                        ? `${r.photos} 張，Drive 上尚無對應資料夾`
                        : [
                            `${r.photos} 張`,
                            r.missing_4k > 0 ? `缺 4K ${r.missing_4k}` : "",
                            r.missing_original > 0 ? `缺原始檔 ${r.missing_original}` : "",
                            r.linked > 0 ? `修復記錄 ${r.linked}` : "",
                            r.cleared > 0 ? `Drive 上已遺失 ${r.cleared}` : "",
                            r.moved > 0 ? `已移動 ${r.moved}` : "",
                            r.orphans_queued > 0 ? `無對應照片 ${r.orphans_queued}` : "",
                            r.foreign > 0 ? `非本站檔案 ${r.foreign}` : "",
                            r.truncated ? "（檔案過多未列完，本次結果不計）" : "",
                          ].filter(Boolean).join("、")}
                  </span>
                </div>
              ))}
            </>
          )}
        </div>
      </details>
    </AdminSection>
  );
}

/* ── 單獨對一本的結果 ─────────────────────────────────────────────────────

  這一格回答的是使用者實際問的兩個問題：**「哪幾張要補、哪幾張不用」**，
  以及**「多餘的那些怎麼了」**。

  ⚠️「多餘的」在這個站有兩種，處理方式刻意不同（後端 findDuplicateRows 有長註解）：
    - **Drive 上多出來的檔**：沒有任何一列指著它，過三道閘就自動排進 trash/。
      搬進垃圾桶是可逆的，所以敢自動做。
    - **站上多出來的列**：刪一列 Photo ＝ 相簿裡少一格，連同標籤、留言、Story、
      手動修過的座標與時間一起沒。哪一列該留只有人判斷得了，**所以只列出來**。
*/

const SLOT_LABEL: Record<string, string> = { "4k": "4K", original: "原始檔" };

/**
 * 影片（0019）與 GIF（0021）在 Drive 上都**只有原始檔一份** —— 沒有衍生的 4K，
 * `drive_file_id` 對它們永遠是 NULL。逐張明細那兩處的「缺哪一份」都要照這個分岔，
 * 不然一整類的檔案會永遠掛著一個補不完的「缺 4K」。
 */
const isOneSlotMedia = (t?: string) => t === "video" || t === "gif";
/** 明細列在檔名後面補一句它是什麼；照片不加（大多數都是照片，加了只是噪音） */
const mediaSuffix = (t?: string) => (t === "video" ? "（影片）" : t === "gif" ? "（GIF）" : "");

/** 還沒解決的那幾種，會出現在「還缺哪些」那一段 */
const NEEDS_ACTION = new Set(["missing", "cleared", "gone"]);

const ITEM_STATE_LABEL: Record<string, string> = {
  missing: "從未上傳成功",
  cleared: "Drive 上已不存在，記錄已清除",
  gone: "有記錄但未出現在 Drive 清單，尚未確認",
  linked: "檔案存在，記錄已自動修復",
  linking: "檔案存在，記錄將於下一輪修復",
  moved: "已移至其他資料夾，備份正常",
};

const EXTRA_REASON_LABEL: Record<string, string> = {
  foreign: "非本站上傳的檔案，不處理",
  too_new: "建立未滿 24 小時，可能仍在上傳",
  in_use: "仍有照片使用中",
  queued_before: "已在待移動佇列中",
  over_limit: "本輪已達處理上限，下一輪繼續",
};

function AlbumAuditReport({ report: r }: { report: DriveAuditAlbumReport }) {
  const items = r.items ?? [];
  const todo = items.filter((i) => NEEDS_ACTION.has(i.state));
  const done = items.filter((i) => !NEEDS_ACTION.has(i.state));
  const extras = r.extras ?? [];
  const queued = extras.filter((e) => e.action === "queued");
  const kept = extras.filter((e) => e.action === "kept");
  const dups = r.dups ?? [];

  return (
    <div className={styles.detail}>
      <div className={styles.detailHead}>單獨比對：{r.name}</div>

      {r.error && <p className={`${styles.message} ${styles.err}`}>錯誤：{r.error}</p>}

      {r.no_folder ? (
        <p className={styles.hint}>
          這本相簿在 Drive 上尚無資料夾，{r.photos} 張皆未備份。
          重新上傳任一張原始檔即可建立。
        </p>
      ) : r.truncated ? (
        <p className={`${styles.message} ${styles.err}`}>
          這本相簿在 Drive 上的檔案過多，本次未完整列出。
          為避免依據不完整的清單誤判，「已遺失」與「多餘檔案」兩段已略過。
        </p>
      ) : null}

      <div className={styles.detailRow}>
        <span className={styles.detailName}>
          <strong>{r.ok}</strong> / {r.photos} 張備份完整
        </span>
        <span className={styles.detailNum}>
          {r.photos - r.ok > 0 ? `尚有 ${r.photos - r.ok} 張待處理` : "全部完成"}
        </span>
      </div>

      {todo.length > 0 && (
        <>
          <div className={styles.detailHead}>缺少備份（{todo.length}{r.items_more ? "＋" : ""}）</div>
          {todo.map((i) => (
            <div key={`${i.photo_id}-${i.slot}`} className={styles.detailRow}>
              <span className={styles.detailName}>
                {i.title}{mediaSuffix(i.media_type)} — 缺 {SLOT_LABEL[i.slot] ?? i.slot}
              </span>
              <span className={styles.detailNote}>{ITEM_STATE_LABEL[i.state] ?? i.state}</span>
            </div>
          ))}
          <p className={styles.hint}>
            補傳方式：將同一個原始檔重新上傳到該相簿，系統會辨識為同一個檔案，
            只補上缺少的部分。4K 版本必須由原始檔產生，無法從站上的縮圖還原。
          </p>
        </>
      )}

      {done.length > 0 && (
        <details className={styles.guide}>
          <summary className={styles.guideSummary}>已自動處理（{done.length}）</summary>
          <div className={styles.guideBody}>
            {done.map((i) => (
              <div key={`${i.photo_id}-${i.slot}`} className={styles.detailRow}>
                <span className={styles.detailName}>
                  {i.title} — {SLOT_LABEL[i.slot] ?? i.slot}
                </span>
                <span className={styles.detailNote}>{ITEM_STATE_LABEL[i.state] ?? i.state}</span>
              </div>
            ))}
          </div>
        </details>
      )}

      {r.items_more ? (
        <p className={styles.hint}>另有 {r.items_more} 筆明細未列出。</p>
      ) : null}

      {(queued.length > 0 || kept.length > 0) && (
        <details className={styles.guide}>
          <summary className={styles.guideSummary}>
            Drive 上的多餘檔案（已移入 trash/ {queued.length}、本次未處理 {kept.length}）
          </summary>
          <div className={styles.guideBody}>
            <p>
              移入 <span className={styles.code}>didadida/trash/</span> 並非刪除，
              可隨時在 Drive 中還原。
            </p>
            {queued.map((e) => (
              <div key={e.drive_id} className={styles.detailRow}>
                <span className={styles.detailName}>{e.name}</span>
                <span className={styles.detailNote}>已移入 trash/</span>
              </div>
            ))}
            {kept.map((e) => (
              <div key={e.drive_id} className={styles.detailRow}>
                <span className={styles.detailName}>{e.name}</span>
                <span className={styles.detailNote}>
                  {EXTRA_REASON_LABEL[e.reason ?? ""] ?? "未處理"}
                </span>
              </div>
            ))}
            {r.extras_more ? <p>另有 {r.extras_more} 個未列出。</p> : null}
          </div>
        </details>
      )}

      {dups.length > 0 && (
        <details className={styles.guide}>
          <summary className={styles.guideSummary}>站上重複的照片（{dups.length} 組，不會自動刪除）</summary>
          <div className={styles.guideBody}>
            <p>
              以下每組在相簿中有兩筆以上指向同一張照片。系統不會自動刪除：
              刪除一筆會連同它的標籤、留言、Story 與手動設定的位置、時間一併移除。
              請至相簿進入編輯模式，自行刪除多餘的那一筆。
            </p>
            {dups.map((d) => (
              <div key={`${d.kind}-${d.key}`}>
                <div className={styles.detailHead}>
                  {d.kind === "same_hash"
                    ? "同一個檔案（內容完全相同）"
                    : "檔名相同（不一定是同一張，請自行確認）"}
                  ：{d.key}
                </div>
                {d.photos.map((p) => (
                  <div key={p.id} className={styles.detailRow}>
                    <span className={styles.detailName}>
                      #{p.id} {p.title}{mediaSuffix(p.media_type)}
                    </span>
                    <span className={styles.detailNote}>
                      {isOneSlotMedia(p.media_type)
                        ? (p.has_original ? "Drive 有原始檔" : "Drive 無備份")
                        : `${p.has_4k ? "有 4K" : "缺 4K"}、${p.has_original ? "有原始檔" : "缺原始檔"}`}
                      {p.created_at ? `　${p.created_at.slice(0, 10)} 加入` : ""}
                    </span>
                  </div>
                ))}
              </div>
            ))}
            {r.dups_more ? <p>另有 {r.dups_more} 組未列出。</p> : null}
          </div>
        </details>
      )}

      {todo.length === 0 && done.length === 0 && extras.length === 0 && dups.length === 0
        && !r.no_folder && !r.truncated && (
        <p className={styles.hint}>這本相簿兩邊完全一致，沒有缺少或多餘的檔案。</p>
      )}
    </div>
  );
}
