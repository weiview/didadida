"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import styles from "./album.module.css";

/**
 * 格線順序的縮影：由上往下每一段連續的照片一格。
 * `key` 是 'YYYY-MM-DD'，或兩個特殊值：'__new'（排在最上面那疊還沒看過的 NEW）、
 * '__nodate'（還沒有拍攝時間的那一疊）。`index` 是那一段第一張在 displayPhotos 裡的位置。
 */
export type TimelineItem = { key: string; index: number };

export type TimelineUnit = "year" | "month" | "day";

type RailNode = { key: string; label: string; index: number };

/** 按住多久才算「長按」。這條軌上沒有第二種長按手勢要區分，等半秒在手機上像沒反應 */
const HOLD_MS = 100;
/** 還沒滿 HOLD_MS 手指就移動超過這麼多 px ＝ 他是要捲頁面，整個讓開 */
const SLOP_PX = 8;
/** 點過這條軌之後撐著不淡掉多久 —— 不撐的話按「年／月／日」之前它就先消失了 */
const AWAKE_MS = 2500;
const UNIT_KEY = "didadida:timeline_unit";
/** 節點不多時才在軌上畫刻度，多了就是一整條糊掉的線 */
const MAX_TICKS = 60;

const UNITS: { value: TimelineUnit; label: string }[] = [
  { value: "year", label: "年" },
  { value: "month", label: "月" },
  { value: "day", label: "日" },
];

function keyForUnit(key: string, unit: TimelineUnit): string {
  if (key.startsWith("__")) return key;
  if (unit === "year") return key.slice(0, 4);
  if (unit === "month") return key.slice(0, 7);
  return key;
}

function labelOf(key: string): string {
  if (key === "__new") return "NEW";
  if (key === "__nodate") return "無日期";
  return key.replace(/-/g, ".");
}

/**
 * 相簿右緣那條時間軸：一顆貼著右緣的半圓把手，長按之後上下拖，
 * 旁邊一條半透明的日期（2026.09.10）跟著手指走，放開就跳過去。
 * 拖一格是一個單位 —— 年、月或日（預設日），由軌道上方那組切換鈕決定。
 *
 * ⚠️⚠️ 刻意是獨立元件，不可以搬回 page.tsx：拖曳中每換一格就是一次 setState，
 *    寫在相簿頁裡等於每一下都重畫整片格線（幾百張卡片）。props 都收進 ref，
 *    所以監聽器那支效果的相依是 []。
 * ⚠️ 觸控監聽器一律原生 `{ passive: false }` —— React 的 onTouchMove 是被動的，
 *    在裡面 preventDefault() 擋不住瀏覽器捲頁面。
 */
export default function TimelineRail({
  items,
  active,
  getTopIndex,
  onJump,
}: {
  items: TimelineItem[];
  /** 頁面正在捲（父層 1.2 秒後自己放掉）：軌道現身、日期也跟著顯示 */
  active: boolean;
  /** 目前畫面最上面那張的 index，用來決定把手平常停在哪一格 */
  getTopIndex: () => number;
  onJump: (photoIdx: number, instant?: boolean) => void;
}) {
  const [unit, setUnit] = useState<TimelineUnit>("day");
  /** 拖曳中：挑中的那一格＋手指在帶子裡的高度（px）。把手與日期跟著手指走，不跳格 */
  const [scrub, setScrub] = useState<{ i: number; y: number } | null>(null);
  const [held, setHeld] = useState(false);
  const [awake, setAwake] = useState(false);
  const [restIdx, setRestIdx] = useState(0);

  const bandRef = useRef<HTMLDivElement>(null);
  const rangeRef = useRef<HTMLDivElement>(null);

  // 讀 localStorage 一律放在掛載之後：靜態匯出的 HTML 第一次 render 要跟伺服器那份一樣
  useEffect(() => {
    try {
      const v = localStorage.getItem(UNIT_KEY);
      if (v === "year" || v === "month" || v === "day") setUnit(v);
    } catch { /* 無痕模式之類的 */ }
  }, []);

  const nodes = useMemo<RailNode[]>(() => {
    const out: RailNode[] = [];
    for (const it of items) {
      const k = keyForUnit(it.key, unit);
      if (out.length && out[out.length - 1].key === k) continue;
      out.push({ key: k, label: labelOf(k), index: it.index });
    }
    return out;
  }, [items, unit]);

  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  const onJumpRef = useRef(onJump);
  onJumpRef.current = onJump;
  const getTopRef = useRef(getTopIndex);
  getTopRef.current = getTopIndex;

  /*
   * 把手平常停在哪：畫面最上面那張落在哪一格。
   * 用 rAF 收斂捲動事件，而且**只有格子換了才 setState** —— 捲動一秒是幾十個事件。
   */
  useEffect(() => {
    let raf = 0;
    const update = () => {
      raf = 0;
      const top = getTopRef.current();
      const ns = nodesRef.current;
      let i = 0;
      for (let k = 0; k < ns.length; k++) {
        if (ns[k].index <= top) i = k;
        else break;
      }
      setRestIdx((prev) => (prev === i ? prev : i));
    };
    const onScroll = () => { if (!raf) raf = requestAnimationFrame(update); };
    update();
    const t = setTimeout(update, 300); // 格線剛畫出來時父層的 topIndex 還沒算
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      if (raf) cancelAnimationFrame(raf);
      clearTimeout(t);
    };
  }, [nodes]);

  // 點過之後撐一下（切換鈕要按得到）
  const awakeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const poke = () => {
    setAwake(true);
    if (awakeTimer.current) clearTimeout(awakeTimer.current);
    awakeTimer.current = setTimeout(() => setAwake(false), AWAKE_MS);
  };
  useEffect(() => () => { if (awakeTimer.current) clearTimeout(awakeTimer.current); }, []);

  const pokeRef = useRef(poke);
  pokeRef.current = poke;

  // 觸控：長按起跑、拖著挑、放開跳。短按＝直接跳到那個高度的那一格
  useEffect(() => {
    const band = bandRef.current;
    if (!band) return;

    let timer: ReturnType<typeof setTimeout> | null = null;
    let startX = 0;
    let startY = 0;
    let lastY = 0;
    let scrubbing = false;
    let ignored = false;
    let picked = -1;

    // 位置照內層那段（.timelineRange）算：帶子上下多留的那截只是讓手指好按，
    // 按在那裡＝夾到第一格／最後一格
    const locate = (clientY: number) => {
      const ns = nodesRef.current;
      const r = (rangeRef.current ?? band).getBoundingClientRect();
      const y = Math.min(Math.max(clientY - r.top, 0), r.height);
      const i = ns.length > 1 && r.height > 0 ? Math.round((y / r.height) * (ns.length - 1)) : 0;
      return { i, y };
    };
    const pick = (clientY: number) => {
      const { i, y } = locate(clientY);
      picked = i;
      setScrub((prev) => (prev && prev.i === i && prev.y === y ? prev : { i, y }));
    };
    const reset = () => {
      if (timer) clearTimeout(timer);
      timer = null;
      scrubbing = false;
      picked = -1;
      setScrub(null);
      setHeld(false);
    };
    const jumpAt = (i: number) => {
      const n = nodesRef.current[i];
      if (n) onJumpRef.current(n.index, true);
    };

    const onStart = (e: TouchEvent) => {
      if (e.touches.length !== 1) { reset(); ignored = true; return; }
      const t = e.touches[0];
      startX = t.clientX;
      startY = lastY = t.clientY;
      ignored = false;
      scrubbing = false;
      setHeld(true);
      pokeRef.current();
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        scrubbing = true;
        try { navigator.vibrate?.(10); } catch { /* 不支援就算了 */ }
        pick(lastY);
      }, HOLD_MS);
    };
    const onMove = (e: TouchEvent) => {
      if (ignored) return;
      const t = e.touches[0];
      if (!t) return;
      lastY = t.clientY;
      if (!scrubbing) {
        // 還沒滿 HOLD_MS 就移動 ＝ 他是要捲頁面（軌道自己貼在右緣，不讓開就是一塊捲不動的死區）
        if (Math.abs(t.clientX - startX) > SLOP_PX || Math.abs(t.clientY - startY) > SLOP_PX) {
          ignored = true;
          reset();
        }
        return;
      }
      e.preventDefault();
      // 父層掛在 window 上的捲動處理器每一下都會掃過整片卡片，拖曳中用不到它
      e.stopPropagation();
      pick(t.clientY);
    };
    const onEnd = (e: TouchEvent) => {
      if (ignored) { reset(); return; }
      // 擋掉瀏覽器補發的 click
      e.preventDefault();
      if (scrubbing) {
        const i = picked;
        reset();
        if (i >= 0) jumpAt(i);
        return;
      }
      if (timer) {
        // 短按：直接跳到手指那個高度的那一格
        reset();
        jumpAt(locate(startY).i);
        return;
      }
      reset();
    };
    const onCancel = () => reset();
    // 長按在手機上會叫出系統選單
    const onContext = (e: Event) => { if (timer || scrubbing) e.preventDefault(); };

    // 桌機：滑鼠按下去就開始拖，不必長按
    const onMouseMove = (e: MouseEvent) => { if (scrubbing) { e.preventDefault(); pick(e.clientY); } };
    const onMouseUp = () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
      const i = picked;
      reset();
      if (i >= 0) jumpAt(i);
    };
    const onMouseDown = (e: MouseEvent) => {
      if (e.button !== 0) return;
      e.preventDefault();
      scrubbing = true;
      setHeld(true);
      pokeRef.current();
      pick(e.clientY);
      window.addEventListener("mousemove", onMouseMove);
      window.addEventListener("mouseup", onMouseUp);
    };

    band.addEventListener("touchstart", onStart, { passive: true });
    band.addEventListener("touchmove", onMove, { passive: false });
    band.addEventListener("touchend", onEnd, { passive: false });
    band.addEventListener("touchcancel", onCancel);
    band.addEventListener("contextmenu", onContext);
    band.addEventListener("mousedown", onMouseDown);
    return () => {
      band.removeEventListener("touchstart", onStart);
      band.removeEventListener("touchmove", onMove);
      band.removeEventListener("touchend", onEnd);
      band.removeEventListener("touchcancel", onCancel);
      band.removeEventListener("contextmenu", onContext);
      band.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
      if (timer) clearTimeout(timer);
    };
  }, []);

  const chooseUnit = (u: TimelineUnit) => {
    setUnit(u);
    poke();
    try { localStorage.setItem(UNIT_KEY, u); } catch { /* 無痕模式之類的 */ }
  };

  const n = nodes.length;
  const ratio = (i: number) => (n > 1 ? i / (n - 1) : 0);
  // 拖曳中照手指的高度（跟著走、不跳格）；平常照格子換算成百分比
  const handleTop = scrub ? `${scrub.y}px` : `${ratio(Math.min(restIdx, Math.max(n - 1, 0))) * 100}%`;
  const shown = scrub ? nodes[scrub.i] : nodes[Math.min(restIdx, n - 1)];
  const showLabel = !!shown && (!!scrub || active);

  const cls = [
    styles.timelineTrack,
    active ? styles.timelineActive : "",
    held || awake ? styles.timelineHeld : "",
    scrub ? styles.timelineScrubbing : "",
  ].filter(Boolean).join(" ");

  return (
    <div className={cls}>
      <div className={styles.timelineUnits} role="radiogroup" aria-label="時間軸的單位">
        {UNITS.map((u) => (
          <button
            key={u.value}
            type="button"
            role="radio"
            aria-checked={unit === u.value}
            className={`${styles.timelineUnitBtn} ${unit === u.value ? styles.timelineUnitOn : ""}`}
            onClick={() => chooseUnit(u.value)}
          >
            {u.label}
          </button>
        ))}
      </div>

      <div ref={bandRef} className={styles.timelineBand} aria-label="時間軸，長按後上下拖曳挑日期">
        <div ref={rangeRef} className={styles.timelineRange}>
          <div className={styles.timelineLine} />
          {n > 1 && n <= MAX_TICKS && nodes.map((nd, i) => (
            <span key={nd.key} className={styles.timelineTick} style={{ top: `${ratio(i) * 100}%` }} />
          ))}
          <div className={styles.timelineKnob} style={{ top: handleTop }} />
          {showLabel && (
            <div className={styles.timelineDateLabel} style={{ top: handleTop }}>
              {shown.label}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
