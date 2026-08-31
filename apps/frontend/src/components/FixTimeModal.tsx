'use client';

import { useEffect, useState } from 'react';
import { shiftPhotoTime, setPhotoTimezone, setPhotoTime } from '@/lib/api';
import { TZ_OPTIONS, tzOptionLabel, tzOptionsIncluding } from '@/lib/tz';
// 檔名猜時間這件事上傳路徑也要用（影片沒有 mvhd 時就靠它），
// 所以實作搬去 lib/videoMeta.ts，兩邊共用同一份 —— 不要再各留一份副本
import { guessWallClockFromName } from '@/lib/videoMeta';

interface Props {
  isOpen: boolean;
  photoIds: number[];
  /**
   * 選取項目的原始檔名（`Photo.title`），只用來給「指定時間」預填。
   * 選填 —— 沒給就只是少了預填，功能照樣完整。
   */
  titles?: string[];
  /**
   * 打開時停在哪個分頁。燈箱那個入口直接進 'set'（那裡就是為了補時間才點的）。
   */
  initialMode?: Mode;
  /**
   * 只給一個分頁，把上面那排分頁鈕整個收起來。
   * ⚠️ 這是**介面上的收斂，不是另做一套** —— 三種操作的語意與 API 都沒有變，
   *    燈箱只是不需要「平移／改時區」那兩個批次操作的入口。
   */
  lockMode?: boolean;
  /**
   * 「指定時間」的預填牆上時間，'YYYY-MM-DD HH:MM:SS' 或 'YYYY-MM-DDTHH:MM:SS'。
   * 從燈箱編輯既有時間時給它，不然使用者要從今天的日期一路調回去。
   * 它的優先序**高於檔名猜出來的值** —— 資料庫裡已經有的東西比猜的可信。
   */
  initialWall?: string | null;
  /** 預填時區（`Photo.tz_offset_minutes`）。沒給就用台灣 */
  initialTz?: number | null;
  onClose: () => void;
  onDone: (result: { updated: number; skippedNoTime: number; what: string }) => void;
}

// 三個操作的差別是「哪一個欄位是對的」，語意不能混：
//   平移時間：相機時鐘走差了 —— 瞬間與牆上時間一起移動，時區不變
//   改時區　：瞬間是對的，只是拿錯時區在顯示 —— 只重算牆上時間，瞬間不動
//   指定時間：本來就沒有時間 —— 牆上時間與時區都由使用者說了算
type Mode = 'shift' | 'timezone' | 'set';

/** 拍攝時間的六個欄位。年月日時分秒都是數字，時區另外一個 select */
interface WallParts { y: number; mo: number; d: number; h: number; mi: number; s: number }

const pad2 = (n: number) => String(n).padStart(2, '0');

/** 那個月有幾天。閏年交給 Date 自己算（第 0 天＝上個月最後一天） */
function daysInMonth(y: number, mo: number): number {
  return new Date(y, mo, 0).getDate();
}

/**
 * 'YYYY-MM-DD HH:MM:SS' / 'YYYY-MM-DDTHH:MM:SS' → 六個數字。
 * 解不出來回 null，呼叫端自己決定退到哪個預設值。
 */
function parseWallParts(v: string | null | undefined): WallParts | null {
  if (!v) return null;
  const m = v.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return null;
  return {
    y: Number(m[1]), mo: Number(m[2]), d: Number(m[3]),
    h: Number(m[4]), mi: Number(m[5]), s: Number(m[6] ?? 0),
  };
}

/** 六個數字 → 後端要的 'YYYY-MM-DD HH:MM:SS'（`parseExifDateTime` 硬性要求秒數） */
function toWallClockString(p: WallParts): string {
  return `${p.y}-${pad2(p.mo)}-${pad2(p.d)} ${pad2(p.h)}:${pad2(p.mi)}:${pad2(p.s)}`;
}

/** 沒有任何線索時的預設值：今天，00:00:00 */
function todayParts(): WallParts {
  const now = new Date();
  return { y: now.getFullYear(), mo: now.getMonth() + 1, d: now.getDate(), h: 0, mi: 0, s: 0 };
}

const range = (from: number, to: number) => {
  const out: number[] = [];
  for (let i = from; i <= to; i++) out.push(i);
  return out;
};

export default function FixTimeModal({
  isOpen, photoIds, titles, initialMode, lockMode, initialWall, initialTz, onClose, onDone,
}: Props) {
  const [mode, setMode] = useState<Mode>(initialMode ?? 'shift');
  const [hours, setHours] = useState(0);
  const [minutes, setMinutes] = useState(0);
  const [tz, setTz] = useState(480);
  // 「指定時間」那六個欄位。一律是完整的值，不會有「還沒選」的狀態
  const [wall, setWall] = useState<WallParts>(todayParts);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 檔名猜出來的預填值。開著的時候算一次就好，選取內容不會中途改變
  const guess = isOpen ? guessWallClockFromName(titles?.[0]) : null;
  const guessed = guess === 'utc' ? null : guess;
  // 資料庫裡已經有的時間比猜的可信，兩個都沒有才退到今天
  const seeded = parseWallParts(initialWall) ?? parseWallParts(guessed);

  useEffect(() => {
    if (!isOpen) return;
    setMode(initialMode ?? 'shift');
    setHours(0); setMinutes(0);
    setTz(initialTz ?? 480);
    setWall(seeded ?? todayParts());
    setError(null);
    // seeded／guessed 由 props 算出來，開啟當下就定了，不需要進相依陣列
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  if (!isOpen) return null;

  const totalMinutes = hours * 60 + minutes;

  // 換年或換月之後，原本選的日可能不存在了（1/31 → 2 月）。夾回該月最後一天，
  // 不然送出去的是一個不存在的日期，而且畫面上看不出哪裡不對
  const setWallPart = (patch: Partial<WallParts>) => {
    setWall((prev) => {
      const next = { ...prev, ...patch };
      const max = daysInMonth(next.y, next.mo);
      if (next.d > max) next.d = max;
      return next;
    });
  };

  const handleSubmit = async () => {
    setSubmitting(true);
    setError(null);

    const res = mode === 'shift'
      ? await shiftPhotoTime(photoIds, totalMinutes)
      : mode === 'timezone'
        ? await setPhotoTimezone(photoIds, tz)
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

  // 「指定時間」的六個欄位永遠是有效值（選單選的），所以只有平移那個模式要擋
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

  const selectStyle = {
    padding: '8px 10px', borderRadius: 8, border: '1px solid #cbd5e1',
    fontSize: 14, background: '#fff', color: '#0f172a',
  } as const;

  /** 年月日時分秒共用的一格：標題 + 選單 */
  const partSelect = (
    label: string, value: number, values: number[],
    onPick: (n: number) => void, fmt: (n: number) => string = String,
  ) => (
    <label style={{ fontSize: 12.5, color: '#475569' }}>
      <div style={{ marginBottom: 4 }}>{label}</div>
      <select value={value} onChange={(e) => onPick(Number(e.target.value))} style={selectStyle}>
        {values.map((n) => <option key={n} value={n}>{fmt(n)}</option>)}
      </select>
    </label>
  );

  // 年份範圍：掃描的老照片可能是 1900 年代，上限給到明年（相機時鐘設錯會跑到未來）
  const thisYear = new Date().getFullYear();
  const years = range(1900, thisYear + 1).reverse();

  return (
    <div
      onClick={onClose}
      style={{
        // ⚠️ 要蓋得住燈箱（lightbox.module.css 最高 3250），從燈箱點「修改」開的
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,.5)', zIndex: 4000,
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

        {!lockMode && (
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
        )}

        {mode === 'shift' && (
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
        )}

        {mode === 'timezone' && (
          <>
            <p style={{ fontSize: 13, color: '#64748b', lineHeight: 1.7, margin: '0 0 12px' }}>
              出國拍照但機身時區沒改的情況。相機記的時刻本身沒錯，錯的只是「該用哪個時區去讀它」，
              所以照片的排序位置不會變，只有顯示出來的拍攝時間會換算成新時區。
            </p>
            <label style={{ fontSize: 13, display: 'block', marginBottom: 18 }}>
              <div style={{ marginBottom: 4, color: '#475569' }}>照片當時所在地的時區</div>
              <select value={tz} onChange={(e) => setTz(Number(e.target.value))} style={selectStyle}>
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
            {/*
              * 六個選單而不是一格 datetime-local：
              *   ① 秒數在 datetime-local 上要靠 step 才出得來，而且各家瀏覽器長得不一樣；
              *   ② 掃描的老照片要調到 1970 年代，日曆一頁一頁翻不完，年份直接選比較快。
              * 時區沿用「改時區」那個清單，兩邊的顯示格式因此完全一致。
              */}
            <div style={{ marginBottom: 4, fontSize: 13, color: '#475569' }}>拍攝當下的時間</div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
              {partSelect('年', wall.y, years, (n) => setWallPart({ y: n }))}
              {partSelect('月', wall.mo, range(1, 12), (n) => setWallPart({ mo: n }))}
              {partSelect('日', wall.d, range(1, daysInMonth(wall.y, wall.mo)), (n) => setWallPart({ d: n }))}
              {partSelect('時', wall.h, range(0, 23), (n) => setWallPart({ h: n }), pad2)}
              {partSelect('分', wall.mi, range(0, 59), (n) => setWallPart({ mi: n }), pad2)}
              {partSelect('秒', wall.s, range(0, 59), (n) => setWallPart({ s: n }), pad2)}
            </div>
            <label style={{ fontSize: 13, display: 'block', marginBottom: 10 }}>
              <div style={{ marginBottom: 4, color: '#475569' }}>當時所在地的時區</div>
              <select value={tz} onChange={(e) => setTz(Number(e.target.value))} style={selectStyle}>
                {tzOptionsIncluding(initialTz).map((o) => (
                  <option key={o.minutes} value={o.minutes}>{tzOptionLabel(o)}</option>
                ))}
              </select>
            </label>
            <p style={{ fontSize: 12.5, color: '#334155', margin: '0 0 10px', lineHeight: 1.6 }}>
              會存成 <code>{toWallClockString(wall)}</code>
              　{tzOptionLabel({ minutes: tz, hint: '' })}
            </p>
            {!initialWall && guessed && (
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
