"use client";

import React, { useEffect, useState } from "react";

interface FilterBottomSheetProps {
  isOpen: boolean;
  onClose: () => void;
  children: React.ReactNode;
  activeFilterCount?: number;
  onReset?: () => void;
  title?: string;
}

export default function FilterBottomSheet({
  isOpen,
  onClose,
  children,
  activeFilterCount = 0,
  onReset,
  title
}: FilterBottomSheetProps) {
  const [rendered, setRendered] = useState(isOpen);
  const [animate, setAnimate] = useState(false);

  useEffect(() => {
    if (isOpen) {
      setRendered(true);
      const timer = setTimeout(() => setAnimate(true), 10);
      document.body.style.overflow = "hidden";
      return () => clearTimeout(timer);
    } else {
      setAnimate(false);
      const timer = setTimeout(() => {
        setRendered(false);
        document.body.style.overflow = "";
      }, 250);
      return () => clearTimeout(timer);
    }
  }, [isOpen]);

  if (!rendered) return null;

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        width: "100vw",
        height: "100vh",
        zIndex: 9999,
        background: animate ? "rgba(0, 0, 0, 0.4)" : "rgba(0, 0, 0, 0)",
        backdropFilter: animate ? "blur(6px)" : "blur(0px)",
        WebkitBackdropFilter: animate ? "blur(6px)" : "blur(0px)",
        transition: "all 0.25s cubic-bezier(0.16, 1, 0.3, 1)",
        display: "flex",
        justifyContent: "center",
        alignItems: "flex-end"
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "100%",
          maxWidth: "500px",
          background: "var(--card-bg, rgba(255, 255, 255, 0.95))",
          borderTopLeftRadius: "24px",
          borderTopRightRadius: "24px",
          border: "1px solid var(--border-color, rgba(0, 0, 0, 0.08))",
          boxShadow: "0 -10px 40px rgba(0, 0, 0, 0.2)",
          padding: "20px 24px 36px 24px",
          boxSizing: "border-box",
          transform: animate ? "translateY(0)" : "translateY(100%)",
          transition: "transform 0.28s cubic-bezier(0.16, 1, 0.3, 1)",
          backdropFilter: "blur(20px)",
          WebkitBackdropFilter: "blur(20px)",
          maxHeight: "85vh",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden"
        }}
      >
        {/* 滑動握把條 */}
        <div style={{ display: "flex", justifyContent: "center", marginBottom: "12px", flexShrink: 0 }}>
          <div style={{ width: "40px", height: "5px", borderRadius: "3px", background: "rgba(0, 0, 0, 0.15)" }} />
        </div>

        {/* 標題欄位 */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px", flexShrink: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <h3 style={{ margin: 0, fontSize: "1.15rem", fontWeight: 600, color: "var(--text-color, #111)" }}>
              {title || "篩選與排序"}
            </h3>
            {activeFilterCount !== undefined && activeFilterCount > 0 && (
              <span
                style={{
                  background: "var(--accent-color, #d1bfae)",
                  color: "#fff",
                  fontSize: "0.75rem",
                  padding: "2px 8px",
                  borderRadius: "12px",
                  fontWeight: 600
                }}
              >
                {activeFilterCount}
              </span>
            )}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
            {onReset && (
              <button
                type="button"
                onClick={onReset}
                style={{
                  background: "none",
                  border: "none",
                  color: "var(--text-light, #888)",
                  fontSize: "0.85rem",
                  cursor: "pointer",
                  padding: "4px 8px"
                }}
              >
                重設
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              style={{
                background: "rgba(0, 0, 0, 0.05)",
                border: "none",
                borderRadius: "50%",
                width: "30px",
                height: "30px",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: "1.2rem",
                color: "#666",
                cursor: "pointer"
              }}
            >
              ×
            </button>
          </div>
        </div>

        {/* 內容區：極致順暢滾動，底部留足 Safe Area 緩衝 space */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "18px",
            alignItems: "center",
            textAlign: "center",
            overflowY: "auto",
            WebkitOverflowScrolling: "touch",
            maxHeight: "calc(80vh - 80px)",
            paddingBottom: "70px"
          }}
        >
          {children}
        </div>
      </div>
    </div>
  );
}
