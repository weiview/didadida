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
      setError(e instanceof Error ? e.message : "讀取失敗");
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
          ? `對完了：${full.totals.albums} 本相簿、${full.totals.photos} 張。`
          : `相簿太多，這一輪先對到第 ${state.albums_done} 本，再按一次會從頭重來。`,
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
      setNote(state.revived ? `救回 ${state.revived} 筆待搬，已經重新試過一次` : "沒有放棄的待搬項目");
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
        站上一張照片，Drive 上就該有<strong>一份 4K ＋ 一份原始檔</strong>
        （影片與 GIF 沒有 4K，只有原始檔一份）。系統平常每十分鐘自己對一本，
        這顆按鈕是<strong>現在就把全部相簿從頭對一遍</strong>，
        對完底下會列出「缺備份的檔」與「被搬進 trash/ 的檔」兩份清單。
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
          {busy === "load" ? "讀取中…" : "只看上次的結果"}
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
            對過 {progress.done}{progress.total > 0 ? ` / ${progress.total}` : ""} 本
            —— 相簿多的話要幾分鐘，這段時間不要關掉這一頁。
          </p>
        </>
      )}

      {error && <p className={`${styles.message} ${styles.err}`}>{error}</p>}
      {note && <p className={`${styles.message} ${styles.ok}`}>{note}</p>}

      {audit && (
        <>
          <p className={styles.hint}>
            {audit.finished_at
              ? `上一輪對完於 ${new Date(audit.finished_at).toLocaleString("zh-TW")}`
              : audit.cursor > 0
                ? `對到一半（已經對過 ${audit.albums_done} 本）`
                : "還沒對過"}
          </p>

          <div className={styles.detail}>
            <div className={styles.detailRow}>
              <span className={styles.detailName}>對過的相簿 / 照片</span>
              <span className={styles.detailNum}>{audit.totals.albums} / {audit.totals.photos}</span>
            </div>
            <div className={styles.detailRow}>
              <span className={styles.detailName}>兩份都在（不用補）</span>
              <span className={styles.detailNum}>{audit.totals.ok ?? 0}</span>
            </div>
            <div className={styles.detailRow}>
              <span className={styles.detailName}>缺 4K / 缺原始檔</span>
              <span className={styles.detailNum}>
                {audit.totals.missing_4k} / {audit.totals.missing_original}
              </span>
            </div>
            <div className={styles.detailRow}>
              <span className={styles.detailName}>檔案在、記錄漏掉（已自動接回來）</span>
              <span className={styles.detailNum}>{audit.totals.linked ?? 0}</span>
            </div>
            <div className={styles.detailRow}>
              <span className={styles.detailName}>沒人指著的檔，已搬進 trash/</span>
              <span className={styles.detailNum}>{audit.totals.orphans_queued}</span>
            </div>
          </div>

          {audit.last_error && (
            <p className={`${styles.message} ${styles.err}`}>上次出錯：{audit.last_error}</p>
          )}
        </>
      )}

      {/* ── 清單一：缺 Drive 備份的檔 ─────────────────────────────────── */}
      <div className={styles.detailHead}>缺 Drive 備份的檔</div>
      <DrivePendingList reloadToken={pendingToken} />

      {/* ── 清單二：被搬進 trash/ 的檔 ────────────────────────────────
        ⚠️ 這是站上**唯一**查得到這件事的地方 —— DriveTrash 那張表搬成功就把列
           刪掉了。以前只有一個「孤兒 12」的數字，使用者看到數字也不知道被搬走
           的是什麼、要不要救回來。
      */}
      {audit && (
        <>
          <div className={styles.detailHead}>
            被搬進 trash/ 的檔（{trashed.length}{audit.trashed_more ? "＋" : ""}）
          </div>
          {trashed.length === 0 ? (
            <p className={styles.hint}>
              這一輪沒有搬走任何檔。
              {audit.totals.orphans_queued > 0 && "（上面那個數字是更早以前那幾輪搬的）"}
            </p>
          ) : (
            <>
              <p className={styles.hint}>
                這些是 Drive 上多出來、站上<strong>沒有任何一格指著</strong>的檔
                （重複補傳留下的第二份、刪過照片留下的殘檔）。
                <strong>搬進 <span className={styles.mono}>didadida/trash/</span> 不是刪除</strong>
                —— 反悔的話進 Drive 自己搬回原本那本相簿的資料夾就好。
                {audit.trashed_more ? `另外還有 ${audit.trashed_more} 筆沒列出來。` : ""}
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
                      title="在 Drive 上打開這個檔"
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
            有 <strong style={{ color: "#b91c1c" }}>{audit.trash.gave_up}</strong> 筆待搬的檔
            試了三次都失敗，已經停在那裡（另外還有 {audit.trash.remaining} 筆排隊中）。
          </p>
          <div className={styles.formRow}>
            <button
              className={`${styles.button} ${styles.primary}`}
              disabled={busy !== null}
              onClick={retryTrash}
            >
              {busy === "trash" ? "重試中…" : `重試放棄的 ${audit.trash.gave_up} 筆`}
            </button>
          </div>
          <details className={styles.guide}>
            <summary className={styles.guideSummary}>看卡住的是哪幾筆</summary>
            <div className={styles.guideBody}>
              {audit.trash.stuck.map((t) => (
                <div key={t.id} className={styles.detailRow}>
                  <span className={styles.mono}>{t.drive_id}</span>
                  <span className={styles.detailNote}>
                    試了 {t.attempts} 次{t.last_error ? `：${t.last_error}` : ""}
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
        <summary className={styles.guideSummary}>進階：單獨比對一本相簿（逐張明細）</summary>
        <div className={styles.guideBody}>
          {audit?.albums && audit.albums.length > 0 ? (
            <div className={styles.formRow}>
              <div className={styles.field}>
                <label htmlFor="audit-album">選一本</label>
                <select
                  id="audit-album"
                  className={styles.select}
                  value={albumId}
                  disabled={busy !== null}
                  onChange={(e) => setAlbumId(e.target.value === "" ? "" : Number(e.target.value))}
                >
                  <option value="">選一本相簿…</option>
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
                {busy === "one" ? "比對中…" : "全面比對這一本"}
              </button>
            </div>
          ) : (
            <p className={styles.hint}>先按上面的「只看上次的結果」或「比對全部相簿」載入相簿清單。</p>
          )}

          {albumReport && <AlbumAuditReport report={albumReport} />}

          {audit && audit.reports.length > 0 && (
            <>
              <div className={styles.detailHead}>逐本相簿的結果（{audit.reports.length}）</div>
              {audit.reports.map((r) => (
                <div key={r.album_id} className={styles.detailRow}>
                  <span className={styles.detailName}>{r.name}</span>
                  <span className={styles.detailNote}>
                    {r.error
                      ? `出錯：${r.error}`
                      : r.no_folder
                        ? `${r.photos} 張，Drive 上還沒有這本的資料夾`
                        : [
                            `${r.photos} 張`,
                            r.missing_4k > 0 ? `缺 4K ${r.missing_4k}` : "",
                            r.missing_original > 0 ? `缺原始檔 ${r.missing_original}` : "",
                            r.linked > 0 ? `接回記錄 ${r.linked}` : "",
                            r.cleared > 0 ? `Drive 上不見了 ${r.cleared}` : "",
                            r.moved > 0 ? `被搬走 ${r.moved}` : "",
                            r.orphans_queued > 0 ? `孤兒 ${r.orphans_queued}` : "",
                            r.foreign > 0 ? `外來檔 ${r.foreign}` : "",
                            r.truncated ? "（檔案太多沒列完，這本的判定不算數）" : "",
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
  missing: "從來沒傳成功過",
  cleared: "Drive 上確認沒了，記錄已清掉",
  gone: "記錄有、Drive 清單裡沒有（還沒追問到）",
  linked: "檔案在，記錄漏掉，已自動接回來",
  linking: "檔案在，記錄下一輪才寫得回去（備份是好的）",
  moved: "被搬到別的資料夾，備份是好的",
};

const EXTRA_REASON_LABEL: Record<string, string> = {
  foreign: "不是本站放的檔，一律不碰",
  too_new: "建立不到 24 小時，可能是剛傳完還沒回報",
  in_use: "那張照片還指著它",
  queued_before: "早就在待搬佇列裡了",
  over_limit: "這一輪額度用完，下一輪再處理",
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

      {r.error && <p className={`${styles.message} ${styles.err}`}>出錯：{r.error}</p>}

      {r.no_folder ? (
        <p className={styles.hint}>
          這本相簿在 Drive 上<strong>還沒有資料夾</strong> —— {r.photos} 張全都沒有備份過。
          把任何一個原始檔再拖進那本相簿一次就會建起來。
        </p>
      ) : r.truncated ? (
        <p className={`${styles.message} ${styles.err}`}>
          這本在 Drive 上的檔案太多，這次<strong>沒有列完</strong>。
          「不見了」與「多出來的檔」整段跳過 —— 拿半份清單去判定會清掉好資料。
        </p>
      ) : null}

      <div className={styles.detailRow}>
        <span className={styles.detailName}>
          <strong>{r.ok}</strong> / {r.photos} 張<strong>不用補</strong>（該有的備份都在）
        </span>
        <span className={styles.detailNum}>
          {r.photos - r.ok > 0 ? `還有 ${r.photos - r.ok} 張要處理` : "全部齊了"}
        </span>
      </div>

      {todo.length > 0 && (
        <>
          <div className={styles.detailHead}>還缺哪些（{todo.length}{r.items_more ? "＋" : ""}）</div>
          {todo.map((i) => (
            <div key={`${i.photo_id}-${i.slot}`} className={styles.detailRow}>
              <span className={styles.detailName}>
                {i.title}{mediaSuffix(i.media_type)} — 缺 {SLOT_LABEL[i.slot] ?? i.slot}
              </span>
              <span className={styles.detailNote}>{ITEM_STATE_LABEL[i.state] ?? i.state}</span>
            </div>
          ))}
          <p className={styles.hint}>
            補的方法：把同一個原始檔再拖進那本相簿一次（站上會認出是同一個檔），
            它只會補缺的那一份。⚠️ 真正的 4K 只編得出來一次 ——
            R2 上那份 2000px 補不回 4K，一定要拿原始檔。
          </p>
        </>
      )}

      {done.length > 0 && (
        <details className={styles.guide}>
          <summary className={styles.guideSummary}>已經自動處理好的（{done.length}）</summary>
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
        <p className={styles.hint}>明細只列前面那些，另外還有 {r.items_more} 筆沒列出來。</p>
      ) : null}

      {(queued.length > 0 || kept.length > 0) && (
        <details className={styles.guide}>
          <summary className={styles.guideSummary}>
            Drive 上多出來的檔（已排進 trash/ {queued.length}、這次不動 {kept.length}）
          </summary>
          <div className={styles.guideBody}>
            <p>
              「排進 trash/」是<strong>搬進 <span className={styles.code}>didadida/trash/</span></strong>
              不是刪除，反悔隨時去 Drive 搬回來。
            </p>
            {queued.map((e) => (
              <div key={e.drive_id} className={styles.detailRow}>
                <span className={styles.detailName}>{e.name}</span>
                <span className={styles.detailNote}>已排進 trash/</span>
              </div>
            ))}
            {kept.map((e) => (
              <div key={e.drive_id} className={styles.detailRow}>
                <span className={styles.detailName}>{e.name}</span>
                <span className={styles.detailNote}>
                  {EXTRA_REASON_LABEL[e.reason ?? ""] ?? "不動它"}
                </span>
              </div>
            ))}
            {r.extras_more ? <p>另外還有 {r.extras_more} 個沒列出來。</p> : null}
          </div>
        </details>
      )}

      {dups.length > 0 && (
        <details className={styles.guide}>
          <summary className={styles.guideSummary}>站上重複的照片（{dups.length} 組，不會自動刪）</summary>
          <div className={styles.guideBody}>
            <p>
              這幾組是<strong>站上（相簿裡）有兩格以上</strong>指著同一張照片。
              <strong>不會自動刪</strong> —— 刪一格連同它的標籤、留言、Story、
              手動修過的座標與時間一起沒，哪一格該留只有你判斷得了。
              到相簿裡進編輯模式選起來刪掉不要的那一格就好。
            </p>
            {dups.map((d) => (
              <div key={`${d.kind}-${d.key}`}>
                <div className={styles.detailHead}>
                  {d.kind === "same_hash"
                    ? "同一個檔（位元組一模一樣）"
                    : "檔名一樣（不一定是同一張，請自己看一眼）"}
                  ：{d.key}
                </div>
                {d.photos.map((p) => (
                  <div key={p.id} className={styles.detailRow}>
                    <span className={styles.detailName}>
                      #{p.id} {p.title}{mediaSuffix(p.media_type)}
                    </span>
                    <span className={styles.detailNote}>
                      {isOneSlotMedia(p.media_type)
                        ? (p.has_original ? "Drive 有原始檔" : "Drive 沒有備份")
                        : `${p.has_4k ? "有 4K" : "缺 4K"}、${p.has_original ? "有原始檔" : "缺原始檔"}`}
                      {p.created_at ? `　${p.created_at.slice(0, 10)} 加入` : ""}
                    </span>
                  </div>
                ))}
              </div>
            ))}
            {r.dups_more ? <p>另外還有 {r.dups_more} 組沒列出來。</p> : null}
          </div>
        </details>
      )}

      {todo.length === 0 && done.length === 0 && extras.length === 0 && dups.length === 0
        && !r.no_folder && !r.truncated && (
        <p className={styles.hint}>這一本兩邊完全對得起來，沒有要補的、也沒有多餘的。</p>
      )}
    </div>
  );
}
