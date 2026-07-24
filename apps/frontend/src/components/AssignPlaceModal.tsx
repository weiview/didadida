'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  previewGeoBatch, assignGeoBatch, searchPlace,
  type GeoPreview,
} from '@/lib/api';

interface Props {
  isOpen: boolean;
  photoIds: number[];
  albumId?: number;
  onClose: () => void;
  onDone: (result: { updated: number; skippedExif: number }) => void;
}

interface PlaceHit { name: string; lat: number; lng: number; }

export default function AssignPlaceModal({ isOpen, photoIds, albumId, onClose, onDone }: Props) {
  const [preview, setPreview] = useState<GeoPreview | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(false);

  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<PlaceHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [place, setPlace] = useState<PlaceHit | null>(null);

  const [createSegment, setCreateSegment] = useState(true);
  const [includeAlsoInRange, setIncludeAlsoInRange] = useState(false);
  const [overwriteExif, setOverwriteExif] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    setPreview(null);
    setQuery(''); setHits([]); setPlace(null);
    setCreateSegment(true); setIncludeAlsoInRange(false); setOverwriteExif(false);

    setLoadingPreview(true);
    previewGeoBatch(photoIds)
      .then(setPreview)
      .finally(() => setLoadingPreview(false));
  }, [isOpen, photoIds]);

  // 地名搜尋做防抖，避免每打一個字就打一次外部 API
  useEffect(() => {
    if (searchTimer.current) clearTimeout(searchTimer.current);
    if (!query.trim()) { setHits([]); return; }
    searchTimer.current = setTimeout(() => {
      setSearching(true);
      searchPlace(query).then(setHits).finally(() => setSearching(false));
    }, 400);
    return () => { if (searchTimer.current) clearTimeout(searchTimer.current); };
  }, [query]);

  const handleSubmit = useCallback(async () => {
    if (!place) return;
    setSubmitting(true);
    const ids = includeAlsoInRange && preview
      ? Array.from(new Set([...photoIds, ...preview.alsoInRange.map(p => p.id)]))
      : photoIds;

    const res = await assignGeoBatch({
      photoIds: ids,
      lat: place.lat,
      lng: place.lng,
      placeName: place.name,
      label: place.name,
      createSegment,
      albumId,
      overwriteExif,
    });
    setSubmitting(false);
    if (res) {
      onDone({ updated: res.updated, skippedExif: res.skippedExif });
      onClose();
    }
  }, [place, includeAlsoInRange, preview, photoIds, createSegment, albumId, overwriteExif, onDone, onClose]);

  if (!isOpen) return null;

  const hasRangeWarning = !!preview && preview.alsoInRange.length > 0;
  const noTimeRange = !!preview && (!preview.startLocal || !preview.endLocal);

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
          background: '#fff', borderRadius: 14, width: '100%', maxWidth: 520,
          maxHeight: '88vh', overflowY: 'auto', padding: 22, color: '#0f172a',
        }}
      >
        <h3 style={{ margin: '0 0 14px', fontSize: 18 }}>指定地點</h3>

        {loadingPreview && <p style={{ fontSize: 14, color: '#64748b' }}>正在計算時間範圍…</p>}

        {preview && (
          <div style={{
            background: '#f8fafc', borderRadius: 10, padding: '12px 14px',
            fontSize: 13.5, lineHeight: 1.8, marginBottom: 14,
          }}>
            <div>已選取 <strong>{preview.selectedCount}</strong> 張</div>
            {preview.startLocal && preview.endLocal ? (
              <div>時間範圍：{preview.startLocal} ~ {preview.endLocal}</div>
            ) : (
              <div style={{ color: '#b45309' }}>選取的照片沒有拍攝時間，無法建立時間區段</div>
            )}
            {preview.missingTimeCount > 0 && (
              <div style={{ color: '#b45309' }}>
                其中 {preview.missingTimeCount} 張缺少拍攝時間，不會納入區段
              </div>
            )}
            {preview.existingExifCount > 0 && (
              <div style={{ color: '#b45309' }}>
                其中 {preview.existingExifCount} 張已有 GPS 座標
              </div>
            )}
          </div>
        )}

        {/* 顯示順序與時間順序不一致時，選取範圍會意外涵蓋其他照片 —— 攤開來讓使用者決定 */}
        {hasRangeWarning && (
          <div style={{
            background: '#fffbeb', border: '1px solid #fcd34d', borderRadius: 10,
            padding: '12px 14px', fontSize: 13.5, lineHeight: 1.7, marginBottom: 14,
          }}>
            <div style={{ fontWeight: 600, marginBottom: 6 }}>
              另有 {preview!.alsoInRange.length} 張照片也落在此時間範圍內，但未被選取
            </div>
            <div style={{ color: '#78350f', marginBottom: 8 }}>
              相簿的顯示順序不一定等於拍攝時間順序，若曾手動排序過就會出現這種情況。
            </div>
            <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={includeAlsoInRange}
                onChange={(e) => setIncludeAlsoInRange(e.target.checked)}
                style={{ marginTop: 3 }}
              />
              <span>連同這 {preview!.alsoInRange.length} 張一起套用</span>
            </label>
          </div>
        )}

        <label style={{ display: 'block', fontSize: 13.5, marginBottom: 6, fontWeight: 600 }}>
          搜尋地點
        </label>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="例如：難波、清水寺、台北101"
          style={{
            width: '100%', padding: '9px 12px', borderRadius: 8,
            border: '1px solid #cbd5e1', fontSize: 14, marginBottom: 8,
          }}
        />
        {searching && <p style={{ fontSize: 13, color: '#64748b', margin: '4px 0' }}>搜尋中…</p>}

        {hits.length > 0 && (
          <div style={{ border: '1px solid #e2e8f0', borderRadius: 8, marginBottom: 12, overflow: 'hidden' }}>
            {hits.map((h, i) => (
              <button
                key={`${h.lat},${h.lng},${i}`}
                onClick={() => { setPlace(h); setHits([]); setQuery(h.name); }}
                style={{
                  display: 'block', width: '100%', textAlign: 'left', padding: '9px 12px',
                  border: 'none', borderTop: i === 0 ? 'none' : '1px solid #f1f5f9',
                  background: '#fff', cursor: 'pointer', fontSize: 13.5,
                }}
              >
                {h.name}
                <span style={{ color: '#94a3b8', fontSize: 12 }}>
                  {'  '}{h.lat.toFixed(4)}, {h.lng.toFixed(4)}
                </span>
              </button>
            ))}
          </div>
        )}

        {place && (
          <div style={{
            background: '#eff6ff', borderRadius: 8, padding: '10px 12px',
            fontSize: 13.5, marginBottom: 14,
          }}>
            已選地點：<strong>{place.name}</strong>
            <span style={{ color: '#64748b' }}>（{place.lat.toFixed(4)}, {place.lng.toFixed(4)}）</span>
          </div>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 18, fontSize: 13.5 }}>
          <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', cursor: noTimeRange ? 'not-allowed' : 'pointer', opacity: noTimeRange ? 0.5 : 1 }}>
            <input
              type="checkbox"
              checked={createSegment && !noTimeRange}
              disabled={noTimeRange}
              onChange={(e) => setCreateSegment(e.target.checked)}
              style={{ marginTop: 3 }}
            />
            <span>
              同時建立行程段
              <span style={{ color: '#64748b', display: 'block', fontSize: 12.5 }}>
                之後加進來的照片，只要落在這個時間範圍就會自動套用同一地點
              </span>
            </span>
          </label>

          {preview && preview.existingExifCount > 0 && (
            <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={overwriteExif}
                onChange={(e) => setOverwriteExif(e.target.checked)}
                style={{ marginTop: 3 }}
              />
              <span>
                覆蓋已有 GPS 的照片
                <span style={{ color: '#64748b', display: 'block', fontSize: 12.5 }}>
                  預設不覆蓋 —— 照片自帶的 GPS 比手動指定精確
                </span>
              </span>
            </label>
          )}
        </div>

        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button
            onClick={onClose}
            style={{
              padding: '9px 18px', borderRadius: 8, border: '1px solid #cbd5e1',
              background: '#fff', cursor: 'pointer', fontSize: 14,
            }}
          >
            取消
          </button>
          <button
            onClick={handleSubmit}
            disabled={!place || submitting}
            style={{
              padding: '9px 18px', borderRadius: 8, border: 'none',
              background: place ? '#2563eb' : '#cbd5e1', color: '#fff',
              cursor: place && !submitting ? 'pointer' : 'not-allowed', fontSize: 14,
            }}
          >
            {submitting ? '套用中…' : '套用地點'}
          </button>
        </div>
      </div>
    </div>
  );
}
