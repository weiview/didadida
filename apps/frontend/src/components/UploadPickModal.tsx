'use client';

import { useEffect, useMemo, useState } from 'react';
import { isVideoFile } from '@/lib/videoUtils';

interface Props {
  /** null ＝視窗不開 */
  files: File[] | null;
  onCancel: () => void;
  /** restricted 與 files 同一個順序 */
  onConfirm: (restricted: boolean[]) => void;
}

/**
 * 上傳前逐張挑「不開放」。只有可管理全站內容的人會走到這一步（呼叫端判斷）。
 *
 * ⚠️ 標記是跟著 `POST /api/upload` 那一趟一起寫進 INSERT 的 —— 那張照片的網址從來
 *    沒有發出去過，所以不必像事後標記那樣換 R2 鍵、也不必推 content_epoch。
 *
 * 預覽是 objectURL，**不讀進記憶體也不打任何 API**。HEIC 多數瀏覽器畫不出來、
 * 影片只畫一格圖示（`<video>` 逐支載 metadata 一次幾十支會卡），兩種都退回檔名。
 */
export default function UploadPickModal({ files, onCancel, onConfirm }: Props) {
  const [marked, setMarked] = useState<Set<number>>(new Set());
  const [broken, setBroken] = useState<Set<number>>(new Set());

  const urls = useMemo(
    () => (files ?? []).map((f) => (isVideoFile(f) ? null : URL.createObjectURL(f))),
    [files],
  );
  useEffect(() => () => urls.forEach((u) => u && URL.revokeObjectURL(u)), [urls]);
  useEffect(() => { setMarked(new Set()); setBroken(new Set()); }, [files]);

  if (!files) return null;

  const toggle = (i: number) => setMarked((prev) => {
    const next = new Set(prev);
    if (next.has(i)) next.delete(i); else next.add(i);
    return next;
  });
  const allMarked = marked.size === files.length;
  const setAll = () => setMarked(allMarked ? new Set() : new Set(files.map((_, i) => i)));

  return (
    <div
      onClick={onCancel}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,.5)', zIndex: 4000,
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: '#fff', borderRadius: 14, width: '100%', maxWidth: 640,
          maxHeight: '88vh', display: 'flex', flexDirection: 'column', padding: 20, color: '#0f172a',
        }}
      >
        <h3 style={{ margin: '0 0 4px', fontSize: 18 }}>準備上傳 {files.length} 個檔案</h3>
        <p style={{ margin: '0 0 12px', fontSize: 13, color: '#64748b', lineHeight: 1.6 }}>
          點一下縮圖可標成「不開放」：只有可管理全站內容的人看得到，其他成員與訪客看不到；
          這些檔案也不會出現在「有人上傳了」的通知裡。不標就照一般方式上傳。
        </p>

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
          <span style={{ fontSize: 13, color: '#334155' }}>
            已標記 <strong>{marked.size}</strong> 個不開放
          </span>
          <button
            onClick={setAll}
            style={{
              padding: '5px 12px', borderRadius: 8, border: '1px solid #cbd5e1',
              background: '#fff', cursor: 'pointer', fontSize: 13,
            }}
          >
            {allMarked ? '全部取消' : '全部標為不開放'}
          </button>
        </div>

        <div
          style={{
            flex: 1, overflowY: 'auto', display: 'grid', gap: 8,
            gridTemplateColumns: 'repeat(auto-fill, minmax(96px, 1fr))', marginBottom: 14,
          }}
        >
          {files.map((f, i) => {
            const on = marked.has(i);
            const url = urls[i];
            return (
              <button
                key={i}
                onClick={() => toggle(i)}
                title={f.name}
                style={{
                  position: 'relative', aspectRatio: '1', padding: 0, borderRadius: 8, overflow: 'hidden',
                  border: on ? '3px solid #f59e0b' : '1px solid #e2e8f0', background: '#0f172a', cursor: 'pointer',
                }}
              >
                {url && !broken.has(i) ? (
                  <img
                    src={url}
                    alt=""
                    onError={() => setBroken((prev) => new Set(prev).add(i))}
                    style={{
                      width: '100%', height: '100%', objectFit: 'cover', display: 'block',
                      filter: on ? 'blur(6px) brightness(.7)' : 'none', transform: on ? 'scale(1.1)' : 'none',
                    }}
                  />
                ) : (
                  <span
                    style={{
                      position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column',
                      alignItems: 'center', justifyContent: 'center', gap: 4, padding: 6,
                      color: '#cbd5e1', fontSize: 11, wordBreak: 'break-all', lineHeight: 1.3,
                    }}
                  >
                    <span style={{ fontSize: 22 }}>{isVideoFile(f) ? '🎬' : '🖼'}</span>
                    {f.name}
                  </span>
                )}
                <span
                  style={{
                    position: 'absolute', top: 4, left: 4, padding: '2px 6px', borderRadius: 999, fontSize: 11,
                    background: on ? '#f59e0b' : 'rgba(15,23,42,.55)', color: '#fff',
                  }}
                >
                  {on ? '🔒 不開放' : '🔓'}
                </span>
              </button>
            );
          })}
        </div>

        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button
            onClick={onCancel}
            style={{
              padding: '9px 18px', borderRadius: 8, border: '1px solid #cbd5e1',
              background: '#fff', cursor: 'pointer', fontSize: 14,
            }}
          >
            取消
          </button>
          <button
            onClick={() => onConfirm(files.map((_, i) => marked.has(i)))}
            style={{
              padding: '9px 18px', borderRadius: 8, border: 'none',
              background: '#2563eb', color: '#fff', cursor: 'pointer', fontSize: 14,
            }}
          >
            開始上傳
          </button>
        </div>
      </div>
    </div>
  );
}
