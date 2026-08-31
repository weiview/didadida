/**
 * Android 的「動態照片」：一個 .jpg 檔尾巴上黏著一段 mp4。
 *
 * 這一檔只做一件事 —— **算出那段 mp4 從第幾個位元組開始**。位元組本身完全不動，
 * 播放時由 `/api/photos/:id/motion` 從 Drive 上那份原始檔切出來（見後端）。
 *
 * ## 為什麼是「算位置」而不是「把影片存起來」
 *
 * 那段 mp4 **本來就已經在 Drive 上了** —— 站上的原始檔是整份直傳的，動態那一段
 * 跟著在裡面。抽出來另外存一份等於同樣的位元組收兩次錢：R2 的儲存是免費額度裡
 * 真的會被吃掉的那一格（見 GIF 那一節），而一支動態照片的影片是 1～4MB，
 * 兩千張就是好幾 GB，額度直接見底。存一個整數就夠了。
 *
 * ## 兩種格式（都是「長度從檔尾往回算」）
 *
 * ① **MicroVideo**（舊的 MVIMG_*.jpg）：XMP 裡 `GCamera:MicroVideoOffset="4104437"`。
 *    ⚠️ 名字叫 Offset，值卻是**影片的長度**（從檔尾往回算），不是起點。
 * ② **Motion Photo v1**（Pixel 的 *.MP.jpg、近年的三星）：XMP 裡一張
 *    `Container:Directory` 清單，`Semantic="MotionPhoto"` 那一項的 `Length`
 *    就是影片長度，`Padding` 是它後面補的位元組。
 *
 * 兩種都是 `起點 = 檔案大小 − 長度 − padding`。
 *
 * ⚠️ **三星更早期那種（JPEG 後面接 `MotionPhoto_Data` 標記）不支援**：它的 XMP
 *    裡沒有長度，只能從檔尾整片掃字串找標記。那在瀏覽器可以（檔案在手上），
 *    在 Worker 就是一次幾 MB 的 Drive 讀取 —— 為了一種舊機型不值得。
 *
 * ## 為什麼不解 JPEG 的段結構
 *
 * XMP 躺在 APP1 段裡，照規矩要一段一段走 marker。但我們要的只是幾個 ASCII 字串，
 * 而且 **APP1 之外的地方不會憑空出現 `Semantic="MotionPhoto"`** —— 直接把檔頭
 * 當文字搜，程式短得多，也不會被「Extended XMP 拆成好幾段」那種變體卡住。
 *
 * **兩份副本**（`apps/frontend/src/lib/` 是 LF 權威、`apps/backend/src/` 是 CRLF
 * 複本），同 `geo.ts`／`videoMeta.ts` 的規矩 —— 位元組在兩個不同的地方：上傳時
 * 原始檔在瀏覽器（直傳 Drive 不經 Worker），回頭補掃時只有 Drive 那邊有。
 */

/** 檔頭要讀多少才找得到 XMP。同 videoMeta 的 HEAD_CHUNK，兩邊行為才會一致 */
export const MOTION_HEAD_CHUNK = 128 * 1024;

/** 小於這個長度的「影片」不當真 —— 那多半是解錯了 */
const MIN_CLIP_BYTES = 8 * 1024;

/** 讀一段位元組。`end` 是**不含**的（跟 Blob.slice 一致） */
export type RangeReader = (start: number, end: number) => Promise<Uint8Array>;

/** 把位元組當 latin1 讀成字串。XMP 是 UTF-8，但我們要比對的全是 ASCII */
function asLatin1(buf: Uint8Array): string {
  let out = '';
  /*
   * 一次一大塊，避免把幾萬個參數推爆呼叫堆疊。
   * ⚠️ 用 `apply` 而不是展開運算子（`...`）—— 前端的 tsconfig target 太舊，
   *    展開 Uint8Array 會要求 downlevelIteration（TS2802）。`apply` 吃的是
   *    array-like，TypedArray 本來就符合，執行時完全一樣。
   */
  for (let i = 0; i < buf.length; i += 8192) {
    const chunk = buf.subarray(i, Math.min(i + 8192, buf.length));
    out += String.fromCharCode.apply(null, chunk as unknown as number[]);
  }
  return out;
}

/*
 * ⚠️⚠️ 這幾個樣式**一律寫成 regex 字面值，不要塞進字串再 new RegExp** ——
 *    字串裡的 `\d`／`\s`／`\w` 只要經過任何一層會處理跳脫字元的東西（貼上、
 *    腳本改檔）就會安靜地掉成 `d`／`s`／`w`，樣式還是能編譯、只是永遠比不中。
 *    這個站已經被同一件事咬過一次（見 CLAUDE.md「資料模型」那條指定時間的按鈕）。
 */
const LENGTH_ATTR = /(?:\w+:)?Length\s*=\s*["'](\d+)["']/;
const PADDING_ATTR = /(?:\w+:)?Padding\s*=\s*["'](\d+)["']/;

function attrNum(tag: string, re: RegExp): number | null {
  const m = re.exec(tag);
  return m ? Number(m[1]) : null;
}

/**
 * 從檔頭的 XMP 算出動態照片那段 mp4 的起點。**不是動態照片就回 0。**
 *
 * 回 0 是「確定沒有」，呼叫端會把它存進 D1 當成「掃過了」——
 * 所以這裡寧可保守：算出來的位置不合理（超出檔案、影片短得離譜）一律回 0。
 */
export function motionOffsetFromHead(head: Uint8Array, fileSize: number): number {
  const text = asLatin1(head);

  const take = (clipLen: number | null, padding: number) => {
    if (clipLen === null || clipLen < MIN_CLIP_BYTES) return 0;
    const start = fileSize - clipLen - padding;
    // 起點至少要在 JPEG 的 SOI 之後，而且不能把整個檔都算成影片
    return start > 2 && start < fileSize ? start : 0;
  };

  // ② Motion Photo v1：先找 Semantic="MotionPhoto"，再回頭取它所在那個標籤的 Length
  const sem = /Semantic\s*=\s*["']MotionPhoto["']/.exec(text);
  if (sem) {
    const lt = text.lastIndexOf('<', sem.index);
    const gt = text.indexOf('>', sem.index);
    const tag = text.slice(lt < 0 ? 0 : lt, gt < 0 ? text.length : gt + 1);
    const hit = take(attrNum(tag, LENGTH_ATTR), attrNum(tag, PADDING_ATTR) ?? 0);
    if (hit) return hit;
  }

  // ① MicroVideo：屬性與元素兩種寫法都收
  const micro = /MicroVideoOffset\s*=\s*["'](\d+)["']/.exec(text)
    || /<\w+:MicroVideoOffset>\s*(\d+)\s*</.exec(text);
  if (micro) {
    const hit = take(Number(micro[1]), 0);
    if (hit) return hit;
  }

  return 0;
}

/** 那個位置看起來像不像一個 mp4 的開頭（`....ftyp`） */
export function looksLikeMp4(chunk: Uint8Array, at = 0): boolean {
  if (chunk.length < at + 8) return false;
  return chunk[at + 4] === 0x66 && chunk[at + 5] === 0x74
    && chunk[at + 6] === 0x79 && chunk[at + 7] === 0x70;   // 'ftyp'
}

/** 在一小段位元組裡找 `ftyp`，回它所屬 box 的起點（找不到回 -1） */
function findFtyp(buf: Uint8Array): number {
  for (let i = 4; i + 8 <= buf.length; i++) {
    if (looksLikeMp4(buf, i - 4)) return i - 4;
  }
  return -1;
}

/**
 * 算出並**驗證**動態照片那段 mp4 的起點。不是動態照片回 0。
 *
 * ⚠️ 驗證那一次讀取**只有真的疑似動態照片時才會發生** —— 一般照片在檔頭那一步
 *    就回 0 了。所以整批掃描的成本是「每張一次讀取」，不是兩次。
 */
export async function readMotionOffset(
  read: RangeReader, fileSize: number, headBuf?: Uint8Array,
): Promise<number> {
  const head = headBuf ?? await read(0, Math.min(fileSize, MOTION_HEAD_CHUNK));
  const guess = motionOffsetFromHead(head, fileSize);
  if (!guess) return 0;

  const probe = await read(guess, Math.min(fileSize, guess + 16));
  if (looksLikeMp4(probe)) return guess;

  /*
   * 算出來的位置差了幾個位元組（有些機型的 Padding 沒寫進 XMP）。
   * 在附近 4KB 裡找一次 `ftyp`，找不到就當成不是動態照片 —— 硬給一個位置
   * 只會讓燈箱端出一支播不了的影片。
   */
  const from = Math.max(0, guess - 2048);
  const near = await read(from, Math.min(fileSize, guess + 2048));
  const at = findFtyp(near);
  return at >= 0 ? from + at : 0;
}

/**
 * 上傳路徑用的：直接從使用者選的檔案算。
 *
 * ⚠️ **絕不往外丟例外** —— 讀不出來只代表「這張不是動態照片」，跟上傳成不成功
 *    無關，丟出去會讓整批停在這裡。
 */
export async function readMotionOffsetFromFile(file: File): Promise<number> {
  try {
    if (!/^image\/jpe?g$/i.test(file.type || '')) return 0;
    const read: RangeReader = async (start, end) =>
      new Uint8Array(await file.slice(start, end).arrayBuffer());
    return await readMotionOffset(read, file.size);
  } catch (err) {
    console.warn('動態照片偵測失敗，當成一般照片', err);
    return 0;
  }
}
