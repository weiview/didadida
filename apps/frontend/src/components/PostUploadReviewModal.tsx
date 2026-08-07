'use client';

import { useEffect, useMemo, useState } from 'react';
import { photoThumbSrc, type Photo } from '@/lib/api';

interface Props {
  isOpen: boolean;
  /** 這一批剛上傳的照片，順序即上傳順序 */
  photos: Photo[];
  onClose: () => void;
  onAssignPlace: (photoIds: number[]) => void;
  onFixTime: (photoIds: number[]) => void;
}

const hasGeo = (p: Photo) => typeof p.lat === 'number' && typeof p.lng === 'number';

/**
 * 上傳結束後的補件關卡。只在這批裡有照片缺座標時才會被開啟。
 * 這裡不自己實作任何寫入 —— 挑完照片就把 id 交回相簿頁，
 * 由既有的 AssignPlaceModal / FixTimeModal 接手，行為與相簿頁的批次操作完全一致。
 */
export default function PostUploadReviewModal({
  isOpen, photos, onClose, onAssignPlace, onFixTime,
}: Props) {
  const [selected, setSelected] = useState<number[]>([]);

  const missingGeoIds = useMemo(
    () => photos.filter((p) => !hasGeo(p)).map((p) => p.id),
    [photos],
  );

  // 預設只勾缺座標的那些 —— 相機自帶 GPS 的照片本來就不需要補
  useEffect(() => {
    if (!isOpen) return;
    setSelected(missingGeoIds);
  }, [isOpen, missingGeoIds]);

  if (!isOpen) return null;

  const toggle = (id: number) => {
    setSelected((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  };

  const allSelected = photos.length > 0 && selected.length === photos.length;
  const toggleAll = () => setSelected(allSelected ? [] : photos.map((p) => p.id));

  const canAct = selected.length > 0;

  const actionBtn = (enabled: boolean, primary: boolean) => ({
    padding: '9px 18px',
    borderRadius: 8,
    border: primary ? 'none' : '1px solid #cbd5e1',
    background: primary ? (enabled ? '#2563eb' : '#cbd5e1') : '#fff',
    color: primary ? '#fff' : '#334155',
    cursor: enabled ? 'pointer' : 'not-allowed',
    fontSize: 14,
    opacity: enabled ? 1 : 0.7,
  } as const);

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,.5)', zIndex: 1000,
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: '#fff', borderRadius: 14, width: '100%', maxWidth: 640,
          maxHeight: '88vh', overflowY: 'auto', padding: 22, color: '#0f172a',
        }}
      >
        <h3 style={{ margin: '0 0 4px', fontSize: 18 }}>剛上傳的照片</h3>
        <p style={{ margin: '0 0 14px', fontSize: 13, color: '#64748b', lineHeight: 1.7 }}>
          這批共 {photos.length} 張，其中 <strong>{missingGeoIds.length} 張沒有位置</strong>（已預先勾選）。
          可以現在就一次補上地點或修正時間，之後也能隨時在相簿頁重選照片再改。
        </p>

        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          marginBottom: 10, fontSize: 13.5,
        }}>
          <span style={{ color: '#475569' }}>已選取 {selected.length} 張</span>
          <button
            onClick={toggleAll}
            style={{
              padding: '5px 12px', borderRadius: 7, border: '1px solid #cbd5e1',
              background: '#fff', cursor: 'pointer', fontSize: 13,
            }}
          >
            {allSelected ? '全部取消' : '全選'}
          </button>
        </div>

        <div style={{
          display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(96px, 1fr))',
          gap: 8, marginBottom: 18,
        }}>
          {photos.map((p) => {
            const isSel = selected.includes(p.id);
            const geo = hasGeo(p);
            return (
              <button
                key={p.id}
                onClick={() => toggle(p.id)}
                title={p.title}
                style={{
                  position: 'relative', padding: 0, border: isSel ? '2px solid #2563eb' : '2px solid transparent',
                  borderRadius: 10, overflow: 'hidden', cursor: 'pointer', background: '#f1f5f9',
                  aspectRatio: '1 / 1', display: 'block',
                }}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={photoThumbSrc(p, 'sm')}
                  alt={p.title}
                  style={{
                    width: '100%', height: '100%', objectFit: 'cover',
                    opacity: isSel ? 1 : 0.55, display: 'block',
                  }}
                />
                <span style={{
                  position: 'absolute', top: 5, left: 5, width: 18, height: 18,
                  borderRadius: 5, background: isSel ? '#2563eb' : 'rgba(255,255,255,.85)',
                  border: '1px solid rgba(0,0,0,.15)', color: '#fff',
                  fontSize: 12, lineHeight: '17px', textAlign: 'center',
                }}>
                  {isSel ? '✓' : ''}
                </span>
                {/* 已經有 EXIF 座標的用角標標出來，避免使用者誤以為每張都要補 */}
                {geo && (
                  <span style={{
                    position: 'absolute', bottom: 4, right: 4, padding: '1px 5px',
                    borderRadius: 5, background: 'rgba(16,185,129,.92)', color: '#fff',
                    fontSize: 10.5, letterSpacing: .3,
                  }}>
                    已有位置
                  </span>
                )}
              </button>
            );
          })}
        </div>

        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
          <button onClick={onClose} style={actionBtn(true, false)}>稍後再說</button>
          <button
            onClick={() => canAct && onFixTime(selected)}
            disabled={!canAct}
            style={actionBtn(canAct, false)}
          >
            修正時間
          </button>
          <button
            onClick={() => canAct && onAssignPlace(selected)}
            disabled={!canAct}
            style={actionBtn(canAct, true)}
          >
            指定地點
          </button>
        </div>
      </div>
    </div>
  );
}
