'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { applyTripSegments, reverseGeocode, setPlaceNames, photoThumbSrc, type Photo } from '@/lib/api';
import { useAdmin } from '@/lib/useAdmin';
import { useRevealedRestricted } from '@/lib/restrictedReveal';

interface Props {
  isOpen: boolean;
  albumId?: number;
  /** 相簿目前的全部照片。寫入之後由 onRefresh 重抓，這裡不做樂觀更新 */
  photos: Photo[];
  onClose: () => void;
  /** 挑好照片後交回相簿頁，由既有的 AssignPlaceModal 接手 */
  onAssignPlace: (photoIds: number[]) => void;
  /** 重抓相簿資料。回傳值這裡用不到，宣告成 unknown 讓呼叫端可以直接丟 loadData 進來 */
  onRefresh: () => Promise<unknown> | unknown;
}

const hasGeo = (p: Photo) => typeof p.lat === 'number' && typeof p.lng === 'number';
const hasName = (p: Photo) => !!(p.place_name && p.place_name.trim());

/** 一張照片在這個畫面裡的三種身分 */
type State = 'none' | 'unnamed' | 'done';
const stateOf = (p: Photo): State => (!hasGeo(p) ? 'none' : hasName(p) ? 'done' : 'unnamed');

const dayOf = (p: Photo): string => {
  const s = p.taken_at_local || p.taken_at || '';
  const d = s.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : '';
};

/**
 * 反查的節流間隔。Photon 是志工維運的免費服務，沒有付費方案可以買額度，
 * 打太快就是在佔用別人的機器。跟 Valhalla 那邊一樣自我約束。
 */
const REVERSE_GAP_MS = 400;
/** 一次最多查幾個不同的位置。超過就分批做，避免一個相簿把人家打爆 */
const REVERSE_CAP = 150;
/** 座標取到小數第四位（約 11 公尺）當快取鍵：同一個景點拍的幾十張只查一次 */
const coordKey = (p: Photo) => `${p.lat!.toFixed(4)},${p.lng!.toFixed(4)}`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 相簿層級的打卡補件畫面。
 *
 * 跟底部動作列的「指定地點」差在切入點：那邊要先自己找出哪些照片沒位置，
 * 這裡直接把整本相簿攤開、照拍攝日分組，缺什麼一眼看得到。
 *
 * 打開就先跑一次行程段套用（step 0）—— 之前建過的「這段時間我在這裡」規則
 * 本來就該先生效，剩下真正沒救的才需要人工處理。
 *
 * 自己不寫座標：挑完照片一樣交回相簿頁給 AssignPlaceModal，
 * 行為與批次操作完全一致。這裡只多做一件事 —— 幫自帶 GPS 的照片補地名，
 * 那個動作不碰 lat/lng（見 api.ts 的 setPlaceNames）。
 */
export default function PlaceCheckinModal({
  isOpen, albumId, photos, onClose, onAssignPlace, onRefresh,
}: Props) {
  const [selected, setSelected] = useState<number[]>([]);
  const [showDone, setShowDone] = useState(false);
  /* 不開放的照片要不要糊掉（站長在 /admin 開的全站設定），掀開狀態全站共用一份 */
  const { restrictedBlur } = useAdmin();
  const revealedRestricted = useRevealedRestricted();
  const blurOf = (p: Photo) =>
    restrictedBlur && p.restricted === 1 && !revealedRestricted.has(p.id);
  const [step0, setStep0] = useState<'idle' | 'running' | 'done'>('idle');
  const [step0Applied, setStep0Applied] = useState(0);
  const [naming, setNaming] = useState<{ done: number; total: number } | null>(null);
  const [nameResult, setNameResult] = useState<string | null>(null);

  // step 0：先讓既有的行程段規則生效，再讓人看剩下的
  useEffect(() => {
    if (!isOpen) return;
    setSelected([]);
    setShowDone(false);
    setNaming(null);
    setNameResult(null);
    setStep0('running');
    let cancelled = false;
    (async () => {
      const applied = await applyTripSegments(albumId);
      if (cancelled) return;
      setStep0Applied(applied);
      if (applied > 0) await onRefresh();
      if (!cancelled) setStep0('done');
    })();
    return () => { cancelled = true; };
    // onRefresh 每次 render 都是新的函式，放進 deps 會讓 step 0 無限重跑
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, albumId]);

  const buckets = useMemo(() => {
    const none: Photo[] = [];
    const unnamed: Photo[] = [];
    const done: Photo[] = [];
    for (const p of photos) {
      const s = stateOf(p);
      (s === 'none' ? none : s === 'unnamed' ? unnamed : done).push(p);
    }
    return { none, unnamed, done };
  }, [photos]);

  /** 要顯示的照片，照拍攝當天分組。沒有時間的那些收在最後一組 */
  const days = useMemo(() => {
    const visible = photos.filter((p) => showDone || stateOf(p) !== 'done');
    const map = new Map<string, Photo[]>();
    for (const p of visible) {
      const d = dayOf(p);
      if (!map.has(d)) map.set(d, []);
      map.get(d)!.push(p);
    }
    return Array.from(map.entries())
      .sort((a, b) => (a[0] === '' ? 1 : b[0] === '' ? -1 : a[0] < b[0] ? -1 : 1))
      .map(([day, list]) => ({
        day,
        list: list.slice().sort((x, y) => (x.taken_at_local || '') < (y.taken_at_local || '') ? -1 : 1),
      }));
  }, [photos, showDone]);

  const toggle = (id: number) => {
    setSelected((prev) => prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]);
  };

  const toggleMany = (ids: number[]) => {
    setSelected((prev) => {
      const all = ids.every((id) => prev.includes(id));
      return all ? prev.filter((id) => !ids.includes(id)) : Array.from(new Set([...prev, ...ids]));
    });
  };

  /**
   * 幫選取的照片中「有座標、沒地名」的那些反查地名。
   * 座標是最準的一份資料，這裡只是幫它取個名字，一個字都不會動到 lat/lng。
   */
  const handleAutoName = useCallback(async () => {
    const targets = photos.filter((p) => selected.includes(p.id) && stateOf(p) === 'unnamed');
    if (targets.length === 0) return;

    // 先按座標收斂，同一個景點的幾十張只查一次
    const groups = new Map<string, Photo[]>();
    for (const p of targets) {
      const k = coordKey(p);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k)!.push(p);
    }
    const keys = Array.from(groups.keys()).slice(0, REVERSE_CAP);

    setNaming({ done: 0, total: keys.length });
    setNameResult(null);

    const items: { photoId: number; placeName: string }[] = [];
    let missed = 0;
    for (let i = 0; i < keys.length; i++) {
      const group = groups.get(keys[i])!;
      const head = group[0];
      const name = await reverseGeocode(head.lat!, head.lng!);
      if (name) for (const p of group) items.push({ photoId: p.id, placeName: name });
      else missed += group.length;
      setNaming({ done: i + 1, total: keys.length });
      if (i < keys.length - 1) await sleep(REVERSE_GAP_MS);
    }

    const updated = items.length > 0 ? await setPlaceNames(items) : 0;
    setNaming(null);

    const rest = groups.size > keys.length ? `，還有 ${groups.size - keys.length} 個位置這次沒查（一次上限 ${REVERSE_CAP} 個，可再按一次）` : '';
    const none = missed > 0 ? `，${missed} 張附近查不到地標` : '';
    setNameResult(`已補上 ${updated} 張的地名${none}${rest}`);
    setSelected([]);
    await onRefresh();
  }, [photos, selected, onRefresh]);

  if (!isOpen) return null;

  const busy = step0 === 'running' || naming !== null;
  const canAssign = selected.length > 0 && !busy;
  const namableSelected = photos.filter((p) => selected.includes(p.id) && stateOf(p) === 'unnamed').length;

  const btn = (enabled: boolean, primary: boolean) => ({
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
      onClick={busy ? undefined : onClose}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,.5)', zIndex: 1000,
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: '#fff', borderRadius: 14, width: '100%', maxWidth: 760,
          maxHeight: '88vh', display: 'flex', flexDirection: 'column', color: '#0f172a',
        }}
      >
        <div style={{ padding: '22px 22px 0' }}>
          <h3 style={{ margin: '0 0 4px', fontSize: 18 }}>整理這本相簿的地點</h3>
          <p style={{ margin: '0 0 12px', fontSize: 13, color: '#64748b', lineHeight: 1.7 }}>
            照拍攝日期排開，缺什麼一眼看得到。挑幾張 →「指定地點」建立打卡；
            自帶 GPS 但沒有地名的，可以直接反查地名（不會動到原本的座標）。
          </p>

          {step0 === 'running' && (
            <div style={{ fontSize: 13.5, color: '#64748b', marginBottom: 10 }}>
              正在套用既有的行程段規則…
            </div>
          )}
          {step0 === 'done' && step0Applied > 0 && (
            <div style={{
              background: '#ecfdf5', border: '1px solid #a7f3d0', borderRadius: 10,
              padding: '9px 12px', fontSize: 13.5, marginBottom: 10,
            }}>
              已依既有行程段自動補上 {step0Applied} 張的位置
            </div>
          )}

          <div style={{
            display: 'flex', gap: 16, flexWrap: 'wrap', fontSize: 13,
            color: '#475569', marginBottom: 10,
          }}>
            <span><span style={{ color: '#b45309' }}>●</span> 沒有位置 {buckets.none.length} 張</span>
            <span><span style={{ color: '#0284c7' }}>●</span> 有座標缺地名 {buckets.unnamed.length} 張</span>
            <span><span style={{ color: '#10b981' }}>●</span> 已完成 {buckets.done.length} 張</span>
          </div>

          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            gap: 12, flexWrap: 'wrap', fontSize: 13.5, marginBottom: 12,
          }}>
            <span style={{ color: '#475569' }}>已選取 {selected.length} 張</span>
            <label style={{ display: 'flex', gap: 7, alignItems: 'center', cursor: 'pointer' }}>
              <input type="checkbox" checked={showDone} onChange={(e) => setShowDone(e.target.checked)} />
              <span>連已完成的一起顯示（要改已經指定過的就打開）</span>
            </label>
          </div>
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: '0 22px' }}>
          {days.length === 0 && (
            <p style={{ fontSize: 14, color: '#64748b', padding: '30px 0', textAlign: 'center' }}>
              {step0 === 'running' ? '' : '這本相簿的照片都有位置與地名了 🎉'}
            </p>
          )}

          {days.map(({ day, list }) => {
            const ids = list.map((p) => p.id);
            const allSel = ids.every((id) => selected.includes(id));
            return (
              <div key={day || 'no-date'} style={{ marginBottom: 18 }}>
                <div style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  position: 'sticky', top: 0, background: '#fff', padding: '6px 0',
                  borderBottom: '1px solid #f1f5f9', marginBottom: 8, zIndex: 1,
                }}>
                  <strong style={{ fontSize: 14 }}>
                    {day || '沒有拍攝時間'}
                    <span style={{ color: '#94a3b8', fontWeight: 400, fontSize: 12.5 }}>
                      {'  '}{list.length} 張
                    </span>
                  </strong>
                  <button
                    onClick={() => toggleMany(ids)}
                    style={{
                      padding: '4px 11px', borderRadius: 7, border: '1px solid #cbd5e1',
                      background: '#fff', cursor: 'pointer', fontSize: 12.5,
                    }}
                  >
                    {allSel ? '取消整天' : '選整天'}
                  </button>
                </div>

                <div style={{
                  display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(92px, 1fr))', gap: 8,
                }}>
                  {list.map((p) => {
                    const isSel = selected.includes(p.id);
                    const st = stateOf(p);
                    const badge = st === 'none'
                      ? { text: '無位置', bg: 'rgba(180,83,9,.92)' }
                      : st === 'unnamed'
                        ? { text: '缺地名', bg: 'rgba(2,132,199,.92)' }
                        : { text: p.place_name!.split(',')[0], bg: 'rgba(16,185,129,.92)' };
                    return (
                      <button
                        key={p.id}
                        onClick={() => toggle(p.id)}
                        title={`${p.title}${p.taken_at_local ? `\n${p.taken_at_local}` : ''}${p.place_name ? `\n${p.place_name}` : ''}`}
                        style={{
                          position: 'relative', padding: 0,
                          border: isSel ? '2px solid #2563eb' : '2px solid transparent',
                          borderRadius: 10, overflow: 'hidden', cursor: 'pointer',
                          background: '#f1f5f9', aspectRatio: '1 / 1', display: 'block',
                        }}
                      >
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={photoThumbSrc(p, 'sm')}
                          alt={p.title}
                          loading="lazy"
                          style={{
                            width: '100%', height: '100%', objectFit: 'cover',
                            opacity: isSel ? 1 : 0.62, display: 'block',
                            /*
                             * 遮罩開著時這裡也糊。這一格是拿來挑「哪幾張要補地點」的，
                             * 靠的是時間與地名，不是看清楚照片內容 —— 所以**這裡沒有
                             * 掀開的入口**，要看就回相簿點那一張（掀開是共用的一份，
                             * 掀完再回來這裡就是清楚的）。
                             */
                            ...(blurOf(p) ? { filter: 'blur(10px)', transform: 'scale(1.2)' } : null),
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
                        <span style={{
                          position: 'absolute', left: 0, right: 0, bottom: 0,
                          padding: '2px 5px', background: badge.bg, color: '#fff',
                          fontSize: 10.5, letterSpacing: .2,
                          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                        }}>
                          {badge.text}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>

        <div style={{ padding: '14px 22px 20px', borderTop: '1px solid #f1f5f9' }}>
          {naming && (
            <div style={{ fontSize: 13, color: '#64748b', marginBottom: 10 }}>
              反查地名中… {naming.done} / {naming.total} 個位置（刻意放慢，Photon 是免費的志工服務）
            </div>
          )}
          {nameResult && (
            <div style={{ fontSize: 13, color: '#0f766e', marginBottom: 10 }}>{nameResult}</div>
          )}
          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
            <button onClick={onClose} disabled={busy} style={btn(!busy, false)}>關閉</button>
            <button
              onClick={handleAutoName}
              disabled={namableSelected === 0 || busy}
              style={btn(namableSelected > 0 && !busy, false)}
            >
              自動補地名{namableSelected > 0 ? `（${namableSelected} 張）` : ''}
            </button>
            <button
              onClick={() => canAssign && onAssignPlace(selected)}
              disabled={!canAssign}
              style={btn(canAssign, true)}
            >
              📍 指定地點
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
