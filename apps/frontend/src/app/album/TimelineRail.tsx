"use client";

/**
 * 相簿右邊那條時間軸（`timelineGroup` 的縮影，見 CLAUDE.md「相簿格線」）。
 *
 * 輕點一個節點＝跳到那個月（沿用原本的 onClick）。
 * **長按 0.2 秒＝進入拖曳選月份**：整條展開成完整的月份清單，手指上下滑動挑一個，
 * 放開就收回去並直接跳到那個月的第一張。
 *
 * ⚠️ 拆成獨立元件是為了**重畫範圍**：拖曳中每換一個月就是一次 setState，
 *    留在 page.tsx 裡等於每一下都重畫整片格線（幾百張卡片）。
 * ⚠️ 觸控監聽器一律原生 `{ passive: false }`（React 的 onTouchMove 是被動的，
 *    `preventDefault()` 擋不住捲頁面，見 CLAUDE.md「手勢」）。
 * ⚠️ 還沒滿 `HOLD_MS` 手指就移動超過 `SLOP_PX` ＝他是要捲（這條軌或整頁），當場讓開，
 *    不然這條細軌會變成一塊捲不動的死區。`HOLD_MS` 越短這條就越要緊 ——
 *    200ms 已經短到「按下去順手往下滑」很容易就壓線，SLOP 是唯一分得開兩者的東西。
 *
 * **第二層：挑日期**（2026-09-29 使用者要求）。選完一個月（拖曳放開、或輕點節點）
 * 先照舊跳到那個月，**同時**在軌道旁邊跳出那個月的日期格；點一天就瞬間跳到那一天的
 * 第一張，點到外面就收起來。那個月只有一天的話不跳（沒有東西可以再挑）。
 * ⚠️ 那一格是軌道的**兄弟節點**不是子節點 —— 軌道平常是 `visibility: hidden`、
 *    捲動停了 1.2 秒就淡出，日期格掛在裡面會跟著一起消失。
 * ⚠️ 點外面收起來聽的是 `pointerdown`，而且**不擋那一下** —— 使用者點到照片時，
 *    照片照樣要打得開，不該先點一下關面板、再點一下才進燈箱。
 */

import { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import styles from "./album.module.css";

// 0.5 → 0.2 秒（2026-09-11 使用者要求）：這條軌上沒有別的長按手勢要區分，
// 等半秒才展開在手機上感覺像沒反應
const HOLD_MS = 200;
const SLOP_PX = 8;

export type TimelineDayItem = { day: number; index: number; count: number };
export type TimelineGroupItem = { label: string; index: number; days?: TimelineDayItem[] };

// 'YYYY/MM' → 'YYYY年M月'，跟捲動時那顆氣泡同一個寫法；「無日期」原樣
function bubbleText(label: string) {
  const [y, m] = label.split("/");
  return m ? `${y}年${Number(m)}月` : label;
}

export default function TimelineRail({
  groups,
  active,
  bubble,
  onJump,
}: {
  groups: TimelineGroupItem[];
  /** 頁面正在捲動（父層 1.2 秒後自己放掉） */
  active: boolean;
  bubble: string;
  /** instant＝拖曳選完的那一跳：瞬間、而且把那個月的第一張放在畫面上緣 */
  onJump: (photoIdx: number, instant?: boolean) => void;
}) {
  const marksRef = useRef<HTMLDivElement>(null);
  // null ＝沒在拖；數字＝目前挑中的節點
  const [scrubIndex, setScrubIndex] = useState<number | null>(null);
  // 手指按著、還沒滿 0.5 秒：這段期間軌道不能因為父層的計時器到了而淡出
  const [held, setHeld] = useState(false);
  // 第二層：挑了哪個月（label）之後端出來的日期格；null ＝收著
  const [dayPanel, setDayPanel] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // 選完一個月：先跳過去，那個月有兩天以上才端出日期格
  const pickMonth = (g: TimelineGroupItem, instant: boolean) => {
    onJumpRef.current(g.index, instant);
    setDayPanel(g.days && g.days.length > 1 ? g.label : null);
  };
  const pickMonthRef = useRef(pickMonth);
  pickMonthRef.current = pickMonth;

  // 監聽器只掛一次，最新的 groups／onJump 從 ref 讀，免得閉包拿到舊的
  const groupsRef = useRef(groups);
  const onJumpRef = useRef(onJump);
  groupsRef.current = groups;
  onJumpRef.current = onJump;

  useEffect(() => {
    const el = marksRef.current;
    if (!el) return;

    let timer: ReturnType<typeof setTimeout> | null = null;
    let startY = 0;
    let lastY = 0;
    let scrubbing = false;
    let picked = -1;

    /*
     * 手指的高度按比例對應整份清單，同時把清單捲到同樣的比例 ——
     * 清單長過軌道時，挑中的那一格因此永遠停在手指旁邊；
     * 最後再照實際位置挑離手指最近的那一格，所以短清單也對得準。
     */
    const pick = (y: number) => {
      const rect = el.getBoundingClientRect();
      const f = Math.min(1, Math.max(0, (y - rect.top) / rect.height));
      el.scrollTop = f * (el.scrollHeight - el.clientHeight);
      const nodes = el.children;
      let best = 0;
      let bestD = Infinity;
      for (let i = 0; i < nodes.length; i++) {
        const r = nodes[i].getBoundingClientRect();
        const d = Math.abs(r.top + r.height / 2 - y);
        if (d < bestD) { bestD = d; best = i; }
      }
      if (best !== picked) {
        picked = best;
        setScrubIndex(best);
      }
    };

    const reset = () => {
      if (timer) { clearTimeout(timer); timer = null; }
      scrubbing = false;
      picked = -1;
      setScrubIndex(null);
      setHeld(false);
    };

    const onStart = (e: TouchEvent) => {
      if (e.touches.length !== 1) { reset(); return; }
      startY = lastY = e.touches[0].clientY;
      setHeld(true);
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        scrubbing = true;
        navigator.vibrate?.(10);
        // 先讓展開的樣式真的畫上去，量到的位置才是展開之後的
        flushSync(() => setScrubIndex(-1));
        pick(lastY);
      }, HOLD_MS);
    };

    const onMove = (e: TouchEvent) => {
      if (e.touches.length !== 1) { reset(); return; }
      lastY = e.touches[0].clientY;
      if (scrubbing) {
        e.preventDefault();
        // 父層掛在 window 上的捲動處理器每一下都會掃過整片格線，拖曳中用不到它
        e.stopPropagation();
        pick(lastY);
      } else if (timer && Math.abs(lastY - startY) > SLOP_PX) {
        reset();
      }
    };

    const onEnd = (e: TouchEvent) => {
      if (scrubbing) {
        // 擋掉放開之後瀏覽器補發的 click，不然會再跳一次（跳到手指底下那一格）
        e.preventDefault();
        const g = groupsRef.current[picked];
        if (g) pickMonthRef.current(g, true);
      }
      reset();
    };

    // Android 長按會叫出選單／開始選字
    const onContextMenu = (e: Event) => {
      if (timer || scrubbing) e.preventDefault();
    };

    el.addEventListener("touchstart", onStart, { passive: true });
    el.addEventListener("touchmove", onMove, { passive: false });
    el.addEventListener("touchend", onEnd, { passive: false });
    el.addEventListener("touchcancel", reset);
    el.addEventListener("contextmenu", onContextMenu);
    return () => {
      if (timer) clearTimeout(timer);
      el.removeEventListener("touchstart", onStart);
      el.removeEventListener("touchmove", onMove);
      el.removeEventListener("touchend", onEnd);
      el.removeEventListener("touchcancel", reset);
      el.removeEventListener("contextmenu", onContextMenu);
    };
  }, []);

  // 日期格：點到外面收起來、Esc 收起來
  useEffect(() => {
    if (!dayPanel) return;
    const onDown = (e: PointerEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) setDayPanel(null);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setDayPanel(null); };
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [dayPanel]);

  // 清單換掉（換排序、篩選）之後那個月可能已經不在了
  const panelGroup = dayPanel ? groups.find((g) => g.label === dayPanel) : undefined;
  const panelDays = panelGroup?.days && panelGroup.days.length > 1 ? panelGroup.days : null;

  const scrubbing = scrubIndex !== null;
  const selected = scrubbing && scrubIndex >= 0 ? groups[scrubIndex] : undefined;
  const bubbleShown = selected ? bubbleText(selected.label) : bubble;

  return (
    <>
    <div
      className={[
        styles.timelineTrack,
        active ? styles.timelineActive : "",
        held ? styles.timelineHeld : "",
        scrubbing ? styles.timelineScrubbing : "",
      ].join(" ")}
    >
      {bubbleShown && <div className={styles.timelineBubble}>{bubbleShown}</div>}
      <div ref={marksRef} className={styles.timelineMarks}>
        {groups.map((item, i) => (
          <div
            key={item.label}
            className={`${styles.timelineNode} ${scrubIndex === i ? styles.timelineNodeSelected : ""}`}
            onClick={() => pickMonth(item, false)}
            title={`前往 ${item.label}`}
          >
            <span className={styles.timelineNodeDot} />
            <span className={styles.timelineNodeText}>{item.label}</span>
          </div>
        ))}
      </div>
    </div>
    {panelGroup && panelDays && !scrubbing && (
      <div ref={panelRef} className={styles.timelineDayPanel} role="dialog" aria-label="挑一天">
        <div className={styles.timelineDayHead}>
          <span>{bubbleText(panelGroup.label)}</span>
          <button type="button" className={styles.timelineDayClose} onClick={() => setDayPanel(null)} aria-label="關閉">×</button>
        </div>
        <div className={styles.timelineDayGrid}>
          {panelDays.map((d) => (
            <button
              key={d.day}
              type="button"
              className={styles.timelineDayBtn}
              onClick={() => { onJump(d.index, true); setDayPanel(null); }}
              title={`${d.count} 張`}
            >
              <span className={styles.timelineDayNum}>{d.day}</span>
              <span className={styles.timelineDayCount}>{d.count}</span>
            </button>
          ))}
        </div>
      </div>
    )}
    </>
  );
}
