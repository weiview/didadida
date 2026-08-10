"use client";

import React, { useState, useRef, useEffect } from 'react';

interface SlideConfirmModalProps {
  isOpen: boolean;
  title?: string;
  message?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export default function SlideConfirmModal({
  isOpen,
  title = "確認刪除",
  message = "確定要執行刪除動作嗎？",
  onConfirm,
  onCancel
}: SlideConfirmModalProps) {
  const [sliderPosition, setSliderPosition] = useState(0);
  /**
   * 已完成的比例（0～1），底下那條填色用的。
   *
   * 不能直接拿 `sliderPosition` 當寬度：滑塊的 left 是它**左緣**的位置，
   * 起點 0 對應的填色卻要是 0、終點對應的要是滿版。之前用
   * `27px + sliderPosition` 去湊（7px 內距 + 半顆滑塊），結果沒動就先亮一截、
   * 滑到底又差 23px 到不了底。位置與比例是兩件事，分開存最省事。
   */
  const [progress, setProgress] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const [isConfirmed, setIsConfirmed] = useState(false);

  const sliderRef = useRef<HTMLDivElement>(null);
  const thumbRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (isOpen) {
      setSliderPosition(0);
      setProgress(0);
      setIsConfirmed(false);
      setIsDragging(false);
    }
  }, [isOpen]);

  const handlePointerDown = (e: React.PointerEvent) => {
    if (isConfirmed) return;
    setIsDragging(true);
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (!isDragging || !sliderRef.current || !thumbRef.current || isConfirmed) return;
    
    const sliderRect = sliderRef.current.getBoundingClientRect();
    const thumbWidth = thumbRef.current.offsetWidth;
    const maxPosition = sliderRect.width - thumbWidth - 10; // 10px padding total
    if (maxPosition <= 0) return;

    let newPosition = e.clientX - sliderRect.left - (thumbWidth / 2);

    if (newPosition < 0) newPosition = 0;
    if (newPosition > maxPosition) newPosition = maxPosition;

    // 過門檻就直接把滑塊補到底：解鎖了卻停在 95% 的位置，看起來像沒滑完
    if (newPosition >= maxPosition * 0.95) {
      setSliderPosition(maxPosition);
      setProgress(1);
      setIsConfirmed(true);
      setIsDragging(false);
      return;
    }

    setSliderPosition(newPosition);
    setProgress(newPosition / maxPosition);
  };

  const handlePointerUp = (e: React.PointerEvent) => {
    if (isConfirmed) return;
    setIsDragging(false);
    if (!isConfirmed) {
      setSliderPosition(0);
      setProgress(0);
    }
    (e.target as HTMLElement).releasePointerCapture(e.pointerId);
  };

  if (!isOpen) return null;

  return (
    <div style={{
      position: 'fixed', top: 0, left: 0, width: '100vw', height: '100vh',
      backgroundColor: 'rgba(255, 255, 255, 0.7)',
      backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)',
      zIndex: 10000,
      display: 'flex', alignItems: 'center', justifyContent: 'center'
    }} onClick={onCancel}>
      <div style={{
        backgroundColor: 'var(--card-bg)', borderRadius: '20px', padding: '30px',
        width: '400px', maxWidth: '90%', textAlign: 'center',
        border: '1px solid var(--border-color)', boxShadow: '0 20px 40px rgba(0,0,0,0.1)'
      }} onClick={e => e.stopPropagation()}>
        <h3 style={{ margin: '0 0 15px 0', color: '#e57373', fontSize: '1.5rem', fontWeight: 500 }}>{title}</h3>
        <p style={{ color: 'var(--text-light)', marginBottom: '30px', fontSize: '1rem' }}>{message}</p>
        
        <div 
          ref={sliderRef}
          style={{
            position: 'relative', width: '100%', height: '54px',
            backgroundColor: 'rgba(0,0,0,0.03)', borderRadius: '30px', overflow: 'hidden',
            display: 'flex', alignItems: 'center', padding: '0 7px',
            touchAction: 'none', border: '1px solid var(--border-color)'
          }}
        >
          <div style={{
            position: 'absolute', width: '100%', left: 0, textAlign: 'center',
            color: 'var(--text-light)', userSelect: 'none', pointerEvents: 'none',
            fontSize: '0.95rem', fontWeight: 500
          }}>
            {isConfirmed ? '已解鎖！請點擊確定刪除' : '向右滑動以解鎖刪除'}
          </div>
          
          <div
            ref={thumbRef}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerUp}
            style={{
              position: 'absolute', left: `calc(7px + ${sliderPosition}px)`,
              width: '40px', height: '40px', borderRadius: '50%',
              backgroundColor: isConfirmed ? '#81c784' : '#e57373',
              cursor: isConfirmed ? 'default' : 'grab',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              boxShadow: '0 2px 8px rgba(0,0,0,0.15)',
              transition: isDragging ? 'none' : 'left 0.3s ease, background-color 0.3s',
              zIndex: 2, touchAction: 'none'
            }}
          >
            {isConfirmed ? (
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20 6 9 17 4 12"></polyline>
              </svg>
            ) : (
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="9 18 15 12 9 6"></polyline>
              </svg>
            )}
          </div>
          
          <div style={{
            position: 'absolute', top: 0, left: 0, height: '100%',
            width: `${progress * 100}%`,
            backgroundColor: isConfirmed ? 'rgba(129, 199, 132, 0.2)' : 'rgba(229, 115, 115, 0.15)',
            transition: isDragging ? 'none' : 'width 0.3s ease',
            zIndex: 1
          }}></div>
        </div>
        
        <div style={{ marginTop: '25px', display: 'flex', justifyContent: 'center', gap: '15px' }}>
          <button 
            onClick={onCancel}
            style={{
              padding: '0.75rem 1.5rem', background: 'transparent',
              border: '1px solid var(--border-color)', color: 'var(--text-light)', cursor: 'pointer', fontSize: '1rem',
              borderRadius: '2rem', transition: 'all 0.2s ease', flex: 1
            }}
            onMouseOver={(e) => e.currentTarget.style.background = 'rgba(0,0,0,0.03)'}
            onMouseOut={(e) => e.currentTarget.style.background = 'transparent'}
          >
            取消
          </button>
          <button
            onClick={onConfirm}
            disabled={!isConfirmed}
            style={{
              padding: '0.75rem 1.5rem', background: isConfirmed ? '#e57373' : 'rgba(0,0,0,0.05)',
              border: 'none', color: isConfirmed ? '#fff' : 'var(--text-light)', cursor: isConfirmed ? 'pointer' : 'not-allowed',
              fontSize: '1rem', borderRadius: '2rem', flex: 1,
              transition: 'all 0.3s ease', boxShadow: isConfirmed ? '0 4px 15px rgba(229, 115, 115, 0.3)' : 'none'
            }}
            onMouseOver={(e) => { if (isConfirmed) e.currentTarget.style.background = '#d32f2f'; }}
            onMouseOut={(e) => { if (isConfirmed) e.currentTarget.style.background = '#e57373'; }}
          >
            確定刪除
          </button>
        </div>
      </div>
    </div>
  );
}
