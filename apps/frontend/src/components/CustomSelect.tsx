"use client";

import React, { useState, useRef, useEffect } from "react";

export interface CustomSelectOption<T> {
  value: T;
  label: string;
  icon?: React.ReactNode;
}

interface CustomSelectProps<T> {
  options: CustomSelectOption<T>[];
  value: T | T[];
  onChange: (value: any) => void;
  placeholder?: string;
  className?: string;
  icon?: React.ReactNode;
  isMulti?: boolean;
}

export default function CustomSelect<T extends string | number>({
  options,
  value,
  onChange,
  placeholder = "請選擇",
  icon,
  isMulti = false
}: CustomSelectProps<T>) {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const selectedValues: T[] = isMulti
    ? (Array.isArray(value) ? value : [])
    : [];

  const selectedOption = !isMulti
    ? options.find(opt => opt.value === value)
    : null;

  const isAllSelected = isMulti && options.length > 0 && selectedValues.length === options.length;

  const [openUpward, setOpenUpward] = useState(false);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    if (isOpen) {
      document.addEventListener("mousedown", handleClickOutside);
      if (containerRef.current) {
        const rect = containerRef.current.getBoundingClientRect();
        const spaceBelow = window.innerHeight - rect.bottom;
        if (spaceBelow < 220 && rect.top > 220) {
          setOpenUpward(true);
        } else {
          setOpenUpward(false);
        }
      }
    }
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [isOpen]);

  const handleToggleOption = (val: T) => {
    if (!isMulti) {
      onChange(val);
      setIsOpen(false);
      return;
    }

    let nextSelected: T[];
    if (selectedValues.includes(val)) {
      nextSelected = selectedValues.filter(v => v !== val);
    } else {
      nextSelected = [...selectedValues, val];
    }
    onChange(nextSelected);
  };

  const handleSelectAll = () => {
    if (isAllSelected) {
      onChange([]);
    } else {
      onChange(options.map(o => o.value));
    }
  };

  const renderTriggerLabel = () => {
    if (!isMulti) {
      return selectedOption ? selectedOption.label : placeholder;
    }

    if (selectedValues.length === 0) {
      return "所有標籤";
    }

    if (selectedValues.length === options.length) {
      return "全選標籤 (所有)";
    }

    if (selectedValues.length === 1) {
      const opt = options.find(o => o.value === selectedValues[0]);
      return opt ? opt.label : placeholder;
    }

    return `已選取 ${selectedValues.length} 個標籤`;
  };

  return (
    <div ref={containerRef} style={{ position: "relative", display: "inline-block", userSelect: "none" }}>
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: "8px",
          padding: "10px 16px",
          borderRadius: "12px",
          border: "1px solid var(--border-color, rgba(0, 0, 0, 0.08))",
          background: "var(--card-bg, rgba(255, 255, 255, 0.85))",
          color: "var(--text-color, #333)",
          fontSize: "0.92rem",
          fontWeight: "500",
          cursor: "pointer",
          backdropFilter: "blur(12px)",
          WebkitBackdropFilter: "blur(12px)",
          boxShadow: isOpen ? "0 4px 20px rgba(0,0,0,0.08)" : "0 2px 8px rgba(0,0,0,0.03)",
          transition: "all 0.2s ease",
          outline: "none",
          minWidth: "140px",
          justifyContent: "space-between"
        }}
      >
        <span style={{ display: "flex", alignItems: "center", gap: "6px", whiteSpace: "nowrap" }}>
          {icon && <span style={{ opacity: 0.7, display: "inline-flex" }}>{icon}</span>}
          {renderTriggerLabel()}
        </span>
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          style={{
            transform: isOpen ? "rotate(180deg)" : "rotate(0deg)",
            transition: "transform 0.2s ease",
            opacity: 0.6
          }}
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      {isOpen && (
        <div
          style={{
            position: "absolute",
            top: openUpward ? "auto" : "calc(100% + 6px)",
            bottom: openUpward ? "calc(100% + 6px)" : "auto",
            left: 0,
            zIndex: 9999,
            minWidth: "100%",
            width: "max-content",
            maxWidth: "280px",
            background: "var(--card-bg, rgba(255, 255, 255, 0.95))",
            border: "1px solid var(--border-color, rgba(0, 0, 0, 0.08))",
            borderRadius: "14px",
            boxShadow: "0 10px 30px rgba(0,0,0,0.12)",
            backdropFilter: "blur(16px)",
            WebkitBackdropFilter: "blur(16px)",
            overflow: "hidden",
            padding: "6px",
            display: "flex",
            flexDirection: "column",
            gap: "2px",
            animation: "fadeIn 0.15s ease",
            maxHeight: "320px",
            overflowY: "auto"
          }}
        >
          {isMulti && (
            <div style={{ display: "flex", justifyContent: "space-between", padding: "6px 8px 8px 8px", borderBottom: "1px solid rgba(0,0,0,0.06)", marginBottom: "4px" }}>
              <button
                type="button"
                onClick={handleSelectAll}
                style={{
                  background: "rgba(209, 191, 174, 0.2)",
                  border: "none",
                  color: "var(--text-color, #333)",
                  fontSize: "0.78rem",
                  padding: "4px 8px",
                  borderRadius: "6px",
                  cursor: "pointer",
                  fontWeight: "500"
                }}
              >
                {isAllSelected ? "取消全選" : "全選"}
              </button>
              {selectedValues.length > 0 && (
                <button
                  type="button"
                  onClick={() => onChange([])}
                  style={{
                    background: "transparent",
                    border: "none",
                    color: "#888",
                    fontSize: "0.78rem",
                    padding: "4px 8px",
                    cursor: "pointer"
                  }}
                >
                  清除重設
                </button>
              )}
            </div>
          )}

          {options.map((opt) => {
            const isSelected = isMulti
              ? selectedValues.includes(opt.value)
              : opt.value === value;

            return (
              <button
                key={String(opt.value)}
                type="button"
                onClick={() => handleToggleOption(opt.value)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: "10px",
                  padding: "9px 14px",
                  borderRadius: "8px",
                  border: "none",
                  background: isSelected ? "rgba(209, 191, 174, 0.25)" : "transparent",
                  color: isSelected ? "var(--text-color, #111)" : "var(--text-color, #444)",
                  fontWeight: isSelected ? "600" : "400",
                  fontSize: "0.9rem",
                  cursor: "pointer",
                  textAlign: "left",
                  transition: "background 0.15s ease",
                  whiteSpace: "nowrap"
                }}
                onMouseOver={(e) => {
                  if (!isSelected) e.currentTarget.style.background = "rgba(0, 0, 0, 0.04)";
                }}
                onMouseOut={(e) => {
                  if (!isSelected) e.currentTarget.style.background = "transparent";
                }}
              >
                <span style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                  {opt.icon && <span>{opt.icon}</span>}
                  {opt.label}
                </span>
                {isSelected && (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--accent-color, #d1bfae)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
