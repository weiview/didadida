'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  parseTimeline, matchPhotosToTimeline,
  type TimelineSample, type MatchResult,
} from '@/lib/googleTimeline';
import { extractTrackMonths, type ExtractResult } from '@/lib/timelineTrack';
import {
  fetchGeoPendingPhotos, applyTimelineMatches, saveTimelineMonth, saveTimelineIndex,
  type Photo,
} from '@/lib/api';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  onDone: (updated: number) => void;
  /** 足跡圖層上傳完成。頁面據此重載索引，不用整頁刷新 */
  onTrackUploaded?: () => void;
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

export default function TimelineImportModal({ isOpen, onClose, onDone, onTrackUploaded }: Props) {
  const [parsing, setParsing] = useState(false);
  const [samples, setSamples] = useState<TimelineSample[]>([]);
  const [format, setFormat] = useState<string>('');
  const [skipped, setSkipped] = useState<string[]>([]);
  const [fileName, setFileName] = useState('');
  const [error, setError] = useState('');

  const [photos, setPhotos] = useState<Photo[]>([]);
  /*
   * 比對容差預設 5 分鐘。
   *
   * 本來是 30 —— 那代表一筆差了 28 分鐘的命中，跟差 1 分鐘的命中在寫入時
   * 權重完全一樣，足以把使用者親手圈的行程段靜默改寫成「那天早上的另一個地點」。
   * 5 分鐘之內的位置通常還在同一個地點，超過就是移動中的猜測。
   * 要放寬還是可以自己拉滑桿，而且超過 10 分鐘的命中後端會自動降級（見 api.ts）。
   */
  const [tolerance, setTolerance] = useState(5);
  const [fallbackOffset, setFallbackOffset] = useState(480); // 台灣 UTC+8
  const [onlyMissing, setOnlyMissing] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<string>('');

  // 足跡圖層（紀念層）。跟上面的照片比對共用同一次選檔，但兩件事完全獨立：
  // 可以只做其中一件，做完一件也不影響另一件
  const [track, setTrack] = useState<ExtractResult | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState('');
  const [trackResult, setTrackResult] = useState('');

  /*
   * 「只處理還沒有座標的照片」現在由後端過濾，所以這個開關一動就得重抓。
   *
   * 以前是一次把全站照片抓回來、在瀏覽器裡 filter，切換開關是零成本的；但那份
   * 請求會讓後端掃過整張 Photo 表並回傳每一個欄位。改成後端過濾之後，勾著的
   * 時候（預設）通常只剩幾百張要載。
   *
   * photosScope 記住手上這份是哪一種，免得每次 render 都以為要重抓。
   */
  const [photosScope, setPhotosScope] = useState<'missing' | 'all' | null>(null);
  const [loadingPhotos, setLoadingPhotos] = useState(false);
  // 慢的請求先回、快的後回時，setPhotos 會被舊資料蓋掉。記住最後一次的序號，
  // 只讓最新那次的結果寫進 state。
  const loadSeq = useRef(0);

  const loadPhotos = useCallback(async (onlyMissingNow: boolean) => {
    const seq = ++loadSeq.current;
    setLoadingPhotos(true);
    const fresh = await fetchGeoPendingPhotos(onlyMissingNow);
    if (seq !== loadSeq.current) return;
    setLoadingPhotos(false);
    // null 是「抓失敗」，空陣列才是「真的沒有待處理的照片」。抓失敗時留著舊快照
    // 並說清楚，不要讓畫面靜靜地變成一個假的「已完成」。
    if (fresh === null) {
      setError('讀取照片清單失敗，畫面上的數字可能不是最新的。請確認仍在登入狀態。');
      return;
    }
    setPhotos(fresh);
    setPhotosScope(onlyMissingNow ? 'missing' : 'all');
  }, []);

  // 已經載過一次之後才跟著開關重抓 —— 還沒選檔前抓了也沒有東西可以比對
  useEffect(() => {
    if (photosScope === null) return;
    const want = onlyMissing ? 'missing' : 'all';
    if (photosScope !== want) loadPhotos(onlyMissing);
  }, [onlyMissing, photosScope, loadPhotos]);

  const handleFile = useCallback(async (file: File) => {
    setParsing(true); setError(''); setResult(''); setTrackResult('');
    setFileName(file.name);
    try {
      const text = await file.text();
      const json = JSON.parse(text);
      const parsed = parseTimeline(json);
      // 足跡圖層走另一條解析路徑（只取移動取樣，不碰停留地點與行程起訖），
      // 趁 json 還在手上一起算完 —— 100MB 的檔案不想留在記憶體裡等第二次
      const extracted = extractTrackMonths(json);
      setTrack(extracted.points > 0 ? extracted : null);

      if (parsed.samples.length === 0) {
        setError('這個檔案裡找不到任何位置資料。請確認匯出的是 Timeline.json（手機版）或舊版的 Records.json。');
        setSamples([]);
      } else {
        setSamples(parsed.samples);
        setFormat(parsed.format);
        setSkipped(parsed.skipped);
        if (photosScope === null) await loadPhotos(onlyMissing);
      }
    } catch (e: any) {
      setError(`解析失敗：${e?.message || e}`);
      setSamples([]);
      setTrack(null);
    } finally {
      setParsing(false);
    }
  }, [photosScope, onlyMissing, loadPhotos]);

  /*
   * 逐月上傳，最後才寫索引。
   *
   * 索引放最後是刻意的：前端只讀索引裡有的月份，所以中途失敗的話
   * 舊索引還在，地圖看到的是上一次完整的資料，而不是半套。
   *
   * 不做增量比對 —— Google 每次匯出都是 2014 年到今天的全量 dump，
   * 找差異的成本比整包重寫還高，而重寫也才 144 個檔。
   */
  const handleUploadTrack = useCallback(async () => {
    if (!track) return;
    setUploading(true); setTrackResult(''); setError('');
    const failed: string[] = [];
    for (let i = 0; i < track.months.length; i++) {
      const m = track.months[i];
      setUploadProgress(`${m.monthKey}（${i + 1}/${track.months.length}）`);
      const ok = await saveTimelineMonth(m.monthKey, m.days);
      if (!ok) failed.push(m.monthKey);
    }
    setUploadProgress('寫入索引…');
    const indexOk = await saveTimelineIndex(
      track.months
        .filter((m) => !failed.includes(m.monthKey))
        .map((m) => ({ monthKey: m.monthKey, points: m.points, days: Object.keys(m.days).length })),
    );
    setUploading(false); setUploadProgress('');

    if (failed.length > 0) {
      setError(`有 ${failed.length} 個月份上傳失敗（${failed.slice(0, 3).join('、')}${failed.length > 3 ? '…' : ''}），索引只收錄了成功的部分。請確認仍在登入狀態後重試。`);
      return;
    }
    if (!indexOk) {
      setError('月份都上傳完了，但索引寫入失敗 —— 地圖上還看不到。請確認仍在登入狀態後重試。');
      return;
    }
    setTrackResult(`已上傳 ${track.months.length} 個月、${track.points.toLocaleString()} 個位置點`);
    onTrackUploaded?.();
  }, [track, onTrackUploaded]);

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
    if (res) {
      setResult(
        `已為 ${res.updated} 張照片寫入位置`
        + (res.skipped > 0 ? `，${res.skipped} 張因已有更可信的位置而跳過` : '')
        + (res.loose ? `（其中 ${res.loose} 筆差距超過 10 分鐘，只補了原本沒有座標的照片）` : ''),
      );
      onDone(res.updated);
      // 寫完一定要重抓：candidates／matches 都是從這份 photos 算出來的，
      // 不重抓的話面板會停在寫入前的快照 —— 綠色訊息說「已寫入 27 張」，
      // 上面卻還寫著「候選 30 張」、按鈕還邀請你再寫一次同樣的 30 張。
      await loadPhotos(onlyMissing);
    } else {
      setError('寫入失敗，請確認仍在登入狀態。');
    }
    setSubmitting(false);
  }, [matches, onDone, loadPhotos, onlyMissing]);

  // 照片位置這半段已經做完，而且沒有剩下可寫的了。
  // 此時主要動作從「寫入」換成「關閉」；但取消勾選「只處理還沒有座標的照片」
  // 之後又會有東西可寫，這個值就自己變回 false，兩顆按鈕的主次跟著換回來。
  const photoWorkDone = result !== '' && matches.length === 0;

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
        <h3 style={{ margin: '0 0 6px', fontSize: 18 }}>從 Google 時間軸匯入</h3>
        <p style={{ fontSize: 13, color: '#64748b', margin: '0 0 16px', lineHeight: 1.7 }}>
          手機的 Google Maps → 你的時間軸 → 設定 → 匯出時間軸資料，會得到 Timeline.json。
          選一次檔可以做兩件獨立的事：<strong style={{ color: '#0f172a' }}>補照片位置</strong>，
          以及<strong style={{ color: '#0f172a' }}>上傳足跡圖層</strong>。
          <br />
          <strong style={{ color: '#0f172a' }}>原始檔永遠不會上傳</strong>，只在你的瀏覽器裡解析；
          送出去的只有座標與時間，地點名稱、住家／公司標記、WiFi 掃描一概不讀。
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

        {track && (
          <div style={{
            border: '1px solid #e2e8f0', borderRadius: 10, padding: '13px 15px', marginBottom: 16,
          }}>
            <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>足跡圖層（紀念層）</div>
            <p style={{ fontSize: 12.5, color: '#64748b', margin: '0 0 10px', lineHeight: 1.7 }}>
              十二年的移動軌跡畫成地圖上最底層的一條淡線。
              <strong style={{ color: '#0f172a' }}>唯讀</strong> —— 不修正、不貼路、也不會拿來推算照片位置。
              重新上傳是整包覆蓋，不用擔心重複。
            </p>
            <div style={{ fontSize: 13, lineHeight: 1.9, marginBottom: 10 }}>
              <div>
                <strong>{track.points.toLocaleString()}</strong> 個位置點，
                散在 <strong>{track.days.toLocaleString()}</strong> 天、
                <strong>{track.months.length}</strong> 個月
              </div>
              <div style={{ color: '#475569', fontSize: 12.5 }}>{track.firstDay} ~ {track.lastDay}</div>
              {track.notes.map((n, i) => (
                <div key={i} style={{ color: '#64748b', fontSize: 12.5 }}>· {n}</div>
              ))}
            </div>
            <button
              onClick={handleUploadTrack}
              disabled={uploading}
              style={{
                padding: '8px 16px', borderRadius: 8, border: '1px solid #cbd5e1',
                background: uploading ? '#f1f5f9' : '#fff',
                cursor: uploading ? 'wait' : 'pointer', fontSize: 13.5,
              }}
            >
              {uploading ? `上傳中… ${uploadProgress}` : '上傳足跡圖層'}
            </button>
            {trackResult && (
              <div style={{
                marginTop: 10, background: '#f0fdf4', border: '1px solid #bbf7d0',
                borderRadius: 9, padding: '9px 12px', fontSize: 13, color: '#166534',
              }}>
                {trackResult}
              </div>
            )}
          </div>
        )}

        {samples.length > 0 && (
          <>
            <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 6 }}>補照片位置</div>
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
              <div>
                {loadingPhotos
                  // 切換上面那個勾選會回後端重撈，數字在那期間是上一次的，要講清楚
                  ? '正在讀取照片清單…'
                  : <>候選照片 <strong>{candidates.length}</strong> 張，比對成功 <strong>{matches.length}</strong> 張</>}
              </div>
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
          {/* 做完之後兩顆按鈕左右對調：主要動作永遠在最右邊 */}
          <button
            onClick={handleApply}
            disabled={matches.length === 0 || submitting}
            style={{
              order: photoWorkDone ? 0 : 1,
              padding: '9px 18px', borderRadius: 8, border: 'none',
              background: matches.length > 0 ? '#2563eb' : '#cbd5e1', color: '#fff',
              cursor: matches.length > 0 && !submitting ? 'pointer' : 'not-allowed', fontSize: 14,
            }}
          >
            {/* 還沒選檔時不能說「沒有要寫入的照片」—— 那時候是還沒算，不是算完是零 */}
            {submitting ? '寫入中…'
              : samples.length === 0 ? '寫入照片位置'
              : matches.length === 0 ? '沒有要寫入的照片'
              : `寫入 ${matches.length} 張照片的位置`}
          </button>
          <button
            onClick={onClose}
            style={{
              order: photoWorkDone ? 1 : 0,
              padding: '9px 18px', borderRadius: 8,
              border: photoWorkDone ? 'none' : '1px solid #cbd5e1',
              background: photoWorkDone ? '#2563eb' : '#fff',
              color: photoWorkDone ? '#fff' : 'inherit',
              cursor: 'pointer', fontSize: 14,
            }}
          >
            關閉
          </button>
        </div>
      </div>
    </div>
  );
}
