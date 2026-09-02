// 手刻的 GIF89a 解碼器。**只給地圖上那顆大頭用。**
//
// 為什麼要自己解：留言區那顆頭像是 <img>，瀏覽器自己會播；但地圖上的頭要先
// 「加一圈外框」再交給 maplibre 的 addImage（那支只吃一塊 RGBA 位元組），
// 而 canvas 畫 GIF 只畫得到第一格。WebCodecs 的 ImageDecoder 做得到，
// 但 Safari 沒有 —— 所以照這個 repo 一貫的作法自己解（同 moov box、同 GPX regex）。
//
// 支援：全域／區域調色盤、透明色、交錯、disposal 0/1/2/3。
// 不支援：GIF87a 以外的怪東西、Netscape 循環次數（我們一律無限循環）。

export interface GifFrame {
  /** 已經合成好的整張畫面（RGBA，width × height） */
  data: Uint8ClampedArray;
  /** 這一格停留多久（毫秒）。0／缺值一律當 100ms —— 瀏覽器也是這樣頂的 */
  delayMs: number;
}

export interface GifImage {
  width: number;
  height: number;
  frames: GifFrame[];
}

/** 是不是 GIF。只看前面那六個位元組，不必整份讀進來 */
export function looksLikeGif(buf: ArrayBuffer): boolean {
  if (buf.byteLength < 6) return false;
  const b = new Uint8Array(buf, 0, 6);
  return b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38; // "GIF8"
}

const MAX_CODES = 4096;

/**
 * LZW 解碼。回傳的是**調色盤索引**，不是顏色。
 *
 * 這是課本上那支：字典用 prefix/suffix 兩條陣列表示，展開時往 stack 推再倒著吐。
 * `code >= next` 是 KwKwK 那個特例（字典裡還沒有、但下一筆就是它）。
 */
function lzwDecode(data: Uint8Array, minCodeSize: number, pixelCount: number): Uint8Array {
  const out = new Uint8Array(pixelCount);
  const clear = 1 << minCodeSize;
  const eoi = clear + 1;

  const prefix = new Int32Array(MAX_CODES);
  const suffix = new Uint8Array(MAX_CODES);
  const stack = new Uint8Array(MAX_CODES + 1);
  for (let i = 0; i < clear; i++) suffix[i] = i;

  let codeSize = minCodeSize + 1;
  let next = eoi + 1;
  let prev = -1;
  let firstChar = 0;
  let bitBuf = 0;
  let bits = 0;
  let pos = 0;
  let oi = 0;

  while (oi < pixelCount) {
    while (bits < codeSize) {
      if (pos >= data.length) return out; // 資料被截斷：吐已經解出來的那些
      bitBuf |= data[pos++] << bits;
      bits += 8;
    }
    const code = bitBuf & ((1 << codeSize) - 1);
    bitBuf >>>= codeSize;
    bits -= codeSize;

    if (code === clear) {
      codeSize = minCodeSize + 1;
      next = eoi + 1;
      prev = -1;
      continue;
    }
    if (code === eoi) break;

    let sp = 0;
    if (prev === -1) {
      if (code >= clear) break; // 壞檔
      firstChar = code;
      stack[sp++] = code;
    } else {
      let inCode = code;
      if (code >= next) {
        stack[sp++] = firstChar;
        inCode = prev;
      }
      while (inCode >= clear) {
        stack[sp++] = suffix[inCode];
        inCode = prefix[inCode];
      }
      firstChar = inCode;
      stack[sp++] = firstChar;
      if (next < MAX_CODES) {
        prefix[next] = prev;
        suffix[next] = firstChar;
        next++;
        if (next === (1 << codeSize) && codeSize < 12) codeSize++;
      }
    }
    prev = code;
    while (sp > 0 && oi < pixelCount) out[oi++] = stack[--sp];
  }
  return out;
}

/** 交錯的 GIF：實際的第 i 列資料要放到畫面的第幾列 */
function interlacedRow(i: number, h: number): number {
  const p1 = Math.ceil(h / 8);
  const p2 = Math.ceil((h - 4) / 8);
  const p3 = Math.ceil((h - 2) / 4);
  if (i < p1) return i * 8;
  if (i < p1 + p2) return (i - p1) * 8 + 4;
  if (i < p1 + p2 + p3) return (i - p1 - p2) * 4 + 2;
  return (i - p1 - p2 - p3) * 2 + 1;
}

/**
 * 解一張 GIF。壞檔一律回 null（呼叫端退回「當成靜態圖」那條路），不丟例外。
 *
 * @param maxFrames 最多留幾格。一格是 width×height×4 的位元組，長動圖會把
 *                  記憶體吃掉 —— 超過就只留前面那幾格（照樣循環，看得出在動）。
 */
export function decodeGif(buf: ArrayBuffer, maxFrames = 24): GifImage | null {
  try {
    const b = new Uint8Array(buf);
    if (!looksLikeGif(buf)) return null;
    let p = 6;

    const rd16 = () => { const v = b[p] | (b[p + 1] << 8); p += 2; return v; };
    const width = rd16();
    const height = rd16();
    if (!(width > 0 && height > 0)) return null;
    const packed = b[p++];
    p++; // 背景色索引 —— 用不到（我們一律以透明起手）
    p++; // 像素長寬比

    const readTable = (n: number) => {
      const t = new Uint8Array(n * 3);
      t.set(b.subarray(p, p + n * 3));
      p += n * 3;
      return t;
    };
    let gct: Uint8Array | null = null;
    if (packed & 0x80) gct = readTable(1 << ((packed & 0x07) + 1));

    /** 把一連串 sub-block（每塊開頭一個長度位元組）接成一整條 */
    const readSubBlocks = () => {
      const parts: Uint8Array[] = [];
      let total = 0;
      for (;;) {
        const n = b[p++];
        if (!n) break;
        parts.push(b.subarray(p, p + n));
        total += n;
        p += n;
      }
      const out = new Uint8Array(total);
      let o = 0;
      for (const part of parts) { out.set(part, o); o += part.length; }
      return out;
    };

    const frames: GifFrame[] = [];
    const canvas = new Uint8ClampedArray(width * height * 4); // 目前這一格之前的畫面
    let saved: Uint8ClampedArray | null = null;               // disposal 3 要還原的那一份

    // 下一張圖要吃的 GCE（圖形控制擴充）
    let delayMs = 100;
    let transparent = -1;
    let disposal = 0;

    while (p < b.length) {
      const marker = b[p++];
      if (marker === 0x3b) break; // trailer
      if (marker === 0x21) {
        const label = b[p++];
        if (label === 0xf9) {
          const size = b[p++];
          const end = p + size;
          const flags = b[p];
          const delayCs = b[p + 1] | (b[p + 2] << 8);
          const tIndex = b[p + 3];
          disposal = (flags >> 2) & 0x07;
          transparent = (flags & 0x01) ? tIndex : -1;
          // 0 與 1 都當 100ms：0 是「越快越好」，而瀏覽器一律頂到 100
          delayMs = delayCs <= 1 ? 100 : delayCs * 10;
          p = end;
          if (b[p] === 0) p++; // 區塊結束
          else readSubBlocks();
        } else {
          readSubBlocks();
        }
        continue;
      }
      if (marker !== 0x2c) return frames.length ? { width, height, frames } : null;

      // ── 影像描述子 ──
      const fx = rd16();
      const fy = rd16();
      const fw = rd16();
      const fh = rd16();
      const fpacked = b[p++];
      const lct = (fpacked & 0x80) ? readTable(1 << ((fpacked & 0x07) + 1)) : null;
      const interlaced = !!(fpacked & 0x40);
      const table = lct || gct;
      const minCodeSize = b[p++];
      const lzw = readSubBlocks();
      if (!table || fw <= 0 || fh <= 0) continue;

      if (disposal === 3) saved = canvas.slice();

      const idx = lzwDecode(lzw, minCodeSize, fw * fh);
      for (let row = 0; row < fh; row++) {
        const dstRow = fy + (interlaced ? interlacedRow(row, fh) : row);
        if (dstRow < 0 || dstRow >= height) continue;
        for (let col = 0; col < fw; col++) {
          const dstCol = fx + col;
          if (dstCol < 0 || dstCol >= width) continue;
          const ci = idx[row * fw + col];
          if (ci === transparent) continue; // 透明＝維持上一格，不是塗成透明
          const s = ci * 3;
          const d = (dstRow * width + dstCol) * 4;
          canvas[d] = table[s];
          canvas[d + 1] = table[s + 1];
          canvas[d + 2] = table[s + 2];
          canvas[d + 3] = 255;
        }
      }

      frames.push({ data: canvas.slice(), delayMs });

      // ── 收尾（下一格開始前要做的事）──
      if (disposal === 2) {
        for (let row = 0; row < fh; row++) {
          const dstRow = fy + row;
          if (dstRow < 0 || dstRow >= height) continue;
          const base = (dstRow * width + fx) * 4;
          const n = Math.min(fw, width - fx) * 4;
          if (n > 0) canvas.fill(0, base, base + n);
        }
      } else if (disposal === 3 && saved) {
        canvas.set(saved);
      }

      if (frames.length >= maxFrames) break;
    }

    return frames.length ? { width, height, frames } : null;
  } catch {
    return null;
  }
}
