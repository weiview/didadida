"use client";

import React, { useEffect, useState } from 'react';

interface PhotoData {
  id?: number;
  url: string;
  created_at?: string;
  taken_at?: string;
  /**
   * 原始檔名。**一定要顯示** —— 縮到 100px 的兩張縮圖長得幾乎一樣，
   * 檔名才是使用者當場判斷得了的線索。
   */
  name?: string;
  /**
   * 點右上角 🔍 放大時要載的那張（站上那份是 800px）。沒給就退回 `url`。
   * ⚠️ 刻意不用 `/full`（Drive 那份 4K）：每點一次就是一趟 Drive 取檔。
   */
  largeUrl?: string;
  /** 這一列跟手上這個檔是**位元組層級**的同一份（特徵碼一樣） */
  sameFile?: boolean;
}

interface GoogleSyncConflictModalProps {
  isOpen: boolean;
  tempPhoto: PhotoData;
  existingPhotos: PhotoData[];
  onResolve: (decision: "keep_both" | "replace", replacePhotoIds?: number[]) => void;
  /**
   * 為什麼判定重複。`same_file` ＝ 特徵碼一樣（**確定**是同一個檔）、
   * `same_time` ＝ 特徵碼對不上、只有拍攝時間一樣（**疑似**）。
   *
   * 兩者要使用者做的事完全不同，所以標題那句話跟著它換：確定的直接處理掉，
   * 疑似的要他放大看一眼再決定（連拍很容易撞在同一秒）。
   */
  reason?: 'same_file' | 'same_time';
  /**
   * 本機上傳走這條路時多一顆「略過這張」。
   *
   * Google 匯入沒有這個選項是因為照片是使用者在 Picker 裡一張一張挑的；
   * 本機上傳常常是整個資料夾拖進來，裡面混到已經傳過的很正常，
   * 「這張不要了」必須是一個按得到的出口。給了才顯示，不影響 Google 那條路。
   */
  onSkip?: () => void;
  /** 一批有好幾張撞到時顯示「第 N / M 張」，不然使用者不知道還要按幾次 */
  counter?: { current: number; total: number };
  /**
   * 「背景處理中 N 張」。
   *
   * ⚠️ 這裡**刻意不再有 `busy` 那種鎖住按鈕的狀態** —— 按下確認之後上傳是排在
   * 背景那條鏈上做的，畫面當場跳下一張，使用者不必等。這行字只是告訴他
   * 「還有幾張在後面跑」，不是要他停下來。
   */
  backgroundNote?: string;
}

export default function GoogleSyncConflictModal({
  isOpen, tempPhoto, existingPhotos, onResolve, onSkip, counter, backgroundNote, reason
}: GoogleSyncConflictModalProps) {
  const [decision, setDecision] = useState<"keep_both" | "replace" | null>(null);
  const [selectedPhotoIds, setSelectedPhotoIds] = useState<number[]>([]);
  /**
   * 放大來看的那一張。**「是不是同一張」靠 100px 的縮圖是看不出來的**，
   * 而這個視窗要使用者做的正是這個判斷。
   *
   * ⚠️ 刻意不接既有的 PhotoLightbox：那支要的是一列真的 `Photo`（留言、EXIF、
   * 上下一張都掛在上面），而左邊那張「準備匯入的新照片」在站上根本還不存在。
   */
  const [zoom, setZoom] = useState<{ url: string; name?: string } | null>(null);

  // 換下一張時把上一張的選擇清掉，不然勾選會沿用到不相干的照片上
  const photoKey = `${tempPhoto?.url || ''}|${counter?.current ?? ''}`;
  const [lastKey, setLastKey] = useState(photoKey);
  if (lastKey !== photoKey) {
    setLastKey(photoKey);
    setDecision(null);
    setSelectedPhotoIds([]);
    setZoom(null);
  }

  // Esc 關掉放大（沒放大時不攔，讓它留給外層）
  useEffect(() => {
    if (!zoom) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setZoom(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [zoom]);

  if (!isOpen) return null;

  const handleConfirm = () => {
    if (decision === "keep_both") {
      onResolve("keep_both");
    } else if (decision === "replace" && selectedPhotoIds.length > 0) {
      onResolve("replace", selectedPhotoIds);
    }
  };

  const isAllSelected = existingPhotos.length > 0 && selectedPhotoIds.length === existingPhotos.length;

  const handleSelectAll = () => {
    setDecision("replace");
    if (isAllSelected) {
      setSelectedPhotoIds([]);
    } else {
      setSelectedPhotoIds(existingPhotos.map(p => p.id!).filter(Boolean));
    }
  };

  /**
   * 縮圖右上角那顆放大鏡。
   *
   * ⚠️ 放大**不能**綁在整格的點擊上 —— 右邊那幾格的點擊早就是「選它來被取代」了，
   * 搶過來會讓原本的操作沒得按。所以另外給一顆按鈕，並且 stopPropagation。
   */
  const zoomButton = (p: PhotoData) => (
    <button
      type="button"
      title="放大看"
      aria-label="放大看"
      onClick={(e) => { e.stopPropagation(); setZoom({ url: p.largeUrl || p.url, name: p.name }); }}
      style={{
        position: 'absolute', top: '5px', right: '5px', width: '28px', height: '28px',
        borderRadius: '50%', border: 'none', background: 'rgba(0,0,0,0.55)', color: '#fff',
        fontSize: '0.85rem', lineHeight: '28px', padding: 0, cursor: 'zoom-in',
      }}
    >
      🔍
    </button>
  );

  return (
    <div style={{
      position: 'fixed', top: 0, left: 0, width: '100vw', height: '100vh',
      backgroundColor: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)',
      zIndex: 10001, display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: '15px', boxSizing: 'border-box'
    }}>
      <div style={{
        backgroundColor: 'var(--card-bg)', borderRadius: '20px', padding: '20px',
        width: '700px', maxWidth: '100%',
        border: '1px solid var(--border-color)', boxShadow: '0 20px 40px rgba(0,0,0,0.2)',
        maxHeight: '90vh', overflowY: 'auto', boxSizing: 'border-box'
      }}>
        <h3 style={{ margin: '0 0 6px 0', fontSize: '1.15rem', color: 'var(--text-color)', lineHeight: '1.4' }}>
          {reason === 'same_file'
            ? '這個檔跟相簿裡已經有的那張特徵碼一樣（確定是同一個檔）'
            : '特徵碼對不上，但拍攝時間一樣 —— 可能是同一張'}
          {counter && (
            <span style={{ marginLeft: 8, fontSize: '0.9rem', color: 'var(--text-light)', fontWeight: 400 }}>
              （第 {counter.current} / {counter.total} 張）
            </span>
          )}
          {backgroundNote && (
            <span style={{ marginLeft: 8, fontSize: '0.85rem', color: 'var(--accent-color)', fontWeight: 400 }}>
              · {backgroundNote}
            </span>
          )}
        </h3>
        <p style={{ margin: '0 0 15px 0', fontSize: '0.85rem', color: 'var(--text-light)', lineHeight: '1.5' }}>
          {reason === 'same_file'
            ? '要留兩份還是取代掉舊的？不要的話按「略過這張」。'
            : '連拍很容易撞在同一秒，不一定是同一張。'}
          {' '}縮圖右上角的 <strong>🔍</strong> 可以放大看，比對完再決定。
        </p>

        <div style={{ display: 'flex', flexDirection: 'row', flexWrap: 'wrap', gap: '20px', marginBottom: '20px' }}>
          {/* 準備匯入的新照片 */}
          <div style={{ flex: '1 1 200px', minWidth: '150px' }}>
            <h4 style={{ marginBottom: '10px', fontSize: '0.95rem' }}>準備匯入的新照片</h4>
            <div style={{
              border: '2px solid var(--accent-color)', borderRadius: '10px',
              overflow: 'hidden', position: 'relative',
            }}>
              {/* 這一格沒有選取的語意，所以整張點下去就是放大 */}
              <img
                src={tempPhoto.url}
                onClick={() => setZoom({ url: tempPhoto.largeUrl || tempPhoto.url, name: tempPhoto.name })}
                style={{
                  width: '100%', maxHeight: '200px', objectFit: 'cover',
                  display: 'block', cursor: 'zoom-in',
                }}
                alt="New"
              />
              {zoomButton(tempPhoto)}
            </div>
            {tempPhoto.name && (
              <div
                title={tempPhoto.name}
                style={{
                  marginTop: '6px', fontSize: '0.8rem', color: 'var(--text-color)',
                  wordBreak: 'break-all', lineHeight: '1.35',
                }}
              >
                {tempPhoto.name}
              </div>
            )}
          </div>

          {/* 已存在的照片 */}
          <div style={{ flex: '2 1 280px', minWidth: '200px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px', flexWrap: 'wrap', gap: '5px' }}>
              <h4 style={{ margin: 0, fontSize: '0.95rem' }}>相簿中已存在的版本 (共 {existingPhotos.length} 張)</h4>
              {existingPhotos.length > 0 && (
                <button
                  type="button"
                  onClick={handleSelectAll}
                  style={{
                    background: isAllSelected ? 'var(--accent-color)' : 'transparent',
                    color: isAllSelected ? '#fff' : 'var(--accent-color)',
                    border: '1px solid var(--accent-color)',
                    borderRadius: '12px',
                    padding: '4px 10px',
                    fontSize: '0.8rem',
                    cursor: 'pointer',
                    fontWeight: 'bold'
                  }}
                >
                  {isAllSelected ? "取消全選" : "全選"}
                </button>
              )}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))', gap: '10px' }}>
              {existingPhotos.map(p => {
                const isSelected = selectedPhotoIds.includes(p.id!);
                return (
                <div
                  key={p.id}
                  style={{
                    border: decision === 'replace' && isSelected ? '3px solid #e57373' : '1px solid var(--border-color)',
                    borderRadius: '8px', overflow: 'hidden', cursor: 'pointer',
                    opacity: decision === 'replace' && selectedPhotoIds.length > 0 && !isSelected ? 0.5 : 1,
                    position: 'relative'
                  }}
                  onClick={() => {
                    setDecision("replace");
                    setSelectedPhotoIds(prev => {
                      if (prev.includes(p.id!)) {
                        return prev.filter(id => id !== p.id!);
                      } else {
                        return [...prev, p.id!];
                      }
                    });
                  }}
                >
                  <input
                    type="checkbox"
                    checked={isSelected}
                    style={{ position: 'absolute', top: '5px', left: '5px', width: '20px', height: '20px', cursor: 'pointer' }}
                    readOnly
                  />
                  {zoomButton(p)}
                  <img src={p.url} style={{ width: '100%', height: '100px', objectFit: 'cover', display: 'block' }} alt="Existing" />
                  <div style={{ padding: '4px', fontSize: '0.72rem', textAlign: 'center', background: 'rgba(0,0,0,0.05)' }}>
                    <div
                      title={p.name || undefined}
                      style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
                    >
                      {p.name || `#${p.id}`}
                    </div>
                    <div style={{ color: 'var(--text-light)' }}>
                      {decision === 'replace' && isSelected
                        ? '準備被取代'
                        : (p.sameFile ? '特徵碼一樣' : '時間一樣')}
                    </div>
                  </div>
                </div>
              )})}
            </div>
          </div>
        </div>

        <div style={{ display: 'flex', gap: '10px', marginTop: '15px', flexWrap: 'wrap' }}>
          <button
            onClick={() => setDecision("keep_both")}
            style={{
              flex: 1, minWidth: '140px', padding: '10px', borderRadius: '10px',
              background: decision === 'keep_both' ? 'var(--accent-color)' : 'transparent',
              color: decision === 'keep_both' ? '#fff' : 'var(--text-color)',
              border: `2px solid var(--accent-color)`,
              cursor: 'pointer', fontSize: '0.95rem', fontWeight: 'bold'
            }}
          >
            全部保留 (都存下來)
          </button>
        </div>

        <div style={{ marginTop: '20px', display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: '12px' }}>
          {onSkip && (
            <button
              type="button"
              onClick={onSkip}
              style={{
                padding: '10px 22px', borderRadius: '25px', background: 'transparent',
                border: '1px solid var(--border-color)', color: 'var(--text-light)',
                cursor: 'pointer', fontSize: '0.95rem',
              }}
            >
              略過這張
            </button>
          )}
          <button
            onClick={handleConfirm}
            disabled={!decision || (decision === 'replace' && selectedPhotoIds.length === 0)}
            style={{
              padding: '10px 30px', borderRadius: '25px',
              background: (!decision || (decision === 'replace' && selectedPhotoIds.length === 0)) ? '#ccc' : 'var(--accent-color)',
              color: 'white', border: 'none', cursor: (!decision || (decision === 'replace' && selectedPhotoIds.length === 0)) ? 'not-allowed' : 'pointer',
              fontSize: '1rem', fontWeight: 'bold'
            }}
          >
            確認
          </button>
        </div>
      </div>

      {/*
        放大檢視。⚠️ z-index 要比視窗本身高，不然放大的圖會被視窗蓋住；
        點任何地方（含圖片本身）都關掉 —— 這裡不需要第二層操作。
      */}
      {zoom && (
        <div
          onClick={() => setZoom(null)}
          style={{
            position: 'fixed', top: 0, left: 0, width: '100vw', height: '100vh',
            zIndex: 10002, background: 'rgba(0,0,0,0.92)', cursor: 'zoom-out',
            display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
            padding: '20px', boxSizing: 'border-box', gap: '10px',
          }}
        >
          <img
            src={zoom.url}
            alt=""
            style={{ maxWidth: '100%', maxHeight: 'calc(100% - 50px)', objectFit: 'contain' }}
          />
          <div style={{ color: '#fff', fontSize: '0.85rem', textAlign: 'center', wordBreak: 'break-all' }}>
            {zoom.name}
            <span style={{ opacity: 0.6, marginLeft: zoom.name ? 8 : 0 }}>點任何地方關閉</span>
          </div>
        </div>
      )}
    </div>
  );
}
