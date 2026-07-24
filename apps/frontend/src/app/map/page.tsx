'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import dynamic from 'next/dynamic';
import {
  fetchFootprint, fetchAlbums, fetchTripSegments, deleteTripSegment,
  applyTripSegments, interpolateGeo, setAlbumMapPrivacy,
  type FootprintPoint, type Album, type TripSegment,
} from '@/lib/api';

// maplibre 需要 window，不能在伺服器端渲染
const FootprintMap = dynamic(() => import('@/components/FootprintMap'), {
  ssr: false,
  loading: () => <div style={{ height: 520, display: 'grid', placeItems: 'center', color: '#64748b' }}>地圖載入中…</div>,
});

export default function MapPage() {
  const [points, setPoints] = useState<FootprintPoint[]>([]);
  const [albums, setAlbums] = useState<Album[]>([]);
  const [segments, setSegments] = useState<TripSegment[]>([]);
  const [isAdmin, setIsAdmin] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [albumId, setAlbumId] = useState<number | ''>('');

  const load = useCallback(async () => {
    setLoading(true);
    const data = await fetchFootprint({
      from: from || undefined,
      // 結束日要含當天整日，否則 '2026-03-05 14:00' 會大於 '2026-03-05' 而被濾掉
      to: to ? `${to} 23:59:59` : undefined,
      albumId: albumId === '' ? undefined : albumId,
    });
    setPoints(data);
    setLoading(false);
  }, [from, to, albumId]);

  useEffect(() => {
    setIsAdmin(typeof window !== 'undefined' && !!localStorage.getItem('admin_token'));
    fetchAlbums().then(setAlbums);
  }, []);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (isAdmin) fetchTripSegments(albumId === '' ? undefined : albumId).then(setSegments);
  }, [isAdmin, albumId]);

  const runTool = async (name: string, fn: () => Promise<number>) => {
    setBusy(name);
    const n = await fn();
    setBusy(null);
    alert(`${name}：更新了 ${n} 張照片`);
    load();
  };

  const currentAlbum = albums.find(a => a.id === albumId);

  return (
    <div style={{ maxWidth: 1100, margin: '0 auto', padding: '24px 16px 60px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 18, flexWrap: 'wrap' }}>
        <Link href="/" style={{ fontSize: 14, color: '#2563eb', textDecoration: 'none' }}>← 回相簿</Link>
        <h1 style={{ fontSize: 24, margin: 0 }}>足跡地圖</h1>
      </div>

      <div style={{
        display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end',
        marginBottom: 16, padding: 14, background: '#f8fafc', borderRadius: 10,
      }}>
        <label style={{ fontSize: 13 }}>
          <div style={{ marginBottom: 4, color: '#475569' }}>開始日期</div>
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)}
            style={{ padding: '7px 10px', borderRadius: 7, border: '1px solid #cbd5e1' }} />
        </label>
        <label style={{ fontSize: 13 }}>
          <div style={{ marginBottom: 4, color: '#475569' }}>結束日期</div>
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)}
            style={{ padding: '7px 10px', borderRadius: 7, border: '1px solid #cbd5e1' }} />
        </label>
        <label style={{ fontSize: 13 }}>
          <div style={{ marginBottom: 4, color: '#475569' }}>相簿</div>
          <select
            value={albumId}
            onChange={(e) => setAlbumId(e.target.value === '' ? '' : Number(e.target.value))}
            style={{ padding: '7px 10px', borderRadius: 7, border: '1px solid #cbd5e1', minWidth: 150 }}
          >
            <option value="">全部相簿</option>
            {albums.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </label>
        {(from || to || albumId !== '') && (
          <button
            onClick={() => { setFrom(''); setTo(''); setAlbumId(''); }}
            style={{ padding: '8px 14px', borderRadius: 7, border: '1px solid #cbd5e1', background: '#fff', cursor: 'pointer', fontSize: 13 }}
          >
            清除篩選
          </button>
        )}
        <div style={{ marginLeft: 'auto', fontSize: 13, color: '#64748b' }}>
          {loading ? '載入中…' : `${points.length} 個足跡點`}
        </div>
      </div>

      <FootprintMap points={points} />

      <div style={{ marginTop: 10, fontSize: 12.5, color: '#64748b', display: 'flex', gap: 16, flexWrap: 'wrap' }}>
        <span>● 實心 = 照片自帶 GPS</span>
        <span>◍ 半透明 = 由前後照片推估</span>
        <span>○ 空心 = 手動指定</span>
      </div>

      {isAdmin && (
        <div style={{ marginTop: 30 }}>
          <h2 style={{ fontSize: 18, marginBottom: 12 }}>管理工具</h2>

          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 20 }}>
            <button
              disabled={!!busy}
              onClick={() => runTool('套用行程段', () => applyTripSegments(albumId === '' ? undefined : albumId))}
              style={toolBtn}
            >
              {busy === '套用行程段' ? '處理中…' : '套用行程段到未定位照片'}
            </button>
            <button
              disabled={!!busy}
              onClick={() => runTool('內插補點', () => interpolateGeo(albumId === '' ? undefined : albumId))}
              style={toolBtn}
            >
              {busy === '內插補點' ? '處理中…' : '對有 GPS 的照片之間內插補點'}
            </button>
          </div>

          {currentAlbum && (
            <div style={{
              padding: 14, background: '#f8fafc', borderRadius: 10, marginBottom: 20, fontSize: 13.5,
            }}>
              <label style={{ display: 'flex', gap: 10, alignItems: 'flex-start', cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={Number(currentAlbum.map_private ?? 1) === 0}
                  onChange={async (e) => {
                    const ok = await setAlbumMapPrivacy(currentAlbum.id, !e.target.checked);
                    if (ok) fetchAlbums().then(setAlbums);
                  }}
                  style={{ marginTop: 3 }}
                />
                <span>
                  公開「{currentAlbum.name}」的足跡地圖
                  <span style={{ display: 'block', color: '#64748b', fontSize: 12.5 }}>
                    預設為私密。即使開啟，個別標記為私密的照片仍不會出現在地圖上。
                  </span>
                </span>
              </label>
            </div>
          )}

          <h3 style={{ fontSize: 15, marginBottom: 8 }}>行程段（{segments.length}）</h3>
          {segments.length === 0 ? (
            <p style={{ fontSize: 13.5, color: '#64748b' }}>
              還沒有行程段。到相簿中選取照片後按「指定地點」，並勾選「同時建立行程段」即可建立。
            </p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {segments.map(s => (
                <div key={s.id} style={{
                  display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px',
                  border: '1px solid #e2e8f0', borderRadius: 9, fontSize: 13.5, flexWrap: 'wrap',
                }}>
                  <strong style={{ minWidth: 110 }}>{s.label}</strong>
                  <span style={{ color: '#64748b' }}>{s.start_local} ~ {s.end_local}</span>
                  <span style={{ color: '#94a3b8', fontSize: 12 }}>
                    {s.lat.toFixed(4)}, {s.lng.toFixed(4)}
                  </span>
                  <button
                    onClick={async () => {
                      if (!confirm(`刪除行程段「${s.label}」？已套用到照片上的地點不會被移除。`)) return;
                      if (await deleteTripSegment(s.id)) {
                        setSegments(prev => prev.filter(x => x.id !== s.id));
                      }
                    }}
                    style={{
                      marginLeft: 'auto', padding: '5px 12px', borderRadius: 6,
                      border: '1px solid #fecaca', background: '#fff', color: '#dc2626',
                      cursor: 'pointer', fontSize: 12.5,
                    }}
                  >
                    刪除
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const toolBtn: React.CSSProperties = {
  padding: '9px 16px', borderRadius: 8, border: '1px solid #cbd5e1',
  background: '#fff', cursor: 'pointer', fontSize: 13.5,
};
