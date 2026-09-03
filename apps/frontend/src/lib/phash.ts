/**
 * 相片的像素比對：dHash（difference hash）。
 *
 * `Photo.file_hash` 比的是**位元組**，所以同一張照片只要重新編碼過就對不上 ——
 * Google 相簿匯入拿到的是 Google 自己轉過的檔、換一台機器／換一個瀏覽器重傳
 * 產生的 800px 縮圖也不會一模一樣。這一支比的是**畫面本身**。
 *
 * ⚠️⚠️ **一定要在瀏覽器算。** Worker 沒有影像解碼器，也沒有 10ms CPU 以外的
 * 預算（同「旋轉」與 GPX 解析那兩條）。算完的值寫回 `Photo.phash`，
 * 所以整站只需要掃一次。
 *
 * 為什麼是 dHash 不是 aHash／pHash(DCT)：
 * - aHash（比平均值）對整體亮度變化太敏感，Google 轉檔常常差一點點。
 * - pHash 要做 32×32 DCT，程式碼多一倍，而我們要抓的是「同一張照片被重新
 *   編碼過」，不是「兩張很像的照片」—— dHash 對重壓縮／縮放已經夠穩。
 * - 64 bit 剛好塞進 16 個十六進位字元，`Photo.phash` 是 TEXT，直接存。
 */

/** 取樣成 9×8 灰階，橫向相鄰兩格比大小 → 8×8 = 64 bit */
const SAMPLE_W = 9;
const SAMPLE_H = 8;

/** 16 個十六進位字元。後端那道驗證用的是同一個長度 */
export const PHASH_HEX_LEN = 16;

/**
 * 整片同色的畫面（全黑的影片封面、掃描失敗的空白）算出來的 dHash 一定是這兩個
 * 值之一。它們**不是「長得一樣」的證據**，只是「沒有東西可以比」——
 * 分組時要跳過，不然全站的黑畫面會被圈成一大組假的重複。
 */
const FLAT_HASHES = new Set(['0000000000000000', 'ffffffffffffffff']);

export function isFlatPhash(hex: string): boolean {
  return FLAT_HASHES.has(hex);
}

async function decode(blob: Blob): Promise<{ src: CanvasImageSource; close(): void }> {
  if (typeof createImageBitmap === 'function') {
    const bmp = await createImageBitmap(blob);
    return { src: bmp, close: () => bmp.close() };
  }
  // Safari 舊版沒有 createImageBitmap，退回 <img> ＋ objectURL
  const url = URL.createObjectURL(blob);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('解不開這張縮圖'));
      el.src = url;
    });
    return { src: img, close: () => URL.revokeObjectURL(url) };
  } catch (e) {
    URL.revokeObjectURL(url);
    throw e;
  }
}

/**
 * 算一張圖的 dHash。回 16 個十六進位字元，算不出來回 null（絕不往外丟例外 ——
 * 一張壞掉的縮圖不該讓整批掃描停在那裡）。
 */
export async function dhashFromBlob(blob: Blob): Promise<string | null> {
  let handle: { src: CanvasImageSource; close(): void } | null = null;
  try {
    handle = await decode(blob);
    const canvas = document.createElement('canvas');
    canvas.width = SAMPLE_W;
    canvas.height = SAMPLE_H;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;

    // ⚠️ 先鋪白底：PNG／WebP 的透明區域畫上去是 RGB 0，跟「黑色」分不出來，
    // 而同一張圖存成 JPEG（沒有透明）算出來就會是白的 —— 兩份會比不在一起
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, SAMPLE_W, SAMPLE_H);
    // ⚠️ 縮到 9×8 **刻意不管長寬比**（那是 dHash 的標準做法）：
    // 這樣同一張照片的 800px 與 400px 版本會算出完全一樣的值
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(handle.src, 0, 0, SAMPLE_W, SAMPLE_H);

    const data = ctx.getImageData(0, 0, SAMPLE_W, SAMPLE_H).data;
    const gray = new Float32Array(SAMPLE_W * SAMPLE_H);
    for (let i = 0; i < gray.length; i++) {
      const o = i * 4;
      gray[i] = data[o] * 0.299 + data[o + 1] * 0.587 + data[o + 2] * 0.114;
    }

    let hex = '';
    let nibble = 0;
    let bits = 0;
    for (let y = 0; y < SAMPLE_H; y++) {
      for (let x = 0; x < SAMPLE_W - 1; x++) {
        const bit = gray[y * SAMPLE_W + x] > gray[y * SAMPLE_W + x + 1] ? 1 : 0;
        nibble = (nibble << 1) | bit;
        if (++bits === 4) {
          hex += nibble.toString(16);
          nibble = 0;
          bits = 0;
        }
      }
    }
    return hex.length === PHASH_HEX_LEN ? hex : null;
  } catch {
    return null;
  } finally {
    try { handle?.close(); } catch { /* 收不掉就算了 */ }
  }
}

/** 把 16 字元的雜湊拆成兩個 32 bit。兩兩比之前先轉一次，不要在迴圈裡 parseInt */
export function phashToInts(hex: string): [number, number] | null {
  if (!/^[0-9a-f]{16}$/.test(hex)) return null;
  return [parseInt(hex.slice(0, 8), 16) >>> 0, parseInt(hex.slice(8), 16) >>> 0];
}

function popcount(n: number): number {
  n = n - ((n >> 1) & 0x55555555);
  n = (n & 0x33333333) + ((n >> 2) & 0x33333333);
  n = (n + (n >> 4)) & 0x0f0f0f0f;
  return (n * 0x01010101) >> 24;
}

/** 兩個雜湊差幾個 bit（0 = 畫面一模一樣） */
export function hamming(a: [number, number], b: [number, number]): number {
  return popcount((a[0] ^ b[0]) >>> 0) + popcount((a[1] ^ b[1]) >>> 0);
}
