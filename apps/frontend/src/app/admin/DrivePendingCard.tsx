"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import styles from "./admin.module.css";
import { fetchDrivePending, type DrivePendingPhoto } from "@/lib/api";

/**
 * 這一列缺的是哪一份。
 *
 * ⚠️ 影片、GIF 與照片是**三個不同的問題**：照片要 4K ＋ 原始檔兩份；影片與 GIF
 *    只有原始檔一份（`drive_file_id` 對它們永遠是 NULL —— 影片見 0019、
 *    GIF 見 0021）。寫成同一句就會有一整類的檔案永遠補不完或永遠看不到。
 *
 * ⚠️ 兩者「沒備份」的嚴重程度不一樣，所以字也不一樣：影片的 Drive 那份是**本體**
 *    （R2 上只有封面），GIF 的動畫本體本來就在 R2，Drive 那份才是備份。
 */
const missingLabel = (p: DrivePendingPhoto): string => {
  if (p.media_type === "video") return "影片缺原始檔";
  if (p.media_type === "gif") return "GIF 缺原始檔備份";
  const need4k = !p.has_4k;
  const needOrig = !p.has_original;
  if (need4k && needOrig) return "兩份都缺";
  return need4k ? "只缺 4K" : "只缺原始檔";
};

/**
 * 「Drive 比對」那一格裡的**第一份清單：缺 Drive 備份的檔案**。
 *
 * 這裡是唯讀的資訊，**沒有補傳按鈕**（2026-08-28 拿掉了）。要補的做法是把
 * 同一個原始檔再拖進那本相簿一次 —— 上傳流程的重複偵測會認出位元組一樣，
 * 直接補既有那一列缺的那一半（`incompleteTwin`），不新增任何一列，
 * 標籤、留言、Story、手動修過的座標與時間全都留著。
 *
 * 所以這一格只要回答三個問題就夠了：**哪個檔、誰傳的、在哪一本**。
 * 檔名點一下就複製（拿去硬碟的搜尋框找那個檔），右邊「看照片」在新分頁
 * 打開那一張的燈箱（回答「這個檔名到底是哪一張」）。
 *
 * ⚠️ **不在進頁時自動抓**：這一頁平常是來加人、改權限的，多打一次請求沒必要
 *    （跟 Drive 比對那一格同一個規矩）。比對完之後才由上層推 `reloadToken`
 *    叫它重讀 —— 那時候這份清單一定變了，讓使用者自己再按一次等於做了一半。
 * ⚠️ **刻意不列縮圖**：一次幾百張就是幾百次 Workers 請求。要看是哪一張是
 *    使用者一次點一張的動作，不是一開頁就全部載進來。
 *
 * 沒有自己的外框與標題 —— 它是 DriveCompareCard 裡的一段。
 */
export function DrivePendingList({ reloadToken = 0 }: { reloadToken?: number }) {
  const [rows, setRows] = useState<DrivePendingPhoto[] | null>(null);
  const [total, setTotal] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 剛剛複製了哪一列的檔名（給那一列一個短暫的「已複製 ✓」） */
  const [copiedId, setCopiedId] = useState<number | null>(null);

  const load = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      // 全站一次撈完；真的很多就跟著 cursor 續撈（一頁 500，最多 20 頁）
      const all: DrivePendingPhoto[] = [];
      let cursor = 0;
      let remaining = 0;
      for (let page = 0; page < 20; page++) {
        const res = await fetchDrivePending(cursor, 500);
        if (!res) throw new Error("讀取清單失敗（要有「可管理全站內容」的權限）");
        all.push(...res.photos);
        remaining = res.remaining;
        cursor = res.next_cursor;
        if (res.done) break;
      }
      setRows(all);
      setTotal(remaining);
    } catch (e) {
      setError(e instanceof Error ? e.message : "讀取清單失敗");
    } finally {
      setBusy(false);
    }
  }, []);

  /**
   * 複製**單一**檔名。
   *
   * ⚠️ 刻意**沒有「複製全部」** —— 實際的動作永遠是「拿一個檔名去硬碟的搜尋框
   *    找一個檔」，整份貼進搜尋框找不到東西。
   * 剪貼簿被擋掉（權限、非安全來源）就 prompt 攤開來讓人自己選取，
   * 只 console.error 又是一次「按了沒反應」。
   */
  const copyName = async (id: number, name: string) => {
    if (!name) return;
    try {
      await navigator.clipboard.writeText(name);
      setCopiedId(id);
      setTimeout(() => setCopiedId((cur) => (cur === id ? null : cur)), 1600);
    } catch {
      window.prompt("複製不了，請自己選取這段文字：", name);
    }
  };

  /*
   * 上層比對完就把 token 推一格，這裡跟著重讀。
   * ⚠️ 初值（0）不能觸發 —— 那就變成「一進頁就自動抓」了，正是上面說不要的。
   */
  const seenToken = useRef(reloadToken);
  useEffect(() => {
    if (reloadToken === seenToken.current) return;
    seenToken.current = reloadToken;
    void load();
  }, [reloadToken, load]);

  return (
    <>
      <p className={styles.hint}>
        上傳當下 Drive 那一步失敗的照片與影片會留在這裡（很舊的照片也是）。
        <strong>要補的話：把同一個原始檔再拖進那本相簿一次就好</strong> ——
        站上會認出是同一個檔，直接補上缺的那一份，相簿裡不會多一格，
        原本的標籤、留言、Story、改過的時間與地點都留著。
        影片沒有 4K 那一份，但 Drive 那份對影片<strong>不是備份是本體</strong>，
        沒上去就等於沒有影片。GIF 同樣沒有 4K 那一份，不過它的動畫本體是存在
        R2 的，Drive 這一份純粹是備份 —— 沒上去相簿裡那一格還是會動。
      </p>

      <div className={styles.formRow}>
        <button className={styles.button} disabled={busy} onClick={load}>
          {busy ? "讀取中…" : rows === null ? "看清單" : "重新讀取"}
        </button>
      </div>

      {error && <p className={`${styles.message} ${styles.err}`}>{error}</p>}

      {rows !== null && rows.length === 0 && (
        <p className={styles.hint}>全站的照片與影片都有完整的 Drive 備份，沒有要補的。</p>
      )}

      {rows !== null && rows.length > 0 && (
        <>
          <p className={styles.hint}>
            有 <strong>{total || rows.length}</strong> 個檔案還沒有完整的 Drive 備份
            {rows.length < total && `（先列出前 ${rows.length} 個）`}
            。點檔名複製那一個，點「看照片」在新分頁打開那一張。
          </p>

          <div
            style={{
              maxHeight: 340,
              overflowY: "auto",
              border: "1px solid var(--border-color)",
              borderRadius: 10,
              marginTop: "0.5rem",
            }}
          >
            {rows.map((p) => {
              const name = p.title || p.file_name;
              const justCopied = copiedId === p.id;
              /*
               * ⚠️ 外層是 div 不是 button —— button 裡面不能再放 button／a。
               *    一列有兩個各自獨立的目標：檔名（複製）與「看照片」（開燈箱）。
               */
              return (
                <div
                  key={p.id}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    flexWrap: "wrap",
                    gap: 4,
                    padding: "4px 6px 4px 10px",
                    borderBottom: "1px solid var(--border-color)",
                    background: justCopied ? "rgba(34,197,94,.12)" : "transparent",
                    fontSize: "0.78rem",
                  }}
                >
                  <button
                    type="button"
                    title={`${name}（點一下複製檔名）`}
                    onClick={() => copyName(p.id, name)}
                    style={{
                      flex: "1 1 200px",
                      minWidth: 0,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      textAlign: "left",
                      border: "none",
                      background: "transparent",
                      padding: "2px 0",
                      color: "inherit",
                      font: "inherit",
                      cursor: "pointer",
                    }}
                  >
                    {name}
                  </button>

                  {/*
                    * 誰傳的、在哪一本 —— 拿著一個檔名而不知道該找誰、該開哪一本，
                    * 這份清單就只是一串沒有下文的字。
                    * uploader_name 後端已經套過「uploaded_by 為 NULL 就看相簿主人」。
                    */}
                  <span className={styles.detailNote} style={{ flex: "none" }}>
                    {justCopied ? (
                      <span style={{ color: "#15803d" }}>已複製 ✓</span>
                    ) : (
                      [
                        missingLabel(p),
                        p.uploader_name || "上傳者不明",
                        p.album_name || "相簿不明",
                      ].join("　·　")
                    )}
                  </span>

                  {/*
                    * ⚠️ album_id 有可能是 undefined（邊快取裡還躺著舊版後端的
                    *    回應），那就不端這顆，不要組出 /album?id=undefined。
                    * ⚠️⚠️ 相簿頁是 /album?id=<相簿>，**不是** /album/<相簿>。
                    *    前端是 output: "export" 的純靜態站，`src/app/album/` 底下
                    *    沒有 [id] 這一層，多打一段路徑就是實實在在的 404
                    *    （站上其他每一個連到相簿的地方都是 ?id=，只有這裡曾經寫錯）。
                    */}
                  {p.album_id ? (
                    <a
                      href={`/album?id=${p.album_id}&photo=${p.id}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      title="在新分頁打開這一張"
                      style={{ flex: "none", padding: "2px 6px", whiteSpace: "nowrap" }}
                    >
                      看照片 ↗
                    </a>
                  ) : null}
                </div>
              );
            })}
          </div>
        </>
      )}
    </>
  );
}
