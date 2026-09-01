import React, { useCallback, useEffect, useRef, useState } from "react";
import styles from "./lightbox.module.css";
import PhotoComments from "./PhotoComments";
import PhotoImage from "@/components/PhotoImage";
import VideoPlayer from "@/components/VideoPlayer";
import FixTimeModal from "@/components/FixTimeModal";
import { Photo, Tag, updatePhoto, addPhotoTag, removePhotoTag, photoFullSrc, photoThumbSrc, photoMotionSrc, hasMotion, isVideo, isGif, setPhotosRestricted } from "@/lib/api";
import { useAdmin } from "@/lib/useAdmin";
import { revealRestricted, toggleRestrictedReveal, useRevealedRestricted } from "@/lib/restrictedReveal";
import { setExifExpanded, useExifExpanded } from "@/lib/exifPref";
import { DEFAULT_TZ_OFFSET_MINUTES, formatWallClock, parseExifDateTime, wallClockFromInstant } from "@/lib/geo";
import { formatTzOffset } from "@/lib/tz";
import { formatDuration } from "@/lib/videoUtils";

/*
 * 動態照片重播之間停多久。0.5 秒是使用者指定的：接成無縫的迴圈看起來像一團
 * 抽損的畫面，中間停一下才看得出來「這是一段影片在重播」。
 */
const MOTION_REPLAY_GAP_MS = 500;

// 只有顯示用的中文說明，值域本身定義在 geo.ts
const TIME_SOURCE_LABEL: Record<string, string> = {
  manual: '手動修正',
  offset_tag: '相機寫入的時區',
  gps_utc: 'GPS 時間推算',
  file_time: '檔案時間',
  assumed: `假設為 ${formatTzOffset(DEFAULT_TZ_OFFSET_MINUTES)}（未經確認）`,
};

interface PhotoLightboxProps {
  photo: Photo;
  isAdmin: boolean;
  availableTags: Tag[];
  onClose: () => void;
  /**
   * 改完資料之後叫一次，由呼叫端把清單重抓回來。
   *
   * ⚠️ 呼叫端**一定要用 silent 的那種重抓**（見 album/page.tsx 的 `loadData`）：
   *    翻起 `loading` 會讓整片格線 unmount、頁面高度塌成 0，捲軸當場回頂端，
   *    使用者關掉燈箱就得從頭找剛剛那一張。順序重排（例如剛補完拍攝時間）
   *    也由呼叫端照 id 把索引挪回同一張照片身上，這裡不必管。
   */
  onUpdate: () => void;
  /**
   * 切換「不開放」時**改用這個**，不要走 onUpdate。
   *
   * 那顆鎖是每幾百張才動一次的管理動作，連重抓都不必：呼叫端拿到這一格的結果
   * 就地把手上那一列換掉就好（見 lib/api applyRestrictedPatch）。
   * 沒給就退回 onUpdate，行為跟以前一樣。
   */
  onToggleRestricted?: (photoId: number, next: boolean) => Promise<boolean>;
  onPrev?: () => void;
  onNext?: () => void;
  hasPrev?: boolean;
  hasNext?: boolean;
}

/**
 * 現在是不是手機的版面（≤768px，跟 lightbox.module.css 的斷點同一個數字）。
 *
 * ⚠️ 初值就直接問 matchMedia，**不是先給 false 再用 effect 補**：燈箱只有在
 *    使用者點下去之後才會被掛出來（靜態匯出的 HTML 裡根本沒有它），所以不會
 *    有 hydration mismatch；反過來先給 false 的話，手機上第一幀會先把 Story
 *    與留言整片畫出來再收掉（而且留言那支請求已經送出去了），閃一下不說，
 *    「一進去只有照片」這件事就等於沒做到。
 */
function useIsMobile() {
  const [isMobile, setIsMobile] = useState(
    () => typeof window !== "undefined" && window.matchMedia("(max-width: 768px)").matches,
  );
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 768px)");
    const onChange = () => setIsMobile(mq.matches);
    onChange();
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return isMobile;
}

export default function PhotoLightbox({ photo, isAdmin, availableTags, onClose, onUpdate, onToggleRestricted, onPrev, onNext, hasPrev, hasNext }: PhotoLightboxProps) {
  /*
   * EXIF 面板的開合是**站台層級的偏好**，不是這一張照片的狀態（見 lib/exifPref）。
   * 以前是 useState(false)：每換一張就收回去，想一路看相機參數得一張按一次。
   */
  const showExif = useExifExpanded();
  // 「拍攝時間」那顆按鈕開的視窗。用的是相簿頁那支 FixTimeModal，只是鎖在「指定時間」
  const [showFixTime, setShowFixTime] = useState(false);

  /* ── 手機：一進來只有照片，點一下才叫出 Story 與留言 ────────────────────
   *
   * 使用者的原話：「點進去燈箱後 希望是不要有任何其他 小故事 留言那些文字，
   * 單純只有照片就好，再點一下照片 才會浮現 story 跟留言，以及查看更多的
   * 文字按鈕，點了之後才會在出現更多其他資訊」。三段：
   *
   *   0 只有照片（照片撐滿整個畫面）
   *   1 ＋ Story ＋ 留言 ＋ 一顆「查看更多」
   *   2 ＋ 標籤／地點／照片資訊(EXIF)
   *
   * ⚠️ **收起來的那幾段是真的不 render，不是用 CSS 藏起來**：`PhotoComments`
   *    一掛上去就是一趟 `GET /api/photos/:id/comments`（D1 讀取）。藏起來的話
   *    每開一張照片照樣花那一趟，而使用者根本還沒說他要看留言。
   * ⚠️ 桌機完全不受影響 —— 那邊是左右兩欄，照片跟留言本來就並排，
   *    收起來只會空一大塊。所以每一個判斷都先看 `isMobile`。
   * ⚠️ 換上一張／下一張**刻意不歸零**：想一路看照片的人不該每換一張就再點一次，
   *    想看留言的人也一樣。歸零的只有「關掉燈箱再開」（元件重新掛載）。
   */
  const isMobile = useIsMobile();
  const [mobileStage, setMobileStage] = useState<0 | 1 | 2>(0);
  /** 手機上現在收著（＝只有照片）。桌機永遠是 false */
  const collapsed = isMobile && mobileStage === 0;
  /** Story 與留言要不要端出來 */
  const showBasics = !isMobile || mobileStage >= 1;
  /** 標籤／地點／照片資訊要不要端出來 */
  const showMore = !isMobile || mobileStage === 2;

  
  const [descValue, setDescValue] = useState(photo.description || "");
  const [isSavingDesc, setIsSavingDesc] = useState(false);
  const [isEditingDesc, setIsEditingDesc] = useState(false);
  
  const [newTagName, setNewTagName] = useState("");
  const [isAddingTag, setIsAddingTag] = useState(false);

  /*
   * 「不開放」那顆開關（0020）。
   *
   * 這裡刻意**不看 isAdmin**（那個是逐張的「這張我改得動嗎」）—— 誰看得到是全站
   * 層級的決定，後端也只讓 can_manage_others 動得了。端給改得動照片但管不了全站
   * 的人，只會換到一顆按下去 403 的開關。
   */
  const { canManageOthers, restrictedBlur } = useAdmin();
  const [isSavingRestricted, setIsSavingRestricted] = useState(false);
  /*
   * 遮罩：不開放的照片連我自己看都先糊著（站長在 /admin 開的全站設定）。
   * 掀開狀態是全站共用的一份（lib/restrictedReveal），所以在格線上掀開的那一張
   * 點進來就是掀開的，換上一張／下一張又各自算各自的。
   */
  const revealedRestricted = useRevealedRestricted();
  const blurred = restrictedBlur && photo.restricted === 1 && !revealedRestricted.has(photo.id);

  const handleToggleRestricted = async (next: boolean) => {
    setIsSavingRestricted(true);
    let ok: boolean;
    if (onToggleRestricted) {
      ok = await onToggleRestricted(photo.id, next);
    } else {
      ok = (await setPhotosRestricted([photo.id], next)).ok;
      if (ok) onUpdate();
    }
    setIsSavingRestricted(false);
    if (!ok) alert("設定失敗，請再試一次");
  };

  useEffect(() => {
    setDescValue(photo.description || "");
    setIsEditingDesc(false);
  }, [photo.id, photo.description]);

  /* ── 手機上把照片放大來看 ──────────────────────────────────────────────
   *
   * 兩指捏合放大（1～5 倍，以兩指中點為錨點）、放大之後單指拖著看、
   * 輕點兩下在原尺寸與 2.5 倍之間切換。換一張照片就回到原尺寸。
   *
   * ⚠️⚠️ 監聽器一定要**自己用 addEventListener 掛、而且 `{ passive: false }`**。
   *    React 的 onTouchMove 是掛在 root 上的**被動**監聽器，在裡面呼叫
   *    `preventDefault()` 一點作用都沒有（瀏覽器照樣捲頁面／接管手勢），
   *    捏合到一半畫面就跟著滑走了。相簿格線那個改欄數的捏合也是同一套寫法。
   * ⚠️ 位移直接寫進 DOM 的 style，**不走 React state** —— 一次捏合是幾十次
   *    touchmove，每一次都重畫整個燈箱（右邊還掛著留言、EXIF、標籤）會掉格。
   *    只有「現在有沒有放大」是 state：它要換掉 touch-action，並讓左右滑動讓開。
   * ⚠️ 影片不參與（`<video>` 自己要吃拖時間軸那些手勢）。
   */
  const containerRef = useRef<HTMLDivElement | null>(null);
  const zoomRef = useRef<HTMLDivElement | null>(null);
  const tf = useRef({ scale: 1, x: 0, y: 0 });
  const [zoomed, setZoomed] = useState(false);
  const zoomable = !isVideo(photo);

  const applyTransform = useCallback(() => {
    const el = zoomRef.current;
    if (!el) return;
    const { scale, x, y } = tf.current;
    el.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
  }, []);

  const resetZoom = useCallback(() => {
    tf.current = { scale: 1, x: 0, y: 0 };
    applyTransform();
    setZoomed(false);
  }, [applyTransform]);

  // 換一張就回到原尺寸 —— 上一張放大到 5 倍的位置對這一張沒有任何意義
  useEffect(() => { resetZoom(); }, [photo.id, resetZoom]);

  /*
   * Android 的動態照片：一張 .jpg 的尾巴上黏著一段 mp4（見 migrations/0024）。
   * 位元組在 Drive 上那份原始檔裡，`/api/photos/:id/motion` 從那裡切出來。
   *
   * ⚠️⚠️ **進燈箱就自己播，而且一直重播**（2026-09-01 使用者拍板改的；
   *    在那之前是「點了才載」）。代價是真的：那段影片 1～4MB，**每開一張
   *    動態照片就是一趟 Drive 取檔**，不是使用者真的想看才花。交換到的是
   *    「動態照片一點進來就在動」—— 那本來就是這種照片存在的理由。
   *    只有動態照片走這條（`hasMotionClip`），普通照片一毛錢也不多花。
   * ⚠️ 重播中間隔 `MOTION_REPLAY_GAP_MS`（0.5 秒），不是 `loop` 屬性 ——
   *    一兩秒的東西接成無縫的循環看起來像一團抽損的畫面，
   *    中間停一下才看得出來「這是一段影片在重播」。
   *    它是一支 `setTimeout`，**換照片與按停止都要收**，不然上一張的計時器
   *    會在這一張身上叫 `play()`。
   * ⚠️ 影片與 GIF 沒有這件事：它們本身就會動，`motion_offset` 對它們永遠是 0。
   */
  const hasMotionClip = !isVideo(photo) && !isGif(photo) && hasMotion(photo);
  const [playMotion, setPlayMotion] = useState(hasMotionClip);
  const [motionFailed, setMotionFailed] = useState(false);
  const motionRef = useRef<HTMLVideoElement | null>(null);
  const motionTimerRef = useRef<number | null>(null);
  const clearMotionTimer = useCallback(() => {
    if (motionTimerRef.current !== null) {
      window.clearTimeout(motionTimerRef.current);
      motionTimerRef.current = null;
    }
  }, []);
  useEffect(() => {
    clearMotionTimer();
    setPlayMotion(hasMotionClip);
    setMotionFailed(false);
  }, [photo.id, hasMotionClip, clearMotionTimer]);
  // 離開燈箱時也要收 —— 計時器活得比元件久就是一支指向已卸載 DOM 的手
  useEffect(() => clearMotionTimer, [clearMotionTimer]);

  /*
   * ⚠️ **影片不參與收合**，跟它不參與捏合放大是同一個理由：`<video>` 自己要吃
   *    點擊（播放／暫停）與拖時間軸那些手勢，`VideoPlayer` 的外框也刻意把 touch
   *    擋在燈箱之外。拿「點一下」當開關就等於搶走播放鍵，而影片一旦收起來就
   *    再也叫不出留言 —— 那是一條沒有出口的路。所以影片一律從第 1 段開始
   *    （Story ＋ 留言看得到，「查看更多」照樣按得到）。
   */
  useEffect(() => {
    if (!isVideo(photo)) return;
    setMobileStage((s) => (s === 0 ? 1 : s));
  }, [photo.id, photo.media_type]);

  /*
   * 輕點一下要做的事。放在 ref 裡是為了讓底下那個掛原生監聽器的 effect
   * **不必因為 stage 換了就重掛一次** —— 重掛的瞬間手指還按著，捏合會斷掉。
   */
  const singleTapRef = useRef<() => void>(() => {});
  useEffect(() => {
    singleTapRef.current = () => {
      if (!isMobile) return;
      // 從第 2 段點下去也是直接收回只有照片：想再看資訊按一下就回來了
      setMobileStage((s) => (s === 0 ? 1 : 0));
    };
  }, [isMobile]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || !zoomable) return;

    const MIN = 1;
    const MAX = 5;
    /** 輕點兩下之間最多隔幾毫秒，以及「這一下算不算輕點」的容忍距離 */
    const TAP_MS = 300;
    const TAP_SLOP = 12;

    let pinchDist = 0;                                   // 0 ＝ 現在不是捏合
    let start = { scale: 1, x: 0, y: 0 };
    let anchor = { x: 0, y: 0 };                         // 起手時中點落在圖層的哪裡
    let panFrom: { x: number; y: number } | null = null;
    let tapFrom: { x: number; y: number; t: number } | null = null;
    let lastTap = 0;
    /** 等著看「這一下到底是輕點一下，還是輕點兩下的第一下」的計時器 */
    let singleTap: ReturnType<typeof setTimeout> | null = null;
    const cancelSingleTap = () => {
      if (singleTap) { clearTimeout(singleTap); singleTap = null; }
    };

    const rectOf = () => el.getBoundingClientRect();
    const gap = (t: TouchList) =>
      Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
    const midOf = (t: TouchList, r: DOMRect) => ({
      x: (t[0].clientX + t[1].clientX) / 2 - r.left,
      y: (t[0].clientY + t[1].clientY) / 2 - r.top,
    });

    /*
     * 夾住位移：放大時不讓照片被拖到整片離開畫面（拖出去就再也找不回來），
     * 一倍時一律回到正中央。transform-origin 是 0 0，所以位移的合法範圍是
     * 「放大後多出來的那一段」的負值。
     */
    const clamp = (v: number, s: number, size: number) => {
      const span = size * s - size;
      if (span <= 0) return 0;
      return Math.min(0, Math.max(-span, v));
    };
    const commit = (scale: number, x: number, y: number, r: DOMRect) => {
      tf.current = { scale, x: clamp(x, scale, r.width), y: clamp(y, scale, r.height) };
      applyTransform();
    };

    /** 輕點兩下：原尺寸 ⇄ 2.5 倍，以點到的那個位置為錨點 */
    const toggleAt = (px: number, py: number, r: DOMRect) => {
      if (tf.current.scale > 1) {
        tf.current = { scale: 1, x: 0, y: 0 };
        applyTransform();
        setZoomed(false);
        return;
      }
      const s = 2.5;
      commit(s, px * (1 - s), py * (1 - s), r);
      setZoomed(true);
    };

    const onStart = (e: TouchEvent) => {
      // 又有手指下來了：先前那一下不能算「輕點一下」（可能是雙擊，也可能是拖）
      cancelSingleTap();
      if (e.touches.length === 2) {
        if (e.cancelable) e.preventDefault();
        const r = rectOf();
        pinchDist = gap(e.touches);
        start = { ...tf.current };
        const m = midOf(e.touches, r);
        // 中點在「還沒縮放的圖層」上的座標。整段捏合都以它為錨點
        anchor = { x: (m.x - start.x) / start.scale, y: (m.y - start.y) / start.scale };
        panFrom = null;
        tapFrom = null;
      } else if (e.touches.length === 1) {
        const t = e.touches[0];
        tapFrom = { x: t.clientX, y: t.clientY, t: Date.now() };
        if (tf.current.scale > 1) panFrom = { x: t.clientX, y: t.clientY };
      }
    };

    const onMove = (e: TouchEvent) => {
      if (e.touches.length >= 2 && pinchDist > 0) {
        if (e.cancelable) e.preventDefault();
        const r = rectOf();
        const scale = Math.min(MAX, Math.max(MIN, (start.scale * gap(e.touches)) / pinchDist));
        const m = midOf(e.touches, r);
        // 錨點跟著兩指中點走，所以捏合同時也能把照片挪過去
        commit(scale, m.x - anchor.x * scale, m.y - anchor.y * scale, r);
        return;
      }
      if (panFrom && e.touches.length === 1 && tf.current.scale > 1) {
        if (e.cancelable) e.preventDefault();
        const t = e.touches[0];
        commit(
          tf.current.scale,
          tf.current.x + (t.clientX - panFrom.x),
          tf.current.y + (t.clientY - panFrom.y),
          rectOf(),
        );
        panFrom = { x: t.clientX, y: t.clientY };
      }
    };

    const onEnd = (e: TouchEvent) => {
      if (e.touches.length < 2) pinchDist = 0;
      if (e.touches.length > 0) return;

      panFrom = null;
      // 手指全部離開才換一次 state：捏合過程中重畫整個燈箱會掉格
      setZoomed(tf.current.scale > 1);

      const t = e.changedTouches[0];
      const from = tapFrom;
      tapFrom = null;
      if (!t || !from) return;
      const isTap =
        Date.now() - from.t < 500 &&
        Math.hypot(t.clientX - from.x, t.clientY - from.y) < TAP_SLOP;
      if (!isTap) { lastTap = 0; return; }

      const now = Date.now();
      if (now - lastTap < TAP_MS) {
        lastTap = 0;
        cancelSingleTap();
        const r = rectOf();
        toggleAt(t.clientX - r.left, t.clientY - r.top, r);
      } else {
        lastTap = now;
        /*
         * 輕點一下＝手機上把 Story／留言收起來或叫回來（見 mobileStage）。
         *
         * ⚠️ **一定要等過 TAP_MS 才動手**，不能當場做：輕點兩下是放大，
         *    馬上做的話每一次放大都會先閃一下收合。第二下的 touchstart 會把
         *    這個計時器取消掉。
         * ⚠️ 放大中（scale > 1）不算 —— 那時候的一下是「我還在看細節」，
         *    把畫面收掉只會打斷他。
         */
        /*
         * ⚠️ 點在按鈕上的那一下不算。照片上面疊著換頁箭頭、左上角那顆鎖、
         *    以及「點一下暫時顯示」的遮罩 —— 它們都是 button，而原生監聽器
         *    掛在整個容器上，子節點的 touchend 照樣冒泡上來（React 那邊的
         *    stopPropagation 攔不到原生事件）。不擋的話按一下遮罩會同時
         *    掀開照片又把 Story 叫出來。
         */
        const onBtn = !!(t.target as HTMLElement | null)?.closest?.("button");
        if (tf.current.scale === 1 && !onBtn) {
          cancelSingleTap();
          singleTap = setTimeout(() => { singleTap = null; singleTapRef.current(); }, TAP_MS);
        }
      }
    };

    // ⚠️ passive: false —— 見上面那段。touchend 不 preventDefault，可以是被動的
    el.addEventListener("touchstart", onStart, { passive: false });
    el.addEventListener("touchmove", onMove, { passive: false });
    el.addEventListener("touchend", onEnd, { passive: true });
    el.addEventListener("touchcancel", onEnd, { passive: true });
    return () => {
      cancelSingleTap();
      el.removeEventListener("touchstart", onStart);
      el.removeEventListener("touchmove", onMove);
      el.removeEventListener("touchend", onEnd);
      el.removeEventListener("touchcancel", onEnd);
    };
  }, [zoomable, applyTransform]);

  // Swipe State
  const [touchStart, setTouchStart] = useState<number | null>(null);
  const [touchEnd, setTouchEnd] = useState<number | null>(null);
  const minSwipeDistance = 50;

  /*
   * ⚠️ 放大中或兩指按著的時候**左右滑動要整組讓開** —— 不然拖著看放大後的
   *    照片，手一往左走就換到下一張了。用 tf.current 判斷（不是 zoomed 那個
   *    state）：捏合過程中刻意不重畫，state 還停在上一個值。
   */
  const swipeBlocked = (e: React.TouchEvent) =>
    e.touches.length > 1 || tf.current.scale > 1;

  const onTouchStartEvent = (e: React.TouchEvent) => {
    setTouchEnd(null);
    if (swipeBlocked(e)) { setTouchStart(null); return; }
    setTouchStart(e.targetTouches[0].clientX);
  };

  const onTouchMoveEvent = (e: React.TouchEvent) => {
    if (swipeBlocked(e)) { setTouchEnd(null); return; }
    setTouchEnd(e.targetTouches[0].clientX);
  };

  const onTouchEndEvent = () => {
    if (!touchStart || !touchEnd) return;
    const distance = touchStart - touchEnd;
    const isLeftSwipe = distance > minSwipeDistance;
    const isRightSwipe = distance < -minSwipeDistance;
    if (isLeftSwipe && onNext && hasNext) {
      onNext();
    }
    if (isRightSwipe && onPrev && hasPrev) {
      onPrev();
    }
  };

  // 燈箱開啟時鎖定背景 body 滾動，並支援鍵盤 (Left/Right/Esc) 與 滾輪切換照片
  React.useEffect(() => {
    const originalStyle = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowLeft" && hasPrev && onPrev) onPrev();
      else if (e.key === "ArrowRight" && hasNext && onNext) onNext();
    };

    /*
     * 在輸入框裡打字時左右鍵是移動游標，不是換照片。滾輪那邊本來就有這個防護
     * （handleWheel），鍵盤這邊漏了 —— 留言框進來之後這件事會天天發生：
     * 打錯字想按左鍵回去改，結果整張照片換掉、打到一半的留言也沒了。
     */
    const guarded = (e: KeyboardEvent) => {
      /*
       * ⚠️ 「指定時間」的視窗開著的時候，整組快捷鍵要讓開。那個視窗裡全是
       *    <select>，而 select 不是 INPUT／TEXTAREA —— 下面那道防護攔不住它：
       *    在年份選單上按左右鍵會一邊改年份、一邊把燈箱換到下一張照片。
       *    Esc 也一樣，該收掉的是視窗不是整個燈箱。
       */
      if (showFixTime) return;
      const el = e.target as HTMLElement | null;
      const tag = el?.tagName;
      if (tag === "TEXTAREA" || tag === "INPUT" || el?.isContentEditable) {
        // Esc 仍然要能關掉燈箱，但在輸入框裡先讓它把焦點吐出來就好
        if (e.key === "Escape") (el as HTMLElement).blur();
        return;
      }
      handleKeyDown(e);
    };

    window.addEventListener("keydown", guarded);

    return () => {
      document.body.style.overflow = originalStyle;
      window.removeEventListener("keydown", guarded);
    };
  }, [hasPrev, hasNext, onPrev, onNext, onClose, showFixTime]);

  // 支援滑鼠滾輪切換照片 (滾輪往下: 下一張; 滾輪往上: 上一張)
  const handleWheel = (e: React.WheelEvent) => {
    // 「指定時間」的視窗開著時不換照片（同鍵盤那邊的理由）
    if (showFixTime) return;
    // 放大來看的時候也不換 —— 滾一下就跳掉的話根本看不完一張（輕點兩下收回原尺寸）
    if (tf.current.scale > 1) return;
    // 若在編輯框或輸入框內滾動則不觸發切換
    if ((e.target as HTMLElement).tagName === 'TEXTAREA' || (e.target as HTMLElement).tagName === 'INPUT') {
      return;
    }
    if (e.deltaY > 30 && hasNext && onNext) {
      onNext();
    } else if (e.deltaY < -30 && hasPrev && onPrev) {
      onPrev();
    }
  };

  const parsedExif = photo.exif ? JSON.parse(photo.exif) : null;

  // 拍攝時間一律顯示照片自己的牆上時間加上時區標籤。
  // 不用 new Date(taken_at).toLocaleString() —— 那會換算成「看照片的人所在的時區」，
  // 在日本拍的照片用台灣的瀏覽器打開會少三小時，看起來像資料壞了。
  //
  // 沒有 taken_at_local 的舊資料要走退路，三層由可信到最不可信：
  //   1. exif.DateTimeOriginal 是不帶時區的牆上時間（'2026:06:18 16:11:00'）→ 直接用
  //   2. taken_at 是真正的 UTC 瞬間，配上這張照片自己的時區 → 換算得到牆上時間
  //   3. 舊 exif blob 裡序列化過的 '2026-06-18T08:11:00.000Z' → 最後手段
  //
  // 第 3 層要擺最後，是因為那個字串其實不是可靠的瞬間：exifr 會用「解析當下的
  // 執行環境時區」把 EXIF 時間 revive 成 Date（同一張照片在瀏覽器得 08:11Z、
  // 在 Worker 得 16:11Z），JSON.stringify 之後就把那個時區烤了進去。要還原只能
  // 賭當初上傳的瀏覽器時區，所以只有在 taken_at 也沒有時才用它。
  // 硬把它當第 1 層那種字串讀的話，台灣的照片會顯示成早上 8 點（少 8 小時）。
  // 時區未知時退回站台預設值，但 displayDate 不會為此加上時區標籤 —— 那是猜的。
  const tzForFallback = photo.tz_offset_minutes ?? DEFAULT_TZ_OFFSET_MINUTES;
  const exifWall =
    parseExifDateTime(parsedExif?.DateTimeOriginal)
    ?? wallClockFromInstant(photo.taken_at, tzForFallback)
    ?? wallClockFromInstant(parsedExif?.DateTimeOriginal, tzForFallback);
  const wallClock = photo.taken_at_local || (exifWall ? formatWallClock(exifWall) : null);
  const displayDate = wallClock
    ? (photo.tz_offset_minutes != null
        ? `${wallClock}　${formatTzOffset(photo.tz_offset_minutes)}`
        : wallClock)
    : null;

  /*
   * 拍攝時間改不改得動。
   *
   * 規則是**本來就沒有時間的才可以指定** —— 相機（EXIF）給的時間是那張照片的
   * 事實，不該在燈箱裡被隨手改掉；沒有時間的那些（影片的封面圖是 canvas 畫的、
   * 掃描的老照片）則是非指定不可，不然它們永遠浮在相簿最前面排不進去。
   *
   * 已經是 `manual` 的還留著可以再改：那個值是人自己填進去的，打錯字的話
   * 這是唯一改得回來的地方（鎖起來等於一次打錯就永遠錯著）。
   * 其餘的來源（offset_tag／gps_utc／file_time／assumed）都是從檔案本身推出來的，
   * 一律鎖住 —— 要批次修正還是走相簿頁那三支（平移／改時區／指定）。
   *
   * ⚠️ 判斷用 displayDate 不是 photo.taken_at：EXIF 裡有時間但 D1 沒存到的
   *    舊資料，畫面上是看得到時間的，那也算「本來就有」。
   *
   * ⚠️⚠️ **影片與 GIF 是例外，永遠改得動**（2026-08-31）。它們的時間是從
   *    mp4 的 moov box（或檔名）推出來的，而那裡面**沒有時區** —— 我們靠
   *    「UTC 瞬間 ⊖ 檔名牆上時間」猜，猜不到時直接當 +8（`assumed`）。
   *    跟相機的 EXIF 不是同一個等級的事實，鎖起來等於猜錯了就永遠錯著，
   *    而這是唯一改得回來的地方。GIF 根本沒有時間可言，同理。
   */
  const canEditTime = isAdmin
    && (!displayDate || photo.time_source === 'manual' || isVideo(photo) || isGif(photo));

  const handleSaveDesc = async () => {
    setIsSavingDesc(true);
    const success = await updatePhoto(photo.id, { description: descValue });
    if (success) {
      onUpdate();
      setIsEditingDesc(false);
    }
    setIsSavingDesc(false);
  };

  const handleAddTag = async () => {
    if (!newTagName.trim()) return;
    setIsAddingTag(true);
    const tag = await addPhotoTag(photo.id, newTagName.trim());
    if (tag) {
      setNewTagName("");
      onUpdate();
    }
    setIsAddingTag(false);
  };

  const handleRemoveTag = async (tagId: number) => {
    const success = await removePhotoTag(photo.id, tagId);
    if (success) onUpdate();
  };

  const formatExposureTime = (time: number | string | undefined) => {
    if (!time) return null;
    const t = Number(time);
    if (isNaN(t) || t === 0) return time;
    if (t >= 1) return `${t}s`;
    return `1/${Math.round(1 / t)}s`;
  };

  const exifItems = [
    { label: '相機', value: parsedExif?.Make },
    { label: '型號', value: parsedExif?.Model },
    { label: '鏡頭', value: parsedExif?.LensModel },
    { label: '光圈', value: parsedExif?.FNumber ? `f/${parsedExif.FNumber}` : null },
    { label: '快門', value: formatExposureTime(parsedExif?.ExposureTime) },
    { label: 'ISO', value: parsedExif?.ISO },
    { label: '焦距', value: parsedExif?.FocalLength ? `${parsedExif.FocalLength}mm` : null },
  ].filter(item => item.value);

  /*
   * 影片的 Metadata（`exif._video`，見 lib/videoMeta.ts）。
   *
   * ⚠️ 「影片沒有 metadata」是誤解 —— mp4／mov 把機身、型號、解析度、編碼、
   *    影格率、建立時間、座標全記在 moov box 裡，只是我們以前沒讀。上傳時在
   *    瀏覽器解、存量的由 /admin「影片的 Metadata」回讀，兩條路都寫進
   *    `Photo.exif` 的 `_video` 底下。所以影片這一塊**不是空的**，
   *    面板的名字也跟著從「照片資訊 (EXIF)」換成「影片的 Metadata」。
   * ⚠️ 沒對照到常用鍵的原始標籤（`Tags`）照樣一條一條列出來 —— 使用者要的是
   *    「檔案裡所有的 metadata」，挑幾格端出來等於又替他決定哪些不重要。
   */
  const videoMeta = (parsedExif?._video ?? null) as Record<string, any> | null;
  const videoTags: Record<string, string> = videoMeta?.Tags ?? {};
  const videoMetaItems = [
    { label: '相機', value: videoMeta?.Make },
    { label: '型號', value: videoMeta?.Model },
    { label: '軟體', value: videoMeta?.Software },
    {
      label: '解析度',
      value: videoMeta?.Width && videoMeta?.Height
        ? `${videoMeta.Width} × ${videoMeta.Height}`
        : null,
    },
    { label: '旋轉', value: videoMeta?.Rotation ? `${videoMeta.Rotation}°` : null },
    { label: '長度', value: formatDuration(videoMeta?.DurationMs ?? photo.duration_ms) },
    { label: '影格率', value: videoMeta?.FrameRate ? `${videoMeta.FrameRate} fps` : null },
    { label: '視訊編碼', value: videoMeta?.VideoCodec },
    { label: '音訊編碼', value: videoMeta?.AudioCodec },
    ...Object.keys(videoTags).map((k) => ({ label: k, value: videoTags[k] })),
  ].filter(item => item.value);

  /** 兩邊畫的是同一個 grid（欄位長得一樣），差別只在資料從哪一塊來 */
  const infoItems = isVideo(photo) ? videoMetaItems : exifItems;

  return (
    /*
     * ⚠️ `data-lightbox` 是給**相簿格線與首頁那兩支改欄數的捏合**認的記號
     *    （app/page.tsx、app/album/page.tsx 的 document 層 touch 監聽器）：
     *    燈箱開著的時候那兩支要整組讓開，不然在這裡捏一下放大照片，
     *    被蓋在後面的格線也跟著改欄數。
     */
    <div className={styles.overlay} data-lightbox onClick={onClose}>
      <button className={styles.closeBtn} onClick={(e) => { e.stopPropagation(); onClose(); }} title="關閉">×</button>
      
      <div className={styles.content} onClick={e => e.stopPropagation()}>

        {/*
          * 照片與照片資訊（Story／標籤／地點／EXIF）是同一塊，留言是另一塊。
          * 桌機時這兩塊左右並排、各自捲；手機時一路往下堆。分欄全靠 CSS，
          * 這裡不判斷螢幕寬度。
          *
          * ⚠️ 底下這一大段沒有跟著 mainPane 縮排 —— 純粹是為了讓當初那次
          *    「把留言搬到右邊」的 diff 只有幾行，不要整檔重排。
          */}
        <div className={styles.mainPane}>

        <div
          ref={containerRef}
          /*
           * 放大中才鎖 touch-action —— 一倍時要留給 .content 直向捲動
           * （手機上照片底下還有 Story、標籤、留言，那些得捲得動）。
           */
          className={`${styles.imageContainer} ${blurred ? styles.blurred : ''} ${zoomed ? styles.zooming : ''} ${collapsed ? styles.soloImage : ''}`}
          onTouchStart={onTouchStartEvent}
          onTouchMove={onTouchMoveEvent}
          onTouchEnd={onTouchEndEvent}
        >
          {/*
            * 影片與照片在這裡分岔。
            *
            * ⚠️ 影片**不能走下面那套判斷**：它的 Drive file id 記在 drive_original_id，
            *    drive_file_id 永遠是 null（見 migrations/0019）—— 不先擋掉的話每一支
            *    影片都會掛上「Drive 沒接上，顯示的是 800px 縮圖」，而那是假的。
            */}
          {isVideo(photo) ? (
            <VideoPlayer photo={photo} />
          ) : (
            <>
          {/*
            * 放大用的圖層。**只包照片本身** —— 那顆鎖、換頁箭頭、
            * 「顯示的是 800px 縮圖」那句話都留在外面，不然放大 5 倍時
            * 它們會跟著變成五倍大並被推出畫面。
            */}
          <div ref={zoomRef} className={styles.zoomLayer}>
          {/* 走 Worker 代理拿 Drive 的 4K；沒有的話那條路由自己會退回 R2 的 800px */}
          {/*
            * 縮圖先頂著、Drive 的 4K 載好再淡入蓋掉。使用者是從格線點進來的，
            * 那張 800px 已經在瀏覽器快取裡 —— 於是點開的瞬間就有畫面，不是黑的。
            *
            * pendingLabel 只在真的有 4K 可等的時候給：沒搬上 Drive 的照片，
            * /full 會 302 回同一張 800px，掛「載入中」等於承諾一個不會來的東西。
            */}
          <PhotoImage
            src={photoFullSrc(photo)}
            placeholderSrc={photoThumbSrc(photo, 'md')}
            alt={photo.title}
            className={styles.image}
            /*
             * GIF 也有東西可等，只是來源不是 Drive 而是 R2 那顆動畫本體
             * （最大 25MB）—— 底下那張靜止的縮圖已經先頂著，不講的話使用者
             * 會以為這張 GIF 壞了不會動。
             */
            pendingLabel={photo.drive_file_id ? '高畫質載入中…' : isGif(photo) ? '動畫載入中…' : null}
          />
          </div>
          {/*
            * R2 只存縮圖，大圖唯一的來源是 Drive。沒有 drive_file_id 就代表現在看到的
            * 是 800px 的相簿縮圖 —— 不講的話使用者只會覺得「這張怎麼有點糊」。
            * 判斷依據刻意用 D1 的欄位而不是圖片實際載到哪一版：Drive 暫時掛掉是幾分鐘的事，
            * 沒有備份是永久的，後者才需要有人去補傳。
            */}
          {/*
            * ⚠️ GIF 要先擋掉，理由跟影片一樣（見上面）：它的動畫本體在 R2、
            *    Drive 上只有原始檔那一份，`drive_file_id` 對它**永遠是 null**。
            *    不擋的話每一張 GIF 都會掛上一句「顯示的是 800px 縮圖」，
            *    而使用者眼前那張正在動的就是完整的原檔。
            */}
          {!isGif(photo) && !photo.drive_file_id && (
            <span className={styles.qualityNote}>
              Drive 沒接上或缺這張備份，顯示的是 800px 縮圖
            </span>
          )}
          {/*
            * 動態照片的那段 mp4。蓋在靜態照片上面、但在遮罩底下（見 CSS）。
            *
            * ⚠️ **不要加 crossOrigin**：不加是 no-cors，跟 <img> 一樣免預檢；
            *    加了 Range 會多一次預檢，而我們也沒有要讀回應的內容（同影片那條）。
            * ⚠️ muted 是必要的，不是偏好 —— 沒有它瀏覽器不准自動播放，
            *    使用者按下去會什麼都不發生。動態照片本來也沒有聲音。
            * ⚠️ 播完自己收回去（onEnded）：那是一兩秒的東西，留在最後一格
            *    不動的畫面上，看起來像卡住了。
            */}
          {hasMotionClip && playMotion && (
            <video
              /* 換一張要重建，不然 src 換了但還停在上一支的最後一格 */
              key={photo.id}
              ref={motionRef}
              className={styles.motionVideo}
              src={photoMotionSrc(photo)}
              poster={photoThumbSrc(photo, 'md')}
              autoPlay
              muted
              playsInline
              onEnded={() => {
                // 停半秒再從頭來（見上面：無縫循環看不出來它在重播）
                clearMotionTimer();
                motionTimerRef.current = window.setTimeout(() => {
                  motionTimerRef.current = null;
                  const v = motionRef.current;
                  if (!v) return;
                  v.currentTime = 0;
                  // 分頁被蓋住、電池模式…… play() 被擋下來是常態，不是錯誤
                  void v.play().catch(() => {});
                }, MOTION_REPLAY_GAP_MS);
              }}
              onError={() => {
                clearMotionTimer();
                setPlayMotion(false);
                setMotionFailed(true);
              }}
            />
          )}
          {/*
            * 這顆是 <button> 不只是為了語意：手機上「輕點照片一下」是那三段
            * 收合／展開的開關，而那個原生監聽器認的就是「點到的是不是按鈕」。
            * 讀不到的時候把原因寫在按鈕上 —— 按了沒反應是這個站最不該有的東西。
            */}
          {hasMotionClip && (
            <button
              type="button"
              className={styles.motionBtn}
              disabled={motionFailed}
              title={motionFailed
                ? '這張的動畫讀不到（原始檔可能還沒備份到 Drive）'
                : playMotion
                  ? '停下這張照片的動態片段'
                  : '播放這張照片的動態片段'}
              onClick={(e) => {
                e.stopPropagation();
                if (motionFailed) return;
                // 放大中直接播會讓影片跟底下那張照片對不齊，先歸零
                resetZoom();
                // 按停止時連重播的計時器一起收，不然半秒後它又自己跳回來
                clearMotionTimer();
                setPlayMotion((v) => !v);
              }}
            >
              <span aria-hidden>{motionFailed ? '⚠' : playMotion ? '■' : '▶'}</span>
              <span>{motionFailed ? '動畫讀不到' : playMotion ? '停止' : '動態'}</span>
            </button>
          )}
            </>
          )}
          {/*
            * 不開放：一顆角落的小開關，就這樣。
            *
            * 以前這是右側資訊欄裡一整段（標題＋一行說明），跟 Story／標籤同一個層級。
            * 但它是每幾百張才會動一次的管理動作，佔那麼大一塊等於把「看照片」這件事
            * 往下推 —— 使用者的原話是「目前設計會影響體驗」。
            *
            * 關著的時候刻意很淡；開著就整顆亮起來並且把「不開放」三個字寫出來。
            * 這顆開關決定的是「誰看得到」，狀態絕對不能靠猜。
            */}
          {canManageOthers && (
            <button
              type="button"
              className={`${styles.restrictBtn} ${photo.restricted === 1 ? styles.restrictBtnOn : ''}`}
              disabled={isSavingRestricted}
              aria-pressed={photo.restricted === 1}
              title={photo.restricted === 1
                ? `目前不開放：只有可管理全站內容的人看得到這${isVideo(photo) ? '支影片' : '張照片'}，其他人的相簿、搜尋與地圖上都沒有它。按一下改回開放`
                : '按一下設成不開放：只有可管理全站內容的人看得到，其他人的相簿、搜尋與地圖上都不會有它'}
              onClick={(e) => { e.stopPropagation(); handleToggleRestricted(photo.restricted !== 1); }}
            >
              <span className={styles.restrictIcon} aria-hidden>{photo.restricted === 1 ? '🔒' : '🔓'}</span>
              {photo.restricted === 1 && <span>不開放</span>}
            </button>
          )}
          {/*
            * 蓋著的時候整塊都是「點一下掀開」。這一層一定要蓋在影片上面 ——
            * 不然糊著的影片還是按得到播放鍵，遮罩等於沒有。
            */}
          {blurred && (
            <button
              type="button"
              className={styles.revealVeil}
              onClick={(e) => { e.stopPropagation(); revealRestricted(photo.id); }}
            >
              <span>🔒 不開放</span>
              <span className={styles.revealVeilHint}>點一下暫時顯示</span>
            </button>
          )}
          {/* 掀開之後留一顆收回去的小鈕，位置接在左上角那顆鎖底下 */}
          {restrictedBlur && photo.restricted === 1 && !blurred && (
            <button
              type="button"
              className={styles.revealBack}
              onClick={(e) => { e.stopPropagation(); toggleRestrictedReveal(photo.id); }}
            >
              暫時顯示中 · 收回
            </button>
          )}
          {hasPrev && (
            <button className={`${styles.navButton} ${styles.prevButton}`} onClick={(e) => { e.stopPropagation(); onPrev?.(); }}>
              &#10094;
            </button>
          )}
          {hasNext && (
            <button className={`${styles.navButton} ${styles.nextButton}`} onClick={(e) => { e.stopPropagation(); onNext?.(); }}>
              &#10095;
            </button>
          )}
        </div>
        
        {showBasics && (
        <div className={styles.detailsContainer}>
          <div className={styles.section}>
            <div className={styles.sectionHeader}>
              <h3>Story</h3>
              {isAdmin && (
                <div className={styles.switchWrapper}>
                  <span>編輯</span>
                  <label className={styles.switch}>
                    <input type="checkbox" checked={isEditingDesc} onChange={(e) => setIsEditingDesc(e.target.checked)} />
                    <span className={styles.slider}></span>
                  </label>
                </div>
              )}
            </div>
            {isAdmin && isEditingDesc ? (
              <div className={styles.editGroup}>
                <textarea 
                  value={descValue} 
                  onChange={e => setDescValue(e.target.value)} 
                  className={styles.textarea}
                  placeholder="輸入 Story (上限 200 字)..."
                  maxLength={200}
                />
                <button className={styles.btn} onClick={handleSaveDesc} disabled={isSavingDesc || descValue === (photo.description || "")}>
                  儲存
                </button>
              </div>
            ) : (
              photo.description ? <p style={{ margin: 0, color: '#ccc', lineHeight: '1.5', fontSize: '0.85rem' }}>{photo.description}</p> : null
            )}
          </div>

          {/* 這一段（標籤／地點／照片資訊）在手機上要按過「查看更多」才出來 */}
          {showMore && (<>
          <div className={styles.section}>
            <h3>標籤</h3>
            <div className={styles.tagsArea} onClick={() => { if(isAdmin && (photo.tags?.length || 0) < 10) document.getElementById('tag-input')?.focus() }}>
              {photo.tags?.map(tag => (
                <span key={tag.id} className={styles.tag}>
                  {tag.name}
                  {isAdmin && (
                    <span className={styles.removeTag} onClick={(e) => { e.stopPropagation(); handleRemoveTag(tag.id); }}>×</span>
                  )}
                </span>
              ))}
              {isAdmin && (photo.tags?.length || 0) < 10 && (
                <>
                  <input 
                    id="tag-input"
                    type="text" 
                    value={newTagName} 
                    onChange={e => setNewTagName(e.target.value)} 
                    onBlur={() => { if(newTagName.trim()) handleAddTag() }}
                    onKeyDown={e => { if(e.key === 'Enter') handleAddTag() }}
                    placeholder="新增標籤..."
                    className={styles.framelessInput}
                    list="available-tags"
                  />
                  <datalist id="available-tags">
                    {availableTags.map(t => <option key={t.id} value={t.name} />)}
                  </datalist>
                </>
              )}
              {!photo.tags?.length && !isAdmin && <span style={{ color: '#777' }}>無標籤</span>}
            </div>

            {/* 管理員新增標籤時：快捷選取既有標籤膠囊按鈕 */}
            {isAdmin && (photo.tags?.length || 0) < 10 && availableTags.filter(t => !photo.tags?.some(pt => pt.name === t.name)).length > 0 && (
              <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginTop: '6px', alignItems: 'center' }}>
                <span style={{ fontSize: '0.75rem', color: '#888' }}>快速加入既有標籤：</span>
                {availableTags
                  .filter(t => !photo.tags?.some(pt => pt.name === t.name))
                  .map(t => (
                    <button
                      key={t.id}
                      type="button"
                      onClick={async (e) => {
                        e.stopPropagation();
                        setIsAddingTag(true);
                        const tag = await addPhotoTag(photo.id, t.name);
                        if (tag) onUpdate();
                        setIsAddingTag(false);
                      }}
                      style={{
                        background: 'rgba(255, 255, 255, 0.08)',
                        border: '1px solid rgba(255, 255, 255, 0.2)',
                        color: 'rgba(255, 255, 255, 0.9)',
                        padding: '2px 8px',
                        borderRadius: '12px',
                        fontSize: '0.75rem',
                        cursor: 'pointer',
                        transition: 'all 0.2s ease'
                      }}
                      onMouseOver={(e) => { e.currentTarget.style.background = 'var(--accent-color)'; e.currentTarget.style.color = '#fff'; }}
                      onMouseOut={(e) => { e.currentTarget.style.background = 'rgba(255, 255, 255, 0.08)'; e.currentTarget.style.color = 'rgba(255, 255, 255, 0.9)'; }}
                    >
                      + {t.name}
                    </button>
                  ))}
              </div>
            )}
          </div>

          {/* 位置與時間的編輯已移到「上傳後的補件視窗」與相簿頁的批次操作 ——
              燈箱是看照片的地方，這裡只留唯讀的地點 */}
          {isAdmin && (
            <div className={styles.section}>
              <div className={styles.sectionHeader}>
                <h3>地點</h3>
              </div>
              <span className={styles.exifValue}>{photo.place_name || '尚未指定地點'}</span>
            </div>
          )}

          {/* 「不開放」的開關在照片左上角（見 imageContainer 裡那顆），不在這一欄 */}

          {/*
            * 照片資訊。**影片也端這一塊**，而且端的東西跟照片一樣多 ——
            * 照片有 EXIF、影片有 moov 裡的 metadata（機身、型號、解析度、編碼…），
            * 所以標題跟著換成「影片的 Metadata」。「拍攝時間」與「時間來源」
            * 那兩格對影片尤其要緊：讀不到時間的影片在相簿裡會一直浮在最前面。
            */}
          <div className={styles.exifToggleRow}>
            <div className={styles.switchWrapper}>
              <span>{isVideo(photo) ? '顯示影片的 Metadata' : '顯示照片資訊 (EXIF)'}</span>
              <label className={styles.switch}>
                <input type="checkbox" checked={showExif} onChange={(e) => setExifExpanded(e.target.checked)} />
                <span className={styles.slider}></span>
              </label>
            </div>
          </div>

          {showExif && (
            <div className={styles.exifContainer}>
              <div className={styles.exifGrid}>
                {/*
                  * 拍攝時間就在這裡，**不另外開一個區塊** —— 它跟時間來源是同一件事
                  * 的兩半（幾點拍的、這個時間哪來的），拆成兩個地方看反而要對照。
                  * 改不改得動看 canEditTime（見上面）：相機給的時間鎖著，
                  * 沒有時間的才給那顆「指定時間」。
                  */}
                <div className={styles.exifItem}>
                  <span className={styles.exifLabel}>拍攝時間</span>
                  <span className={styles.exifValue}>
                    {displayDate
                      || (isVideo(photo) ? '未指定（檔案裡沒有寫時間）'
                        : isGif(photo) ? '未指定（GIF 沒有 EXIF）' : '未知')}
                  </span>
                </div>

                {/* 時間來源決定這張照片的時間可不可信 —— assumed 的照片不該拿去比對 GPS 軌跡 */}
                <div className={styles.exifItem}>
                  <span className={styles.exifLabel}>時間來源</span>
                  <span className={styles.exifValue}>
                    {(photo.time_source && TIME_SOURCE_LABEL[photo.time_source]) || '—'}
                    {canEditTime && (
                      <button
                        type="button"
                        className={styles.exifEditBtn}
                        onClick={() => setShowFixTime(true)}
                        title={displayDate ? '改掉手動填的時間' : '這一張沒有拍攝時間，指定一個'}
                      >
                        {displayDate ? '修改' : '指定時間'}
                      </button>
                    )}
                  </span>
                </div>

                {infoItems.length > 0 ? (
                  infoItems.map(item => (
                    <div className={styles.exifItem} key={item.label}>
                      <span className={styles.exifLabel}>{item.label}</span>
                      <span className={styles.exifValue}>{item.value}</span>
                    </div>
                  ))
                ) : (
                  <div className={styles.exifItem}>
                    <span className={styles.exifValue} style={{ color: '#888' }}>
                      {isVideo(photo)
                        ? '還沒讀過這支影片的 metadata（站長可以到後台「影片的 Metadata」回讀一次）'
                        : isGif(photo)
                          ? 'GIF 沒有相機參數'
                          : '此照片無其他 EXIF 參數'}
                    </span>
                  </div>
                )}
              </div>
            </div>
          )}
          </>)}

          {/*
            * 「查看更多」。手機專屬 —— 桌機沒有分段，上面那些本來就全在。
            * 刻意是一顆**文字**按鈕（使用者的原話：「查看更多的文字按鈕」），
            * 不做成箭頭或把手：這一塊底下接的是留言，多一個圖示反而看不出
            * 它管的是哪一段。展開之後換成「收起其他資訊」——
            * 只能靠點照片收回去的話，等於要人記住一個沒寫出來的手勢。
            */}
          {isMobile && (
            <button
              type="button"
              className={styles.moreBtn}
              onClick={() => setMobileStage((s) => (s === 2 ? 1 : 2))}
            >
              {mobileStage === 2 ? '收起其他資訊' : '查看更多'}
            </button>
          )}

        </div>
        )}

        </div>

        {/* 留言。看不看得到、留不留得了都在元件裡自己判斷（沒權限就整塊不出現，
            外面這層有 :empty 的規則跟著收掉），所以這裡不必再包一層條件 */}
        {/* ⚠️ 手機第 0 段**整塊不掛**，不是用 CSS 藏起來 —— 掛上去就是一趟
            GET /api/photos/:id/comments（見 mobileStage 那一段） */}
        {showBasics && (
        <div className={styles.commentsPane}>
          <PhotoComments photoId={photo.id} />
        </div>
        )}

        {/*
          * 指定／修改這一張的拍攝時間。用的就是相簿頁那支 FixTimeModal（鎖在
          * 「指定時間」那個模式），不另外做一套 —— 換算牆上時間與時區的規則
          * 只能有一份實作。
          * ⚠️ 它擺在 styles.content 裡面，那一層有 stopPropagation，
          *    所以在視窗裡點來點去不會把燈箱一起關掉。
          */}
        <FixTimeModal
          isOpen={showFixTime}
          photoIds={[photo.id]}
          titles={[photo.title || '']}
          initialMode="set"
          lockMode
          initialWall={wallClock}
          initialTz={photo.tz_offset_minutes}
          onClose={() => setShowFixTime(false)}
          onDone={() => onUpdate()}
        />
      </div>
    </div>
  );
}
