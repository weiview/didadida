'use client';

import { useEffect, useState } from 'react';
import { photoThumbSrc, rotatePhotoThumbs, isVideo, isGif, type Photo, type RotateDegrees, type RotatedThumbs } from '@/lib/api';

interface Props {
  isOpen: boolean;
  /** 選取的那幾張（要整筆 Photo，不是 id）—— 預覽與「哪些轉不了」都要看 media_type */
  photos: Photo[];
  onClose: () => void;
  onDone: (result: { rotated: RotatedThumbs[]; failures: string[]; skipped: number }) => void;
}

/**
 * 批次把 R2 的縮圖轉個方向。
 *
 * **轉的只有網站上那兩顆縮圖**（見 `rotatePhotoThumbs`）—— Drive 上那份 4K 吃的是
 * 原始檔、本來就是正的，歪掉的一直只有縮圖。所以這個視窗要講清楚「轉的是哪一份」，
 * 不然使用者會以為原始檔被動過。
 *
 * ⚠️ **只收 90 的倍數**：任意角度會在四個角露出空白，而這裡要解的是「相機把方向
 *    記錯了」，那本來就只差 90 的倍數。
 *
 * ⚠️ **影片與 GIF 直接跳過，而且要在按之前就講出來**（不是按了才逐張失敗）：
 *    影片在 R2 上只有一張封面、GIF 的動畫本體整份在 R2，轉了都是把使用者看到的
 *    東西弄壞。後端那道 400 才是真的關。
 */
export default function RotatePhotosModal({ isOpen, photos, onClose, onDone }: Props) {
  const [deg, setDeg] = useState(0);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    setDeg(0);
    setBusy(false);
    setDone(0);
    setError(null);
  }, [isOpen]);

  if (!isOpen) return null;

  const targets = photos.filter((p) => !isVideo(p) && !isGif(p));
  const skipped = photos.length - targets.length;
  const preview = targets[0];
  const canSubmit = deg !== 0 && targets.length > 0;

  const turn = (delta: number) => setDeg((prev) => (prev + delta + 360) % 360);

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);

    // 一張一張來，不是 Promise.all —— 每一張都是「抓縮圖 → 重編兩顆 → 上傳」，
    // 同時開幾十份會把記憶體與頻寬吃光（同重複照片那條佇列的理由）
    const rotated: RotatedThumbs[] = [];
    const failures: string[] = [];
    for (const p of targets) {
      try {
        rotated.push(await rotatePhotoThumbs(p, deg as RotateDegrees));
      } catch (e: any) {
        // ⚠️ 失敗**不可以當場 alert**，那會蓋在還在跑的批次上面。
        //    逐張記下原因，收工一次講完（同 IngestResult.failures 的規矩）
        failures.push(`${p.title || p.file_name || p.id}：${e?.message || '未知錯誤'}`);
      }
      setDone((n) => n + 1);
    }

    setBusy(false);
    if (rotated.length === 0 && failures.length > 0) {
      // 一張都沒成功就留在視窗裡講原因，關掉會讓人以為什麼都沒發生
      setError(`全部都失敗了。${failures[0]}`);
      return;
    }
    onDone({ rotated, failures, skipped });
    onClose();
  };

  const turnButton = (label: string, delta: number) => (
    <button
      onClick={() => turn(delta)}
      disabled={busy}
      style={{
        padding: '9px 16px', borderRadius: 8, border: '1px solid #cbd5e1',
        background: '#fff', cursor: busy ? 'not-allowed' : 'pointer', fontSize: 15,
      }}
    >
      {label}
    </button>
  );

  return (
    <div
      onClick={busy ? undefined : onClose}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,.5)', zIndex: 4000,
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: '#fff', borderRadius: 14, width: '100%', maxWidth: 460,
          maxHeight: '88vh', overflowY: 'auto', padding: 22, color: '#0f172a',
        }}
      >
        <h3 style={{ margin: '0 0 4px', fontSize: 18 }}>旋轉照片</h3>
        <p style={{ margin: '0 0 14px', fontSize: 13, color: '#64748b' }}>
          已選取 {photos.length} 張{targets.length !== photos.length && `，其中 ${targets.length} 張可以轉`}
        </p>

        {/*
          * 預覽用 CSS transform 轉，不真的重編位元組 —— 使用者要的是「看一眼對不對」，
          * 而真正的重編會發生在按下套用之後。外框固定成正方形，這樣轉 90 度時
          * 版面不會跳一下
          */}
        <div
          style={{
            height: 220, marginBottom: 14, borderRadius: 10, background: '#0f172a',
            display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden',
          }}
        >
          {preview ? (
            <img
              src={photoThumbSrc(preview, 'md')}
              alt=""
              style={{
                maxWidth: deg === 90 || deg === 270 ? 200 : '100%',
                maxHeight: deg === 90 || deg === 270 ? '100%' : 200,
                objectFit: 'contain',
                transform: `rotate(${deg}deg)`,
                transition: 'transform .18s ease',
              }}
            />
          ) : (
            <span style={{ color: '#94a3b8', fontSize: 13 }}>沒有可以旋轉的照片</span>
          )}
        </div>

        <div style={{ display: 'flex', gap: 10, justifyContent: 'center', marginBottom: 14 }}>
          {turnButton('↺ 左轉 90°', -90)}
          {turnButton('↻ 右轉 90°', 90)}
        </div>

        <p style={{ fontSize: 12.5, color: '#334155', margin: '0 0 10px', lineHeight: 1.6 }}>
          目前 <strong>{deg === 0 ? '沒有旋轉' : `順時針 ${deg}°`}</strong>
          {targets.length > 1 && '，選取的每一張都會轉同樣的角度。'}
        </p>
        <p style={{ fontSize: 12.5, color: '#64748b', margin: '0 0 10px', lineHeight: 1.6 }}>
          轉的是<strong>網站上的縮圖</strong>（相簿格線、首頁、地圖）。
          Google Drive 上那份原始檔與大圖不會被動到。
        </p>
        {skipped > 0 && (
          <p style={{ fontSize: 12.5, color: '#b45309', margin: '0 0 10px', lineHeight: 1.6 }}>
            其中 {skipped} 個是影片或 GIF，<strong>不會處理</strong> ——
            影片在網站上只有一張封面、GIF 是動畫本體，轉了會弄壞它們。
          </p>
        )}

        {error && (
          <p style={{ fontSize: 13, color: '#b91c1c', margin: '0 0 12px' }}>{error}</p>
        )}

        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button
            onClick={onClose}
            disabled={busy}
            style={{
              padding: '9px 18px', borderRadius: 8, border: '1px solid #cbd5e1',
              background: '#fff', cursor: busy ? 'not-allowed' : 'pointer', fontSize: 14,
            }}
          >
            取消
          </button>
          <button
            onClick={handleSubmit}
            disabled={!canSubmit || busy}
            style={{
              padding: '9px 18px', borderRadius: 8, border: 'none',
              background: canSubmit && !busy ? '#2563eb' : '#cbd5e1', color: '#fff',
              cursor: canSubmit && !busy ? 'pointer' : 'not-allowed', fontSize: 14,
            }}
          >
            {busy ? `處理中 ${done}/${targets.length}…` : `套用到 ${targets.length} 張`}
          </button>
        </div>
      </div>
    </div>
  );
}
