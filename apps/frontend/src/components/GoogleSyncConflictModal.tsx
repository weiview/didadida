"use client";

import React, { useState } from 'react';

interface PhotoData {
  id?: number;
  url: string;
  created_at?: string;
  taken_at?: string;
}

interface GoogleSyncConflictModalProps {
  isOpen: boolean;
  tempPhoto: PhotoData;
  existingPhotos: PhotoData[];
  onResolve: (decision: "keep_both" | "replace", replacePhotoIds?: number[]) => void;
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
  /** 正在處理這張（上傳／取代），把按鈕鎖起來 */
  busy?: boolean;
}

export default function GoogleSyncConflictModal({
  isOpen, tempPhoto, existingPhotos, onResolve, onSkip, counter, busy
}: GoogleSyncConflictModalProps) {
  const [decision, setDecision] = useState<"keep_both" | "replace" | null>(null);
  const [selectedPhotoIds, setSelectedPhotoIds] = useState<number[]>([]);

  // 換下一張時把上一張的選擇清掉，不然勾選會沿用到不相干的照片上
  const photoKey = `${tempPhoto?.url || ''}|${counter?.current ?? ''}`;
  const [lastKey, setLastKey] = useState(photoKey);
  if (lastKey !== photoKey) {
    setLastKey(photoKey);
    setDecision(null);
    setSelectedPhotoIds([]);
  }

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
        <h3 style={{ margin: '0 0 15px 0', fontSize: '1.15rem', color: 'var(--text-color)', lineHeight: '1.4' }}>
          此相簿中找到多個可能重複的版本。請問您想怎麼處理？
          {counter && (
            <span style={{ marginLeft: 8, fontSize: '0.9rem', color: 'var(--text-light)', fontWeight: 400 }}>
              （第 {counter.current} / {counter.total} 張）
            </span>
          )}
        </h3>
        
        <div style={{ display: 'flex', flexDirection: 'row', flexWrap: 'wrap', gap: '20px', marginBottom: '20px' }}>
          {/* 準備匯入的新照片 */}
          <div style={{ flex: '1 1 200px', minWidth: '150px' }}>
            <h4 style={{ marginBottom: '10px', fontSize: '0.95rem' }}>準備匯入的新照片</h4>
            <div style={{ border: '2px solid var(--accent-color)', borderRadius: '10px', overflow: 'hidden' }}>
              <img src={tempPhoto.url} style={{ width: '100%', maxHeight: '200px', objectFit: 'cover', display: 'block' }} alt="New" />
            </div>
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
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(100px, 1fr))', gap: '10px' }}>
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
                  <img src={p.url} style={{ width: '100%', height: '100px', objectFit: 'cover', display: 'block' }} alt="Existing" />
                  <div style={{ padding: '4px', fontSize: '0.75rem', textAlign: 'center', background: 'rgba(0,0,0,0.05)' }}>
                    {decision === 'replace' && isSelected ? '準備被取代' : '點擊選取'}
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
              disabled={busy}
              style={{
                padding: '10px 22px', borderRadius: '25px', background: 'transparent',
                border: '1px solid var(--border-color)', color: 'var(--text-light)',
                cursor: busy ? 'not-allowed' : 'pointer', fontSize: '0.95rem',
              }}
            >
              略過這張
            </button>
          )}
          <button
            onClick={handleConfirm}
            disabled={busy || !decision || (decision === 'replace' && selectedPhotoIds.length === 0)}
            style={{
              padding: '10px 30px', borderRadius: '25px',
              background: (!decision || (decision === 'replace' && selectedPhotoIds.length === 0)) ? '#ccc' : 'var(--accent-color)',
              color: 'white', border: 'none', cursor: (!decision || (decision === 'replace' && selectedPhotoIds.length === 0)) ? 'not-allowed' : 'pointer',
              fontSize: '1rem', fontWeight: 'bold'
            }}
          >
            {busy ? '處理中...' : '確認'}
          </button>
        </div>
      </div>
    </div>
  );
}
