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
}

export default function GoogleSyncConflictModal({
  isOpen, tempPhoto, existingPhotos, onResolve
}: GoogleSyncConflictModalProps) {
  const [decision, setDecision] = useState<"keep_both" | "replace" | null>(null);
  const [selectedPhotoIds, setSelectedPhotoIds] = useState<number[]>([]);

  if (!isOpen) return null;

  const handleConfirm = () => {
    if (decision === "keep_both") {
      onResolve("keep_both");
    } else if (decision === "replace" && selectedPhotoIds.length > 0) {
      onResolve("replace", selectedPhotoIds);
    }
  };

  return (
    <div style={{
      position: 'fixed', top: 0, left: 0, width: '100vw', height: '100vh',
      backgroundColor: 'rgba(255,255,255,0.7)', backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)',
      zIndex: 10001, display: 'flex', alignItems: 'center', justifyContent: 'center'
    }}>
      <div style={{
        backgroundColor: 'var(--card-bg)', borderRadius: '20px', padding: '30px',
        width: '700px', maxWidth: '95%',
        border: '1px solid var(--border-color)', boxShadow: '0 20px 40px rgba(0,0,0,0.1)',
        maxHeight: '90vh', overflowY: 'auto'
      }}>
        <h3 style={{ margin: '0 0 15px 0', fontSize: '1.25rem', color: 'var(--text-color)' }}>
          此相簿中找到多個可能重複的版本。請問您想怎麼處理？
        </h3>
        
        <div style={{ display: 'flex', gap: '20px', marginBottom: '20px' }}>
          {/* 準備匯入的新照片 */}
          <div style={{ flex: 1 }}>
            <h4 style={{ marginBottom: '10px' }}>準備匯入的新照片</h4>
            <div style={{ border: '2px solid var(--accent-color)', borderRadius: '10px', overflow: 'hidden' }}>
              <img src={tempPhoto.url} style={{ width: '100%', display: 'block' }} alt="New" />
            </div>
          </div>
          
          {/* 已存在的照片 */}
          <div style={{ flex: 2 }}>
            <h4 style={{ marginBottom: '10px' }}>相簿中已存在的版本 (共 {existingPhotos.length} 張)</h4>
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
                  <img src={p.url} style={{ width: '100%', height: '120px', objectFit: 'cover', display: 'block' }} alt="Existing" />
                  <div style={{ padding: '5px', fontSize: '0.8rem', textAlign: 'center', background: 'rgba(0,0,0,0.05)' }}>
                    {decision === 'replace' && isSelected ? '準備被取代' : '點擊選取'}
                  </div>
                </div>
              )})}
            </div>
          </div>
        </div>

        <div style={{ display: 'flex', gap: '15px', marginTop: '20px' }}>
          <button
            onClick={() => setDecision("keep_both")}
            style={{
              flex: 1, padding: '12px', borderRadius: '10px',
              background: decision === 'keep_both' ? 'var(--accent-color)' : 'transparent',
              color: decision === 'keep_both' ? '#fff' : 'var(--text-color)',
              border: `2px solid var(--accent-color)`,
              cursor: 'pointer', fontSize: '1rem', fontWeight: 'bold'
            }}
          >
            全部保留 (都存下來)
          </button>
        </div>

        <div style={{ marginTop: '30px', textAlign: 'right' }}>
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
    </div>
  );
}
