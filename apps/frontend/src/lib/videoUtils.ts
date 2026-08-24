/**
 * 影片：擷封面、讀長度、格式判斷。
 *
 * 站上的影片是 **Drive 存原始檔、R2 只存一張封面圖**（見 migrations/0019）。
 * 封面就是這裡從影片裡撈出來的一格畫面，之後餵給跟照片同一條的上傳路
 * （`uploadPhoto` → 後端產 800／400 進 R2）。
 *
 * ⚠️ **不轉檔。** 瀏覽器端能做的只有 WebCodecs（要 mp4box.js 拆封裝，音訊與
 *    Safari 都有風險）或 ffmpeg.wasm（0.1–0.5x 實時，而且它要的 COOP/COEP
 *    會同時弄壞 Google Picker、Drive 上傳與地圖圖磚）。Worker 那邊更不可能
 *    ——10ms CPU、128MB 記憶體。原始檔怎麼進來就怎麼放上去。
 */

/** 選檔時放行的影片格式。**跟播放端是同一組** —— 瀏覽器解不開的東西，
 *  封面擷不出來、播也播不出來，擋在選檔那一步比事後報錯好懂。 */
export const ACCEPTED_VIDEO_TYPES = 'video/mp4, video/quicktime, video/webm';

export function isVideoFile(file: File): boolean {
  // 有些來源的 File.type 是空的，退回看副檔名
  if (file.type) return file.type.startsWith('video/');
  return /\.(mp4|mov|m4v|webm)$/i.test(file.name);
}

export interface VideoPoster {
  /** 擷出來的那一格，WebP。丟給 uploadPhoto 當作「這張照片」的原圖 */
  poster: File;
  /** 影片長度，毫秒。存進 Photo.duration_ms，格線上那個「0:42」就是它 */
  durationMs: number;
  width: number;
  height: number;
}

/** 封面畫布的長邊上限。後端還會再產 800／400，這裡只要夠清楚就好 */
const POSTER_MAX_EDGE = 1600;
/** 解不開、或慢到不像話的檔就別讓使用者一直等 */
const POSTER_TIMEOUT_MS = 45000;

/**
 * 從影片裡撈一格當封面。
 *
 * 取的是**第 1 秒**（短片就取一成的位置），不是第 0 秒 —— 很多相機的第一格
 * 是全黑或還沒對到焦的，拿它當封面整本相簿會出現一排黑格子。
 *
 * ⚠️ 一定要 `muted` ＋ `playsInline`：沒有 muted 的話行動版瀏覽器連
 *    metadata 都不肯載，seek 事件永遠不會來，這支函式就吊死在 timeout。
 */
export async function captureVideoPoster(file: File): Promise<VideoPoster> {
  const url = URL.createObjectURL(file);
  const video = document.createElement('video');
  video.preload = 'metadata';
  video.muted = true;
  video.playsInline = true;
  // blob: 跟頁面同源，canvas 不會被污染（換成遠端網址就會 tainted，toBlob 直接丟錯）
  video.src = url;

  try {
    const meta = await withTimeout(
      once(video, 'loadedmetadata'),
      `讀不到「${file.name}」的影片資訊`,
    ).then(() => ({
      // 串流式的 webm 有時候回 Infinity；當成沒有長度，格線就不畫時間角標
      durationMs: Number.isFinite(video.duration) ? Math.round(video.duration * 1000) : 0,
      width: video.videoWidth,
      height: video.videoHeight,
    }));

    if (!meta.width || !meta.height) {
      throw new Error(`「${file.name}」這個格式瀏覽器解不開，換 MP4 再試一次`);
    }

    // 有長度就取 1 秒或一成的位置（取小的），沒長度只好從頭拿
    const seekTo = meta.durationMs > 0
      ? Math.min(1, (meta.durationMs / 1000) * 0.1)
      : 0;
    const painted = once(video, 'seeked');
    video.currentTime = seekTo;
    await withTimeout(painted, `擷不到「${file.name}」的封面畫面`);

    /*
     * seeked 只保證「跳到了」，不保證那一格已經畫出來。有 requestVideoFrameCallback
     * 的瀏覽器等它給的那一幀最準；沒有的就退回等一次重繪。
     * 不等的話 drawImage 有機會畫到一張全黑的畫布。
     */
    await nextFrame(video);

    const scale = Math.min(1, POSTER_MAX_EDGE / Math.max(meta.width, meta.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(meta.width * scale));
    canvas.height = Math.max(1, Math.round(meta.height * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('這個瀏覽器畫不出封面');
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    const blob = await new Promise<Blob | null>((resolve) => {
      // 不支援 WebP 編碼的瀏覽器會自己退回 PNG，後端兩種都收
      canvas.toBlob(resolve, 'image/webp', 0.85);
    });
    if (!blob) throw new Error(`「${file.name}」的封面編不出來`);

    const base = file.name.replace(/\.[^/.]+$/, '') || 'video';
    return {
      poster: new File([blob], `${base}.webp`, { type: blob.type || 'image/webp' }),
      durationMs: meta.durationMs,
      width: canvas.width,
      height: canvas.height,
    };
  } finally {
    // 沒收掉的話那個 2GB 的檔會被 blob URL 一直釘在記憶體裡
    video.removeAttribute('src');
    video.load();
    URL.revokeObjectURL(url);
  }
}

/** 把毫秒寫成 `1:05` / `1:02:03`。null／0 回 null，呼叫端就不畫角標 */
export function formatDuration(ms: number | null | undefined): string | null {
  if (!ms || ms <= 0) return null;
  const total = Math.round(ms / 1000);
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/* ---- 小工具 ---- */

function once(el: HTMLVideoElement, event: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const ok = () => { cleanup(); resolve(); };
    const bad = () => { cleanup(); reject(new Error(`影片載入失敗（${event}）`)); };
    const cleanup = () => {
      el.removeEventListener(event, ok);
      el.removeEventListener('error', bad);
    };
    el.addEventListener(event, ok, { once: true });
    el.addEventListener('error', bad, { once: true });
  });
}

function withTimeout<T>(p: Promise<T>, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), POSTER_TIMEOUT_MS);
    p.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

/** 等到影片真的把那一格畫出來 */
function nextFrame(video: HTMLVideoElement): Promise<void> {
  const rvfc = (video as any).requestVideoFrameCallback;
  if (typeof rvfc === 'function') {
    return new Promise((resolve) => {
      // 保險：有些實作在暫停狀態下不會回呼，等太久就直接畫
      const timer = setTimeout(resolve, 300);
      rvfc.call(video, () => { clearTimeout(timer); resolve(); });
    });
  }
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}
