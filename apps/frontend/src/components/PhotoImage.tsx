"use client";

import React, { useCallback, useEffect, useState } from "react";
import styles from "./PhotoImage.module.css";

interface PhotoImageProps {
  /** 最終要顯示的網址 */
  src: string;
  /**
   * 先頂著的低解析度版本。給了才會有「點開就看得到、之後自己變清晰」的效果 ——
   * 燈箱要傳格線那張 800px 縮圖，使用者剛剛才在格線上看過，那張已經在瀏覽器快取裡，
   * 於是點開的瞬間就有畫面，Drive 的 4K 在背後慢慢來。
   */
  placeholderSrc?: string;
  alt: string;
  /**
   * 套在 `<img>` 上。**只負責 object-fit 之類的呈現方式**，位置與淡入由這個元件自己管。
   * 格線是 cover、燈箱是 contain，那是呼叫端才知道的事。
   */
  className?: string;
  /** 一次幾十張的格線要 lazy；燈箱的主圖是使用者正在等的東西，不要 lazy */
  lazy?: boolean;
  /**
   * placeholder 已經頂上、`src` 還沒到時顯示的角落提示。
   *
   * 不給就不顯示 —— 沒有更高畫質可以等的照片（沒搬上 Drive 的那些）不該掛一個
   * 永遠不會實現的「載入中」，那比沒有提示更難懂。
   */
  pendingLabel?: string | null;
}

/**
 * 帶載入狀態的照片。全站顯示照片的地方都走這一支。
 *
 * 三種狀態，對應三種畫面：
 *   1. 什麼都還沒畫出來 → 轉圈圈。這是「以為當掉了」的那一格，最重要的就是它。
 *   2. placeholder 上了、主圖還在路上 → 看得到照片 ＋ 角落一行小字。
 *   3. 主圖到了 → 淡入蓋掉 placeholder。
 *
 * ⚠️ 外層容器必須是 `position: relative` 或本身有明確尺寸 —— 這個元件的外框是
 *    `width/height: 100%`，兩張圖在裡面絕對定位疊起來。相簿卡片（`.photoCard`）
 *    與燈箱的 `.imageContainer` 本來就都符合，不必為它改 CSS。
 */
export default function PhotoImage({
  src, placeholderSrc, alt, className, lazy, pendingLabel,
}: PhotoImageProps) {
  const [loaded, setLoaded] = useState(false);
  const [placeholderLoaded, setPlaceholderLoaded] = useState(false);

  /*
   * 換照片（燈箱按上一張／下一張）時要回到未載入狀態。
   * 少了這一段，新的大圖還在路上就會被當成已經到了，畫面會停在上一張。
   */
  useEffect(() => { setLoaded(false); }, [src]);
  useEffect(() => { setPlaceholderLoaded(false); }, [placeholderSrc]);

  /*
   * 已經在快取裡的圖片，可能在 React 掛上 onLoad 之前就解碼完了 —— 那一下的 load
   * 事件沒有人接，只靠 onLoad 的話這種圖會永遠停在轉圈圈。ref 進來時補問一次
   * `complete`。這不是邊緣情況：燈箱的 placeholder 幾乎每次都命中快取。
   */
  const markLoaded = useCallback((el: HTMLImageElement | null) => {
    if (el?.complete && el.naturalWidth > 0) setLoaded(true);
  }, []);
  const markPlaceholderLoaded = useCallback((el: HTMLImageElement | null) => {
    if (el?.complete && el.naturalWidth > 0) setPlaceholderLoaded(true);
  }, []);

  // 兩張都還沒畫出來才轉圈圈。placeholder 上了就不轉了 —— 已經看得到東西了
  const blank = !loaded && !placeholderLoaded;

  return (
    <div className={styles.wrapper}>
      {/*
        * placeholder 在主圖到了之後就拆掉，不留著疊在下面：燈箱一次只有一張照片，
        * 但格線滑很長的時候每張都多留一個 <img> 會讓瀏覽器多扛幾十張解好的點陣圖。
        */}
      {placeholderSrc && !loaded && (
        <img
          ref={markPlaceholderLoaded}
          src={placeholderSrc}
          alt=""
          aria-hidden="true"
          className={`${styles.layer} ${className ?? ""}`}
          decoding="async"
          onLoad={() => setPlaceholderLoaded(true)}
        />
      )}

      <img
        ref={markLoaded}
        src={src}
        alt={alt}
        className={`${styles.layer} ${styles.main} ${loaded ? styles.mainLoaded : ""} ${className ?? ""}`}
        loading={lazy ? "lazy" : undefined}
        decoding="async"
        onLoad={() => setLoaded(true)}
        /*
         * 載不出來也要把轉圈圈收掉，不然壞掉的圖會永遠轉下去 —— 那正是使用者說的
         * 「以為當掉了」。轉圈圈停下來、畫面留在 placeholder 或空白，至少是個終點。
         */
        onError={() => setLoaded(true)}
      />

      {blank && <span className={styles.spinner} aria-label="載入中" role="status" />}

      {!blank && !loaded && pendingLabel && (
        <span className={styles.pending}>{pendingLabel}</span>
      )}
    </div>
  );
}

/**
 * 單獨的轉圈圈，給「顯示的圖不是 `<img>` 而是 CSS 背景圖」的地方用 ——
 * 目前只有首頁的相簿封面。
 *
 * ⚠️ 那邊用背景圖是刻意的（延後掛載才抓圖，省下「相簿數 × 預覽張數」次 Workers
 *    請求，見 `app/page.tsx` 裡 mountedCount 的說明），**不要為了載入狀態把它改回
 *    `<img>` 然後套 PhotoImage** —— 那會把省下來的請求全部還回去。
 */
export function PhotoSpinner() {
  return <span className={styles.spinner} aria-label="載入中" role="status" />;
}
