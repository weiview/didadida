'use client';

import { useCallback, useMemo, useState } from 'react';
import {
  parseTimeline, matchPhotosToTimeline,
  type TimelineSample, type MatchResult,
} from '@/lib/googleTimeline';
import { fetchAllPhotos, applyTimelineMatches, type Photo } from '@/lib/api';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  onDone: (updated: number) => void;
}

/** ISO → 牆上時間字串；舊照片沒有 taken_at_local 時用它退化 */
function toLocalString(p: Photo): string | null {
  if (p.taken_at_local) return p.taken_at_local;
  if (p.taken_at) return p.taken_at.slice(0, 19).replace('T', ' ');
  return null;
}

const fmtRange = (samples: TimelineSample[]) => {
  if (samples.length === 0) return '';
  const a = new Date(samples[0].utcMs).toISOString().slice(0, 10);
  const b = new Date(samples[samples.length - 1].utcMs).toISOString().slice(0, 10);
  return `${a} ~ ${b}`;
};

export default function TimelineImportModal({ isOpen, onClose, onDone }: Props) {
  const [parsing, setParsing] = useState(false);
  const [samples, setSamples] = useState<TimelineSample[]>([]);
  const [format, setFormat] = useState<string>('');
  const [skipped, setSkipped] = useState<string[]>([]);
  const [fileName, setFileName] = useState('');
  const [error, setError] = useState('');

  const [photos, setPhotos] = useState<Photo[]>([]);
  const [tolerance, setTolerance] = useState(30);
  const [fallbackOffset, setFallbackOffset] = useState(480); // 台灣 UTC+8
  const [onlyMissing, setOnlyMissing] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<string>('');

  const handleFile = useCallback(async (file: File) => {
    setParsing(true); setError(''); setResult('');
    setFileName(file.name);
    try {
      const text = await file.text();
      const json = JSON.parse(text);
      const parsed = parseTimeline(json);
      if (parsed.samples.length === 0) {
        setError('這個檔案裡找不到任何位置資料。請確認匯出的是 Timeline.json（手機版）或舊版的 Records.json。');
        setSamples([]);
      } else {
        setSamples(parsed.samples);
        setFormat(parsed.format);
        setSkipped(parsed.skipped);
        if (photos.length === 0) setPhotos(await fetchAllPhotos());
      }
    } catch (e: any) {
      setError(`解析失敗：${e?.message || e}`);
      setSamples([]);
    } finally {
      setParsing(false);
    }
  }, [photos.length]);

  // 候選照片與比對結果都是純計算，參數一改就即時重算
  const candidates = useMemo(() => {
    const list = onlyMissing ? photos.filter((p) => p.lat === null || p.lat === undefined) : photos;
    return list
      .map((p) => ({ id: p.id, localTime: toLocalString(p) }))
      .filter((p): p is { id: number; localTime: string } => !!p.localTime);
  }, [photos, onlyMissing]);

  const matches: MatchResult[] = useMemo(
    () => (samples.length === 0 ? [] : matchPhotosToTimeline(candidates, samples, {
      toleranceMinutes: tolerance,
      fallbackOffsetMinutes: fallbackOffset,
    })),
    [candidates, samples, tolerance, fallbackOffset],
  );

  const buckets = useMemo(() => {
    const b = { exact: 0, near: 0, loose: 0 };
    for (const m of matches) {
      if (m.gapMinutes <= 2) b.exact++;
      else if (m.gapMinutes <= 10) b.near++;
      else b.loose++;
    }
    return b;
  }, [matches]);

  const handleApply = useCallback(async () => {
    setSubmitting(true);
    const res = await applyTimelineMatches(matches);
    setSubmitting(false);
    if (res) {
      setResult(`已為 ${res.updated} 張照片寫入位置` + (res.skipped > 0 ? `，${res.skipped} 張因已有 GPS 而跳過` : ''));
      onDone(res.updated);
    } else {
      setError('寫入失敗，請確認仍在登入狀態。');
    }
  }, [matches, onDone]);

  if (!isOpen) return null;

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
          background: '#fff', borderRadius: 14, width: '100%', maxWidth: 560,
          maxHeight: '88vh', overflowY: 'auto', padding: 22, color: '#0f172a',
        }}
      >
        <h3 style={{ margin: '0 0 6px', fontSize: 18 }}>從 Google 時間軸匯入位置</h3>
        <p style={{ fontSize: 13, color: '#64748b', margin: '0 0 16px', lineHeight: 1.7 }}>
          手機的 Google Maps → 你的時間軸 → 設定 → 匯出時間軸資料，會得到 Timeline.json。
          <strong style={{ color: '#0f172a' }}>檔案只在你的瀏覽器裡解析，不會上傳</strong>，
          只有比對出來的座標會寫進資料庫。
        </p>

        <label style={{
          display: 'block', border: '2px dashed #cbd5e1', borderRadius: 10,
          padding: 18, textAlign: 'center', cursor: 'pointer', marginBottom: 14,
        }}>
          <input
            type="file"
            accept="application/json,.json"
            style={{ display: 'none' }}
            onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); }}
          />
          <span style={{ fontSize: 14, color: '#2563eb' }}>
            {fileName || '選擇 Timeline.json'}
          </span>
        </label>

        {parsing && <p style={{ fontSize: 13.5, color: '#64748b' }}>解析中…（檔案較大時需要幾秒）</p>}

        {error && (
          <div style={{
            background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 9,
            padding: '10px 13px', fontSize: 13.5, color: '#b91c1c', marginBottom: 14,
          }}>
            {error}
          </div>
        )}

        {samples.length > 0 && (
          <>
            <div style={{
              background: '#f8fafc', borderRadius: 10, padding: '12px 14px',
              fontSize: 13.5, lineHeight: 1.8, marginBottom: 14,
            }}>
              <div>格式：<strong>{format === 'phone' ? '手機版匯出' : format === 'records' ? '舊版 Records.json' : '舊版語意月檔'}</strong></div>
              <div>位置取樣點：<strong>{samples.length.toLocaleString()}</strong> 筆</div>
              <div>時間範圍：{fmtRange(samples)}</div>
              {skipped.map((s, i) => (
                <div key={i} style={{ color: '#64748b', fontSize: 12.5 }}>· {s}</div>
              ))}
            </div>

            <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginBottom: 14 }}>
              <label style={{ fontSize: 13 }}>
                <div style={{ marginBottom: 4, color: '#475569' }}>容許時間差</div>
                <select
                  value={tolerance}
                  onChange={(e) => setTolerance(Number(e.target.value))}
                  style={{ padding: '6px 9px', borderRadius: 7, border: '1px solid #cbd5e1' }}
                >
                  <option value={5}>5 分鐘（最嚴格）</option>
                  <option value={30}>30 分鐘</option>
                  <option value={120}>2 小時</option>
                  <option value={720}>12 小時（最寬鬆）</option>
                </select>
              </label>
              <label style={{ fontSize: 13 }}>
                <div style={{ marginBottom: 4, color: '#475569' }}>預設時區</div>
                <select
                  value={fallbackOffset}
                  onChange={(e) => setFallbackOffset(Number(e.target.value))}
                  style={{ padding: '6px 9px', borderRadius: 7, border: '1px solid #cbd5e1' }}
                >
                  <option value={480}>UTC+8（台灣）</option>
                  <option value={540}>UTC+9（日本）</option>
                  <option value={0}>UTC+0</option>
                  <option value={-300}>UTC-5</option>
                  <option value={-480}>UTC-8</option>
                </select>
              </label>
            </div>
            <p style={{ fontSize: 12.5, color: '#64748b', margin: '-6px 0 14px', lineHeight: 1.6 }}>
              預設時區只在時間軸記錄本身沒帶時區時才會用到；手機版匯出通常每筆都自帶，用不上。
            </p>

            <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 13.5, marginBottom: 14, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={onlyMissing}
                onChange={(e) => setOnlyMissing(e.target.checked)}
                style={{ marginTop: 3 }}
              />
              <span>
                只處理還沒有座標的照片
                <span style={{ display: 'block', color: '#64748b', fontSize: 12.5 }}>
                  取消勾選會連已用行程段或內插定位過的照片一起重算（照片自帶的 GPS 一律不覆蓋）
                </span>
              </span>
            </label>

            <div style={{
              background: matches.length > 0 ? '#eff6ff' : '#fffbeb',
              border: `1px solid ${matches.length > 0 ? '#bfdbfe' : '#fcd34d'}`,
              borderRadius: 10, padding: '12px 14px', fontSize: 13.5, lineHeight: 1.8, marginBottom: 16,
            }}>
              <div>候選照片 <strong>{candidates.length}</strong> 張，比對成功 <strong>{matches.length}</strong> 張</div>
              {matches.length > 0 && (
                <div style={{ color: '#475569', fontSize: 12.5 }}>
                  時間差 2 分鐘內：{buckets.exact} ／ 10 分鐘內：{buckets.near} ／ 更久：{buckets.loose}
                </div>
              )}
              {matches.length === 0 && candidates.length > 0 && (
                <div style={{ color: '#78350f', fontSize: 12.5 }}>
                  照片的拍攝時間都不在時間軸的涵蓋範圍內。可以試著放寬容許時間差，或確認匯出的時間軸有涵蓋到這些照片的日期。
                </div>
              )}
            </div>

            {result && (
              <div style={{
                background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 9,
                padding: '10px 13px', fontSize: 13.5, color: '#166534', marginBottom: 14,
              }}>
                {result}
              </div>
            )}
          </>
        )}

        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button
            onClick={onClose}
            style={{
              padding: '9px 18px', borderRadius: 8, border: '1px solid #cbd5e1',
              background: '#fff', cursor: 'pointer', fontSize: 14,
            }}
          >
            關閉
          </button>
          <button
            onClick={handleApply}
            disabled={matches.length === 0 || submitting}
            style={{
              padding: '9px 18px', borderRadius: 8, border: 'none',
              background: matches.length > 0 ? '#2563eb' : '#cbd5e1', color: '#fff',
              cursor: matches.length > 0 && !submitting ? 'pointer' : 'not-allowed', fontSize: 14,
            }}
          >
            {submitting ? '寫入中…' : `寫入 ${matches.length} 張照片的位置`}
          </button>
        </div>
      </div>
    </div>
  );
}
