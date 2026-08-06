"use client";

import { useEffect, useRef, useState } from "react";
import { CORNER_BASE_PX, useCornerStackLift } from "@/lib/cornerStack";

/** 動作列頂端與「回到頂端」鈕之間留的空隙 */
const GAP = 12;

/**
 * 編輯模式那排批次動作（全選／刪除／完成…）。
 *
 * 版面全交給傳進來的 className（各頁的 `.actionBar`），這裡只多做一件事：
 * 量自己實際佔到哪裡，登記進 corner stack，好讓「回到頂端」鈕疊上去。
 * 量測而不是寫死高度 —— 手機上按鈕會換行，兩排跟一排差很多。
 */
export default function BottomActionBar({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [lift, setLift] = useState(0);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const measure = () => {
      const rect = el.getBoundingClientRect();
      setLift(Math.max(0, window.innerHeight - rect.top + GAP - CORNER_BASE_PX));
    };

    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    window.addEventListener("resize", measure);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, []);

  useCornerStackLift(lift, lift > 0);

  // floating-control：捲動中 globals.css 會關掉全站的 pointer-events，
  // 這排永遠浮在最上層且隨時要能按，不該被那條效能規則掃到
  return (
    <div ref={ref} className={className ? `${className} floating-control` : "floating-control"}>
      {children}
    </div>
  );
}
