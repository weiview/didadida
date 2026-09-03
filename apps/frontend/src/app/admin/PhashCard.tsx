"use client";

import { useMemo, useState } from "react";
import {
  deletePhoto, fetchPhashPage, photoThumbSrc, savePhashes, type PhashPhoto,
} from "@/lib/api";
import { dhashFromBlob, hamming, isFlatPhash, phashToInts } from "@/lib/phash";
import { useAdmin } from "@/lib/useAdmin";
import { revealRestricted, useRevealedRestricted } from "@/lib/restrictedReveal";
import AdminSection from "./AdminSection";
import styles from "./admin.module.css";

/*
 * 相片的像素比對：找出「重複、但特徵碼不同」的照片。
 *
 * file_hash 比的是位元組，所以只要重新編碼過就對不上 —— Google 相簿匯入
 * 拿到的是 Google 自己轉過的檔、換一台機器重傳產生的 800px 縮圖也不會一樣。
 * 這一格改比**畫面本身**（9x8 灰階的 dHash，見 lib/phash.ts）。
 *
 * 雜湊在瀏覽器算（Worker 沒有影像解碼器，也沒有 10ms CPU 以外的預算），
 * 算完寫回 Photo.phash —— 那一欄早就在，只是從來沒有人餵過它。
 * 所以整站只需要掃一次：之後新上傳的照片自己會帶著 phash 上來
 * （見 lib/api.ts 的 uploadPhoto），這顆按鈕再按只會處理新增的那幾張。
 *
 * 絕不自動刪、也不整組刪（使用者拍板）。哪一列該留只有人判斷得了
 * —— 舊的那列往往帶著標籤與留言。同「站上多餘的列只列出來不刪」那條規矩。
 */

/** 一頁抓幾列。列數不是瓶頸（D1 算的是讀了幾列），回應大小才是 */
const PAGE = 500;
/** 保險絲：500 一頁 x 200 輪 = 10 萬張 */
const MAX_ROUNDS = 200;
/** 同時抓幾張縮圖。太高只是把自己的 Worker 塞住，抓的總數完全一樣 */
const CONCURRENCY = 4;
/** 一趟寫回幾筆（後端也擋著同一個數字）。順便當「算到這裡就先存」的節奏 */
const WRITE_CHUNK = 200;
/** 畫面上最多列幾組。真的有幾百組時，先處理完前面這些再按一次 */
const MAX_GROUPS = 100;

/** 幾個 bit 以內算「長得一樣」 */
const LEVELS = [
  { value: 0, label: "一模一樣（0）" },
  { value: 4, label: "幾乎一樣（4 以內，推薦）" },
  { value: 8, label: "有點像就算（8 以內）" },
];

interface Group {
  key: string;
  photos: PhashPhoto[];
}

export default function PhashCard() {
  const { restrictedBlur } = useAdmin();
  const revealed = useRevealedRestricted();

  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState("");
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null);
  const [items, setItems] = useState<PhashPhoto[] | null>(null);
  const [albums, setAlbums] = useState<Map<number, string>>(new Map());
  const [threshold, setThreshold] = useState(4);
  const [deleting, setDeleting] = useState<number | null>(null);

  const run = async () => {
    setBusy(true);
    setMessage(null);
    setProgress(null);
    try {
      /* 1. 把全站的清單抓回來 —— 跨相簿的重複正是特徵碼比對抓不到的那一種 */
      const all: PhashPhoto[] = [];
      const albumMap = new Map<number, string>();
      let cursor = 0;
      let rounds = 0;
      let total = 0;
      for (;;) {
        const res = await fetchPhashPage(cursor, PAGE);
        if (rounds === 0) {
          total = res.total ?? 0;
          for (const a of res.albums ?? []) albumMap.set(a.id, a.name);
        }
        rounds++;
        all.push(...res.items);
        cursor = res.next_cursor;
        setPhase("讀清單");
        setProgress({ done: all.length, total: total || all.length });
        if (res.done) break;
        if (rounds >= MAX_ROUNDS) {
          setMessage({ text: `清單超過 ${MAX_ROUNDS * PAGE} 張，先比對前面這些。`, ok: false });
          break;
        }
      }
      setAlbums(albumMap);

      /* 2. 只算沒算過的那幾張。算過的照片一輩子不會再被抓一次縮圖 */
      const todo = all.filter((p) => !p.phash);
      let failed = 0;
      let computed = 0;
      let saveError = "";
      for (let i = 0; i < todo.length; i += WRITE_CHUNK) {
        const chunk = todo.slice(i, i + WRITE_CHUNK);
        const out: { id: number; phash: string }[] = [];
        let next = 0;
        await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
          for (;;) {
            const k = next++;
            if (k >= chunk.length) return;
            const p = chunk[k];
            let hex: string | null = null;
            try {
              // 抓 400px 那顆（逐級退回）。一定要 fetch 位元組再進 canvas ——
              // 直接把跨來源的網址塞給 img 會汙染 canvas，getImageData 當場丟例外
              const res = await fetch(photoThumbSrc(p, "sm"));
              if (res.ok) hex = await dhashFromBlob(await res.blob());
            } catch { /* 一張抓不到不該停掉整批 */ }
            if (hex) {
              p.phash = hex;
              out.push({ id: p.id, phash: hex });
              computed++;
            } else {
              failed++;
            }
            setPhase("算特徵值");
            setProgress({ done: computed + failed, total: todo.length });
          }
        }));
        /*
         * 算一塊就寫回一塊，不要全部算完才寫 —— 中途關掉分頁的話，
         * 已經花掉的那些請求就白花了（下次按又要重抓一次縮圖）。
         */
        if (out.length > 0) {
          try {
            await savePhashes(out);
          } catch (e) {
            saveError = e instanceof Error ? e.message : "寫回特徵值失敗";
          }
        }
      }

      setItems(all);
      setPhase("");
      setProgress(null);
      setMessage({
        text: `全站 ${all.length} 張，這一趟新算了 ${computed} 張`
          + (todo.length === 0 ? "（都算過了）" : "")
          + (failed ? `。${failed} 張讀不到縮圖，再按一次會重試` : "")
          + (saveError ? `。${saveError}` : "")
          + "。",
        ok: !failed && !saveError,
      });
    } catch (e) {
      setMessage({ text: e instanceof Error ? e.message : "比對失敗", ok: false });
      setPhase("");
      setProgress(null);
    } finally {
      setBusy(false);
    }
  };

  /*
   * 分組。換門檻不重抓也不重算 —— 雜湊都在手上了，這裡純粹是記憶體運算。
   *
   * 先照「完全相同的雜湊」收成桶（絕大多數的重複都落在這裡），再拿不重複的
   * 雜湊兩兩比漢明距離、用 union-find 併起來。比不重複的那幾個而不是每一張，
   * 幾千張照片也只是幾毫秒。
   */
  const groups = useMemo<Group[]>(() => {
    if (!items) return [];
    const buckets = new Map<string, PhashPhoto[]>();
    for (const p of items) {
      const h = p.phash;
      // 整片同色的畫面（全黑的影片封面）雜湊都一樣，那不是「長得一樣」的
      // 證據，是「沒有東西可以比」—— 混進去會生出一大組假的重複
      if (!h || isFlatPhash(h) || !phashToInts(h)) continue;
      const list = buckets.get(h);
      if (list) list.push(p);
      else buckets.set(h, [p]);
    }

    const keys = Array.from(buckets.keys());
    const ints = keys.map((k) => phashToInts(k)!);
    const parent = keys.map((_, i) => i);
    const find = (i: number): number => {
      while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; }
      return i;
    };
    if (threshold > 0) {
      for (let a = 0; a < keys.length; a++) {
        for (let b = a + 1; b < keys.length; b++) {
          if (hamming(ints[a], ints[b]) <= threshold) {
            const ra = find(a);
            const rb = find(b);
            if (ra !== rb) parent[ra] = rb;
          }
        }
      }
    }

    const merged = new Map<number, PhashPhoto[]>();
    for (let i = 0; i < keys.length; i++) {
      const root = find(i);
      const photos = buckets.get(keys[i])!;
      const list = merged.get(root);
      if (list) list.push(...photos);
      else merged.set(root, [...photos]);
    }

    const out: Group[] = [];
    merged.forEach((photos, root) => {
      if (photos.length < 2) return;
      photos.sort((a, b) => a.id - b.id);
      out.push({ key: keys[root], photos });
    });
    // 張數多的排前面：那幾組最值得先處理
    out.sort((a, b) => b.photos.length - a.photos.length || a.photos[0].id - b.photos[0].id);
    return out;
  }, [items, threshold]);

  const dupCount = groups.reduce((n, g) => n + g.photos.length - 1, 0);

  const remove = async (photo: PhashPhoto) => {
    const where = albums.get(photo.album_id) || `相簿 #${photo.album_id}`;
    const ok = window.confirm(
      `刪掉「${photo.title || `#${photo.id}`}」（在「${where}」）？\n\n`
      + "連同它的標籤、留言、Story、手動修過的座標與時間一起沒，"
      + "Drive 上那一份會排進 trash/。這件事沒有辦法復原。",
    );
    if (!ok) return;
    setDeleting(photo.id);
    try {
      const done = await deletePhoto(photo.id);
      if (!done) {
        setMessage({ text: `刪不掉 #${photo.id}，請再試一次`, ok: false });
        return;
      }
      // 刪完不重抓（同「不開放」那顆快速鎖的理由）：整份清單重抓一次要好幾秒，
      // 而且捲軸會跳回去，使用者得重新找剛剛看到哪一組
      setItems((prev) => (prev ? prev.filter((p) => p.id !== photo.id) : prev));
    } catch (e) {
      setMessage({ text: e instanceof Error ? e.message : "刪除失敗", ok: false });
    } finally {
      setDeleting(null);
    }
  };

  return (
    <AdminSection id="phash" title="相片的像素比對">
      <p className={styles.hint}>
        找「明明是同一張、但<strong>特徵碼不一樣</strong>」的重複照片。
        特徵碼比的是位元組，所以從 Google 相簿匯入（Google 自己轉過檔）、
        或換一台電腦重傳的同一張照片一定對不上；這裡改比<strong>畫面本身</strong>。
      </p>
      <p className={styles.hint}>
        比對<strong>全站</strong>一次做完，跨相簿的重複也找得到。算過的照片不會再算第二次，
        新上傳的照片自己就帶著特徵值上來，所以這顆按鈕平常按一下很快。
        <strong>連拍</strong>（同一秒連按好幾張）畫面幾乎一樣，也會被圈在一起 ——
        所以下面每一張都要你自己看過再決定刪不刪。
      </p>

      <div className={styles.formRow}>
        <button className={`${styles.button} ${styles.primary}`} onClick={run} disabled={busy}>
          {busy ? `${phase || "處理"}中...` : items ? "重新比對" : "開始比對"}
        </button>
        <select
          className={styles.select}
          value={threshold}
          onChange={(e) => setThreshold(Number(e.target.value))}
          disabled={busy}
          title="要多像才算重複"
        >
          {LEVELS.map((l) => <option key={l.value} value={l.value}>{l.label}</option>)}
        </select>
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

      {items && (
        <p className={styles.hint}>
          {groups.length === 0
            ? "沒有找到長得一樣的照片。"
            : `找到 ${groups.length} 組長得一樣的（多出來的共 ${dupCount} 張）`
              + (groups.length > MAX_GROUPS ? `，先列前 ${MAX_GROUPS} 組。` : "。")}
        </p>
      )}

      {groups.slice(0, MAX_GROUPS).map((g) => (
        <div key={g.key} className={styles.dupGroup}>
          <div className={styles.detailHead}>這 {g.photos.length} 張長得一樣</div>
          {g.photos.map((p) => {
            const blurred = restrictedBlur && p.restricted === 1 && !revealed.has(p.id);
            const sameBytes = !!p.file_hash && p.file_hash === g.photos[0].file_hash;
            return (
              <div key={p.id} className={styles.dupRow}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  className={blurred ? `${styles.dupThumb} ${styles.dupBlur}` : styles.dupThumb}
                  src={photoThumbSrc(p, "sm")}
                  alt=""
                  loading="lazy"
                  onClick={() => { if (blurred) revealRestricted(p.id); }}
                />
                <div className={styles.dupInfo}>
                  {/*
                    相簿頁是 /album?id=<相簿>，不是 /album/<相簿>。前端是
                    output: "export" 的純靜態站，src/app/album/ 底下沒有 [id]
                    這一層，多打一段路徑就是真的 404。
                  */}
                  <a
                    className={styles.detailName}
                    href={`/album?id=${p.album_id}&photo=${p.id}`}
                    target="_blank"
                    rel="noreferrer"
                    title="在新分頁看這張照片"
                  >
                    {p.title || `#${p.id}`} ↗
                  </a>
                  <span className={styles.detailNote}>
                    {albums.get(p.album_id) || `相簿 #${p.album_id}`}
                    {p.taken_at ? ` · ${p.taken_at.slice(0, 16).replace("T", " ")}` : " · 沒有拍攝時間"}
                    {p.media_type && p.media_type !== "photo" ? ` · ${p.media_type}` : ""}
                    {sameBytes ? " · 特徵碼也一樣" : ""}
                  </span>
                </div>
                <button
                  className={`${styles.button} ${styles.danger}`}
                  onClick={() => remove(p)}
                  disabled={deleting !== null}
                >
                  {deleting === p.id ? "刪除中..." : "刪除"}
                </button>
              </div>
            );
          })}
        </div>
      ))}
    </AdminSection>
  );
}
