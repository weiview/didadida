'use client';

import { useEffect, useMemo, useState } from 'react';
import { fetchGuestAlbums, updateGuestAlbums, type GuestAlbumOption } from '@/lib/api';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  /** 存好之後回報「現在有幾本是開放的」，讓後台那一格寫得出一句話 */
  onSaved: (visibleCount: number) => void;
}

/**
 * 訪客看得到哪幾本相簿（`Album.guest_visible`，0027）。
 *
 * **白名單語意：預設看不到，勾起來才給看**（使用者 2026-09-07 拍板）。所以新建的
 * 相簿一律是關的 —— 忘了回來勾就是訪客看不到，那個方向的錯誤是安全的。
 *
 * ⚠️ 清單是**在視窗打開的當下才抓**，不是進 /admin 就抓：後台平常是來加人、
 *    改權限的，而這一格幾個月才動一次（同 Drive 比對那一格的規矩）。
 *
 * ⚠️ 存的是**完整清單不是差異** —— 沒勾的一律關掉。所以送出之前一定要真的抓過一次，
 *    不然會拿一份空的清單去覆蓋掉站長原本勾好的。
 */
export default function GuestAlbumsModal({ isOpen, onClose, onSaved }: Props) {
  const [albums, setAlbums] = useState<GuestAlbumOption[] | null>(null);
  const [checked, setChecked] = useState<Set<number>>(new Set());
  const [keyword, setKeyword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    let alive = true;
    setAlbums(null);
    setKeyword('');
    setError(null);
    setBusy(false);
    fetchGuestAlbums()
      .then((list) => {
        if (!alive) return;
        setAlbums(list);
        setChecked(new Set(list.filter((a) => a.guest_visible === 1).map((a) => a.id)));
      })
      .catch((e: any) => {
        if (!alive) return;
        setAlbums([]);
        setError(e.message || '讀取相簿清單失敗');
      });
    return () => { alive = false; };
  }, [isOpen]);

  // 過濾只在記憶體裡做（相簿是幾十列的小表，整份都在手上了）
  const shown = useMemo(() => {
    const k = keyword.trim().toLowerCase();
    if (!k || !albums) return albums ?? [];
    return albums.filter((a) => (a.name || '').toLowerCase().includes(k));
  }, [albums, keyword]);

  if (!isOpen) return null;

  const toggle = (id: number) => {
    // ⚠️ 一定要做一份新的 Set 再換掉 —— React 比的是參考，就地 add 不會重畫
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  /** 全選／全不選只作用在**篩選後看得到的那幾本**，不然打了關鍵字還會動到看不見的列 */
  const setAllShown = (on: boolean) => {
    setChecked((prev) => {
      const next = new Set(prev);
      for (const a of shown) {
        if (on) next.add(a.id);
        else next.delete(a.id);
      }
      return next;
    });
  };

  const save = async () => {
    if (busy || albums === null) return;
    setBusy(true);
    setError(null);
    const result = await updateGuestAlbums(Array.from(checked));
    setBusy(false);
    if (!result.success) return setError(result.message || '存檔失敗');
    onSaved((result.albums ?? []).filter((a) => a.guest_visible === 1).length);
    onClose();
  };

  const btn = (label: string, onClick: () => void, primary = false) => (
    <button
      onClick={onClick}
      disabled={busy}
      style={{
        padding: '9px 18px', borderRadius: 8,
        border: primary ? 'none' : '1px solid #cbd5e1',
        background: primary ? '#2563eb' : '#fff',
        color: primary ? '#fff' : '#0f172a',
        cursor: busy ? 'not-allowed' : 'pointer', fontSize: 14,
      }}
    >
      {label}
    </button>
  );

  return (
    <div
      onClick={busy ? undefined : onClose}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,.5)', zIndex: 4000,
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: '#fff', borderRadius: 14, width: '100%', maxWidth: 520,
          maxHeight: '88vh', display: 'flex', flexDirection: 'column',
          overflow: 'hidden', color: '#0f172a',
        }}
      >
        <div style={{ padding: '20px 22px 12px', borderBottom: '1px solid #e2e8f0' }}>
          <h3 style={{ margin: '0 0 4px', fontSize: 18 }}>訪客看得到哪幾本相簿</h3>
          <p style={{ margin: '0 0 12px', fontSize: 12.5, color: '#64748b', lineHeight: 1.6 }}>
            勾起來的才給訪客看，其餘的在他眼中整本不存在（相簿列表、搜尋與足跡地圖都不會出現）。
            新建的相簿預設是關的，開放前記得回來勾。
          </p>
          <input
            type="text"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            placeholder="篩選相簿名稱"
            style={{
              width: '100%', padding: '8px 10px', borderRadius: 8,
              border: '1px solid #cbd5e1', fontSize: 14, boxSizing: 'border-box',
            }}
          />
          <div style={{ display: 'flex', gap: 14, marginTop: 10, fontSize: 13 }}>
            <button
              onClick={() => setAllShown(true)}
              disabled={busy || shown.length === 0}
              style={{ border: 'none', background: 'none', color: '#2563eb', cursor: 'pointer', padding: 0, fontSize: 13 }}
            >
              全部勾選
            </button>
            <button
              onClick={() => setAllShown(false)}
              disabled={busy || shown.length === 0}
              style={{ border: 'none', background: 'none', color: '#2563eb', cursor: 'pointer', padding: 0, fontSize: 13 }}
            >
              全部取消
            </button>
            <span style={{ marginLeft: 'auto', color: '#64748b' }}>
              已開放 {checked.size} 本
            </span>
          </div>
        </div>

        <div style={{ flex: '1 1 auto', overflowY: 'auto', padding: '6px 22px' }}>
          {albums === null && (
            <p style={{ fontSize: 13, color: '#64748b', padding: '14px 0' }}>載入中…</p>
          )}
          {albums !== null && shown.length === 0 && (
            <p style={{ fontSize: 13, color: '#64748b', padding: '14px 0' }}>
              {albums.length === 0 ? '站上還沒有相簿。' : '沒有符合的相簿。'}
            </p>
          )}
          {shown.map((a) => (
            <label
              key={a.id}
              style={{
                display: 'flex', alignItems: 'center', gap: 10, padding: '9px 0',
                borderTop: '1px solid #f1f5f9', fontSize: 14, cursor: 'pointer',
              }}
            >
              <input
                type="checkbox"
                checked={checked.has(a.id)}
                disabled={busy}
                onChange={() => toggle(a.id)}
              />
              <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {a.name || `（沒有名字的相簿 #${a.id}）`}
              </span>
            </label>
          ))}
        </div>

        <div style={{ flex: 'none', padding: '14px 22px', borderTop: '1px solid #e2e8f0' }}>
          {error && <p style={{ fontSize: 13, color: '#b91c1c', margin: '0 0 10px' }}>{error}</p>}
          <p style={{ fontSize: 12, color: '#64748b', margin: '0 0 12px', lineHeight: 1.6 }}>
            關掉一本相簿之後，訪客要重新整理才會消失；已經載到他瀏覽器裡的縮圖網址仍然開得起來。
          </p>
          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
            {btn('取消', onClose)}
            {btn(busy ? '儲存中…' : '儲存', save, true)}
          </div>
        </div>
      </div>
    </div>
  );
}
