'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fetchDrivePending, type DrivePendingPhoto } from '@/lib/api';
import { ensureAlbumFolder, ensureDriveFolders, prewarmDrive, pushPhotoToDrive, pushVideoToDrive } from '@/lib/drive';
import { ACCEPTED_VIDEO_TYPES } from '@/lib/videoUtils';

interface Props {
  isOpen: boolean;
  /** 只補這本相簿。不帶就是全站，但目前沒有這種入口 */
  albumId?: number;
  onClose: () => void;
  /** 補完之後重抓相簿資料 */
  onDone: () => Promise<unknown> | unknown;
}

/** 去掉副檔名再轉小寫。上傳時 resizeImageFile 會把副檔名改寫成 .jpg，只有主檔名靠得住 */
const baseKey = (name: string) => name.replace(/\.[^/.]+$/, '').trim().toLowerCase();

interface Match {
  photo: DrivePendingPhoto;
  file: File;
}

/** 影片的 Drive id 記在 drive_original_id，沒有 4K 那一份（見 0019） */
const isVideoRow = (p: DrivePendingPhoto) => p.media_type === 'video';

/**
 * 這一列還缺哪幾份。
 *
 * 補傳只補缺的那一半 —— 已經上去的那份再傳一次，Drive 上就會多一個同名檔
 * （Drive 不會去重），而且白白多編一次 4K。
 */
const missingHalves = (p: DrivePendingPhoto): { fourK: boolean; original: boolean } =>
  isVideoRow(p)
    ? { fourK: false, original: !p.has_original }
    : { fourK: !p.has_4k, original: !p.has_original };

/** 清單上那一行右邊的小字：缺 4K、缺原始檔，還是兩份都缺 */
const missingLabel = (p: DrivePendingPhoto): string => {
  const m = missingHalves(p);
  if (isVideoRow(p)) return '影片';
  if (m.fourK && m.original) return '';
  return m.fourK ? '只缺 4K' : '只缺原始檔';
};

/**
 * 「補傳 Drive」：把上傳當下沒送上 Drive 的照片補一份 4K + 原始檔。
 *
 * **為什麼要人重選檔案，不由後端自動補。** R2 上只有 2000px 的 JPEG，
 * 拿它去補等於把一張 2000px 送上 Drive 叫做 4K —— 畫質跟現況一模一樣，
 * 名實不符。真正的 4K 只能從相機原始檔重新編，而原始檔只在使用者的硬碟上。
 *
 * ⚠️ **影片也在這份清單裡**，而且對影片來說這不是備份是救命 —— R2 上只有一張
 *    封面圖，Drive 那份沒上去就等於沒有影片。影片走 pushVideoToDrive（分塊上傳、
 *    沒有 4K 那一份），**絕對不能拿去跑 pushPhotoToDrive** —— 那會對幾 GB 的檔
 *    跑 encode4kWebp。
 *
 * Drive 的授權在管理員登入時就一起拿到了，這裡不會有任何授權彈窗；
 * 手上沒 token 只代表登入過期，重新登入即可。
 */
export default function DriveBackfillModal({ isOpen, albumId, onClose, onDone }: Props) {
  const [pending, setPending] = useState<DrivePendingPhoto[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ current: number; total: number; name: string } | null>(null);
  const [result, setResult] = useState<
    { ok: number; failed: number; error?: string; failures?: string[] } | null
  >(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // 剛剛複製了哪一列的檔名（給那一列一個短暫的「已複製 ✓」）
  const [copiedId, setCopiedId] = useState<number | null>(null);

  const load = useCallback(async () => {
    setPending(null);
    setLoadError(null);
    try {
      // 一本相簿通常一批就撈完；真的破 500 張就跟著 cursor 續撈
      const all: DrivePendingPhoto[] = [];
      let cursor = 0;
      for (let page = 0; page < 20; page++) {
        const res = await fetchDrivePending(cursor, 500, albumId);
        if (!res) throw new Error('讀取待補清單失敗');
        all.push(...res.photos);
        cursor = res.next_cursor;
        if (res.done) break;
      }
      setPending(all);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : '讀取待補清單失敗');
    }
  }, [albumId]);

  useEffect(() => {
    if (!isOpen) return;
    setFiles([]);
    setResult(null);
    setProgress(null);
    load();
    // 趁使用者還在讀畫面、選檔案，先把 GIS 元件與後端設定備好。
    // 「開始補傳」按下去那一刻不能再等網路，不然 5 秒的啟用狀態會過期
    prewarmDrive();
  }, [isOpen, load]);

  /**
   * 檔名對照片。同一個主檔名在待補清單裡出現兩次就兩邊都不碰 ——
   * 猜錯會把 A 的原始檔記成 B 的備份，而那是靜悄悄的錯，之後沒人查得出來。
   */
  const { matches, unmatchedFiles, ambiguous, matchedIds, dupNames } = useMemo(() => {
    const byKey = new Map<string, DrivePendingPhoto[]>();
    for (const p of pending ?? []) {
      const k = baseKey(p.title || p.file_name);
      const list = byKey.get(k);
      if (list) list.push(p);
      else byKey.set(k, [p]);
    }
    // 待補清單裡自己就同名的那幾張。清單上要標出來 —— 不標的話使用者會一直
    // 重選那個檔案，然後一直什麼都沒發生（它們是被「不猜」規則擋掉的）
    const dupNames = new Set<string>();
    // forEach 而不是 for…of：tsconfig 的 target 沒開 downlevelIteration，
    // 直接迭代 Map 會被 TS2802 擋下來
    byKey.forEach((list, k) => { if (list.length > 1) dupNames.add(k); });

    const matches: Match[] = [];
    const unmatchedFiles: File[] = [];
    const ambiguous: string[] = [];
    const matchedIds = new Set<number>();

    for (const file of files) {
      const hits = byKey.get(baseKey(file.name));
      if (!hits || hits.length === 0) {
        unmatchedFiles.push(file);
      } else if (hits.length > 1) {
        ambiguous.push(file.name);
      } else {
        matches.push({ photo: hits[0], file });
        matchedIds.add(hits[0].id);
      }
    }

    return { matches, unmatchedFiles, ambiguous, matchedIds, dupNames };
  }, [pending, files]);

  /**
   * 複製**單一**檔名（點清單上那一列）。
   *
   * 有清單還不夠 —— 人要拿著檔名去硬碟的搜尋框裡找那個檔，用貼的比照著打快。
   * ⚠️ 刻意**不做「複製全部」** —— 一次貼幾十個檔名進搜尋框是找不到東西的，
   *    實際的動作永遠是「找一個、選一個」，整份複製只會讓人再自己切一次。
   * 剪貼簿被擋掉（權限、非安全來源）就直接 prompt 攤開來讓人自己選取，
   * 不要只 console.error：那又是一次「按了沒反應」。
   */
  const copyName = async (id: number, name: string) => {
    if (!name) return;
    try {
      await navigator.clipboard.writeText(name);
      setCopiedId(id);
      setTimeout(() => setCopiedId((cur) => (cur === id ? null : cur)), 1600);
    } catch {
      window.prompt('複製不了，請自己選取這段文字：', name);
    }
  };

  const handleStart = async () => {
    if (matches.length === 0 || busy) return;
    setBusy(true);
    setResult(null);

    // 寫入用的 token 跟後端換（是「Drive 寫入帳號」的，不是登入者自己的），
    // 所以這裡不會有任何彈窗。沒連結／授權過期會在這一步就丟錯
    let drive: { folderId: string; token: string };
    try {
      const folders = await ensureDriveFolders();
      if (!albumId) throw new Error('沒有相簿 id，不知道該把檔案放進哪個資料夾');
      drive = { folderId: await ensureAlbumFolder(folders, albumId), token: folders.token };
    } catch (e) {
      setBusy(false);
      setResult({ ok: 0, failed: 0, error: e instanceof Error ? e.message : 'Google Drive 授權失敗' });
      return;
    }

    let ok = 0;
    const failures: string[] = [];
    for (let i = 0; i < matches.length; i++) {
      const { photo, file } = matches[i];
      setProgress({ current: i + 1, total: matches.length, name: file.name });
      try {
        if (isVideoRow(photo)) {
          // 影片沒有 4K 那一份，而且要走分塊上傳（幾 GB 的檔不能整份塞進一次請求）
          await pushVideoToDrive(drive, photo.id, file);
          ok++;
        } else {
          const res = await pushPhotoToDrive(drive, photo.id, file, missingHalves(photo));
          if (res.ok) ok++;
          else failures.push(`${file.name}：${res.reason ?? 'Drive 上傳失敗'}`);
        }
      } catch (e) {
        console.warn(`照片 ${photo.id} 補傳失敗`, e);
        failures.push(`${file.name}：${e instanceof Error ? e.message : String(e)}`);
      }
    }

    setProgress(null);
    setBusy(false);
    // ⚠️ 失敗一律逐檔講原因。「失敗 N 張」對 HEIC 這種永遠編不出 4K 的檔是句假話，
    //    再試一百次都一樣，而使用者只能一直重試
    setResult({ ok, failed: failures.length, failures });
    setFiles([]);
    await load();
    await onDone();
  };

  if (!isOpen) return null;

  const btn = (enabled: boolean, primary = false) => ({
    padding: '9px 16px',
    borderRadius: 8,
    border: primary ? 'none' : '1px solid #cbd5e1',
    background: primary ? (enabled ? '#2563eb' : '#93c5fd') : '#fff',
    color: primary ? '#fff' : '#334155',
    cursor: enabled ? 'pointer' : 'default',
    fontSize: 14,
    opacity: enabled ? 1 : 0.7,
  } as const);

  const note = { fontSize: 12.5, color: '#64748b', lineHeight: 1.7 } as const;

  return (
    <div
      onClick={busy ? undefined : onClose}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,.5)', zIndex: 1000,
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: '#fff', borderRadius: 14, width: '100%', maxWidth: 620,
          maxHeight: '88vh', display: 'flex', flexDirection: 'column', color: '#0f172a',
        }}
      >
        <div style={{ padding: '16px 20px', borderBottom: '1px solid #f1f5f9' }}>
          <strong style={{ fontSize: 16 }}>補傳 Drive 備份</strong>
          <div style={{ ...note, marginTop: 4 }}>
            重新選一次原始檔，補上缺的那幾份。相簿裡的照片本身不會動。
            影片也在這份清單裡 —— 影片的 Drive 那份不是備份，沒上去就等於沒有影片。
          </div>
        </div>

        <div style={{ padding: '16px 20px', overflowY: 'auto', flex: 1 }}>
          {pending === null && !loadError && <div style={note}>讀取待補清單中...</div>}
          {loadError && <div style={{ color: '#b91c1c', fontSize: 13.5 }}>{loadError}</div>}

          {pending !== null && pending.length === 0 && (
            <div style={{ fontSize: 14 }}>
              這本相簿的照片都有 Drive 備份了，沒有要補的。
            </div>
          )}

          {/* 結果放在待補清單的條件之外：補完會重抓清單，包在裡面的話成功訊息會被洗掉 */}
          {result && (
            <div style={{ marginBottom: 14, fontSize: 13.5, lineHeight: 1.8 }}>
              {result.error ? (
                <span style={{ color: '#b91c1c' }}>Drive 沒接上：{result.error}</span>
              ) : (
                <>
                  補傳完成：成功 <strong style={{ color: '#15803d' }}>{result.ok}</strong> 個
                  {result.failed > 0 && (
                    <>，失敗 <strong style={{ color: '#b91c1c' }}>{result.failed}</strong> 個</>
                  )}
                  {result.failures && result.failures.length > 0 && (
                    <details style={{ color: '#b91c1c', marginTop: 4 }}>
                      <summary style={{ cursor: 'pointer' }}>看失敗的原因</summary>
                      <div style={{ ...note, color: '#b91c1c', paddingLeft: 14 }}>
                        {result.failures.map((f, i) => <div key={i}>{f}</div>)}
                      </div>
                    </details>
                  )}
                </>
              )}
            </div>
          )}

          {pending !== null && pending.length > 0 && (
            <>
              <div style={{ fontSize: 14, marginBottom: 8 }}>
                有 <strong>{pending.length}</strong> 個檔案還沒有完整的 Drive 備份
                <span style={{ color: '#64748b', fontSize: 12.5 }}>（點檔名複製那一個）</span>：
              </div>

              {/*
                * **一定要把檔名列出來。** 這個視窗要人「重新選一次原始檔」，
                * 而補傳是靠檔名對回照片的 —— 只講「還有 N 張」等於要使用者
                * 自己猜是哪幾張，硬碟裡幾千個檔根本無從選起。
                *
                * 只列文字不列縮圖：一次幾百張縮圖就是幾百次 Workers 請求，
                * 而這裡要回答的問題是「我該去找哪個檔」，檔名就夠了。
                */}
              <div style={{
                maxHeight: 190, overflowY: 'auto', margin: '0 0 14px',
                border: '1px solid #e2e8f0', borderRadius: 8, background: '#f8fafc',
              }}>
                {pending.map((p) => {
                  const name = p.title || p.file_name;
                  const isMatched = matchedIds.has(p.id);
                  const isDup = dupNames.has(baseKey(name));
                  const justCopied = copiedId === p.id;
                  /*
                   * 整列就是那顆按鈕（不是旁邊再擺一顆小圖示）—— 檔名本身很長，
                   * 已經佔滿一整列，要點的目標就是它。用 <button> 而不是 div
                   * 是為了鍵盤也按得到。
                   */
                  return (
                    <button
                      key={p.id}
                      type="button"
                      title={`${name}（點一下複製檔名）`}
                      onClick={() => copyName(p.id, name)}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 8, width: '100%',
                        padding: '5px 10px', fontSize: 12.5, lineHeight: 1.5,
                        borderBottom: '1px solid #eef2f7', textAlign: 'left',
                        borderTop: 'none', borderLeft: 'none', borderRight: 'none',
                        background: justCopied ? '#ecfdf5' : 'transparent',
                        color: isMatched ? '#15803d' : '#334155',
                        cursor: 'pointer', font: 'inherit',
                      }}
                    >
                      <span style={{ width: 14, flexShrink: 0 }}>{isMatched ? '✓' : ''}</span>
                      <span style={{
                        flex: 1, overflow: 'hidden',
                        textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      }}>
                        {name}
                      </span>
                      {justCopied ? (
                        <span style={{ color: '#15803d', flexShrink: 0, fontSize: 11.5 }}>已複製 ✓</span>
                      ) : (
                        <>
                          {missingLabel(p) && (
                            <span style={{
                              color: isVideoRow(p) ? '#7c3aed' : '#64748b', flexShrink: 0, fontSize: 11.5,
                            }}>
                              {missingLabel(p)}
                            </span>
                          )}
                          {isDup && (
                            <span style={{ color: '#92400e', flexShrink: 0 }}>同名多張</span>
                          )}
                        </>
                      )}
                    </button>
                  );
                })}
              </div>

              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={busy}
                style={btn(!busy)}
              >
                {files.length > 0 ? `重新選擇檔案（已選 ${files.length} 個）` : '選擇原始檔'}
              </button>
              <input
                type="file"
                ref={fileInputRef}
                style={{ display: 'none' }}
                accept={`image/jpeg, image/png, image/webp, image/heic, image/heif, ${ACCEPTED_VIDEO_TYPES}`}
                multiple
                onChange={(e) => {
                  setFiles(Array.from(e.target.files ?? []));
                  setResult(null);
                  // 清空才能重選同一批檔案
                  if (fileInputRef.current) fileInputRef.current.value = '';
                }}
              />

              {files.length > 0 && (
                <div style={{ marginTop: 14, fontSize: 13.5, lineHeight: 1.9 }}>
                  <div>
                    對上 <strong style={{ color: '#15803d' }}>{matches.length}</strong> 張，
                    可以補傳。
                  </div>
                  {unmatchedFiles.length > 0 && (
                    <details style={{ color: '#92400e' }}>
                      <summary style={{ cursor: 'pointer' }}>
                        {unmatchedFiles.length} 個檔案在這本相簿裡找不到對應照片，會略過
                      </summary>
                      <div style={{ ...note, paddingLeft: 14 }}>
                        {unmatchedFiles.map((f) => f.name).join('、')}
                      </div>
                    </details>
                  )}
                  {ambiguous.length > 0 && (
                    <details style={{ color: '#92400e' }}>
                      <summary style={{ cursor: 'pointer' }}>
                        {ambiguous.length} 個檔名同時對到多張照片，不猜，一律略過
                      </summary>
                      <div style={{ ...note, paddingLeft: 14 }}>{ambiguous.join('、')}</div>
                    </details>
                  )}
                  {pending.length - matchedIds.size > 0 && (
                    <div style={note}>
                      還有 {pending.length - matchedIds.size} 張沒被選到（上面清單裡沒有 ✓ 的那些），留著下次再補。
                    </div>
                  )}
                </div>
              )}

              {progress && (
                <div style={{ marginTop: 14 }}>
                  <div style={{ height: 6, background: '#e2e8f0', borderRadius: 3, overflow: 'hidden' }}>
                    <div style={{
                      height: '100%', width: `${(progress.current / progress.total) * 100}%`,
                      background: '#2563eb', transition: 'width .2s',
                    }} />
                  </div>
                  <div style={{ ...note, marginTop: 6 }}>
                    正在補傳 {progress.name}（{progress.current} / {progress.total}）
                  </div>
                </div>
              )}

              <div style={{ ...note, marginTop: 16, borderTop: '1px solid #f1f5f9', paddingTop: 12 }}>
                靠<strong>檔名</strong>對應（不含副檔名）。改過檔名的檔案對不上，
                但不會出錯，只會被列進「找不到對應照片」。
                標著「同名多張」的那幾張不猜也不碰 —— 猜錯會把 A 的原始檔記成 B 的備份，
                而那是查不出來的錯。要補的話先把其中幾張改名再回來。
                <br />
                每張照片要重新編一次 4K 再傳兩個檔（只缺一份的就只補那一份），
                影片是整份原始檔分塊上傳。數量多會跑一陣子，請不要關掉這個視窗。
              </div>
            </>
          )}
        </div>

        <div style={{
          padding: '12px 20px', borderTop: '1px solid #f1f5f9',
          display: 'flex', justifyContent: 'flex-end', gap: 8,
        }}>
          <button type="button" onClick={onClose} disabled={busy} style={btn(!busy)}>
            {result && !result.error ? '關閉' : '取消'}
          </button>
          <button
            type="button"
            onClick={handleStart}
            disabled={busy || matches.length === 0}
            style={btn(!busy && matches.length > 0, true)}
            title="這一步會彈出 Google 授權視窗"
          >
            {busy ? '補傳中...' : `開始補傳${matches.length > 0 ? ` ${matches.length} 張` : ''}`}
          </button>
        </div>
      </div>
    </div>
  );
}
