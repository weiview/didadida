"use client";

import { useState } from "react";
import { getUsage, scanR2Usage, type UsageMetric, type UsageReport } from "@/lib/api";
import AdminSection from "./AdminSection";
import styles from "./admin.module.css";

/*
 * 免費額度用量。**滿條＝免費額度用完**（使用者的原話）。
 *
 * 「還剩多少」在 Cloudflare 後台是散在 R2／D1／Workers 三個頁面的數字，
 * 而不要產生費用是這個站的最高宗旨 —— 所以把會咬人的那幾格收成一排條放這裡。
 *
 * 數字有兩個來源，**兩個都留著**：
 *   ① 自己算得出來的：R2 的儲存量（掃一遍 bucket 加總）、D1 的資料庫大小
 *      （任何一句查詢的 meta.size_after 就是，零成本）。不必任何設定。
 *   ② Cloudflare 的 GraphQL Analytics：今日 Workers 請求數、R2 class A／B
 *      操作次數、D1 讀寫列數。這幾格**沒有第二條路** —— Worker 量不出自己
 *      今天被打了幾次。要一把 `CF_API_TOKEN`，沒設就顯示「未設定」，
 *      其餘照常（見下面那段說明）。
 *
 * ⚠️ 這一格**不在進頁時自動抓**（要按按鈕），跟 Drive 比對那格同一個規矩 ——
 *    /admin 平常是來加人、改權限的。
 * ⚠️⚠️ 掃 R2 **是前端的迴圈，不是一次請求**：一頁 1000 顆物件就是一個
 *    subrequest，而 Workers 免費版單次呼叫上限 50 個。後端一趟掃 8 頁並把
 *    游標記在 AppSetting 裡，這裡推到 done 為止（同「比對全部相簿」的做法）。
 */

/** 保險絲：一輪 8000 顆，200 輪＝160 萬顆。壞掉時不要讓迴圈永遠打下去 */
const MAX_ROUNDS = 200;

const LABELS: Record<string, { name: string; note: string }> = {
  r2_storage: { name: "R2 儲存空間", note: "縮圖、GIF 動畫、頭像、GPS 軌跡" },
  r2_class_a: { name: "R2 寫入類操作（class A）", note: "上傳、更新縮圖、列出物件" },
  r2_class_b: { name: "R2 讀取類操作（class B）", note: "讀取未命中快取的縮圖" },
  d1_storage: { name: "D1 資料庫大小", note: "照片、相簿、軌跡點、留言" },
  d1_rows_read: { name: "D1 讀取列數", note: "載入相簿清單等查詢" },
  d1_rows_written: { name: "D1 寫入列數", note: "上傳、修改資料、上線狀態" },
  workers_requests: { name: "Workers 請求數", note: "每一次 API 呼叫，含圖片" },
};

const PERIOD: Record<string, string> = { now: "目前", day: "今天", month: "本月" };

function fmtBytes(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)} KB`;
  return `${n} B`;
}

function fmt(n: number, unit: "bytes" | "count"): string {
  return unit === "bytes" ? fmtBytes(n) : n.toLocaleString();
}

function Bar({ m }: { m: UsageMetric }) {
  const label = LABELS[m.key] ?? { name: m.key, note: "" };
  const known = m.used != null;
  const pct = known ? Math.min((m.used! / m.limit) * 100, 100) : 0;
  const fill = pct >= 90 ? styles.usageHot : pct >= 70 ? styles.usageWarn : "";

  return (
    <div className={styles.usageRow}>
      <div className={styles.usageHead}>
        <span className={styles.usageLabel}>
          {label.name}
          <span className={styles.usageNote}>　{PERIOD[m.period]}</span>
        </span>
        <span className={styles.usageNum}>
          {known
            ? `${fmt(m.used!, m.unit)} / ${fmt(m.limit, m.unit)}（${pct.toFixed(pct >= 10 ? 0 : 1)}%）`
            : `— / ${fmt(m.limit, m.unit)}`}
        </span>
      </div>
      <div className={styles.usageTrack}>
        {known
          ? <div className={`${styles.usageFill} ${fill}`} style={{ width: `${pct}%` }} />
          : <div className={styles.usageUnknown} />}
      </div>
      <div className={styles.usageNote}>
        {label.note}
        {/*
          * ⚠️ 量不到跟「用了零」是兩件事，一定要分開講 —— 條都是空的，
          *    不寫的話使用者會以為這一格真的沒用到任何額度。
          */}
        {m.error ? `　⚠️ ${m.error}`
          : !known && m.key === "r2_storage" ? "　（尚未掃描，請按下方「重新掃描 R2」）"
          : !known ? "　（需要 CF_API_TOKEN，說明如下）"
          : ""}
      </div>
    </div>
  );
}

export default function UsageCard() {
  const [report, setReport] = useState<UsageReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [scanned, setScanned] = useState(0);
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null);

  const load = async () => {
    setBusy(true);
    setMessage(null);
    try {
      setReport(await getUsage());
    } catch (e) {
      setMessage({ text: e instanceof Error ? e.message : "載入用量失敗", ok: false });
    } finally {
      setBusy(false);
    }
  };

  const rescan = async () => {
    setScanning(true);
    setMessage(null);
    setScanned(0);
    try {
      let rounds = 0;
      for (;;) {
        // 第一趟 reset：這顆按鈕的意思是「從頭再算一次」，接著上次的游標會漏掉新物件
        const state = await scanR2Usage(rounds === 0);
        rounds++;
        setScanned(state.objects);
        if (state.done) break;
        if (rounds >= MAX_ROUNDS) {
          setMessage({
            text: `已掃描 ${MAX_ROUNDS} 輪仍未完成，暫停處理。再按一次會從中斷處繼續。`,
            ok: false,
          });
          break;
        }
      }
      setReport(await getUsage());
    } catch (e) {
      setMessage({ text: e instanceof Error ? e.message : "掃描 R2 失敗", ok: false });
    } finally {
      setScanning(false);
    }
  };

  const scan = report?.r2_scan;
  const kinds = scan ? Object.entries(scan.kinds).sort((a, b) => b[1].bytes - a[1].bytes) : [];

  return (
    <AdminSection id="usage" title="免費額度用量">
      <p className={styles.hint}>
        本站運行於 Cloudflare 免費額度。進度條滿即表示額度用盡，後續請求會被拒絕或開始計費。
        用量達七成轉為黃色、九成轉為紅色。
      </p>

      <div className={styles.formRow}>
        <button
          className={`${styles.button} ${styles.primary}`}
          onClick={load}
          disabled={busy || scanning}
        >
          {busy ? "載入中…" : report ? "重新整理" : "查看用量"}
        </button>
        <button className={styles.button} onClick={rescan} disabled={busy || scanning}>
          {scanning ? `掃描 R2 中…（${scanned.toLocaleString()} 個物件）` : "重新掃描 R2"}
        </button>
      </div>

      {message && (
        <p className={`${styles.message} ${message.ok ? styles.ok : styles.err}`}>{message.text}</p>
      )}

      {report && (
        <>
          <div style={{ marginTop: "0.5rem" }}>
            {report.metrics.map((m) => <Bar key={m.key} m={m} />)}
          </div>

          <p className={styles.usageNote} style={{ marginTop: "0.8rem" }}>
            統計時間：{new Date(report.generated_at).toLocaleString("zh-TW")}
            {scan?.scanned_at && `　｜　R2 上次掃描：${new Date(scan.scanned_at).toLocaleString("zh-TW")}`}
          </p>

          {/*
            沒設 token 的時候要把「怎麼補」寫出來 —— 只寫「未設定」等於留下一個
            使用者查不下去的死巷。指令刻意不含值，也提醒不要用管線（會多存換行）。
          */}
          {!report.analytics.configured && (
            <details className={styles.guide}>
              <summary className={styles.guideSummary}>
                有項目顯示「未設定」？請設定 Cloudflare 用量 token
              </summary>
              <div className={styles.guideBody}>
                <p>
                  今日 Workers 請求數、R2 操作次數與 D1 讀寫列數無法由本站自行統計，
                  必須向 Cloudflare 查詢，需要一組<strong>帳號層級</strong>的 API token：
                </p>
                <ol className={styles.guideList}>
                  <li>Cloudflare 後台 → 右上角頭像 → <span className={styles.code}>API Tokens</span> → Create Token → Custom token。</li>
                  <li>權限選擇 <span className={styles.code}>Account</span> → <span className={styles.code}>Account Analytics</span> → <span className={styles.code}>Read</span>，其餘不需要。</li>
                  <li>
                    在 <span className={styles.code}>apps/backend</span> 底下寫入兩個環境（依提示貼上值，
                    <strong>請勿使用管線傳入</strong>，會多存一個換行）：
                    <div className={styles.mono}>npx wrangler secret put CF_API_TOKEN</div>
                    <div className={styles.mono}>npx wrangler secret put CF_API_TOKEN --env dev</div>
                  </li>
                  <li>
                    帳號 ID 也需一併設定（值取自 <span className={styles.code}>npx wrangler whoami</span>
                    的 Account ID）：
                    <div className={styles.mono}>npx wrangler secret put CF_ACCOUNT_ID</div>
                    <div className={styles.mono}>npx wrangler secret put CF_ACCOUNT_ID --env dev</div>
                  </li>
                </ol>
                <p>
                  第 4 步不可省略：查詢帳號清單需要 <span className={styles.code}>Account Settings: Read</span>，
                  而此 token 僅有 Analytics 讀取權限，無法自行判斷所屬帳號。
                </p>
              </div>
            </details>
          )}

          {report.analytics.errors.length > 0 && (
            <div className={styles.detail}>
              <div className={styles.detailHead}>向 Cloudflare 查詢時發生的錯誤</div>
              {report.analytics.errors.map((e, i) => (
                <div key={i} className={styles.detailRow}>
                  <span className={styles.detailNote}>{e}</span>
                </div>
              ))}
            </div>
          )}

          {scan && (
            <details className={styles.guide}>
              <summary className={styles.guideSummary}>
                R2 內容明細（{scan.objects.toLocaleString()} 個物件 ／ {fmtBytes(scan.bytes)}
                {scan.done ? "" : "，尚未掃描完成"}）
              </summary>
              <div className={styles.guideBody}>
                <p>
                  此為<strong>本環境單一 bucket</strong> 的掃描結果。
                  上方的 R2 儲存空間在設定 token 後顯示的是整個帳號的數字
                  （正式站與測試站合計），帳單以後者為準。
                </p>
                {kinds.map(([kind, v]) => (
                  <div key={kind} className={styles.detailRow}>
                    <span className={styles.detailName}>{kind}</span>
                    <span className={styles.detailNum}>
                      {v.objects.toLocaleString()} 個 ／ {fmtBytes(v.bytes)}
                    </span>
                  </div>
                ))}
              </div>
            </details>
          )}

          {(report.breakdown.r2_ops.length > 0
            || report.breakdown.workers.length > 0
            || report.breakdown.d1.length > 0) && (
            <details className={styles.guide}>
              <summary className={styles.guideSummary}>詳細數據</summary>
              <div className={styles.guideBody}>
                {report.breakdown.workers.length > 0 && (
                  <>
                    <div className={styles.guideHead}>Workers 今日請求數</div>
                    {report.breakdown.workers.map((w) => (
                      <div key={w.name} className={styles.detailRow}>
                        <span className={styles.detailName}>{w.name}</span>
                        <span className={styles.detailNum}>{w.requests.toLocaleString()}</span>
                      </div>
                    ))}
                  </>
                )}
                {report.breakdown.r2_buckets.length > 0 && (
                  <>
                    <div className={styles.guideHead}>R2 各個 bucket</div>
                    {report.breakdown.r2_buckets.map((b) => (
                      <div key={b.name} className={styles.detailRow}>
                        <span className={styles.detailName}>{b.name}</span>
                        <span className={styles.detailNum}>
                          {fmtBytes(b.bytes)} ／ {b.objects.toLocaleString()} 個
                        </span>
                      </div>
                    ))}
                  </>
                )}
                {report.breakdown.r2_ops.length > 0 && (
                  <>
                    <div className={styles.guideHead}>R2 本月操作（cls 為收費分級）</div>
                    {report.breakdown.r2_ops.map((o) => (
                      <div key={o.name} className={styles.detailRow}>
                        <span className={styles.detailName}>
                          {o.name}
                          <span className={styles.detailNote}>　cls {o.cls}</span>
                        </span>
                        <span className={styles.detailNum}>{o.requests.toLocaleString()}</span>
                      </div>
                    ))}
                  </>
                )}
                {report.breakdown.d1.length > 0 && (
                  <>
                    <div className={styles.guideHead}>D1 今日讀寫列數</div>
                    {report.breakdown.d1.map((d) => (
                      <div key={d.name} className={styles.detailRow}>
                        <span className={styles.detailName}>{d.name}…</span>
                        <span className={styles.detailNum}>
                          讀取 {d.rows_read.toLocaleString()} ／ 寫入 {d.rows_written.toLocaleString()}
                        </span>
                      </div>
                    ))}
                  </>
                )}
              </div>
            </details>
          )}
        </>
      )}
    </AdminSection>
  );
}
