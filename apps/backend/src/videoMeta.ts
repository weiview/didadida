// 影片的拍攝時間與座標：解 mp4／mov 的 moov box。
//
// 註：本檔在 apps/frontend/src/lib/videoMeta.ts 與 apps/backend/src/videoMeta.ts
// 各有一份相同副本（同 geo.ts 的規矩）。上傳路徑在瀏覽器解（原始影片直傳 Drive，
// 從不經過 Worker），回寫既有影片的路徑在 Worker 解（位元組只有 Drive 那邊有）。
// **修改時請同步兩邊**。前端這份是權威（LF），後端那份是 CRLF 複本。
//
// ── 為什麼不是「影片沒有 EXIF」 ──────────────────────────────────
// 影片檔本來就帶著這些資訊，只是格式不同：mp4／mov 把它們放在 `moov` box 裡。
// 站上讀不到純粹是因為封面圖是 canvas 畫出來的（不帶任何 metadata），
// 而我們一直只從 <video> 元素問長度與寬高。
//
// ⚠️⚠️ **`mvhd.creation_time` 沒有時區。** 規格說是 UTC，實際上一大票 Android
//    機身寫的是當地時間 —— 猜錯就是整整 8 小時，而且錯得很安靜（同 `PXL_` 檔名
//    刻意不猜的那個坑）。所以這一檔的時間有四層，**優先序不能對調**：
//
//      ① 檔案自己寫明時區（Apple 的 creationdate `2024-08-15T14:30:00+0800`）
//         → 牆上時間與時區都有了，最準。iPhone／iPad 走這條。
//      ② 有 mvhd 瞬間 ＋ 另一個「牆上時間」來源（©day 沒帶時區的那種，或
//         `VID_20260824_143000.mp4` 這類檔名）→ **兩者相減就是時區**，
//         跟 geo.ts 拿 GPSTimeStamp 減 DateTimeOriginal 是同一招。
//      ③ 只有 mvhd → 照規格當 UTC 瞬間（`file_time`）。Pixel 的 `PXL_` 正好
//         落在這裡，而且是對的 —— 它的檔名本來就是 UTC，不參與②的相減。
//      ④ 只有牆上時間 → 配站台預設時區（`assumed`）。
//
//    ②相減出來**剛好是 0** 代表 mvhd 寫的其實是當地時間（不是 UTC），這時候
//    退回④用牆上時間，不要真的存一個 UTC+0 進去。
//
// 這一檔本身**不做任何時間換算**：它只負責把檔案裡有什麼挖出來，湊成一份
// EXIF 形狀的物件交給 `normalizeGeo()`。全站的不變式（taken_at =
// taken_at_local − tz）只能有一份實作，那份在 geo.ts。

import {
  deriveTzOffset, formatWallClock, parseExifDateTime, wallClockAsUtcMs,
  type WallClock,
} from './geo';

/** 讀檔案的某一段。瀏覽器用 File.slice，Worker 用 Drive 的 Range 請求 */
export type RangeReader = (start: number, endExclusive: number) => Promise<Uint8Array>;

export interface VideoMeta {
  /** mvhd 的建立時間換算成 UTC 毫秒。**沒有時區保證**，用途見檔頭的四層 */
  instantMs: number | null;
  /** 檔案自己寫明時區時的牆上時間 'YYYY-MM-DD HH:MM:SS' */
  wallClock: string | null;
  /** 跟 wallClock 成對出現的時區偏移（分鐘） */
  offsetMinutes: number | null;
  /** 只有牆上時間、沒帶時區的那種（©day 常是這樣） */
  wallClockOnly: string | null;
  lat: number | null;
  lng: number | null;

  /*
   * 以下是「照片有 EXIF、影片有 metadata」那一半 —— 時間與座標之外，
   * 檔案裡還寫著機身、軟體、解析度、編碼…… 燈箱要照著 EXIF 那一格畫出來。
   * 全部都在**已經讀進記憶體的那份 moov 裡**，不多花任何一次 Drive 讀取。
   */

  /**
   * 檔案裡**所有**讀得出來的標籤：udta 底下每一個 `©xxx`，加上 Apple 的
   * keys／ilst 每一筆。鍵名原樣保留、不做對照 —— 哪幾個要翻成中文是燈箱的事，
   * 這一檔只負責「一個都不漏」。
   */
  tags: Record<string, string>;
  /** 影像尺寸。已經套過 tkhd 的旋轉矩陣，直的影片回的就是直的 */
  width: number | null;
  height: number | null;
  /** tkhd 矩陣算出來的旋轉角（0／90／180／270） */
  rotation: number | null;
  /** mvhd 的 duration ÷ timescale */
  durationMs: number | null;
  /** stsd 第一個 entry 的四字元型別：avc1／hvc1／mp4a… */
  videoCodec: string | null;
  audioCodec: string | null;
  /** 影格率＝視訊軌的樣本數 ÷ 時長 */
  frameRate: number | null;
}

/**
 * ⚠️ 這是**函式不是常數**：`tags` 是物件，共用一份常數再淺複製出來的每一支影片
 *    會指到同一張表，第二支就會看到第一支的標籤。
 */
function emptyMeta(): VideoMeta {
  return {
    instantMs: null, wallClock: null, offsetMinutes: null,
    wallClockOnly: null, lat: null, lng: null,
    tags: {}, width: null, height: null, rotation: null,
    durationMs: null, videoCodec: null, audioCodec: null, frameRate: null,
  };
}

/**
 * 檔頭一次讀多少。faststart 的 mp4（多數手機相機）moov 整個就在這裡面，
 * 一次讀完就夠；moov 在檔尾的靠 mdat 的 size 直接跳過去，不必逐段試。
 */
export const HEAD_CHUNK = 128 * 1024;
/** moov 大到這個程度就只讀開頭（mvhd 一定在最前面），udta 那些就放棄 */
const MOOV_MAX = 8 * 1024 * 1024;
/** QuickTime 紀元 1904-01-01 到 Unix 紀元 1970-01-01 的秒數 */
const MAC_EPOCH_OFFSET = 2082844800;
/** 地球上實際存在的最大時區偏移為 UTC+14 */
const MAX_TZ_OFFSET_MINUTES = 14 * 60;

/* ---------- box 走訪 ---------- */

function u32(b: Uint8Array, i: number): number {
  return ((b[i] << 24) >>> 0) + (b[i + 1] << 16) + (b[i + 2] << 8) + b[i + 3];
}

/** 64 位元的 size。超過 2^53 的檔案不存在，直接用兩個 32 位元湊 */
function u64(b: Uint8Array, i: number): number {
  return u32(b, i) * 4294967296 + u32(b, i + 4);
}

/** box 的四個字元型別。`©day`／`©xyz` 的第一個位元組是 0xA9，latin1 剛好對得上 */
function boxType(b: Uint8Array, i: number): string {
  return String.fromCharCode(b[i], b[i + 1], b[i + 2], b[i + 3]);
}

interface BoxHead { size: number; headLen: number; type: string }

/** 解一個 box 的檔頭。`size === 1` 是 64 位元長度，`size === 0` 是「一路到檔尾」 */
function readBoxHead(b: Uint8Array, i: number): BoxHead | null {
  if (i + 8 > b.length) return null;
  const raw = u32(b, i);
  const type = boxType(b, i + 4);
  if (raw === 1) {
    if (i + 16 > b.length) return null;
    return { size: u64(b, i + 8), headLen: 16, type };
  }
  return { size: raw, headLen: 8, type };
}

type BoxVisitor = (type: string, contentStart: number, contentEnd: number) => void;

/**
 * 走訪 [from, to) 裡的每一個 box，回報**內容**的範圍（不含檔頭）。
 *
 * ⚠️ 截斷是常態，不是錯誤 —— 我們常常只讀了檔案的一小段（moov 太大時只讀開頭）。
 *    最後一個 box 超出手上這塊時照樣回報，把 `to` 當成它的結尾：子解析器讀到一半
 *    沒東西就自己放棄，比整個停下來好（否則 mvhd 明明就在最前面卻解不到）。
 */
function walkBoxes(b: Uint8Array, from: number, to: number, visit: BoxVisitor): void {
  let p = from;
  while (p + 8 <= to) {
    const head = readBoxHead(b, p);
    if (!head) break;
    // size 0 ＝ 這個 box 一路到結尾
    const size = head.size === 0 ? to - p : head.size;
    if (size < head.headLen) break;   // 壞掉的檔，不要無窮迴圈
    const end = p + size;
    visit(head.type, p + head.headLen, Math.min(end, to));
    if (end <= p) break;
    p = end;
  }
}

/** 這個位置看起來像不像一個 box 檔頭（給 meta 那個 FullBox 的歧義用） */
function looksLikeBox(b: Uint8Array, i: number, to: number): boolean {
  const head = readBoxHead(b, i);
  if (!head || head.size < 8 || i + head.size > to + 8) return false;
  for (let k = i + 4; k < i + 8; k++) {
    const c = b[k];
    if (c !== 0xa9 && (c < 0x20 || c > 0x7e)) return false;
  }
  return true;
}

/* ---------- 各個 box 的內容 ---------- */

/**
 * mvhd：影片的建立時間（1904 紀元的秒數）＋ 長度。版本 1 的時間與長度都是 64 位元。
 *
 * ⚠️ 兩件事**各自檢查邊界**：截斷的 moov 常常只夠讀到時間，那時候長度讀不到，
 *    但時間仍然是好的 —— 綁在一起檢查等於為了長度把時間也丟掉。
 */
function parseMvhd(b: Uint8Array, s: number, e: number): { instantMs: number | null; durationMs: number | null } {
  const out: { instantMs: number | null; durationMs: number | null } = { instantMs: null, durationMs: null };
  if (s + 5 > e) return out;
  const v1 = b[s] === 1;

  // 建立時間
  let secs = 0;
  if (v1) { if (s + 12 <= e) secs = u64(b, s + 4); }
  else if (s + 8 <= e) secs = u32(b, s + 4);
  if (secs) {
    const ms = (secs - MAC_EPOCH_OFFSET) * 1000;
    // 1990 年以前與未來的時間都是壞值（有些機身寫的是「開機到現在」的秒數）
    if (ms >= Date.UTC(1990, 0, 1) && ms <= Date.now() + 86400000) out.instantMs = ms;
  }

  // 長度：timescale ＋ duration 接在兩個時間戳後面
  const tsAt = s + (v1 ? 20 : 12);
  const durAt = s + (v1 ? 24 : 16);
  const durEnd = durAt + (v1 ? 8 : 4);
  if (durEnd <= e) {
    const timescale = u32(b, tsAt);
    const duration = v1 ? u64(b, durAt) : u32(b, durAt);
    // 0xFFFFFFFF ＝「不知道」，不是一段 49 天的影片
    if (timescale > 0 && duration > 0 && duration !== 0xffffffff) {
      out.durationMs = Math.round((duration / timescale) * 1000);
    }
  }
  return out;
}

/** 一條軌（trak）解出來的東西。視訊軌與音訊軌各取各的 */
interface TrackInfo {
  kind: string | null;      // hdlr 的 handler type：'vide'／'soun'／…
  codec: string | null;
  width: number | null;
  height: number | null;
  rotation: number | null;
  frameRate: number | null;
}

/** 16.16 定點數（tkhd 的矩陣與寬高都是這個格式） */
function fixed1616(b: Uint8Array, i: number): number {
  const raw = u32(b, i);
  return (raw >= 0x80000000 ? raw - 0x100000000 : raw) / 65536;
}

/**
 * tkhd：旋轉矩陣 ＋ 影像寬高。
 *
 * ⚠️ 手機的直式影片**位元組上仍然是橫的**，靠矩陣轉 90 度 —— 所以寬高一定要
 *    套過旋轉再交出去，不然直的影片會寫成 1920 × 1080。
 */
function parseTkhd(b: Uint8Array, s: number, e: number, t: TrackInfo): void {
  // version(1)+flags(3) 之後：v0 是 4+4+4+4+4（建立/修改/id/保留/時長）＝ 20，
  // v1 的兩個時間戳與時長是 64 位元 ＝ 32；再加 8 保留 + 2 layer + 2 group
  // + 2 volume + 2 保留，矩陣才開始。
  const matrixAt = s + (b[s] === 1 ? 52 : 40);
  if (matrixAt + 44 > e) return;

  // 矩陣前兩個值是 a、b，旋轉角就是 atan2(b, a)
  const a = fixed1616(b, matrixAt);
  const bb = fixed1616(b, matrixAt + 4);
  let deg = Math.round((Math.atan2(bb, a) * 180) / Math.PI);
  if (deg < 0) deg += 360;
  deg = (Math.round(deg / 90) * 90) % 360;
  t.rotation = deg;

  // 寬高接在 36 個位元組的矩陣後面
  let w = fixed1616(b, matrixAt + 36);
  let h = fixed1616(b, matrixAt + 40);
  if (deg === 90 || deg === 270) { const tmp = w; w = h; h = tmp; }
  if (w >= 1 && h >= 1) { t.width = Math.round(w); t.height = Math.round(h); }
}

/**
 * 一條軌：tkhd（尺寸／旋轉）→ mdia → mdhd（時基）／hdlr（是影像還是聲音）／
 * minf → stbl → stsd（編碼）與 stts（樣本數，除以時長就是影格率）。
 *
 * ⚠️ 這些全都在**已經讀進來的那份 moov 裡**，一次 Drive 讀取都不會多花。
 *    唯一的代價是 stbl 很大時可能被 MOOV_MAX 截斷，那時候 walkBoxes 自己會停。
 */
function parseTrak(b: Uint8Array, s: number, e: number): TrackInfo {
  const t: TrackInfo = { kind: null, codec: null, width: null, height: null, rotation: null, frameRate: null };
  let timescale = 0;
  let duration = 0;
  let samples = 0;

  walkBoxes(b, s, e, (type, cs, ce) => {
    if (type === 'tkhd') {
      parseTkhd(b, cs, ce, t);
      return;
    }
    if (type !== 'mdia') return;
    walkBoxes(b, cs, ce, (mt, ms, me) => {
      if (mt === 'mdhd') {
        const v1 = b[ms] === 1;
        const tsAt = ms + (v1 ? 20 : 12);
        const durAt = ms + (v1 ? 24 : 16);
        if (durAt + (v1 ? 8 : 4) <= me) {
          timescale = u32(b, tsAt);
          duration = v1 ? u64(b, durAt) : u32(b, durAt);
        }
      } else if (mt === 'hdlr') {
        // FullBox(4) + pre_defined(4)，接著才是 handler type
        if (ms + 12 <= me) t.kind = boxType(b, ms + 8);
      } else if (mt === 'minf') {
        walkBoxes(b, ms, me, (nt, ns, ne) => {
          if (nt !== 'stbl') return;
          walkBoxes(b, ns, ne, (st, ss, se) => {
            if (st === 'stsd') {
              // FullBox(4) + entry_count(4)，接著就是第一個 entry 的 box 檔頭
              if (ss + 16 <= se && !t.codec) t.codec = boxType(b, ss + 12).trim();
            } else if (st === 'stts') {
              // FullBox(4) + entry_count(4)，每一筆 [sample_count][sample_delta]
              if (ss + 8 > se) return;
              const n = u32(b, ss + 4);
              let p = ss + 8;
              for (let i = 0; i < n && p + 8 <= se; i++, p += 8) samples += u32(b, p);
            }
          });
        });
      }
    });
  });

  if (timescale > 0 && duration > 0 && samples > 0) {
    const fps = samples / (duration / timescale);
    // 1000 以上一定是解錯了（音訊軌的樣本數除以時長就是取樣率）
    if (fps > 0 && fps < 1000) t.frameRate = Math.round(fps * 100) / 100;
  }
  return t;
}

/**
 * `©xyz` 的 ISO 6709 座標，如 `+25.0330+121.5654+018.000/`。
 * 前面兩個 uint16 是字串長度與語系碼。
 */
function parseIso6709(raw: string): { lat: number; lng: number } | null {
  const m = raw.trim().match(/^([+-]\d{1,3}(?:\.\d+)?)([+-]\d{1,3}(?:\.\d+)?)/);
  if (!m) return null;
  const lat = Number(m[1]);
  const lng = Number(m[2]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat, lng };
}

const decoder = new TextDecoder();

/**
 * udta 底下**不是** `©xxx` 開頭、但一樣是文字的那幾個。
 * 0xA9 開頭的整批都收（見 udtaChild），這裡只補這些例外。
 */
const UDTA_TEXT_TYPES: Record<string, true> = {
  name: true, auth: true, titl: true, desc: true, albm: true, gnre: true, yrrc: true,
};

/** udta 底下那些 `©xxx` 的內容：[長度 uint16][語系 uint16][字串] */
function parseUdtaText(b: Uint8Array, s: number, e: number): string {
  if (s + 4 > e) return '';
  const len = (b[s] << 8) + b[s + 1];
  const from = s + 4;
  const to = Math.min(e, from + (len || (e - from)));
  return decoder.decode(b.subarray(from, to)).replace(/\0/g, '').trim();
}

/**
 * 帶時區的時間字串 → 牆上時間 ＋ 偏移。
 *
 * Apple 的 `creationdate` 長這樣：`2024-08-15T14:30:00+0800`。
 * **沒有時區標記的一律回 null** —— 那是牆上時間，走另一條路（見檔頭②④），
 * 硬當成瞬間會差一整個時區。這條規則跟 geo.ts 的 parseExifDateTime 是一體兩面。
 */
function parseDateWithOffset(raw: string): { wallClock: string; offsetMinutes: number } | null {
  const m = raw.trim().match(
    /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})$/,
  );
  if (!m) return null;
  const wc: WallClock = {
    y: +m[1], mo: +m[2], d: +m[3], h: +m[4], mi: +m[5], s: +m[6],
  };
  if (wc.y < 1990 || wc.mo < 1 || wc.mo > 12 || wc.d < 1 || wc.d > 31) return null;

  const tzRaw = m[7];
  let offsetMinutes = 0;
  if (tzRaw !== 'Z') {
    const t = tzRaw.replace(':', '');
    const mins = Number(t.slice(1, 3)) * 60 + Number(t.slice(3, 5));
    if (!Number.isFinite(mins) || mins > MAX_TZ_OFFSET_MINUTES) return null;
    offsetMinutes = t[0] === '-' ? -mins : mins;
  }
  return { wallClock: formatWallClock(wc), offsetMinutes };
}

/** 沒帶時區的時間字串（©day 常是這樣）→ 牆上時間 */
function parseDateNoOffset(raw: string): string | null {
  const wc = parseExifDateTime(raw.trim());
  return wc ? formatWallClock(wc) : null;
}

/**
 * Apple 的 keys／ilst：`keys` 是一張「索引 → 鍵名」的表，`ilst` 裡每個 box 的
 * 「型別」其實是那張表的索引（1 起算），內容再包一層 `data` box。
 * 兩個 box 誰先出現不保證，所以先收完再對。
 */
function parseAppleMeta(b: Uint8Array, s: number, e: number, out: Record<string, string>): void {
  // ISO BMFF 的 meta 是 FullBox（前 4 個位元組是 version/flags），QuickTime 的不是。
  // 硬套其中一種會有一半的檔解不開，所以看下一個位置像不像 box 頭來決定。
  const from = looksLikeBox(b, s, e) ? s : s + 4;

  const keys: string[] = [];
  let ilst: [number, number] | null = null;
  walkBoxes(b, from, e, (type, cs, ce) => {
    if (type === 'keys') {
      // FullBox(4) + entry_count(4)，接著是 [size(4)][namespace(4)][鍵名]
      let p = cs + 8;
      while (p + 8 <= ce) {
        const size = u32(b, p);
        if (size < 8 || p + size > ce) break;
        keys.push(decoder.decode(b.subarray(p + 8, p + size)));
        p += size;
      }
    } else if (type === 'ilst') {
      ilst = [cs, ce];
    }
  });
  if (!ilst) return;

  walkBoxes(b, ilst[0], ilst[1], (type, cs, ce) => {
    // 這裡的「型別」是四個位元組的大端整數，不是字串
    const idx = (type.charCodeAt(0) << 24) + (type.charCodeAt(1) << 16)
      + (type.charCodeAt(2) << 8) + type.charCodeAt(3);
    const name = keys[idx - 1];
    if (!name) return;
    walkBoxes(b, cs, ce, (dt, ds, de) => {
      // data box：[型別指示 4][語系 4][內容]
      if (dt !== 'data' || ds + 8 > de) return;
      const text = decoder.decode(b.subarray(ds + 8, de)).replace(/\0/g, '').trim();
      if (text) out[name] = text;
    });
  });
}

/* ---------- 對外：把一支影片的 metadata 讀出來 ---------- */

/**
 * 從 mp4／mov 裡讀出拍攝時間與座標。
 *
 * `read` 只會被叫幾次：檔頭一塊（faststart 的檔這一塊就含 moov），moov 在檔尾時
 * 再讀它的檔頭與內容。**在 Worker 裡每一次都是一個 Drive subrequest**（免費版
 * 單次呼叫上限 50），所以刻意不逐個 box 去試。
 */
export async function readVideoMeta(
  read: RangeReader, size: number, headBuf?: Uint8Array,
): Promise<VideoMeta> {
  if (!size || size < 16) return emptyMeta();

  const head = headBuf ?? await read(0, Math.min(size, HEAD_CHUNK));
  if (head.length < 8) return emptyMeta();

  // 走頂層 box 找 moov。mdat（那個幾 GB 的位元組海）只看它的 size 就跳過去了
  let moovStart = -1;
  let moovEnd = -1;
  let p = 0;
  while (p + 8 <= size) {
    let hdr: Uint8Array;
    let base: number;
    if (p + 16 <= head.length) {
      hdr = head; base = p;
    } else {
      // moov 在檔尾的那種（mdat 排在前面）—— 只為了它的檔頭多讀 16 個位元組
      hdr = await read(p, Math.min(size, p + 16)); base = 0;
      if (hdr.length < 8) break;
    }
    const box = readBoxHead(hdr, base);
    if (!box) break;
    const boxSize = box.size === 0 ? size - p : box.size;
    if (boxSize < box.headLen) break;
    if (box.type === 'moov') {
      moovStart = p + box.headLen;
      moovEnd = Math.min(size, p + boxSize);
      break;
    }
    p += boxSize;
  }
  if (moovStart < 0 || moovEnd <= moovStart) return emptyMeta();

  // moov 的位元組。已經在檔頭那塊裡就不要再讀一次
  let moov: Uint8Array;
  let off: number;
  if (moovEnd <= head.length) {
    moov = head; off = moovStart;
  } else {
    // 太大的 moov（很長的影片，sample table 就好幾 MB）只讀開頭：mvhd 一定是
    // moov 的第一個子 box，而 udta／meta 排在最後面 —— 那種檔就只拿得到 mvhd。
    const end = Math.min(moovEnd, moovStart + MOOV_MAX);
    moov = await read(moovStart, end); off = 0;
  }
  const moovStop = off + (moovEnd - moovStart) > moov.length
    ? moov.length : off + (moovEnd - moovStart);

  const out: VideoMeta = emptyMeta();
  const apple: Record<string, string> = {};
  const tracks: TrackInfo[] = [];

  const udtaChild: BoxVisitor = (type, s, e) => {
    /*
     * 先原樣收下來 —— 認得的（©xyz／©day）下面再各自解析，不認得的
     * （©mak 機身廠牌、©mod 型號、©swr 軟體，以及各家自己塞的）**一個都不丟**。
     * 使用者要的是「檔案裡所有的 metadata」，我們沒有資格先挑掉幾個。
     */
    if (type.charCodeAt(0) === 0xa9 || UDTA_TEXT_TYPES[type]) {
      const text = parseUdtaText(moov, s, e);
      if (text) out.tags[type] = text;
    }

    if (type === '©xyz') {
      const c = parseIso6709(parseUdtaText(moov, s, e));
      if (c) { out.lat = c.lat; out.lng = c.lng; }
    } else if (type === '©day') {
      const text = parseUdtaText(moov, s, e);
      const withTz = parseDateWithOffset(text);
      if (withTz) {
        out.wallClock = withTz.wallClock;
        out.offsetMinutes = withTz.offsetMinutes;
      } else {
        out.wallClockOnly = parseDateNoOffset(text) ?? out.wallClockOnly;
      }
    } else if (type === 'meta') {
      parseAppleMeta(moov, s, e, apple);
    }
  };

  walkBoxes(moov, off, moovStop, (type, s, e) => {
    if (type === 'mvhd') {
      const mv = parseMvhd(moov, s, e);
      out.instantMs = mv.instantMs;
      out.durationMs = mv.durationMs;
    } else if (type === 'trak') {
      tracks.push(parseTrak(moov, s, e));
    } else if (type === 'udta') {
      walkBoxes(moov, s, e, udtaChild);
    } else if (type === 'meta') {
      // mov 把 meta 掛在 moov 底下，mp4 多半掛在 udta 底下，兩邊都要看
      parseAppleMeta(moov, s, e, apple);
    }
  });

  // Apple 的欄位最準（時區直接寫在裡面），蓋過 ©day
  const appleDate = apple['com.apple.quicktime.creationdate'];
  if (appleDate) {
    const withTz = parseDateWithOffset(appleDate);
    if (withTz) {
      out.wallClock = withTz.wallClock;
      out.offsetMinutes = withTz.offsetMinutes;
    } else {
      out.wallClockOnly = parseDateNoOffset(appleDate) ?? out.wallClockOnly;
    }
  }
  const appleLoc = apple['com.apple.quicktime.location.ISO6709'];
  if (appleLoc && out.lat === null) {
    const c = parseIso6709(appleLoc);
    if (c) { out.lat = c.lat; out.lng = c.lng; }
  }

  // Apple 那一整批也全部留著（機身、型號、iOS 版本、拍攝模式…）
  const appleKeys = Object.keys(apple);
  for (let i = 0; i < appleKeys.length; i++) out.tags[appleKeys[i]] = apple[appleKeys[i]];

  /*
   * 軌：影像那條給尺寸／旋轉／影格率，聲音那條只取編碼。
   * ⚠️ hdlr 讀不到時（截斷的 moov）退而求其次：有寬高的就是影像那條。
   */
  let vid: TrackInfo | null = null;
  let aud: TrackInfo | null = null;
  for (let i = 0; i < tracks.length; i++) {
    const t = tracks[i];
    if (t.kind === 'soun') { if (!aud) aud = t; continue; }
    if (t.kind === 'vide') { if (!vid || vid.kind !== 'vide') vid = t; continue; }
    if (!vid && t.width !== null) vid = t;
  }
  if (vid) {
    out.width = vid.width;
    out.height = vid.height;
    out.rotation = vid.rotation;
    out.videoCodec = vid.codec;
    out.frameRate = vid.frameRate;
  }
  if (aud) out.audioCodec = aud.codec;

  return out;
}

/* ---------- 檔名那條線索 ---------- */

/**
 * 從檔名猜牆上時間。
 *
 * 認得 `VID_20260824_143000.mp4`／`IMG_20260824_143000.jpg`／`20260824_143000`
 * 這一類 Android 常見的檔名。
 *
 * ⚠️ **`PXL_` 開頭的刻意不猜**（Pixel 的相機）—— 那串數字是 **UTC**，
 *    直接當牆上時間會整整差一個時區（台灣是 8 小時），而且錯得很安靜。
 *    回 'utc' 讓呼叫端自己決定怎麼講（FixTimeModal 會寫出「為什麼沒有預填」，
 *    videoMetaToExif 則是不拿它去跟 mvhd 相減）。
 *
 * ⚠️⚠️ 這兩個正規表示式的 `\d` 曾經整批掉成 `d`，於是「指定時間」的套用鈕
 *    從上線那天起一直是灰的。**改這一檔如果經過任何會處理跳脫字元的腳本，
 *    改完一定要 grep 一次 `[^\\]d{`。**
 */
export function guessWallClockFromName(name: string | undefined): string | 'utc' | null {
  if (!name) return null;
  if (/^PXL_/i.test(name)) return 'utc';
  const m = name.match(/(?:^|[^0-9])(\d{4})(\d{2})(\d{2})[_-]?(\d{2})(\d{2})(\d{2})(?![0-9])/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  const yy = Number(y);
  if (yy < 1990 || yy > 2100) return null;
  if (Number(mo) < 1 || Number(mo) > 12 || Number(d) < 1 || Number(d) > 31) return null;
  if (Number(h) > 23 || Number(mi) > 59 || Number(s) > 59) return null;
  return `${y}-${mo}-${d}T${h}:${mi}:${s}`;
}

/* ---------- 對外：湊成 EXIF 形狀交給 normalizeGeo ---------- */

/**
 * 存進 `Photo.exif` 的那一塊「影片 metadata」。
 *
 * ⚠️ **刻意掛在既有的 `exif` 欄位底下**（鍵名 `_video`），不另外開一欄 ——
 *    那一欄本來就是 TEXT、影片一直是空的，多一欄 migration 換來的是同一件事。
 *    `normalizeGeo()` 只讀白名單裡那幾個鍵，多這一塊對它完全沒有影響。
 * ⚠️ 鍵名跟 EXIF 平行（Make／Model／Software），燈箱那一格才畫得出「照片有什麼、
 *    影片就有什麼」。認不出來的原始標籤整批留在 `Tags` 裡，一個都不丟。
 */
export interface VideoExifBlock {
  Make?: string;
  Model?: string;
  Software?: string;
  Width?: number;
  Height?: number;
  Rotation?: number;
  DurationMs?: number;
  FrameRate?: number;
  VideoCodec?: string;
  AudioCodec?: string;
  /** 沒對照到那幾個常用鍵的原始標籤，鍵名照檔案裡寫的 */
  Tags?: Record<string, string>;
}

/** 同一件事在不同機身寫在不同鍵上，由前往後取第一個有值的 */
const MAKE_KEYS = ['com.apple.quicktime.make', '©mak', 'com.android.manufacturer'];
const MODEL_KEYS = ['com.apple.quicktime.model', '©mod', 'com.android.model'];
const SOFTWARE_KEYS = ['com.apple.quicktime.software', '©swr', 'com.android.version'];

/** 這幾個已經在別的地方畫出來了（時間、座標），不必在原始標籤裡再列一次 */
const SHOWN_ELSEWHERE = [
  '©day', '©xyz',
  'com.apple.quicktime.creationdate',
  'com.apple.quicktime.location.ISO6709',
];

/**
 * 標籤值可能是二進位（有些 box 的內容根本不是文字）。控制字元與解碼失敗的
 * 替代字元一律拿掉，並且夾在 200 字 —— 這一份是要塞進 D1 那一列 JSON 的。
 */
function cleanTagValue(raw: string): string {
  let s = '';
  for (let i = 0; i < raw.length; i++) {
    const c = raw.charCodeAt(i);
    // 控制字元與「解碼失敗」那個替代字元（U+FFFD）都不要
    if (c < 0x20 || c === 0x7f || c === 0xfffd) continue;
    s += raw[i];
  }
  s = s.trim();
  return s.length > 200 ? `${s.slice(0, 200)}…` : s;
}

function pickTag(tags: Record<string, string>, keys: string[]): string | undefined {
  for (let i = 0; i < keys.length; i++) {
    const v = tags[keys[i]];
    if (v) {
      const c = cleanTagValue(v);
      if (c) return c;
    }
  }
  return undefined;
}

/** 讀到的 metadata → 要存起來的那一塊。什麼都沒有時回空物件 */
export function videoMetaBlock(meta: VideoMeta): VideoExifBlock {
  const out: VideoExifBlock = {};
  const make = pickTag(meta.tags, MAKE_KEYS);
  const model = pickTag(meta.tags, MODEL_KEYS);
  const software = pickTag(meta.tags, SOFTWARE_KEYS);
  if (make) out.Make = make;
  if (model) out.Model = model;
  if (software) out.Software = software;
  if (meta.width !== null && meta.height !== null) {
    out.Width = meta.width;
    out.Height = meta.height;
  }
  if (meta.rotation) out.Rotation = meta.rotation;
  if (meta.durationMs !== null) out.DurationMs = meta.durationMs;
  if (meta.frameRate !== null) out.FrameRate = meta.frameRate;
  if (meta.videoCodec) out.VideoCodec = meta.videoCodec;
  if (meta.audioCodec) out.AudioCodec = meta.audioCodec;

  const used = MAKE_KEYS.concat(MODEL_KEYS, SOFTWARE_KEYS, SHOWN_ELSEWHERE);
  const rest: Record<string, string> = {};
  const names = Object.keys(meta.tags);
  for (let i = 0; i < names.length; i++) {
    const k = names[i];
    if (used.indexOf(k) >= 0) continue;
    const v = cleanTagValue(meta.tags[k]);
    if (v) rest[k] = v;
  }
  if (Object.keys(rest).length > 0) out.Tags = rest;
  return out;
}

export interface VideoExifShape {
  /** 白名單過的 EXIF 形狀物件，直接餵 normalizeGeo（或 uploadPhoto 的 exifData） */
  exif: Record<string, unknown> | null;
  /** 只有瞬間、推不出時區時的備援（normalizeGeo 會標成 file_time） */
  fallbackIso: string | null;
  /** 這一份時間是靠哪一層得來的，只給 UI 與回寫報告用 */
  how: 'tagged' | 'derived' | 'instant' | 'wall' | 'none';
}

/** 時區偏移（分鐘）→ EXIF 的 `+08:00` */
function fmtOffset(min: number): string {
  const sign = min < 0 ? '-' : '+';
  const a = Math.abs(min);
  const hh = String(Math.floor(a / 60)).padStart(2, '0');
  const mm = String(a % 60).padStart(2, '0');
  return `${sign}${hh}:${mm}`;
}

/** UTC 毫秒 → EXIF 的 GPSDateStamp／GPSTimeStamp（那兩欄記的就是 UTC） */
function gpsStamps(ms: number): { GPSDateStamp: string; GPSTimeStamp: number[] } {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return {
    GPSDateStamp: `${d.getUTCFullYear()}:${p(d.getUTCMonth() + 1)}:${p(d.getUTCDate())}`,
    GPSTimeStamp: [d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()],
  };
}

/**
 * 相減推時區時，容許牆上時間與瞬間差多少分鐘。
 *
 * mvhd 記的常是**錄影結束**的時間，而檔名是**開始**的時間 —— 一支 3 分鐘的影片
 * 兩者就差 3 分鐘。真實時區都是 15 分鐘的倍數，四捨五入吸收得掉；
 * 殘差超過這個數字（＝很長的影片，或根本不是同一個時鐘）就不要硬推。
 */
const DERIVE_RESIDUAL_MAX_MIN = 10;

/**
 * 把讀到的 metadata 湊成 EXIF 形狀，交給 `normalizeGeo()`。
 *
 * **這裡不做任何換算**，只決定「餵哪幾個欄位進去」—— 時區怎麼算、
 * taken_at 怎麼推，全站只有 geo.ts 那一份實作。
 * 四層的優先序與理由見檔頭。
 */
export function videoMetaToExif(meta: VideoMeta, fileName?: string): VideoExifShape {
  const exif: Record<string, unknown> = {};

  /*
   * 檔案裡讀到的**全部** metadata 掛在 `_video` 底下，跟著 exif 一起存進 D1 ——
   * 燈箱那塊面板要拿它畫「影片的 Metadata」（照片有什麼、影片就有什麼）。
   * `normalizeGeo()` 只讀白名單裡那幾個鍵，多這一塊對它完全沒有影響。
   */
  const block = videoMetaBlock(meta);
  const hasBlock = Object.keys(block).length > 0;
  if (hasBlock) exif._video = block;

  const geo = meta.lat !== null && meta.lng !== null;
  if (geo) {
    exif.latitude = meta.lat;
    exif.longitude = meta.lng;
  }
  /*
   * ⚠️ 「有沒有東西值得存」不可以再寫成 `Object.keys(exif).length > 0` ——
   *    `_video` 幾乎一定在裡面，那句話會永遠是 true。
   */
  const hasAny = () => geo || hasBlock;

  // ① 檔案自己寫明時區 —— 牆上時間與偏移都有，normalizeGeo 會標成 offset_tag
  if (meta.wallClock && meta.offsetMinutes !== null) {
    exif.DateTimeOriginal = meta.wallClock;
    exif.OffsetTimeOriginal = fmtOffset(meta.offsetMinutes);
    return { exif, fallbackIso: null, how: 'tagged' };
  }

  // 另一個「牆上時間」來源：檔案裡的 ©day 優先於檔名（同一個時鐘，但更可信）
  const named = guessWallClockFromName(fileName);
  const wall = meta.wallClockOnly ?? (named && named !== 'utc' ? named : null);

  // ② 瞬間 ＋ 牆上時間 → 相減就是時區。交給 geo.ts 的 deriveTzOffset 去算，
  //    這裡只先擋掉「推出來不合理」的情況
  if (meta.instantMs !== null && wall) {
    const wc = parseExifDateTime(wall);
    if (wc) {
      const diff = (wallClockAsUtcMs(wc) - meta.instantMs) / 60000;
      const snapped = Math.round(diff / 15) * 15;
      const residual = Math.abs(diff - snapped);
      // snapped === 0 ＝ mvhd 寫的其實是當地時間而不是 UTC（一票 Android 機身
      // 就是這樣）。真的存成 UTC+0 的話瞬間會整整差一個時區，退回④才對。
      if (snapped !== 0
        && Math.abs(snapped) <= MAX_TZ_OFFSET_MINUTES
        && residual <= DERIVE_RESIDUAL_MAX_MIN) {
        const candidate = {
          ...exif,
          DateTimeOriginal: formatWallClock(wc),
          ...gpsStamps(meta.instantMs),
        };
        // 用 geo.ts 自己再確認一次：兩邊算法一致才送出去
        if (deriveTzOffset(candidate)) {
          return { exif: candidate, fallbackIso: null, how: 'derived' };
        }
      }
      // 推不出時區，但牆上時間是有的 → ④
      exif.DateTimeOriginal = formatWallClock(wc);
      return { exif, fallbackIso: null, how: 'wall' };
    }
  }

  // ③ 只有 mvhd → 照規格當 UTC 瞬間。`PXL_` 的檔名本來就是 UTC，落在這裡剛好對
  if (meta.instantMs !== null) {
    return {
      exif: hasAny() ? exif : null,
      fallbackIso: new Date(meta.instantMs).toISOString(),
      how: 'instant',
    };
  }

  // ④ 只有牆上時間 → 配站台預設時區，normalizeGeo 會標成 assumed
  if (wall) {
    const wc = parseExifDateTime(wall);
    if (wc) {
      exif.DateTimeOriginal = formatWallClock(wc);
      return { exif, fallbackIso: null, how: 'wall' };
    }
  }

  return { exif: hasAny() ? exif : null, fallbackIso: null, how: 'none' };
}

/** 瀏覽器端的 RangeReader：File.slice 是惰性的，不會把幾 GB 讀進記憶體 */
export function fileRangeReader(file: File): RangeReader {
  return async (start, end) =>
    new Uint8Array(await file.slice(start, end).arrayBuffer());
}

/**
 * 一支本機影片的 metadata → EXIF 形狀。上傳路徑就叫這一支。
 *
 * ⚠️ **絕不往外丟例外**：讀不到 metadata 只是「這支影片沒有時間」，
 *    跟上傳成不成功無關。丟出去會讓整批停在這裡。
 */
export async function readVideoExifFromFile(file: File): Promise<VideoExifShape> {
  try {
    const meta = await readVideoMeta(fileRangeReader(file), file.size);
    return videoMetaToExif(meta, file.name);
  } catch (err) {
    console.warn('讀不到影片的拍攝資訊，當成沒有', file.name, err);
    return videoMetaToExif(emptyMeta(), file.name);
  }
}
