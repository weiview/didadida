'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fetchDrivePending, type DrivePendingPhoto } from '@/lib/api';
import { ensureAlbumFolder, ensureDriveFolders, prewarmDrive, pushPhotoToDrive } from '@/lib/drive';

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

/**
 * 「補傳 Drive」：把上傳當下沒送上 Drive 的照片補一份 4K + 原始檔。
 *
 * **為什麼要人重選檔案，不由後端自動補。** R2 上只有 2000px 的 JPEG，
 * 拿它去補等於把一張 2000px 送上 Drive 叫做 4K —— 畫質跟現況一模一樣，
 * 名實不符。真正的 4K 只能從相機原始檔重新編，而原始檔只在使用者的硬碟上。
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
  const [result, setResult] = useState<{ ok: number; failed: number; error?: string } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

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
  const { matches, unmatchedFiles, ambiguous, untouched } = useMemo(() => {
    const byKey = new Map<string, DrivePendingPhoto[]>();
    for (const p of pending ?? []) {
      const k = baseKey(p.title || p.file_name);
      const list = byKey.get(k);
      if (list) list.push(p);
      else byKey.set(k, [p]);
    }

    const matches: Match[] = [];
    const unmatchedFiles: File[] = [];
    const ambiguous: string[] = [];
    const used = new Set<number>();

    for (const file of files) {
      const hits = byKey.get(baseKey(file.name));
      if (!hits || hits.length === 0) {
        unmatchedFiles.push(file);
      } else if (hits.length > 1) {
        ambiguous.push(file.name);
      } else {
        matches.push({ photo: hits[0], file });
        used.add(hits[0].id);
      }
    }

    const untouched = (pending ?? []).filter((p) => !used.has(p.id));
    return { matches, unmatchedFiles, ambiguous, untouched };
  }, [pending, files]);

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
    let failed = 0;
    for (let i = 0; i < matches.length; i++) {
      const { photo, file } = matches[i];
      setProgress({ current: i + 1, total: matches.length, name: file.name });
      try {
        if (await pushPhotoToDrive(drive, photo.id, file)) ok++;
        else failed++;
      } catch (e) {
        console.warn(`照片 ${photo.id} 補傳失敗`, e);
        failed++;
      }
    }

    setProgress(null);
    setBusy(false);
    setResult({ ok, failed });
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
            重新選一次原始檔，補上 4K 與原始檔備份。照片本身不會動，只是多一份備份。
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
                  補傳完成：成功 <strong style={{ color: '#15803d' }}>{result.ok}</strong> 張
                  {result.failed > 0 && (
                    <>，失敗 <strong style={{ color: '#b91c1c' }}>{result.failed}</strong> 張（可以再試一次）</>
                  )}
                </>
              )}
            </div>
          )}

          {pending !== null && pending.length > 0 && (
            <>
              <div style={{ fontSize: 14, marginBottom: 12 }}>
                有 <strong>{pending.length}</strong> 張照片還沒有 Drive 備份。
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
                accept="image/jpeg, image/png, image/webp, image/heic, image/heif"
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
                  {untouched.length > 0 && (
                    <div style={note}>
                      還有 {untouched.length} 張沒被選到，留著下次再補。
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
                <br />
                每張要重新編一次 4K 再傳兩個檔，數量多會跑一陣子，請不要關掉這個視窗。
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
