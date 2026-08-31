'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

/*
 * 足跡地圖的日期選擇器。
 *
 * 為什麼不用 <input type="date">：那個框只吃 min/max，沒辦法把中間某幾天鎖起來。
 * 這一頁十二年裡絕大多數的日子是空的，讓人一天一天試出「哪天有東西」很折磨 ——
 * 沒有足跡的日子在這裡直接點不下去，而且有足跡的日子帶一個點，一眼就看得出來。
 *
 * 資料從哪來由外面決定（daysWithData）。這裡刻意不自己去抓：
 * Google 足跡是一個月一個檔，抓哪個月、快取放哪都是頁面那邊的事。
 *
 * **兩處共用**：/map 的日期篩選、/album 的日期篩選。相簿那邊要的是同一件事
 * （「哪幾天有東西」＋單日或範圍），差別只有面板上那幾句說明文字要叫「照片」
 * 而不是「足跡」—— 所以是一個 `noun` 選填 prop，不是第二支日曆元件。
 */

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];
const MONTHS = Array.from({ length: 12 }, (_, i) => String(i + 1).padStart(2, '0'));

/** 'YYYY-MM-DD' → 'YYYY-MM' */
export function monthOf(day: string): string {
  return day.slice(0, 7);
}

/** 今天的當地日。日期一律用本地時區看，跟日期框原本的行為一致 */
export function todayLocal(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 月份加減。用 UTC 建日期，免得月底在某些時區被推到隔壁月 */
function shiftMonth(monthKey: string, delta: number): string {
  const [y, m] = monthKey.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/**
 * 一個月的格子。開頭補 null 讓 1 號落在正確的星期欄位。
 * 全部走 UTC —— 這裡算的是「日曆上的格子」，跟時區無關。
 */
function monthCells(monthKey: string): (string | null)[] {
  const [y, m] = monthKey.split('-').map(Number);
  const startDow = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
  const total = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const cells: (string | null)[] = Array(startDow).fill(null);
  for (let d = 1; d <= total; d++) {
    cells.push(`${monthKey}-${String(d).padStart(2, '0')}`);
  }
  return cells;
}

interface Props {
  /** 目前選的範圍。空字串代表沒選（＝全部日期） */
  from: string;
  to: string;
  /** 選好了。單日時兩個值一樣 */
  onChange: (from: string, to: string) => void;
  /** 面板正在看哪個月（'YYYY-MM'）。受控 —— 外面要靠它決定去抓哪個月的資料 */
  month: string;
  onMonthChange: (month: string) => void;
  /**
   * 這個月哪幾天有足跡。
   *
   * **null 代表「還不知道」，那就整個月都可以選** —— 資料還沒到就先把日子鎖起來，
   * 會變成使用者明明有足跡卻點不下去，那比讓他點到一天空的還糟。
   */
  daysWithData: Set<string> | null;
  /**
   * 哪幾年有足跡（'2014'…）。年份下拉選單只列這些 ——
   * 十二年的資料要靠 ‹ 一個月一個月退回 2014 年是折磨人的事。
   * 沒給就只列目前看的那一年。
   */
  years?: string[];
  /** 這個月的資料還在抓 */
  loading?: boolean;
  /** 可選範圍的上下界（選了相簿時鎖到該相簿的照片範圍） */
  min?: string;
  max?: string;
  /**
   * 「有東西的日子」在這一頁叫什麼。地圖是足跡、相簿是照片。
   *
   * 這支元件兩邊共用（同一件事不要做第二套日曆），差別只有面板上那幾句說明文字 ——
   * 相簿裡寫「這個月沒有任何足跡」會讓人以為自己按錯頁面了。
   */
  noun?: string;
  /**
   * 按鈕上面那行欄位標題。`null` ＝不畫。
   *
   * 地圖那排控制項每一格都有標題（日期／相簿／…），對齊得靠它；相簿頁的篩選列
   * 只有一個沒有標題的搜尋框，多一行字反而讓兩格的高度對不起來。
   */
  fieldLabel?: string | null;
}

export default function FootprintDayPicker({
  from, to, onChange, month, onMonthChange, daysWithData, years, loading = false, min, max,
  noun = '足跡', fieldLabel = '日期',
}: Props) {
  const [open, setOpen] = useState(false);
  /**
   * 範圍的起點，等著第二下把它收成一段。null 代表下一次點擊是「重新開始」。
   *
   * 拿它當狀態而不是直接看 from/to：從外面看不出「使用者剛點了第一下、正在等第二下」
   * 和「已經選好一段」的差別，而這兩個狀態下同一個點擊要做完全不同的事。
   */
  const [anchor, setAnchor] = useState<string | null>(null);
  const boxRef = useRef<HTMLDivElement | null>(null);

  // 點面板外面、或按 Esc 就收起來
  useEffect(() => {
    if (!open) return;
    const close = () => { setOpen(false); setAnchor(null); };
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // 打開時跳到已選日期所在的月份，沒選就維持外面給的月份。
  // 關起來時順手把等待中的起點丟掉 —— 下次打開是全新的一次選取
  useEffect(() => {
    if (open) { if (from) onMonthChange(monthOf(from)); }
    else setAnchor(null);
    // 只在開闔的那一刻對齊，之後使用者自己翻月份不能被拉回來
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const cells = useMemo(() => monthCells(month), [month]);

  const enabled = useCallback((day: string) => {
    if (min && day < min) return false;
    if (max && day > max) return false;
    // 不知道就放行，理由見 daysWithData 的說明
    return daysWithData === null || daysWithData.has(day);
  }, [daysWithData, min, max]);

  /*
   * 點一天的語意：
   *   第一下 → 記下起點，開始日與結束日都設成那天（＝就看這一天）
   *   第二下 → 跟起點收成一段範圍。點更前面的日子也行，前後會自動對調
   *   第三下 → 重新開始，回到「就看這一天」
   *
   * 面板刻意不在點完後關起來。原本點一下就收，等於第二下永遠沒有機會發生 ——
   * 範圍選取的程式碼一直都在，只是使用者碰不到它。要離開就按「完成」或點面板外面。
   */
  const pick = (day: string) => {
    if (anchor === null) {
      setAnchor(day);
      onChange(day, day);
    } else {
      const lo = day < anchor ? day : anchor;
      const hi = day < anchor ? anchor : day;
      onChange(lo, hi);
      setAnchor(null);
    }
  };

  const label = !from && !to ? '全部日期'
    : from && from === to ? from
    : `${from || '最早'} ～ ${to || '最新'}`;

  const [yearStr, monthStr] = month.split('-');

  // 目前看的年份一定要在選單裡，否則那一年沒足跡時選單會顯示成空白
  const yearOptions = useMemo(() => {
    const set = new Set(years ?? []);
    set.add(yearStr);
    return Array.from(set).sort();
  }, [years, yearStr]);

  return (
    <div ref={boxRef} style={{ position: 'relative', fontSize: 13 }}>
      {fieldLabel !== null && (
        <div style={{ marginBottom: 4, color: '#475569' }}>{fieldLabel}</div>
      )}
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        style={{
          padding: '7px 12px', borderRadius: 7, border: '1px solid #cbd5e1',
          background: '#fff', cursor: 'pointer', fontSize: 13, minWidth: 168, textAlign: 'left',
        }}
        title={`只有留下${noun}的日子選得到。點一天＝就看那天，再點第二天＝框出一段範圍`}
      >
        {label} ▾
      </button>

      {open && (
        <div style={{
          position: 'absolute', zIndex: 20, top: '100%', left: 0, marginTop: 6,
          background: '#fff', border: '1px solid #e2e8f0', borderRadius: 10,
          boxShadow: '0 8px 24px rgba(15,23,42,.14)', padding: 12, width: 280,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 8 }}>
            <button type="button" onClick={() => onMonthChange(shiftMonth(month, -1))} style={navBtn} title="上個月">‹</button>
            <select
              value={yearStr}
              onChange={(e) => onMonthChange(`${e.target.value}-${monthStr}`)}
              style={{ ...jumpSelect, flex: 1 }}
              title={`有${noun}的年份`}
            >
              {yearOptions.map(y => <option key={y} value={y}>{y} 年</option>)}
            </select>
            <select
              value={monthStr}
              onChange={(e) => onMonthChange(`${yearStr}-${e.target.value}`)}
              style={jumpSelect}
            >
              {MONTHS.map(m => <option key={m} value={m}>{Number(m)} 月</option>)}
            </select>
            <button type="button" onClick={() => onMonthChange(shiftMonth(month, 1))} style={navBtn} title="下個月">›</button>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 2, marginBottom: 4 }}>
            {WEEKDAYS.map(w => (
              <div key={w} style={{ textAlign: 'center', fontSize: 11, color: '#94a3b8', padding: '2px 0' }}>{w}</div>
            ))}
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 2 }}>
            {cells.map((day, i) => {
              if (day === null) return <div key={`pad-${i}`} />;
              const ok = enabled(day);
              const selected = !!from && day >= from && day <= (to || from);
              const isEdge = day === from || day === to;
              const hasData = daysWithData !== null && daysWithData.has(day);
              return (
                <button
                  key={day}
                  type="button"
                  disabled={!ok}
                  onClick={() => pick(day)}
                  title={ok ? day : `${day} 沒有任何${noun}`}
                  style={{
                    position: 'relative', padding: '6px 0', borderRadius: 6, fontSize: 12.5,
                    border: '1px solid transparent',
                    // 選不到的日子不留任何可以按的樣子 —— 灰字、預設游標
                    cursor: ok ? 'pointer' : 'default',
                    color: !ok ? '#cbd5e1' : isEdge ? '#fff' : '#0f172a',
                    background: isEdge ? '#2563eb' : selected ? '#dbeafe' : 'transparent',
                    fontWeight: isEdge ? 600 : 400,
                  }}
                >
                  {Number(day.slice(8))}
                  {/* 有足跡的日子帶一個小點。選中那天是白底藍字，點也跟著換色才看得見 */}
                  {hasData && (
                    <span style={{
                      position: 'absolute', left: '50%', bottom: 2, transform: 'translateX(-50%)',
                      width: 3, height: 3, borderRadius: '50%',
                      background: isEdge ? '#fff' : '#2563eb',
                    }} />
                  )}
                </button>
              );
            })}
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10 }}>
            <span style={{ fontSize: 11.5, color: anchor ? '#2563eb' : '#94a3b8', flex: 1 }}>
              {/* 等第二下的時候，這行字要蓋過月份統計 —— 那是此刻唯一需要知道的事，
                  而且它同時解釋了「為什麼面板還開著」 */}
              {anchor ? '再點一天框出範圍，或按「完成」就看這一天'
                : loading ? `讀取這個月的${noun}…`
                : daysWithData === null ? `（尚未載入${noun}索引）`
                : daysWithData.size === 0 ? `這個月沒有任何${noun}`
                : `這個月有 ${daysWithData.size} 天有${noun}`}
            </span>
            {(from || to) && (
              <button
                type="button"
                onClick={() => { onChange('', ''); setOpen(false); }}
                style={{ ...navBtn, width: 'auto', padding: '4px 10px' }}
              >
                全部日期
              </button>
            )}
            <button
              type="button"
              onClick={() => setOpen(false)}
              style={{
                ...navBtn, width: 'auto', padding: '4px 12px',
                borderColor: '#2563eb', color: '#2563eb',
              }}
            >
              完成
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

const jumpSelect: React.CSSProperties = {
  padding: '3px 4px', borderRadius: 6, border: '1px solid #e2e8f0',
  background: '#fff', fontSize: 12.5, color: '#0f172a', cursor: 'pointer',
};

const navBtn: React.CSSProperties = {
  width: 26, height: 26, display: 'grid', placeItems: 'center',
  border: '1px solid #e2e8f0', borderRadius: 6, background: '#fff',
  cursor: 'pointer', fontSize: 12, color: '#475569', padding: 0,
};
