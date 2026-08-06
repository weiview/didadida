"use client";

import { useEffect, useState } from "react";
import { useCornerStackLift } from "@/lib/cornerStack";

export type FabAction = {
  key: string;
  /** 展開後那顆藥丸上的字 */
  label: string;
  /** 一個 emoji，沒有就不畫 */
  icon?: string;
  onClick?: () => void;
  disabled?: boolean;
  title?: string;
  /**
   * 有子動作就變成一扇門：點下去不執行 onClick，改成把這一串換成子動作。
   * 只支援一層 —— 再深下去就不該用藥丸了，那是選單該做的事。
   */
  children?: FabAction[];
};

const FAB_SIZE = 56;
const GAP = 12;

/*
 * 配色與材質都在 globals.css 的 .glass-control / .glass-accent：
 * 整串藥丸跟 FAB 同一片玻璃、同一個暖色調，深褐色的字
 * —— 主題色是淺奶茶，白字壓在上面幾乎看不見。
 */

/**
 * 右下角的浮動操作鈕：平常只有一顆 icon，點開才展開下面這串動作。
 *
 * 頁首原本一排「編輯／建立相簿／上傳照片…」在手機上會擠掉搜尋框，
 * 收進這裡之後畫面乾淨，而且手指本來就在右下角。
 *
 * **`actions[0]` 貼著 FAB**（由下往上長），所以陣列第一項要放最常用的那個。
 * `actions` 是空的就整顆不畫 —— 例如編輯模式下改由底部動作列接手。
 *
 * 帶 `children` 的那一項是一扇門：點下去整串換成子動作，最上面補一列「← 原標題」
 * 退回上一層。只做一層 —— 同一件事的不同來源（本機／Google 相簿）收在一起是合理的，
 * 再深就該換成對話框了。
 */
export default function FabMenu({
  actions,
  ariaLabel = "更多操作",
}: {
  actions: FabAction[];
  ariaLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  /** 目前展開的是哪一扇門的子動作；null 就是最上層 */
  const [submenu, setSubmenu] = useState<FabAction | null>(null);
  /**
   * 換層的時候先讓新的那串維持在收合狀態，下一幀才放行 —— 少了這一步，
   * 新藥丸會以最終樣子直接出現在畫面上，看起來像閃了一下而不是長出來。
   */
  const [entered, setEntered] = useState(true);
  const visible = actions.length > 0;

  useCornerStackLift(FAB_SIZE + GAP, visible);

  const close = () => {
    setOpen(false);
    // 不在這裡清掉 submenu：淡出的 0.2s 內清掉會讓上一層的藥丸閃回來。
    // 下次展開時才重置（見 toggle）
  };

  const toggle = () => {
    if (open) close();
    else {
      setSubmenu(null);
      setEntered(true);
      setOpen(true);
    }
  };

  const goTo = (next: FabAction | null) => {
    setEntered(false);
    setSubmenu(next);
    // 兩層 rAF：第一幀 React 才把收合狀態畫上去，第二幀改值才會被當成過場
    requestAnimationFrame(() => requestAnimationFrame(() => setEntered(true)));
  };

  // 動作清單變了（例如切進編輯模式）就收起來，免得展開狀態卡在那裡
  useEffect(() => {
    if (!visible) setOpen(false);
  }, [visible]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      // 在子層先退回上一層，第二下才整個收起來 —— Esc 一次關掉全部
      // 會讓人搞不清楚自己剛剛按掉了幾層
      if (e.key === "Escape") {
        if (submenu) goTo(null);
        else close();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, submenu]);

  if (!visible) return null;

  /** 藥丸真的展開到位（換層的中間那一幀不算） */
  const shown = open && entered;

  /*
   * 這一串由下往上長（column-reverse），所以陣列越前面越貼近 FAB＝越好按。
   * 在子層時把「返回」放在最末＝整串的最上面，讀起來就是
   *   ← 上傳照片
   *     將 Google 相簿匯入
   *     本機上傳
   *   (FAB)
   * 標題在頂、選項在下，跟一般選單的方向一致。
   */
  type Row = FabAction & { back?: boolean };
  const rows: Row[] = submenu
    ? [...(submenu.children ?? []), { key: "__back", label: submenu.label, icon: "←", back: true }]
    : actions;

  return (
    <>
      {/* 點空白處收起。順便壓暗底下的內容，讓展開的那串成為視覺焦點 */}
      <div
        className={open ? "floating-control" : undefined}
        onClick={close}
        style={{
          position: "fixed",
          inset: 0,
          zIndex: 940,
          // 壓暗＋輕微失焦。玻璃要有東西可以折射才看得出材質，
          // 純色遮罩會讓上面那串看起來像貼在灰紙上
          background: "rgba(38, 30, 24, 0.22)",
          backdropFilter: "blur(2px)",
          WebkitBackdropFilter: "blur(2px)",
          opacity: open ? 1 : 0,
          pointerEvents: open ? "auto" : "none",
          transition: "opacity 0.22s ease",
        }}
      />

      <div
        style={{
          position: "fixed",
          right: "max(16px, env(safe-area-inset-right))",
          bottom: "max(16px, env(safe-area-inset-bottom))",
          zIndex: 950,
          display: "flex",
          // 由下往上長：column-reverse 讓 actions[0] 落在最貼近 FAB 的位置
          flexDirection: "column-reverse",
          alignItems: "flex-end",
          gap: 10,
          /*
           * 這層是排版用的空殼，絕對不能吃點擊。
           *
           * 收合時藥丸只是 opacity: 0，還在版面上 —— 這個 div 的高度因此一路長到
           * 200 多 px，寬度跟著最長的那顆藥丸。它 z-index 950，正好整片蓋在
           * z-index 900 的「回到頂端」鈕上面（那顆被 corner stack 墊高到 84px，
           * 剛好落在殼裡）。沒有背景色看不出來，但 hit-test 不管透明度，
           * 點下去全被這個空殼接走 —— 使用者看到的就是「按了沒反應」。
           *
           * pointer-events 會繼承，所以底下真正要按的東西各自寫回 auto：
           * FAB 是固定的 auto，藥丸則跟著 open 切換。
           */
          pointerEvents: "none",
        }}
      >
        <button
          type="button"
          aria-label={ariaLabel}
          aria-expanded={open}
          title={ariaLabel}
          // floating-control：捲動中 globals.css 會關掉全站的 pointer-events，這是豁免票
          // glass-control/glass-accent：毛玻璃材質與按壓回饋，見 globals.css
          className="floating-control glass-control glass-accent"
          onClick={toggle}
          style={{
            width: FAB_SIZE,
            height: FAB_SIZE,
            borderRadius: "50%",
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            // 外層那個殼是 pointer-events: none，這裡要自己寫回來（見上面）
            pointerEvents: "auto",
            // 展開時轉 45°：＋ 直接變成 ×，不必換圖示。
            // 走 CSS 變數而不是直接寫 transform，:active 的縮放才疊得上去
            ["--glass-transform" as string]: open ? "rotate(45deg)" : "rotate(0deg)",
          } as React.CSSProperties}
        >
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
        </button>

        {rows.map((row, i) => (
          <button
            key={`${submenu?.key ?? ""}/${row.key}`}
            type="button"
            /*
             * floating-control 收合時不掛，讓 pointerEvents: none 照常生效。
             * 返回列不加 glass-accent：跟「回到頂端」同一個道理 —— 它是導覽不是動作，
             * 留暖白，不跟底下真正要按的那幾顆搶注意力。
             */
            className={`glass-control${row.back ? "" : " glass-accent"}${open ? " floating-control" : ""}`}
            title={row.title || row.label}
            disabled={row.disabled}
            aria-haspopup={row.children ? "true" : undefined}
            onClick={() => {
              if (row.back) return goTo(null);
              if (row.children) return goTo(row);
              // setOpen 是排程的，onClick 仍在這個 click 事件裡同步執行 ——
              // 需要使用者手勢的動作（開檔案選擇、window.open）才不會被擋掉
              close();
              row.onClick?.();
            }}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 8,
              padding: "11px 18px",
              borderRadius: 24,
              fontSize: "0.95rem",
              fontWeight: 500,
              whiteSpace: "nowrap",
              cursor: row.disabled ? "not-allowed" : "pointer",
              opacity: shown ? (row.disabled ? 0.55 : 1) : 0,
              ["--glass-transform" as string]: shown ? "translateY(0)" : "translateY(10px) scale(0.96)",
              pointerEvents: shown ? "auto" : "none",
              // 由 FAB 往外依序冒出來，收合時一起消失
              transitionDelay: `${shown ? i * 30 : 0}ms`,
            } as React.CSSProperties}
          >
            {row.icon && <span aria-hidden>{row.icon}</span>}
            {row.label}
            {/* 這顆點下去還有下一層，先講清楚，不然點了跳出別的東西會像誤觸 */}
            {row.children && <span aria-hidden style={{ opacity: 0.5, marginLeft: 2 }}>›</span>}
          </button>
        ))}
      </div>
    </>
  );
}
