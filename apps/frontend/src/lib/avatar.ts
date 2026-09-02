// 頭像的前置處理。**像素的事全在瀏覽器做完才上傳**，Worker 只負責收檔案，
// 跟照片縮圖同一套分工（見 lib/imageUtils.ts）。
//
// 一張圖要同時服務兩個地方：留言區 32px 的圓形頭像、地圖上坐在小車上的大頭。
// 所以產物一律是 **256px 見方、保 alpha** 的 WebP —— 兩邊都夠用，不必存兩份。
//
// 使用者自己傳去背 PNG（站上不做自動去背：那要拉幾十 MB 的模型，為一次性設定
// 不值得）。但**沒去背也不能壞**，所以這裡分兩條路：
//
//   有 alpha  → 先裁掉透明邊界（去背圖常常四周一大圈空白），再等比縮進 256 見方。
//               頭會填滿畫面，坐上車才夠大。
//   沒 alpha  → 中央裁成正方形，套圓形遮罩。地圖上是一顆圓頭，不是一塊方照片。

/** 產物邊長。留言 32px、地圖約 96 CSS px @2x = 192px，256 兩邊都有餘裕 */
export const AVATAR_SIZE = 256;

/** 去背圖四周留的白邊（比例）。完全貼齊邊界看起來會很擠 */
const CONTAIN_PAD = 0.04;

/** 判定「這個像素算不算存在」的門檻。抗鋸齒的邊緣會有很淡的殘留，太低會把裁切框撐大 */
const ALPHA_FLOOR = 16;

export interface PreparedAvatar {
  blob: Blob;
  /** 'image/webp'、'image/png' 或 'image/gif'。後端只收這三種 —— JPEG 沒有 alpha */
  type: string;
  /** 原圖本來就是去背的嗎。false ＝ 我們幫他套了圓形遮罩 */
  hadAlpha: boolean;
  /** 這是一支動圖嗎（GIF 原檔直送，沒有經過下面那一整套處理） */
  animated: boolean;
  /** 給預覽用的 object URL。用完記得 revoke */
  previewUrl: string;
}

/** 這個檔案是 GIF 嗎。副檔名也認一次 —— 有些系統丟過來的 type 是空字串 */
function isGifFile(file: File): boolean {
  return file.type === 'image/gif' || /\.gif$/i.test(file.name);
}

/**
 * `canvas.toBlob` 對不認得的 MIME **會安靜地吐 PNG**，不會報錯（同 api.ts 的坑）。
 * 先探一次，決定要走 WebP 還是 PNG —— 兩種後端都收，差別只是檔案大小。
 */
let webpEncodable: boolean | null = null;
function canEncodeWebp(): boolean {
  if (webpEncodable === null) {
    const probe = document.createElement('canvas');
    probe.width = 1;
    probe.height = 1;
    webpEncodable = probe.toDataURL('image/webp').startsWith('data:image/webp');
  }
  return webpEncodable;
}

/** 把檔案解成點陣圖。`from-image` 讓手機直拍的照片自己轉正，不必讀 EXIF */
async function decode(file: File): Promise<ImageBitmap | HTMLImageElement> {
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(file, { imageOrientation: 'from-image' } as any);
    } catch {
      // Safari 舊版不吃那個選項，退回 <img>
    }
  }
  const url = URL.createObjectURL(file);
  try {
    return await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('讀不懂這個圖檔'));
      img.src = url;
    });
  } finally {
    // 圖已經解好了，URL 可以放掉（onload 之後 src 不再需要它）
    URL.revokeObjectURL(url);
  }
}

/**
 * 有沒有真的透明的地方，以及不透明內容的邊界。
 *
 * 兩件事一起算是為了只讀一次 ImageData —— 4K 的 PNG 讀兩次是好幾千萬次陣列存取。
 * 回傳的 box 是「alpha > ALPHA_FLOOR」的最小包圍框；整張全不透明時 box 就是整張。
 */
function scanAlpha(data: Uint8ClampedArray, w: number, h: number) {
  let hasAlpha = false;
  let minX = w; let minY = h; let maxX = -1; let maxY = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const a = data[(y * w + x) * 4 + 3];
      if (a < 250) hasAlpha = true;
      if (a > ALPHA_FLOOR) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  // 整張都是透明的（有人真的會傳空白 PNG）—— 當成沒有邊界，交給呼叫端用整張
  if (maxX < 0) return { hasAlpha, box: { x: 0, y: 0, w, h } };
  return { hasAlpha, box: { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 } };
}

/**
 * 把使用者挑的檔案變成可以上傳的頭像。
 *
 * 失敗時丟例外（訊息可以直接顯示給使用者）。
 */
export async function prepareAvatar(file: File): Promise<PreparedAvatar> {
  /*
   * ⚠️⚠️ **GIF 整份原檔直送，一個像素都不碰。**
   *
   * 底下那一整套（裁透明邊界／圓形遮罩／重編）都要經過 canvas，而 canvas
   * **只畫得出第一格** —— 送進去出來的就是一張靜止圖，動畫沒了，而且錯得很安靜
   * （使用者看到的是自己那張圖，只是不會動）。
   *
   * 代價是動圖不會被裁邊也不會被套圓形遮罩：沒去背的方形 GIF 在地圖上就是一塊
   * 方的。那件事挑檔案的時候講出來就好（見 AvatarPicker），比弄丟動畫划算。
   */
  if (isGifFile(file)) {
    return {
      blob: file, type: 'image/gif',
      // 動圖一律不套圓形遮罩，所以也不必宣稱「沒有 alpha 已經幫你裁圓」
      hadAlpha: true, animated: true,
      previewUrl: URL.createObjectURL(file),
    };
  }
  const src = await decode(file);
  const sw = 'width' in src ? src.width : 0;
  const sh = 'height' in src ? src.height : 0;
  if (!sw || !sh) throw new Error('讀不懂這個圖檔');

  /*
   * 先縮到一個夠掃描的尺寸再讀 ImageData。原尺寸掃一張 4000×3000 的圖是
   * 一千兩百萬個像素，手機上會卡好幾秒 —— 而我們只需要知道「哪裡是透明的」，
   * 512 的解析度足夠算出邊界（誤差最多兩三個原始像素，肉眼看不出來）。
   */
  const scanMax = 512;
  const k = Math.min(1, scanMax / Math.max(sw, sh));
  const scanW = Math.max(1, Math.round(sw * k));
  const scanH = Math.max(1, Math.round(sh * k));
  const scan = document.createElement('canvas');
  scan.width = scanW;
  scan.height = scanH;
  const sctx = scan.getContext('2d', { willReadFrequently: true });
  if (!sctx) throw new Error('這個瀏覽器畫不出 canvas');
  sctx.drawImage(src as CanvasImageSource, 0, 0, scanW, scanH);
  const { hasAlpha, box } = scanAlpha(sctx.getImageData(0, 0, scanW, scanH).data, scanW, scanH);

  const out = document.createElement('canvas');
  out.width = AVATAR_SIZE;
  out.height = AVATAR_SIZE;
  const ctx = out.getContext('2d');
  if (!ctx) throw new Error('這個瀏覽器畫不出 canvas');
  ctx.imageSmoothingQuality = 'high';

  if (hasAlpha) {
    // 去背圖：裁掉透明邊界，整個人（頭）等比塞進正方形，多出來的地方留透明
    const cx = box.x / k;
    const cy = box.y / k;
    const cw = box.w / k;
    const ch = box.h / k;
    const avail = AVATAR_SIZE * (1 - CONTAIN_PAD * 2);
    const scale = Math.min(avail / cw, avail / ch);
    const dw = cw * scale;
    const dh = ch * scale;
    ctx.drawImage(
      src as CanvasImageSource,
      cx, cy, cw, ch,
      (AVATAR_SIZE - dw) / 2, (AVATAR_SIZE - dh) / 2, dw, dh,
    );
  } else {
    // 一般照片：中央裁成正方形（cover），再切成圓的。
    // 遮罩用 destination-in 而不是先 clip 再畫 —— clip 的邊緣沒有抗鋸齒，
    // 32px 的留言頭像會看得出鋸齒
    const side = Math.min(sw, sh);
    ctx.drawImage(
      src as CanvasImageSource,
      (sw - side) / 2, (sh - side) / 2, side, side,
      0, 0, AVATAR_SIZE, AVATAR_SIZE,
    );
    ctx.globalCompositeOperation = 'destination-in';
    ctx.beginPath();
    ctx.arc(AVATAR_SIZE / 2, AVATAR_SIZE / 2, AVATAR_SIZE / 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalCompositeOperation = 'source-over';
  }

  if ('close' in src && typeof src.close === 'function') src.close();

  const type = canEncodeWebp() ? 'image/webp' : 'image/png';
  const blob = await new Promise<Blob | null>((resolve) =>
    out.toBlob((b) => resolve(b), type, 0.92));
  if (!blob) throw new Error('產生頭像失敗');

  return { blob, type, hadAlpha: hasAlpha, animated: false, previewUrl: URL.createObjectURL(blob) };
}
