'use client';

import { useEffect, useState } from 'react';
import { shiftPhotoTime, setPhotoTimezone, setPhotoTime } from '@/lib/api';
import { TZ_OPTIONS, tzOptionLabel } from '@/lib/tz';

interface Props {
  isOpen: boolean;
  photoIds: number[];
  /**
   * 選取項目的原始檔名（`Photo.title`），只用來給「指定時間」預填。
   * 選填 —— 沒給就只是少了預填，功能照樣完整。
   */
  titles?: string[];
  onClose: () => void;
  onDone: (result: { updated: number; skippedNoTime: number; what: string }) => void;
}

// 三個操作的差別是「哪一個欄位是對的」，語意不能混：
//   平移時間：相機時鐘走差了 —— 瞬間與牆上時間一起移動，時區不變
//   改時區　：瞬間是對的，只是拿錯時區在顯示 —— 只重算牆上時間，瞬間不動
//   指定時間：本來就沒有時間 —— 牆上時間與時區都由使用者說了算
type Mode = 'shift' | 'timezone' | 'set';

/**
 * 從檔名猜拍攝時間，**只當預填值**，使用者按套用才會真的寫進去。
 *
 * 認得 `VID_20260824_143000.mp4`／`IMG_20260824_143000.jpg`／`20260824_143000`
 * 這一類 Android 常見的檔名。
 *
 * ⚠️ **`PXL_` 開頭的刻意不猜**（Pixel 的相機）—— 那串數字是 **UTC**，
 *    直接當牆上時間預填會整整差一個時區（台灣是 8 小時），而且錯得很安靜。
 *    回 'utc' 讓畫面說明白為什麼沒有預填，使用者自己填才不會被誤導。
 */
function guessWallClockFromName(name: string | undefined): string | 'utc' | null {
  if (!name) return null;
  if (/^PXL_/i.test(name)) return 'utc';
  const m = name.match(/(?:^|[^0-9])(d{4})(d{2})(d{2})[_-]?(d{2})(d{2})(d{2})(?![0-9])/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  const yy = Number(y);
  if (yy < 1990 || yy > 2100) return null;
  if (Number(mo) < 1 || Number(mo) > 12 || Number(d) < 1 || Number(d) > 31) return null;
  if (Number(h) > 23 || Number(mi) > 59 || Number(s) > 59) return null;
  return `${y}-${mo}-${d}T${h}:${mi}:${s}`;
}

/**
 * datetime-local 的值（'YYYY-MM-DDTHH:MM' 或 '…:SS'）→ 後端要的
 * 'YYYY-MM-DD HH:MM:SS'。沒填秒數時補 :00 —— 後端的 parseExifDateTime
 * 硬性要求秒數，少了會被當成無效字串退回 400。
 */
function toWallClockString(v: string): string {
  const [date, time = ''] = v.split('T');
  const parts = time.split(':');
  while (parts.length < 3) parts.push('00');
  return `${date} ${parts.slice(0, 3).map((n) => n.padStart(2, '0')).join(':')}`;
}

export default function FixTimeModal({ isOpen, photoIds, titles, onClose, onDone }: Props) {
  const [mode, setMode] = useState<Mode>('shift');
  const [hours, setHours] = useState(0);
  const [minutes, setMinutes] = useState(0);
  const [tz, setTz] = useState(480);
  // datetime-local 的值：'YYYY-MM-DDTHH:MM:SS'
  const [wall, setWall] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 檔名猜出來的預填值。開著的時候算一次就好，選取內容不會中途改變
  const guess = isOpen ? guessWallClockFromName(titles?.[0]) : null;
  const guessed = guess === 'utc' ? null : guess;

  useEffect(() => {
    if (!isOpen) return;
    setMode('shift');
    setHours(0); setMinutes(0);
    setTz(480);
    setWall(guessed ?? '');
    setError(null);
    // guessed 由 titles 算出來，開啟當下就定了，不需要進相依陣列
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  if (!isOpen) return null;

  const totalMinutes = hours * 60 + minutes;

  const handleSubmit = async () => {
    setSubmitting(true);
    setError(null);

    const res = mode === 'shift'
      ? await shiftPhotoTime(photoIds, totalMinutes)
      : mode === 'timezone'
        ? await setPhotoTimezone(photoIds, tz)
        // 後端要的是 YYYY-MM-DD HH:MM:SS；datetime-local 沒填秒數時要自己補
        : await setPhotoTime(photoIds, toWallClockString(wall), tz);

    setSubmitting(false);
    if (!res) {
      setError('修正失敗，請確認登入狀態後再試一次');
      return;
    }
    onDone({
      updated: res.updated,
      skippedNoTime: res.skippedNoTime,
      what: mode === 'shift' ? '平移拍攝時間' : mode === 'timezone' ? '變更時區' : '指定拍攝時間',
    });
    onClose();
  };

  const canSubmit = mode === 'shift'
    ? totalMinutes !== 0
    : mode === 'set'
      ? /^d{4}-d{2}-d{2}Td{2}:d{2}/.test(wall)
      : true;

  const tabStyle = (active: boolean) => ({
    flex: 1,
    padding: '9px 12px',
    borderRadius: 8,
    border: active ? '1px solid #2563eb' : '1px solid #cbd5e1',
    background: active ? '#eff6ff' : '#fff',
    color: active ? '#1d4ed8' : '#475569',
    fontWeight: active ? 600 : 400,
    fontSize: 13.5,
    cursor: 'pointer',
  } as const);

  const numInput = {
    width: 74, padding: '8px 10px', borderRadius: 8,
    border: '1px solid #cbd5e1', fontSize: 14,
  } as const;

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
          background: '#fff', borderRadius: 14, width: '100%', maxWidth: 500,
          maxHeight: '88vh', overflowY: 'auto', padding: 22, color: '#0f172a',
        }}
      >
        <h3 style={{ margin: '0 0 4px', fontSize: 18 }}>拍攝時間</h3>
        <p style={{ margin: '0 0 14px', fontSize: 13, color: '#64748b' }}>
          已選取 {photoIds.length} 張
        </p>

        <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
          <button onClick={() => setMode('shift')} style={tabStyle(mode === 'shift')}>
            平移時間
          </button>
          <button onClick={() => setMode('timezone')} style={tabStyle(mode === 'timezone')}>
            改時區
          </button>
          <button onClick={() => setMode('set')} style={tabStyle(mode === 'set')}>
            指定時間
          </button>
        </div>

        {mode === 'shift' ? (
          <>
            <p style={{ fontSize: 13, color: '#64748b', lineHeight: 1.7, margin: '0 0 12px' }}>
              相機時鐘本身走差了（例如 D800 每年約慢一分鐘）。拍攝時間會整批往前或往後移動，
              時區不變。要用多少可以拿手機時間對一下機身時鐘的差距。
            </p>
            <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', marginBottom: 8 }}>
              <label style={{ fontSize: 13 }}>
                <div style={{ marginBottom: 4, color: '#475569' }}>小時</div>
                <input
                  type="number"
                  value={hours}
                  onChange={(e) => setHours(Math.trunc(Number(e.target.value) || 0))}
                  style={numInput}
                />
              </label>
              <label style={{ fontSize: 13 }}>
                <div style={{ marginBottom: 4, color: '#475569' }}>分鐘</div>
                <input
                  type="number"
                  value={minutes}
                  onChange={(e) => setMinutes(Math.trunc(Number(e.target.value) || 0))}
                  style={numInput}
                />
              </label>
              <div style={{ fontSize: 13, color: '#64748b', paddingBottom: 9 }}>
                {totalMinutes === 0
                  ? '（填正數往後、負數往前）'
                  : `共 ${totalMinutes > 0 ? '+' : ''}${totalMinutes} 分鐘`}
              </div>
            </div>
            <p style={{ fontSize: 12.5, color: '#b45309', margin: '0 0 18px', lineHeight: 1.6 }}>
              這個操作會把時間標記為「使用者修正」，之後任何自動流程都不會再改動它。
            </p>
          </>
        ) : (
          <>
            <p style={{ fontSize: 13, color: '#64748b', lineHeight: 1.7, margin: '0 0 12px' }}>
              出國拍照但機身時區沒改的情況。相機記的時刻本身沒錯，錯的只是「該用哪個時區去讀它」，
              所以照片的排序位置不會變，只有顯示出來的拍攝時間會換算成新時區。
            </p>
            <label style={{ fontSize: 13, display: 'block', marginBottom: 18 }}>
              <div style={{ marginBottom: 4, color: '#475569' }}>照片當時所在地的時區</div>
              <select
                value={tz}
                onChange={(e) => setTz(Number(e.target.value))}
                style={{ padding: '8px 10px', borderRadius: 8, border: '1px solid #cbd5e1', fontSize: 14 }}
              >
                {TZ_OPTIONS.map((o) => (
                  <option key={o.minutes} value={o.minutes}>{tzOptionLabel(o)}</option>
                ))}
              </select>
            </label>
          </>
        )}

        {mode === 'set' && (
          <>
            <p style={{ fontSize: 13, color: '#64748b', lineHeight: 1.7, margin: '0 0 12px' }}>
              本來就<strong>沒有</strong>拍攝時間的東西才用這個：影片（封面圖是網頁畫出來的，不帶 EXIF）、
              掃描的老照片、被 App 洗掉 EXIF 的圖。上面兩個操作都需要一個原本的時間當基準，
              對這些一律跳過。
            </p>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 10 }}>
              <label style={{ fontSize: 13 }}>
                <div style={{ marginBottom: 4, color: '#475569' }}>拍攝當下的時間</div>
                <input
                  type="datetime-local"
                  step={1}
                  value={wall}
                  onChange={(e) => setWall(e.target.value)}
                  style={{ padding: '8px 10px', borderRadius: 8, border: '1px solid #cbd5e1', fontSize: 14 }}
                />
              </label>
              <label style={{ fontSize: 13 }}>
                <div style={{ marginBottom: 4, color: '#475569' }}>當時所在地的時區</div>
                <select
                  value={tz}
                  onChange={(e) => setTz(Number(e.target.value))}
                  style={{ padding: '8px 10px', borderRadius: 8, border: '1px solid #cbd5e1', fontSize: 14 }}
                >
                  {TZ_OPTIONS.map((o) => (
                    <option key={o.minutes} value={o.minutes}>{tzOptionLabel(o)}</option>
                  ))}
                </select>
              </label>
            </div>
            {guessed && (
              <p style={{ fontSize: 12.5, color: '#15803d', margin: '0 0 10px', lineHeight: 1.6 }}>
                已從檔名 <code>{titles?.[0]}</code> 預填，確認一下對不對再套用。
              </p>
            )}
            {guess === 'utc' && (
              <p style={{ fontSize: 12.5, color: '#b45309', margin: '0 0 10px', lineHeight: 1.6 }}>
                檔名 <code>{titles?.[0]}</code> 裡的時間是 UTC（Pixel 相機的習慣），
                直接拿來用會差一整個時區，所以沒有幫你預填。
              </p>
            )}
            {photoIds.length > 1 && (
              <p style={{ fontSize: 12.5, color: '#b45309', margin: '0 0 10px', lineHeight: 1.6 }}>
                選取了 {photoIds.length} 個項目，<strong>全部都會被設成同一個時間</strong>。
                每支影片各自的時間要一個一個來。
              </p>
            )}
            <p style={{ fontSize: 12.5, color: '#b45309', margin: '0 0 18px', lineHeight: 1.6 }}>
              這個操作會把時間標記為「使用者指定」，之後任何自動流程都不會再改動它。
            </p>
          </>
        )}

        {error && (
          <p style={{ fontSize: 13, color: '#b91c1c', margin: '0 0 12px' }}>{error}</p>
        )}

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
            disabled={!canSubmit || submitting}
            style={{
              padding: '9px 18px', borderRadius: 8, border: 'none',
              background: canSubmit ? '#2563eb' : '#cbd5e1', color: '#fff',
              cursor: canSubmit && !submitting ? 'pointer' : 'not-allowed', fontSize: 14,
            }}
          >
            {submitting ? '處理中…' : '套用'}
          </button>
        </div>
      </div>
    </div>
  );
}
