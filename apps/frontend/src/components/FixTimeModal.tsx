'use client';

import { useEffect, useState } from 'react';
import { shiftPhotoTime, setPhotoTimezone } from '@/lib/api';
import { TZ_OPTIONS, tzOptionLabel } from '@/lib/tz';

interface Props {
  isOpen: boolean;
  photoIds: number[];
  onClose: () => void;
  onDone: (result: { updated: number; skippedNoTime: number; what: string }) => void;
}

// 兩個操作的差別是「哪一個欄位是對的」，語意不能混：
//   平移時間：相機時鐘走差了 —— 瞬間與牆上時間一起移動，時區不變
//   改時區　：瞬間是對的，只是拿錯時區在顯示 —— 只重算牆上時間，瞬間不動
type Mode = 'shift' | 'timezone';

export default function FixTimeModal({ isOpen, photoIds, onClose, onDone }: Props) {
  const [mode, setMode] = useState<Mode>('shift');
  const [hours, setHours] = useState(0);
  const [minutes, setMinutes] = useState(0);
  const [tz, setTz] = useState(480);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    setMode('shift');
    setHours(0); setMinutes(0);
    setTz(480);
    setError(null);
  }, [isOpen]);

  if (!isOpen) return null;

  const totalMinutes = hours * 60 + minutes;

  const handleSubmit = async () => {
    setSubmitting(true);
    setError(null);

    const res = mode === 'shift'
      ? await shiftPhotoTime(photoIds, totalMinutes)
      : await setPhotoTimezone(photoIds, tz);

    setSubmitting(false);
    if (!res) {
      setError('修正失敗，請確認登入狀態後再試一次');
      return;
    }
    onDone({
      updated: res.updated,
      skippedNoTime: res.skippedNoTime,
      what: mode === 'shift' ? '平移拍攝時間' : '變更時區',
    });
    onClose();
  };

  const canSubmit = mode === 'shift' ? totalMinutes !== 0 : true;

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
        <h3 style={{ margin: '0 0 4px', fontSize: 18 }}>修正拍攝時間</h3>
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
