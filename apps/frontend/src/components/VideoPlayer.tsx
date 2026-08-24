"use client";

import { useEffect, useState } from "react";
import { photoThumbSrc, photoVideoSrc, type Photo } from "@/lib/api";
import { PhotoSpinner } from "./PhotoImage";
import styles from "./VideoPlayer.module.css";

/**
 * 燈箱裡的影片播放器。
 *
 * 位元組走 `/api/photos/:id/video`（Worker 代理 Drive，轉發 Range），封面直接用
 * R2 那張 800px 縮圖 —— 它多半已經在瀏覽器快取裡（使用者是從格線點進來的），
 * 所以點開的瞬間就有畫面，不是一塊黑的。
 *
 * ⚠️ **不要加 `crossOrigin`**：不加才是 no-cors 請求（跟 `<img>` 一樣），Range
 *    不必預檢。我們也沒有任何理由去讀那個回應的內容。
 *
 * ⚠️ 觸控事件要擋在這裡。燈箱的 imageContainer 掛著左右滑動換照片，不擋的話
 *    在手機上拖影片的時間軸會變成「換下一張」。
 */
export default function VideoPlayer({ photo }: { photo: Photo }) {
  /** loading 涵蓋兩件事：一開始還沒讀到 metadata，以及播到一半在緩衝 */
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");

  // 換一支就重新來過（key 已經會讓 <video> 重建，這裡是把外層狀態也拉回去）
  useEffect(() => { setState("loading"); }, [photo.id]);

  return (
    <div
      className={styles.wrapper}
      onTouchStart={(e) => e.stopPropagation()}
      onTouchMove={(e) => e.stopPropagation()}
      onTouchEnd={(e) => e.stopPropagation()}
    >
      <video
        key={photo.id}
        className={styles.video}
        src={photoVideoSrc(photo)}
        poster={photoThumbSrc(photo, "md")}
        controls
        playsInline
        /*
         * metadata 而不是 auto：一支影片可能好幾 GB，點開燈箱就自動下載整份，
         * 使用者只是滑過去看一眼也會把流量吃光。按下播放才開始串。
         */
        preload="metadata"
        onLoadedMetadata={() => setState("ready")}
        onCanPlay={() => setState("ready")}
        onPlaying={() => setState("ready")}
        // 緩衝不夠停下來等 —— 這時候要轉圈圈，不然畫面凍住看起來像當掉
        onWaiting={() => setState("loading")}
        onError={() => setState("error")}
      />
      {state === "loading" && <PhotoSpinner />}
      {state === "error" && (
        <p className={styles.error}>
          這支影片播不出來。可能是上傳還沒完成，或 Drive 暫時取不到 —— 稍後再試一次。
        </p>
      )}
    </div>
  );
}
