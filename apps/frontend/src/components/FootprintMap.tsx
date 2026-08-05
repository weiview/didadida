'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  MapLibreMap, NavigationControl, LngLatBounds,
  type GeoJSONSource, type MapLayerMouseEvent,
} from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import type { Album, FootprintPoint, TrackPoint, TrackPointEdit } from '@/lib/api';
import { MOVER_EMOJI, metersBetween, segmentKey } from '@/lib/vehicles';

// OpenFreeMap：免費、免 API key、無流量上限的向量圖磚。
// 不用 Google Maps 是因為它強制要求綁定信用卡的帳單帳戶。
const DEFAULT_STYLE = 'https://tiles.openfreemap.org/styles/positron';

interface Props {
  points: FootprintPoint[];
  /**
   * 要不要在地圖上畫照片（圓點、聚合、縮圖）。
   *
   * 關掉時是把 photos 這個 source 餵空，而不是只切圖層可見性 ——
   * 縮圖採「畫到才載」（見 styleimagemissing），source 空了就不會有人來要圖，
   * 也就順便省掉那一整批 R2 讀取與頻寬。
   *
   * points 仍然照傳：關掉只是不畫，鏡頭框景與播放列的統計都還算它們。
   */
  showPhotos?: boolean;
  /**
   * 相簿清單。只為了一件事：整叢照片都屬於同一本相簿時，用那本的封面照當代表。
   *
   * 沒傳、或那本沒設封面，就退回「從這本相簿的照片裡隨機挑一張」——
   * 所以這個 prop 是加分項，缺了地圖照樣完整。
   */
  albums?: Album[];
  /** GPS 軌跡點。有軌跡時，動畫就是沿著它跑 */
  tracks?: TrackPoint[];
  /**
   * 把照片位置也串進動畫路徑。
   * 預設關閉：照片之間拉直線是憑空捏造的路徑，兩張照片就會變成一條穿牆而過的直線。
   * 沒有軌跡的舊相簿才需要打開它。
   */
  connectPhotos?: boolean;
  height?: number | string;
  styleUrl?: string;
  onSelectPhoto?: (point: FootprintPoint) => void;
  /** 管理者才給編輯軌跡點的入口 */
  editable?: boolean;
  /**
   * 送出軌跡點編修。一次可能有多天（跨日的選取要分開送，因為後端是逐日改的），
   * 回傳 false 代表沒改成功，畫面上的選取會保留讓使用者重試。
   */
  onEditPoints?: (edits: TrackPointEdit[]) => Promise<boolean>;
  /**
   * 把照片搬到指定座標（geo_source 會變成 'manual'）。
   * 跟 onEditPoints 分開是因為改的是不同資料表，後端也是兩條路由。
   */
  onMovePhoto?: (photoId: number, lat: number, lng: number) => Promise<boolean>;
  /**
   * 未經濃縮／抽稀的原始軌跡點（由頁面解析 GPX 而來，這裡只負責畫與跑動畫）。
   *
   * 刻意跟 tracks 分開而不是合併：這些點不在 D1 裡，沒有真的 id，
   * 不可以進編輯模式 —— 選了也刪不掉、合併不了。
   *
   * 純檢視用，不寫進 D1 —— 完整軌跡動輒好幾萬點，寫進去會吃掉免費方案
   * 每日 10 萬列的寫入額度，而且編輯模式的段內點號會變成五位數而不能用。
   */
  rawTracks?: TrackPoint[];
  /** 要不要把原始軌跡畫成橘色虛線。跟 animateOn 分開：可以只跑動畫不畫線，反之亦然 */
  showRawLine?: boolean;
  /**
   * 貼路（map matching）後的軌跡點。幾何來自 OSM 路網，時間是從原本的點內插回來的，
   * 所以跟 rawTracks 一樣可以直接畫、直接跑動畫。
   *
   * 同樣不在 D1 裡（存 R2），不可編輯 —— 這是衍生資料，改它沒有意義，
   * 真要修的是原本的軌跡點。
   */
  matchedTracks?: TrackPoint[];
  /** 要不要把貼路軌跡畫成紫色實線 */
  showMatchedLine?: boolean;
  /**
   * 要不要畫 D1 濃縮軌跡（綠線）與停留圈。
   *
   * 平常看的是貼路軌跡，這一層只是它的原料 —— 兩條疊在一起反而看不出貼路
   * 有沒有貼準。關掉只影響「畫不畫」，編輯模式的軌跡點另有一層，不受影響。
   */
  showTrackLine?: boolean;
  /** 動畫沿著哪一份軌跡跑。選到的那份沒資料時自動退回 'track' */
  animateOn?: 'track' | 'raw' | 'matched';
  /**
   * Google 時間軸的紀念層，已經切好可以連的線段（[lng, lat][][]）。
   *
   * 傳的是線而不是點，因為這一層跟其他三層的本質不同：它唯讀 —— 不編輯、
   * 不貼路、不跑動畫、不參與照片位置推論。頁面那邊算完就定案，
   * 這裡只負責畫。跟著傳點進來只會讓人以為它能做跟 tracks 一樣的事。
   */
  timelineLines?: [number, number][][];
  /**
   * 鏡頭要直接停在這個點（[lng, lat]），而不是把所有東西框進畫面。
   *
   * 只看一天的時候用：框住一整天的範圍會把鏡頭拉到看不出細節的高度，
   * 而人在看某一天時想從那天的起點看起（通常接著就按播放）。
   * 給 null 就恢復成「全部框進來」。
   */
  focusPoint?: [number, number] | null;
}

/** 動畫路徑上的一個節點 */
interface PathNode {
  /** UTC 毫秒。照片與軌跡唯一的共同時間軸 */
  t: number;
  lng: number;
  lat: number;
  /** 與前一個節點之間不可以連線 */
  breakBefore: boolean;
  /** 'day_key#seg'。照片節點為 null —— 它不屬於任何一段軌跡 */
  segKey: string | null;
}

/** 一次停留。匯入時已把亂跳的點收成質心，這裡只是把它的時間區間還原回來 */
interface Stay {
  /** 進入與離開的 UTC 毫秒 */
  t0: number;
  t1: number;
  lng: number;
  lat: number;
  sec: number;
}

// 超過這個間隔就斷開。跨夜（10 幾小時）仍然連著，隔好幾個月的兩趟旅行則不會被
// 一條橫跨地圖的假直線接起來。
const MAX_GAP_MS = 24 * 60 * 60 * 1000;

// 照片離停留質心多近才算「在同一個地方」。停留半徑是 60m，這裡放寬到兩倍，
// 因為照片本身的 EXIF 座標也有誤差，而且大樓的另一側仍然是同一棟樓。
const STAY_SNAP_M = 120;

// 地圖上最多同時保留幾張縮圖。超過就退回圓點 ——
// 每張都是一塊要留在 GPU 上的貼圖，不設上限的話大相簿會把記憶體吃光。
const MAX_THUMBS = 200;

// 照片在地圖上畫成「對話框泡泡」：圓角白框裝著照片，底下一根尾巴指著座標。
// 下面全是 CSS px，實際貼圖以 BUBBLE_PR 倍解析度畫，再靠 pixelRatio 交還給 maplibre
// （直接畫成 CSS 尺寸的話，放大到 icon-size 1.5 會糊掉）。
const BUBBLE_PR = 2;
const BUBBLE_W = 84;
const BUBBLE_H = 84;
/** 尾巴高度。泡泡本體離座標多遠就是靠它 */
const BUBBLE_TAIL = 14;
/** 四周留白，純粹是給陰影用的；畫圖時要扣掉，錨點也要補回來（見 icon-offset） */
const BUBBLE_PAD = 8;
/** 白框粗細與圓角。圓角刻意放很大 —— 泡泡「可愛」的主要來源就是這個 */
const BUBBLE_BORDER = 5;
const BUBBLE_RADIUS = 24;

// 泡泡外圈的糖果色。依 id 取模挑一個，讓一整片泡泡看起來熱鬧而不是一片白。
// 不帶任何語意（不代表座標來源、不代表相簿），純裝飾
const BUBBLE_RINGS = ['#f472b6', '#fbbf24', '#34d399', '#60a5fa', '#a78bfa', '#fb7185'];

/**
 * 代表照的挑法：把「這次載入抽的亂數」放高位、照片 id 放低位打包成一個數字，
 * 交給 maplibre 的 clusterProperties 用 max 累加 —— 累加完的最大值，
 * 就等於這一叢裡隨機抽中的那一張。
 *
 * 拿 max 而不是別的：clusterProperties 只吃 min/max/sum 這類可結合的累加器，
 * 沒有「隨便給我一個」可用。低位留 1e9 給 id，高位亂數上限 1e5，
 * 乘起來 1e14 還在 double 的精確整數範圍（2^53）內。
 */
const REP_ID_MOD = 1e9;
const REP_RAND_MAX = 1e5;

/**
 * 「一坨」的判定半徑。同一本相簿、彼此在這個距離內的照片會被釘到同一個點上，
 * 攤成撲克牌那樣的扇形。
 *
 * 為什麼不是整本相簿取平均：一本相簿常常是一整趟旅行，橫跨好幾公里，
 * 取平均會把所有照片釘在一片什麼都沒有的空地上。要的是「同一個地方」而不是「同一本」。
 *
 * 40m 是照著泡泡的實際大小回推的 —— z19 時 1px ≈ 0.3m，泡泡約 126px 寬 ≈ 38m，
 * 也就是「在這個距離內就一定會疊在一起」的門檻。
 */
const PILE_RADIUS_M = 40;
/** 一坨最多攤開幾張。剩下的不畫，張數由徽章交代 */
const PILE_MAX_CARDS = 5;
/**
 * 扇形的總張角（度）。泡泡以尾巴尖端為旋轉中心（icon-rotate 是繞著 icon-anchor 轉的），
 * 所以這個角度直接就是牌面攤開的幅度：泡泡本體的中心約在支點上方 56px，
 * ±32° 換算過去大約是半個泡泡寬的間距，看得出是五張不同的照片又還疊著。
 */
const PILE_FAN_DEG = 64;

/** 每張照片畫在哪、怎麼擺。由 usePiles 算出來，只給 photos 這個 source 用 */
interface PileSlot {
  /** 釘住的座標（同一坨共用；單張就是它自己） */
  lng: number;
  lat: number;
  /** 這一坨總共幾張 */
  pile: number;
  /** 扇形裡的第幾張（0 起算）。-1 = 這張不畫 */
  fan: number;
  /** 旋轉角度（度） */
  angle: number;
}

// 跳到某一天的起點時用的縮放。街廓看得清楚，又不至於窄到看不出接下來往哪走。
// 固定值而不是「保留使用者目前的縮放」—— 從全球視野點進某一天，
// 沿用當下的縮放等於停在一片什麼都看不到的地方。
const FOCUS_ZOOM = 14;

/** 'YYYY-MM-DD HH:MM:SS' → 顯示用的短字串 */
function shortTime(local: string): string {
  if (!local) return '';
  const [d, t] = local.split(' ');
  return t ? `${d} ${t.slice(0, 5)}` : d;
}

/** 照片的 UTC 毫秒。沒有 taken_at 就只能拿當地時間頂著 */
function photoUtcMs(p: FootprintPoint): number | null {
  if (p.taken_at) {
    const t = Date.parse(p.taken_at);
    if (Number.isFinite(t)) return t;
  }
  // 退而求其次：把當地時間當成 UTC。照片之間的先後順序仍然正確，
  // 但跟軌跡混排時會偏掉一個時區 —— 這種照片本來就沒有可靠的絕對時間
  if (p.local_time) {
    const t = Date.parse(`${p.local_time.replace(' ', 'T')}Z`);
    if (Number.isFinite(t)) return t;
  }
  return null;
}

/** 圓角矩形路徑。不用 ctx.roundRect —— 它比較新，而且各家 TS lib 版本有無不定 */
function roundedRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/**
 * 對話框泡泡的外框路徑：圓角矩形 + 底部朝下的尾巴，一條路徑走完。
 *
 * 尾巴不另外畫一個三角形疊上去 —— 分開畫的話白框的接縫會露出來，
 * 而且外圈那條糖果色描邊會從尾巴根部橫切過去。
 * 尾巴尖端固定在正中央：錨點就是靠它對準座標的。
 */
function bubblePath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number, tail: number) {
  const cx = x + w / 2;
  const half = tail * 0.62; // 尾巴根部的半寬
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.arcTo(x + w, y, x + w, y + r, r);
  ctx.lineTo(x + w, y + h - r);
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.lineTo(cx + half, y + h);
  ctx.lineTo(cx, y + h + tail);
  ctx.lineTo(cx - half, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.arcTo(x, y + h, x, y + h - r, r);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
}

/**
 * 把照片畫成地圖用的對話框泡泡。
 *
 * 走 canvas 是因為 map.addImage 要的是像素資料，不是 <img>。
 * 這需要圖片是 CORS-clean，/api/photos/view/ 有回 Access-Control-Allow-Origin: *，
 * 所以 crossOrigin='anonymous' 成立；少了它 canvas 會被污染，getImageData 會直接丟例外。
 *
 * ring 是外圈描邊的顏色，由呼叫端依 id 挑（見 BUBBLE_RINGS）。
 */
function loadBubble(url: string, ring: string): Promise<ImageData> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onerror = () => reject(new Error('圖片載入失敗'));
    img.onload = () => {
      const wPx = (BUBBLE_W + BUBBLE_PAD * 2) * BUBBLE_PR;
      const hPx = (BUBBLE_H + BUBBLE_TAIL + BUBBLE_PAD * 2) * BUBBLE_PR;
      const canvas = document.createElement('canvas');
      canvas.width = wPx;
      canvas.height = hPx;
      const ctx = canvas.getContext('2d');
      if (!ctx) { reject(new Error('取不到 canvas context')); return; }
      // 之後的座標一律用 CSS px 思考，解析度只是倍率
      ctx.scale(BUBBLE_PR, BUBBLE_PR);

      const x = BUBBLE_PAD;
      const y = BUBBLE_PAD;

      // 白框本體。順手投一層淡影，泡泡才會像是浮在底圖上而不是印在上面
      ctx.save();
      ctx.shadowColor = 'rgba(15, 23, 42, 0.35)';
      ctx.shadowBlur = 6;
      ctx.shadowOffsetY = 3;
      bubblePath(ctx, x, y, BUBBLE_W, BUBBLE_H, BUBBLE_RADIUS, BUBBLE_TAIL);
      ctx.fillStyle = '#ffffff';
      ctx.fill();
      ctx.restore();

      // 照片：置中裁切（cover），不要把照片壓扁
      ctx.save();
      const ix = x + BUBBLE_BORDER;
      const iy = y + BUBBLE_BORDER;
      const iw = BUBBLE_W - BUBBLE_BORDER * 2;
      const ih = BUBBLE_H - BUBBLE_BORDER * 2;
      roundedRectPath(ctx, ix, iy, iw, ih, Math.max(BUBBLE_RADIUS - BUBBLE_BORDER, 2));
      ctx.clip();
      const side = Math.min(img.width, img.height);
      ctx.drawImage(
        img,
        (img.width - side) / 2, (img.height - side) / 2, side, side,
        ix, iy, iw, ih,
      );
      ctx.restore();

      // 外圈糖果色描邊。畫在最後，才不會被照片蓋掉，也不會沾到上面那層陰影
      bubblePath(ctx, x, y, BUBBLE_W, BUBBLE_H, BUBBLE_RADIUS, BUBBLE_TAIL);
      ctx.lineWidth = 2.5;
      ctx.lineJoin = 'round';
      ctx.strokeStyle = ring;
      ctx.stroke();

      try {
        resolve(ctx.getImageData(0, 0, wPx, hPx));
      } catch (err) {
        reject(err as Error);
      }
    };
    img.src = url;
  });
}

/**
 * 把 emoji 畫成點陣圖。
 *
 * 不能直接寫進 symbol 的 text-field：地圖文字走的是底圖樣式提供的 SDF 字型，
 * OpenFreeMap 的 Noto Sans 沒有 emoji 字符，畫出來會是豆腐。
 * canvas 用的是作業系統字型，emoji 才有得畫。
 */
function emojiImage(emoji: string, size = 40): ImageData | null {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.font = `${Math.round(size * 0.72)}px "Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(emoji, size / 2, size / 2 + size * 0.04);
  return ctx.getImageData(0, 0, size, size);
}

/** 秒數 → '3 小時 20 分' 這種給人看的長度 */
function humanDuration(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  if (h === 0) return `${m} 分`;
  return m === 0 ? `${h} 小時` : `${h} 小時 ${m} 分`;
}

/**
 * 把擠在同一個地方的照片收成一坨，決定每張畫在哪、擺成什麼角度。
 *
 * 分組是貪婪的「領頭者」法：照時間掃過去，落在某一坨的質心 PILE_RADIUS_M 內
 * 且同一本相簿就併進去，質心跟著更新，否則自己開一坨。O(n × 坨數)，
 * 幾百張照片綽綽有餘，不值得為它拉一套空間索引進來。
 *
 * 一坨最多攤開 PILE_MAX_CARDS 張，而且是**照時間均勻取樣**而不是取前幾張 ——
 * 五張攤開來要能代表這個地方待的那一整段，不是只看到剛到的頭五分鐘。
 *
 * 沒被選中的那幾張仍然留在資料裡（fan = -1，圖層自己濾掉）：
 * 它們得繼續參與 maplibre 的聚合，否則縮小時徽章上的張數會少算。
 */
function buildPiles(sorted: FootprintPoint[], pileUp: boolean): Map<number, PileSlot> {
  const out = new Map<number, PileSlot>();

  // 編輯模式不併坨：位置要能對得上真實座標，不然「把這張搬到這裡」會從錯的地方搬起
  if (!pileUp) {
    for (const p of sorted) {
      out.set(p.id, { lng: p.lng, lat: p.lat, pile: 1, fan: 0, angle: (p.id % 11) - 5 });
    }
    return out;
  }

  const groups: { albumId: number; lng: number; lat: number; members: FootprintPoint[] }[] = [];
  for (const p of sorted) {
    const g = groups.find(
      (q) => q.albumId === p.album_id && metersBetween(q.lat, q.lng, p.lat, p.lng) <= PILE_RADIUS_M,
    );
    if (!g) {
      groups.push({ albumId: p.album_id, lng: p.lng, lat: p.lat, members: [p] });
      continue;
    }
    g.members.push(p);
    g.lng += (p.lng - g.lng) / g.members.length;
    g.lat += (p.lat - g.lat) / g.members.length;
  }

  for (const g of groups) {
    const n = g.members.length;
    const k = Math.min(n, PILE_MAX_CARDS);
    const picked = new Set<number>();
    for (let i = 0; i < k; i++) picked.add(k === 1 ? 0 : Math.round((i * (n - 1)) / (k - 1)));

    const step = k > 1 ? PILE_FAN_DEG / (k - 1) : 0;
    let fanIdx = 0;
    for (let i = 0; i < n; i++) {
      const m = g.members[i];
      const show = picked.has(i);
      const fan = show ? fanIdx++ : -1;
      // 單張沒得攤，給一點固定的小歪斜就好；一整排全擺正會像證件照
      const angle = n === 1 ? (m.id % 11) - 5 : -PILE_FAN_DEG / 2 + Math.max(fan, 0) * step;
      out.set(m.id, { lng: g.lng, lat: g.lat, pile: n, fan, angle: show ? angle : 0 });
    }
  }
  return out;
}

/**
 * 把軌跡點按「哪一天的第幾段」切成一條條折線。
 * 跨段不可以連線 —— 中間是關機或收不到訊號，接起來會憑空畫出一條沒走過的直線。
 * 資料本來就按時間遞增，這裡只做分組。
 */
function groupLines(points: TrackPoint[] | undefined): [number, number][][] {
  const groups = new Map<string, [number, number][]>();
  for (const p of points || []) {
    const key = segmentKey(p.day_key, p.seg);
    const line = groups.get(key);
    if (line) line.push([p.lng, p.lat]);
    else groups.set(key, [[p.lng, p.lat]]);
  }
  return Array.from(groups.values()).filter((line) => line.length >= 2);
}

export default function FootprintMap({
  points, showPhotos = true, albums, tracks, connectPhotos = false, height = 520, styleUrl, onSelectPhoto,
  editable = false, onEditPoints, onMovePhoto,
  rawTracks, showRawLine = false,
  matchedTracks, showMatchedLine = false,
  showTrackLine = true,
  animateOn = 'track',
  timelineLines,
  focusPoint,
}: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const rafRef = useRef<number | null>(null);
  // 地圖只建立一次，事件處理器會鎖住當時的 props。用 ref 讓它讀得到最新的資料
  const pathRef = useRef<PathNode[]>([]);
  const sortedRef = useRef<FootprintPoint[]>([]);
  const albumsRef = useRef<Album[]>([]);
  // 已經加進地圖的縮圖，以及正在下載中的。避免同一張重複抓，也用來擋住上限
  const thumbLoaded = useRef<Set<string>>(new Set());
  const thumbPending = useRef<Set<string>>(new Set());
  // 編輯模式相關的 ref，同樣是為了讓「只註冊一次」的地圖事件讀得到最新狀態
  const tracksRef = useRef<TrackPoint[]>([]);
  const editingRef = useRef(false);
  // shift 連選的起點（tracks 陣列裡的索引）
  const anchorIdxRef = useRef<number | null>(null);

  const [ready, setReady] = useState(false);
  const [playing, setPlaying] = useState(false);
  // 走到第幾個點（浮點數，小數部分用來內插線段的最後一小截）
  const [head, setHead] = useState(0);
  const [speed, setSpeed] = useState(1);

  const [editing, setEditing] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  // 編輯模式下被選起來的照片。跟軌跡點分開存 —— 兩邊的 id 各自從 1 開始，混在同一個 Set 裡會撞號
  const [selectedPhotoIds, setSelectedPhotoIds] = useState<Set<number>>(new Set());
  const [editBusy, setEditBusy] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  // 依當地時間排序；後端已排過，這裡再保險一次
  const sorted = useMemo(
    () => [...points].sort((a, b) => (a.local_time || '').localeCompare(b.local_time || '')),
    [points],
  );
  const coords = useMemo(() => sorted.map((p) => [p.lng, p.lat] as [number, number]), [sorted]);

  // 只影響 photos 這個 source 怎麼畫。動畫路徑、鏡頭框景、點擊後的資料一律走真實座標
  const piles = useMemo(() => buildPiles(sorted, !editing), [sorted, editing]);

  const trackLines = useMemo(() => groupLines(tracks), [tracks]);

  // 原始軌跡與貼路軌跡的線，分組規則跟 trackLines 一樣
  const rawLines = useMemo(() => groupLines(rawTracks), [rawTracks]);
  const matchedLines = useMemo(() => groupLines(matchedTracks), [matchedTracks]);

  // 動畫沿著哪一份軌跡跑。選了某一份卻還沒載到資料時退回濃縮版 ——
  // 否則切過去的那一瞬間動畫會整個空掉，看起來像壞了
  const animTracks = useMemo(() => {
    if (animateOn === 'raw' && (rawTracks?.length ?? 0) > 0) return rawTracks!;
    if (animateOn === 'matched' && (matchedTracks?.length ?? 0) > 0) return matchedTracks!;
    return tracks || [];
  }, [animateOn, rawTracks, matchedTracks, tracks]);

  // 每個軌跡點在它那一段裡的序號（從 1 起算）。地圖上的號碼跟工具列的訊息共用這一份。
  //
  // 每段各自編號，而不是整份軌跡一路數下去：一天有好幾段的日子會冒出「第 3184 點」
  // 這種記不住的數字，而且能合併的點本來就限定在同一段裡。
  // tracks 已按時間排序，照順序數出來就是行進順序。
  const orderById = useMemo(() => {
    const counters = new Map<string, number>();
    const out = new Map<number, number>();
    for (const p of tracks || []) {
      const key = segmentKey(p.day_key, p.seg);
      const n = (counters.get(key) ?? 0) + 1;
      counters.set(key, n);
      out.set(p.id, n);
    }
    return out;
  }, [tracks]);

  // 停留：匯入時已經把室內亂跳的一串點收成質心上的兩點（進入、離開），
  // 這裡把那個時間區間還原回來，之後用它判斷「照片是不是在同一個地方拍的」。
  const stays = useMemo<Stay[]>(() => {
    const list = tracks || [];
    const out: Stay[] = [];
    for (let i = 0; i < list.length; i++) {
      const sec = list[i].stay_sec ?? 0;
      if (sec <= 0) continue;
      const t0 = Date.parse(list[i].t_utc);
      if (!Number.isFinite(t0)) continue;
      // 離開時刻就是同座標的下一個點。萬一被截斷（LIMIT）就用停留秒數推回去
      const next = list[i + 1];
      const sameSeg = next && next.day_key === list[i].day_key && next.seg === list[i].seg;
      const t1 = sameSeg ? Date.parse(next.t_utc) : t0 + sec * 1000;
      out.push({ t0, t1: Number.isFinite(t1) ? t1 : t0 + sec * 1000, lng: list[i].lng, lat: list[i].lat, sec });
    }
    return out;
  }, [tracks]);

  // 照片依 UTC 排好，用來對照「動畫走到這個時間點時，人在拍哪一張」
  const photoNodes = useMemo(
    () => sorted
      .map((p) => ({ p, t: photoUtcMs(p) }))
      .filter((x): x is { p: FootprintPoint; t: number } => x.t !== null)
      .sort((a, b) => a.t - b.t),
    [sorted],
  );

  // 動畫路徑：軌跡點永遠算數，照片只有在開關打開時才併進來，並且依 UTC 混排。
  // 手機軌跡是密集的實測位置，照片位置是同一段行程的稀疏取樣，兩者本來就該是同一條線。
  const path = useMemo<PathNode[]>(() => {
    // group 為 null 代表「不會自己造成斷點」—— 照片會接上它時間上落在的那一段軌跡
    const raw: { t: number; lng: number; lat: number; group: string | null }[] = [];

    for (const p of animTracks) {
      const t = Date.parse(p.t_utc);
      if (Number.isFinite(t)) raw.push({ t, lng: p.lng, lat: p.lat, group: segmentKey(p.day_key, p.seg) });
    }

    if (connectPhotos) {
      for (const p of sorted) {
        // interpolated 的座標本來就是在前後兩張照片之間拉直線算出來的。
        // 把它當成路徑節點，等於把那條假直線再畫一次。
        if (p.geo_source === 'interpolated') continue;
        const t = photoUtcMs(p);
        if (t === null) continue;
        // 在同一棟大樓裡拍的照片：時間落在停留區間內、位置又跟停留質心重疊，
        // 那個位置停留點已經代表過了。再加一個節點只會讓動畫為了一張照片
        // 往外拉一條線再拉回來 —— 那正是「濃縮成一個點」要消掉的東西。
        // 兩個條件都成立才收，只有時間對上但位置差很遠時是真的移動過，要留著。
        const insideStay = stays.some(
          (s) => t >= s.t0 && t <= s.t1 && metersBetween(p.lat, p.lng, s.lat, s.lng) <= STAY_SNAP_M,
        );
        if (insideStay) continue;
        raw.push({ t, lng: p.lng, lat: p.lat, group: null });
      }
    }

    raw.sort((a, b) => a.t - b.t);

    // 段別要往後傳遞，不能被中間的照片沖掉。照片剛好落在兩段軌跡之間的錄製空隙時，
    // 若只比對「前一個節點」，兩邊都會因為照片的段別是 null 而比不出換段，
    // 結果那張照片就把兩段本來該斷開的軌跡接成一條沒走過的直線。
    const out: PathNode[] = [];
    let lastGroup: string | null = null;
    for (let i = 0; i < raw.length; i++) {
      const n = raw[i];
      const prev = i > 0 ? raw[i - 1] : null;
      const segChanged = n.group !== null && lastGroup !== null && n.group !== lastGroup;
      if (n.group !== null) lastGroup = n.group;
      const tooFar = prev !== null && n.t - prev.t > MAX_GAP_MS;
      out.push({
        t: n.t, lng: n.lng, lat: n.lat,
        breakBefore: prev !== null && (segChanged || tooFar),
        // 照片節點沿用它落在的那一段的交通工具，不然畫面上的圖示會一路閃爍
        segKey: n.group ?? lastGroup,
      });
    }
    return out;
  }, [animTracks, sorted, connectPhotos, stays]);

  const maxIndex = Math.max(path.length - 1, 0);
  // head 是動畫算出來的浮點數，會被拿來當陣列索引，所以夾在合法範圍內再用。
  // 少了下界的話，播放起頭那一瞬間的負值會變成 path[-1]
  const headIndex = Number.isFinite(head)
    ? Math.min(Math.max(Math.floor(head), 0), maxIndex)
    : 0;
  const headTime = path[headIndex]?.t ?? null;

  // 動畫走到哪個時間，就顯示那個時間之前最後拍的那張
  const current = useMemo(() => {
    if (headTime === null) return undefined;
    let found: FootprintPoint | undefined;
    for (const x of photoNodes) {
      if (x.t > headTime) break;
      found = x.p;
    }
    return found;
  }, [photoNodes, headTime]);

  useEffect(() => { pathRef.current = path; }, [path]);
  useEffect(() => { sortedRef.current = sorted; }, [sorted]);
  useEffect(() => { albumsRef.current = albums || []; }, [albums]);
  useEffect(() => { tracksRef.current = tracks || []; }, [tracks]);
  useEffect(() => { editingRef.current = editing; }, [editing]);

  // --- 建立地圖 ---
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const map = new MapLibreMap({
      container: containerRef.current,
      style: styleUrl || DEFAULT_STYLE,
      center: coords[0] || [121.5, 25.04],
      zoom: coords.length ? 9 : 6,
      attributionControl: { compact: true },
    });
    map.addControl(new NavigationControl({ showCompass: false }), 'top-right');
    mapRef.current = map;
    // 底圖或圖磚載入失敗時要留下線索 —— 沒有這個 handler 時地圖只會靜靜地一片空白
    map.on('error', (e: any) => console.error('[FootprintMap] 地圖錯誤:', e?.error?.message || e));

    map.on('load', () => {
      // Google 時間軸的紀念層。第一個加，所以墊在所有東西的最底下 ——
      // 它是背景中的背景：十二年的足跡疊起來，常走的路自然變濃，
      // 但今天要看的是上面那幾層
      map.addSource('timeline-track', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });
      map.addLayer({
        id: 'timeline-track-line',
        type: 'line',
        source: 'timeline-track',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        // 桃紅。原本是灰藍 #64748b，跟 OpenFreeMap 底圖的道路與行政區界幾乎同色，
        // 十二年的足跡疊上去看起來只是底圖髒了。桃紅在這張底圖上沒有任何東西在用，
        // 也跟另外三層（綠／橘／紫）分得開。
        // 仍然刻意細而淡：單獨一條不搶戲，重疊多的地方自己會浮出來
        paint: { 'line-color': '#db2777', 'line-width': 1.1, 'line-opacity': 0.45 },
      });

      // 原始軌跡的對照底線，排在 gps-track 之前才會墊在它下面 ——
      // 要看的是「濃縮後的線偏離原始路徑多少」，濃縮後那條必須疊在上面
      map.addSource('raw-track', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });
      map.addLayer({
        id: 'raw-track-line',
        type: 'line',
        source: 'raw-track',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        // 橘色虛線：跟綠色實線的軌跡明顯區隔，一眼看得出哪條是原始的
        paint: {
          'line-color': '#f97316',
          'line-width': 1.5,
          'line-opacity': 0.7,
          'line-dasharray': [2, 1.5],
        },
      });

      // 貼路軌跡。也墊在 gps-track 底下，一樣是為了對照 ——
      // 要看的是原本的線偏離道路多少，原本那條得在上面
      map.addSource('matched-track', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });
      map.addLayer({
        id: 'matched-track-line',
        type: 'line',
        source: 'matched-track',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        // 紫色粗實線：畫的是道路本身，比原始軌跡的虛線更該被看見
        paint: {
          'line-color': '#7c3aed',
          'line-width': 3.5,
          'line-opacity': 0.75,
        },
      });

      // 先加軌跡，才會壓在照片路線與標記底下 —— 它是背景，不是主角
      map.addSource('gps-track', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });
      map.addLayer({
        id: 'gps-track-line',
        type: 'line',
        source: 'gps-track',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#16a34a', 'line-width': 2.5, 'line-opacity': 0.45 },
      });

      // 停留點：待越久畫越大。沒有這一層的話，濃縮完的軌跡看起來只是一條線
      // 中間莫名其妙頓住，看不出「這裡待了三個小時」
      map.addSource('stays', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      map.addLayer({
        id: 'stay-points',
        type: 'circle',
        source: 'stays',
        paint: {
          'circle-radius': ['step', ['get', 'sec'], 7, 1800, 10, 7200, 14],
          'circle-color': '#16a34a',
          'circle-opacity': 0.22,
          'circle-stroke-width': 2,
          'circle-stroke-color': '#16a34a',
          'circle-stroke-opacity': 0.7,
        },
      });
      map.addLayer({
        id: 'stay-label',
        type: 'symbol',
        source: 'stays',
        // 短暫的停留不標字，否則整張地圖都是標籤
        filter: ['>=', ['get', 'sec'], 1800],
        layout: {
          'text-field': ['get', 'label'],
          'text-font': ['Noto Sans Bold'],
          'text-size': 11,
          'text-offset': [0, 1.4],
          'text-allow-overlap': false,
        },
        paint: { 'text-color': '#15803d', 'text-halo-color': '#ffffff', 'text-halo-width': 1.5 },
      });

      map.addSource('route', {
        type: 'geojson',
        data: { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [] } },
      });
      // 路線畫兩層：底下較寬的淡色當光暈，上面實線當主體
      map.addLayer({
        id: 'route-glow',
        type: 'line',
        source: 'route',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#2563eb', 'line-width': 10, 'line-opacity': 0.18, 'line-blur': 6 },
      });
      map.addLayer({
        id: 'route-line',
        type: 'line',
        source: 'route',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#2563eb', 'line-width': 3 },
      });

      map.addSource('photos', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
        cluster: true,
        // 泡泡比原本的圓點大得多，聚合半徑跟著放大，否則縮小時會擠成一片疊圖
        clusterRadius: 70,
        // 一路聚到 z17 才散開，散開之後由 buildPiles 的扇形接手。
        // 停在 z15 的話 z16~17 這一段既沒有叢集、又還沒近到分得開，會糊成一團
        clusterMaxZoom: 17,
        clusterProperties: {
          // 整叢是不是同一本相簿：min === max 就是。
          // 沒有「集合」型的累加器可用，只好靠兩端夾出來
          aMin: ['min', ['get', 'album_id']],
          aMax: ['max', ['get', 'album_id']],
          // 這一叢的代表照（見 REP_ID_MOD）
          rep: ['max', ['get', 'rep']],
        },
      });

      // 泡泡的大小與傾角，單張與整叢共用同一組，兩層看起來才是同一種東西。
      // interpolate 在頭尾停靠點之外會夾住，這就是「不能大過頭」的上下限
      const bubbleSize: any = [
        'interpolate', ['linear'], ['zoom'],
        9, 0.62,
        13, 0.95,
        16, 1.25,
        18, 1.5,
      ];
      // 每個泡泡歪一點點，角度由 rep 決定（單張與叢集都有這個屬性）。
      // 全部擺正會像一排證件照，歪一點才活
      const bubbleTilt: any = ['-', ['%', ['get', 'rep'], 11], 5];
      const bubbleLayout = {
        'icon-size': bubbleSize,
        // 尾巴尖端要落在座標上：圖的底部往下推一個 BUBBLE_PAD（陰影留白）補回來。
        // icon-offset 會跟著 icon-size 一起縮放，所以放大時也對得準
        'icon-anchor': 'bottom' as const,
        'icon-offset': [0, BUBBLE_PAD] as [number, number],
        'icon-rotate': bubbleTilt,
        // 傾角是畫面上的裝飾，不該跟著地圖轉
        'icon-rotation-alignment': 'viewport' as const,
        // 照片本來就常常擠在一起，讓它們互相遮擋比整片消失好
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
      };

      // 同一景點常常拍幾十張，不聚合會疊成一坨。
      // 這個圓點只是泡泡還沒載到時的底 —— 數量改由右上角的徽章顯示
      map.addLayer({
        id: 'photo-clusters',
        type: 'circle',
        source: 'photos',
        filter: ['has', 'point_count'],
        paint: {
          'circle-color': '#2563eb',
          'circle-opacity': 0.9,
          'circle-radius': ['step', ['get', 'point_count'], 8, 10, 10, 50, 12],
          'circle-stroke-width': 2,
          'circle-stroke-color': '#ffffff',
        },
      });

      // 單點一律同一個樣子。以前依 geo_source 分成五種顏色與透明度，拿掉了：
      // 那需要一整排圖例才看得懂，而多數點上面本來就疊著縮圖，顏色根本露不出來。
      // 「這張照片的位置是量到的還是推出來的」點開它就會說（見底下的播放列）。
      map.addLayer({
        id: 'photo-points',
        type: 'circle',
        source: 'photos',
        // fan < 0 是被同一坨蓋掉、不畫的那幾張。它們跟同坨的其他人同座標，
        // 畫出來只是把同一個圓點重疊描好幾次
        filter: ['all', ['!', ['has', 'point_count']], ['>=', ['get', 'fan'], 0]],
        paint: {
          'circle-radius': 7,
          'circle-color': '#2563eb',
          'circle-opacity': 1,
          'circle-stroke-width': 2,
          'circle-stroke-color': '#ffffff',
        },
      });

      // 泡泡疊在圓點之上。圓點那兩層留著當底 —— 圖還沒載到（或載失敗）時
      // 至少還看得到位置，不會整個標記消失。
      //
      // 單張與叢集分兩層而不是靠 icon-image 一條 case 判完，是為了點擊：
      // 點單張要開燈箱、點叢集要展開，兩件事得掛在不同的 layer 上
      map.addLayer({
        id: 'photo-thumbs',
        type: 'symbol',
        source: 'photos',
        filter: ['all', ['!', ['has', 'point_count']], ['>=', ['get', 'fan'], 0]],
        layout: {
          ...bubbleLayout,
          'icon-image': ['concat', 'photo-', ['to-string', ['get', 'id']]],
          // 擠在一起的那幾張已經被釘在同一個點上，角度由 buildPiles 排成扇形。
          // 旋轉中心就是 icon-anchor（尾巴尖端），所以攤開來自然是握著一手牌的樣子
          'icon-rotate': ['get', 'angle'],
          // 牌面由左到右依序疊上去，不然每次重繪的前後關係都可能不一樣
          'symbol-sort-key': ['get', 'fan'],
        },
      });

      // 整叢的代表照：全部同一本相簿就用那本的封面（album-<id>，載不到封面時
      // 由 styleimagemissing 那邊退回隨機一張），否則用這一區隨機抽中的那張照片
      map.addLayer({
        id: 'photo-cluster-thumbs',
        type: 'symbol',
        source: 'photos',
        filter: ['has', 'point_count'],
        layout: {
          ...bubbleLayout,
          'icon-image': [
            'case',
            ['==', ['get', 'aMin'], ['get', 'aMax']],
            ['concat', 'album-', ['to-string', ['get', 'aMin']]],
            ['concat', 'photo-', ['to-string', ['%', ['get', 'rep'], REP_ID_MOD]]],
          ],
        },
      });

      // 張數徽章，貼在泡泡的右上角。
      //
      // 不能畫進貼圖裡：同一張代表照會出現在張數不同的叢集上，貼圖是共用的。
      // 位置只好用 translate 手算 —— 泡泡以尾巴尖端為錨，本體頂緣在
      // -(BUBBLE_H + BUBBLE_TAIL) × icon-size，右緣在 BUBBLE_W/2 × icon-size，
      // 下面每個縮放停靠點就是把這兩個數字乘出來的（跟 bubbleSize 同一組 zoom）
      const badgeShift: any = [
        'interpolate', ['linear'], ['zoom'],
        9, [22, -57],
        13, [34, -87],
        16, [45, -115],
        18, [54, -138],
      ];
      // 徽章要蓋兩種情況：maplibre 聚出來的叢集，以及放大之後攤成扇形的那一坨。
      // 一坨只掛在第一張牌上，否則五張牌會冒出五個一模一樣的徽章
      const badgeFilter: any = [
        'any',
        ['has', 'point_count'],
        ['all', ['==', ['get', 'fan'], 0], ['>', ['get', 'pile'], 1]],
      ];
      const badgeText: any = [
        'case',
        ['has', 'point_count'], ['get', 'point_count_abbreviated'],
        ['to-string', ['get', 'pile']],
      ];
      map.addLayer({
        id: 'photo-count-badge',
        type: 'circle',
        source: 'photos',
        filter: badgeFilter,
        paint: {
          'circle-color': '#f43f5e',
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 9, 9, 13, 12, 16, 15, 18, 17],
          'circle-stroke-width': 2.5,
          'circle-stroke-color': '#ffffff',
          'circle-translate': badgeShift,
          // 泡泡是畫面對齊的，徽章要跟著它，不能跟著地圖轉
          'circle-translate-anchor': 'viewport',
        },
      });
      map.addLayer({
        id: 'photo-count-label',
        type: 'symbol',
        source: 'photos',
        filter: badgeFilter,
        // 必須指定 OpenFreeMap 實際提供的字型；用 maplibre 預設的
        // "Open Sans Regular,Arial Unicode MS Regular" 會 404 而退化成本地字型
        layout: {
          'text-field': badgeText,
          'text-font': ['Noto Sans Bold'],
          'text-size': ['interpolate', ['linear'], ['zoom'], 9, 10, 13, 12, 16, 14, 18, 16],
          'text-allow-overlap': true,
          'text-ignore-placement': true,
        },
        paint: {
          'text-color': '#ffffff',
          'text-translate': badgeShift,
          'text-translate-anchor': 'viewport',
        },
      });

      // 移動圖示。畫在最上層，它是動畫的主角。
      // 只有一個圖示，不隨交通工具改變 —— 理由見 vehicles.ts 開頭
      const moverImg = emojiImage(MOVER_EMOJI);
      if (moverImg && !map.hasImage('mover')) map.addImage('mover', moverImg);
      map.addSource('vehicle', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      map.addLayer({
        id: 'vehicle-marker',
        type: 'symbol',
        source: 'vehicle',
        layout: {
          'icon-image': 'mover',
          'icon-size': 0.72,
          'icon-allow-overlap': true,
          'icon-ignore-placement': true,
          // 刻意不隨行進方向旋轉：飛碟沒有明確的頭尾，轉了只是抖動
          'icon-rotation-alignment': 'viewport',
        },
      });

      // 編輯模式的軌跡點。放在最上層 —— 縮圖比它大得多，壓在底下會點不到。
      // 只有進編輯模式才會有資料，平常這一層是空的
      map.addSource('track-points', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      map.addLayer({
        id: 'track-point-dots',
        type: 'circle',
        source: 'track-points',
        paint: {
          'circle-radius': ['case', ['get', 'selected'], 9, ['case', ['get', 'stay'], 7, 5]],
          'circle-color': ['case', ['get', 'selected'], '#ef4444', '#0f766e'],
          'circle-opacity': 0.9,
          'circle-stroke-width': 2,
          'circle-stroke-color': '#ffffff',
        },
      });

      // 點號。要一個一個核對「合併哪幾點」時，光看一堆長得一樣的圓點是數不出來的。
      // 刻意不開 text-allow-overlap：軌跡動輒上千點，全部標出來會糊成一片黑，
      // 交給 maplibre 的碰撞偵測自動疏密 —— 放大才看得到每一點的號碼。
      map.addLayer({
        id: 'track-point-labels',
        type: 'symbol',
        source: 'track-points',
        layout: {
          'text-field': ['get', 'label'],
          'text-font': ['Noto Sans Bold'],
          'text-size': 11,
          'text-anchor': 'bottom',
          'text-offset': [0, -0.7],
          // 數字越小越優先擺放：選起來的點一定要看得到號碼，
          // 否則使用者沒辦法確認自己選的是不是打算選的那幾點
          'symbol-sort-key': ['case', ['get', 'selected'], 0, 1],
        },
        paint: {
          'text-color': ['case', ['get', 'selected'], '#b91c1c', '#0f766e'],
          'text-halo-color': '#ffffff',
          'text-halo-width': 1.5,
        },
      });

      // 被選起來的照片。畫成一圈紅框套在縮圖外面，而不是改圓點的顏色 ——
      // 縮圖蓋在圓點上，改底下那層根本看不到。
      // filter 預設不匹配任何東西，選取變動時才由下面的 effect 換掉
      map.addLayer({
        id: 'photo-selected-ring',
        type: 'circle',
        source: 'photos',
        filter: ['all', ['!', ['has', 'point_count']], ['in', ['get', 'id'], ['literal', []]]],
        paint: {
          // 跟著縮圖一起縮放，才會一直是「框住那張照片」而不是框住空氣
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 20, 14, 34, 17, 50],
          'circle-opacity': 0,
          'circle-stroke-width': 3,
          'circle-stroke-color': '#ef4444',
        },
      });

      map.on('click', 'track-point-dots', (e: MapLayerMouseEvent) => {
        const id = Number(e.features?.[0]?.properties?.id);
        if (!Number.isFinite(id)) return;
        const idx = tracksRef.current.findIndex((p) => p.id === id);
        const shift = (e.originalEvent as MouseEvent | undefined)?.shiftKey === true;

        setEditError(null);
        setSelectedIds((prev) => {
          const next = new Set(prev);
          if (shift && anchorIdxRef.current !== null && idx >= 0) {
            // 連選：一個一個點五十個點是不可能的操作
            const lo = Math.min(anchorIdxRef.current, idx);
            const hi = Math.max(anchorIdxRef.current, idx);
            for (let i = lo; i <= hi; i++) next.add(tracksRef.current[i].id);
          } else if (next.has(id)) {
            next.delete(id);
          } else {
            next.add(id);
          }
          return next;
        });
        // shift 連選不移動錨點，才能反覆調整同一段的範圍
        if (!shift && idx >= 0) anchorIdxRef.current = idx;
      });
      map.on('mouseenter', 'track-point-dots', () => { map.getCanvas().style.cursor = 'pointer'; });
      map.on('mouseleave', 'track-point-dots', () => { map.getCanvas().style.cursor = ''; });

      /**
       * icon-image 的名字 → 要拿哪張圖來畫。
       *
       * photo-<id>：那張照片本身。
       * album-<id>：那本相簿的封面；沒設封面就從這本相簿在地圖上的照片裡隨機挑一張。
       *   挑完就進了 maplibre 的圖庫、整個 session 不會再抽，所以不會一直跳。
       */
      const bubbleSourceFor = (imageId: string): string | null => {
        if (imageId.startsWith('photo-')) {
          const photoId = Number(imageId.slice('photo-'.length));
          return sortedRef.current.find((p) => p.id === photoId)?.url ?? null;
        }
        const albumId = Number(imageId.slice('album-'.length));
        const cover = albumsRef.current.find((a) => a.id === albumId)?.cover_photo_url;
        if (cover) return cover;
        const pool = sortedRef.current.filter((p) => p.album_id === albumId);
        if (pool.length === 0) return null;
        return pool[Math.floor(Math.random() * pool.length)].url;
      };

      // 縮圖採「用到才載」：maplibre 找不到 icon-image 就會發這個事件。
      // 一次把整個相簿的縮圖抓下來是白費頻寬 —— 聚合起來的照片只會畫出一張代表。
      map.on('styleimagemissing', (e: { id: string }) => {
        const id = e.id;
        if (!id.startsWith('photo-') && !id.startsWith('album-')) return;
        if (thumbPending.current.has(id) || thumbLoaded.current.size >= MAX_THUMBS) return;
        const url = bubbleSourceFor(id);
        if (!url) return;

        // 外圈顏色只求穩定與分散，用 id 的數字部分取模就夠
        const ring = BUBBLE_RINGS[Math.abs(Number(id.slice(id.indexOf('-') + 1)) || 0) % BUBBLE_RINGS.length];

        thumbPending.current.add(id);
        loadBubble(url, ring)
          .then((data) => {
            // 這中間地圖可能已經被 remove，或別的路徑已經加過同一張
            if (!mapRef.current || mapRef.current.hasImage(id)) return;
            mapRef.current.addImage(id, data, { pixelRatio: BUBBLE_PR });
            thumbLoaded.current.add(id);
          })
          .catch(() => { /* 載不到就維持圓點，不需要打擾使用者 */ })
          .finally(() => { thumbPending.current.delete(id); });
      });

      // 點叢集就展開。泡泡那一層畫得比底下的圓點大，只掛圓點的話點到泡泡不會有反應
      const onClusterClick = (e: MapLayerMouseEvent) => {
        const f = map.queryRenderedFeatures(e.point, {
          layers: ['photo-clusters', 'photo-cluster-thumbs'],
        })[0];
        const clusterId = f?.properties?.cluster_id;
        const src = map.getSource('photos') as GeoJSONSource;
        if (clusterId == null || !src) return;
        src.getClusterExpansionZoom(clusterId).then((zoom: number) => {
          map.easeTo({ center: (f.geometry as any).coordinates, zoom });
        }).catch(() => { /* 叢集已不存在，忽略 */ });
      };
      map.on('click', 'photo-clusters', onClusterClick);
      map.on('click', 'photo-cluster-thumbs', onClusterClick);

      const onPhotoClick = (e: MapLayerMouseEvent) => {
        const f = e.features?.[0];
        if (!f) return;
        const id = Number(f.properties?.id);

        // 編輯模式下點照片是「選起來」，不是開燈箱
        if (editingRef.current) {
          if (!Number.isFinite(id)) return;
          // 軌跡點那一層畫在縮圖上面，同一下點擊兩邊的 handler 都會收到。
          // 讓軌跡點優先，否則想選底下的軌跡點時會連照片一起選到
          if (map.queryRenderedFeatures(e.point, { layers: ['track-point-dots'] }).length > 0) return;
          setEditError(null);
          setSelectedPhotoIds((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
          });
          return;
        }

        const point = sortedRef.current.find((p) => p.id === id);
        if (point) {
          // 路徑節點不再等於照片，得用時間找到動畫上對應的位置
          const t = photoUtcMs(point);
          if (t !== null && pathRef.current.length > 0) {
            const idx = pathRef.current.findIndex((n) => n.t >= t);
            setHead(idx < 0 ? pathRef.current.length - 1 : idx);
          }
          onSelectPhoto?.(point);
        }
      };
      // 泡泡比底下的圓點大，只掛在圓點上的話點到泡泡邊緣會沒有反應
      map.on('click', 'photo-points', onPhotoClick);
      map.on('click', 'photo-thumbs', onPhotoClick);

      for (const layer of ['photo-points', 'photo-thumbs', 'photo-clusters', 'photo-cluster-thumbs']) {
        map.on('mouseenter', layer, () => { map.getCanvas().style.cursor = 'pointer'; });
        map.on('mouseleave', layer, () => { map.getCanvas().style.cursor = ''; });
      }

      setReady(true);
    });

    return () => {
      map.remove();
      mapRef.current = null;
      setReady(false);
    };
    // 只建立一次；資料變動由下面的 effect 更新
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [styleUrl]);

  // --- 資料變動時重設並套用 ---
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;

    setPlaying(false);

    const src = map.getSource('photos') as GeoJSONSource | undefined;
    src?.setData({
      type: 'FeatureCollection',
      features: (showPhotos ? sorted : []).map((p) => {
        // 落單的照片（理論上不會有，piles 是照 sorted 建的）就照原座標畫
        const slot = piles.get(p.id) ?? { lng: p.lng, lat: p.lat, pile: 1, fan: 0, angle: 0 };
        return {
          type: 'Feature' as const,
          properties: {
            id: p.id,
            geo_source: p.geo_source,
            title: p.title,
            album_id: p.album_id,
            // 每次資料換掉就重抽一次代表照（也順便換一輪叢集泡泡的傾角）。
            // id 超過 REP_ID_MOD 的話低位會溢位、代表照就抽錯 —— 現實中差了好幾個數量級
            rep: Math.floor(Math.random() * REP_RAND_MAX) * REP_ID_MOD + (p.id % REP_ID_MOD),
            pile: slot.pile,
            fan: slot.fan,
            angle: slot.angle,
          },
          // 同一坨的照片一律釘在該坨的質心上，不是各自的真實座標
          geometry: { type: 'Point' as const, coordinates: [slot.lng, slot.lat] },
        };
      }),
    });

  }, [sorted, coords, piles, showPhotos, ready]);

  // 關掉照片時把照片的選取一起放掉。留著的話編輯面板會說「已選 3 張」，
  // 但畫面上一張都看不到，也點不到任何一張來取消
  useEffect(() => {
    if (!showPhotos) setSelectedPhotoIds(new Set());
  }, [showPhotos]);

  // 路徑換了就把播放頭移到終點，維持「預設看到完整路線」的樣子
  useEffect(() => {
    setHead(path.length > 0 ? path.length - 1 : 0);
    setPlaying(false);
  }, [path]);

  // --- 軌跡 ---
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const src = map.getSource('gps-track') as GeoJSONSource | undefined;
    src?.setData({
      type: 'FeatureCollection',
      features: (showTrackLine ? trackLines : []).map((line) => ({
        type: 'Feature',
        properties: {},
        geometry: { type: 'LineString', coordinates: line },
      })),
    });
  }, [trackLines, showTrackLine, ready]);

  // --- Google 時間軸紀念層 ---
  // 線已經在頁面那邊切好了，這裡不做任何判斷 —— 沒傳就是不畫
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const src = map.getSource('timeline-track') as GeoJSONSource | undefined;
    src?.setData({
      type: 'FeatureCollection',
      features: (timelineLines ?? []).map((line) => ({
        type: 'Feature',
        properties: {},
        geometry: { type: 'LineString', coordinates: line },
      })),
    });
  }, [timelineLines, ready]);

  // --- 原始軌跡對照底線 ---
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const src = map.getSource('raw-track') as GeoJSONSource | undefined;
    src?.setData({
      type: 'FeatureCollection',
      features: (showRawLine ? rawLines : []).map((line) => ({
        type: 'Feature',
        properties: {},
        geometry: { type: 'LineString', coordinates: line },
      })),
    });
  }, [rawLines, showRawLine, ready]);

  // --- 貼路軌跡 ---
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const src = map.getSource('matched-track') as GeoJSONSource | undefined;
    src?.setData({
      type: 'FeatureCollection',
      features: (showMatchedLine ? matchedLines : []).map((line) => ({
        type: 'Feature',
        properties: {},
        geometry: { type: 'LineString', coordinates: line },
      })),
    });
  }, [matchedLines, showMatchedLine, ready]);

  // --- 停留點 ---
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const src = map.getSource('stays') as GeoJSONSource | undefined;
    src?.setData({
      type: 'FeatureCollection',
      // 停留圈是綠線的註解（「這裡的線頓住是因為待了三小時」），
      // 綠線關掉時單獨留著只會變成一堆沒有來由的圈
      features: (showTrackLine ? stays : []).map((s) => ({
        type: 'Feature',
        properties: { sec: s.sec, label: humanDuration(s.sec) },
        geometry: { type: 'Point', coordinates: [s.lng, s.lat] },
      })),
    });
  }, [stays, showTrackLine, ready]);

  // --- 編輯模式的軌跡點 ---
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const src = map.getSource('track-points') as GeoJSONSource | undefined;
    if (!src) return;
    src.setData({
      type: 'FeatureCollection',
      features: editing
        ? (tracks || []).map((p) => ({
          type: 'Feature' as const,
          properties: {
            id: p.id,
            selected: selectedIds.has(p.id),
            stay: (p.stay_sec ?? 0) > 0,
            label: String(orderById.get(p.id) ?? ''),
          },
          geometry: { type: 'Point' as const, coordinates: [p.lng, p.lat] },
        }))
        : [],
    });
  }, [editing, selectedIds, tracks, orderById, ready]);

  // --- 被選起來的照片 ---
  // 只換 filter，不動 photos 這個 source —— 它開了 cluster，重設資料會讓
  // 整個聚合重算，每點一下照片就閃一次
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    if (!map.getLayer('photo-selected-ring')) return;
    const ids = editing ? Array.from(selectedPhotoIds) : [];
    map.setFilter('photo-selected-ring', [
      'all', ['!', ['has', 'point_count']], ['in', ['get', 'id'], ['literal', ids]],
    ]);
  }, [editing, selectedPhotoIds, ready]);

  // --- 視野 ---
  // 照片與軌跡分開載入，兩邊都要納入，否則先到的那一批會把視野定死
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;

    // 只看一天：直接停在起點，不框全部。理由見 focusPoint 的說明
    if (focusPoint) {
      map.easeTo({ center: focusPoint, zoom: FOCUS_ZOOM, duration: 600 });
      return;
    }

    // 只框看得到的線。綠線關掉、只留貼路時還照 trackLines 框的話，
    // 鏡頭會停在一個畫面上什麼都沒有的範圍
    const lines = showTrackLine ? trackLines : showMatchedLine ? matchedLines : trackLines;

    // Google 足跡也要框進來。以前漏掉它，結果只有那一層有資料的年份（2014 年那些
    // 早於 GPS 軌跡的日子）畫得出線，鏡頭卻不會過去 —— 線確實畫了，只是在畫面外。
    // timelineLines 沒開的時候頁面傳 undefined，跟上面「只框看得到的」一致。
    //
    // 不用 flat()：不篩日期時這一層是十二年、幾十萬個點，攤平只是白配一個大陣列
    let bounds: LngLatBounds | null = null;
    const extend = (c: [number, number]) => {
      bounds = bounds === null ? new LngLatBounds(c, c) : bounds.extend(c);
    };
    for (const c of coords) extend(c);
    for (const line of lines) for (const c of line) extend(c);
    for (const line of timelineLines ?? []) for (const c of line) extend(c);
    if (bounds === null) return;

    map.fitBounds(bounds, { padding: 60, maxZoom: 13, duration: 600 });
  }, [coords, trackLines, matchedLines, timelineLines, showTrackLine, showMatchedLine, focusPoint, ready]);

  // --- 路線隨 head 生長 ---
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const src = map.getSource('route') as GeoJSONSource | undefined;
    if (!src) return;

    const whole = Math.floor(head);
    const frac = head - whole;

    // 走過的部分要切成多條線 —— 遇到斷點（換軌跡段、或隔太久）就另起一條，
    // 用單一 LineString 會把中間那段沒走過的路憑空連起來
    const lines: [number, number][][] = [];
    let cur: [number, number][] = [];
    for (let i = 0; i <= whole && i < path.length; i++) {
      if (path[i].breakBefore && cur.length > 0) {
        lines.push(cur);
        cur = [];
      }
      cur.push([path[i].lng, path[i].lat]);
    }
    // 內插出最後一小截，線條才會平滑前進而不是一格一格跳。
    // 下一個節點如果是斷點就不能內插，那一段本來就沒有連線
    const a = path[whole];
    const b = path[whole + 1];
    if (frac > 0 && a && b && !b.breakBefore) {
      cur.push([a.lng + (b.lng - a.lng) * frac, a.lat + (b.lat - a.lat) * frac]);
    }
    if (cur.length > 0) lines.push(cur);

    src.setData({
      type: 'FeatureCollection',
      features: lines
        .filter((l) => l.length >= 2)
        .map((l) => ({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: l } })),
    });

    // 飛碟停在路線頭端，跟線一起前進
    const vehicleSrc = map.getSource('vehicle') as GeoJSONSource | undefined;
    const headPos = cur.length > 0 ? cur[cur.length - 1] : null;
    if (vehicleSrc) {
      vehicleSrc.setData({
        type: 'FeatureCollection',
        features: headPos ? [{
          type: 'Feature',
          properties: {},
          geometry: { type: 'Point', coordinates: headPos },
        }] : [],
      });
    }

    /*
     * 跟拍：每一幀都把鏡頭對到飛碟目前的位置，讓它固定在畫面正中央。
     *
     * 用 setCenter 而不是 easeTo —— easeTo 是「用 N 毫秒滑過去」，每幀都下一次
     * 新的 easeTo 會不斷打斷上一次的補間，鏡頭永遠追在飛碟後面，飛碟就會飄到
     * 畫面邊緣（原本每 600ms 才對準一次節點，正是這個症狀）。head 本身已經是
     * 連續內插出來的，直接設中心就已經是平滑的移動。
     */
    if (playing && headPos) {
      map.setCenter(headPos as [number, number]);
    }
  }, [head, path, ready, playing]);

  // --- 播放迴圈 ---
  useEffect(() => {
    if (!playing) {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      return;
    }
    // 節點數會從幾張照片到幾千個軌跡點都有，用固定的「每秒幾個節點」會讓
    // 軌跡慢到看不完。改成不管幾個點，1x 都大約 25 秒跑完整條。
    const nodesPerSec = Math.max(1, path.length / 25) * speed;
    let last = performance.now();
    const tick = (now: number) => {
      // requestAnimationFrame 給的是「這一幀開始」的時間，可能早於上面那個
      // 在同一幀的 JS 裡取的 performance.now()，第一次 tick 的 dt 會是負的
      const dt = Math.max(0, (now - last) / 1000);
      last = now;
      setHead((h) => {
        const next = h + dt * nodesPerSec;
        if (next >= path.length - 1) {
          setPlaying(false);
          return Math.max(path.length - 1, 0);
        }
        return next;
      });
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    };
  }, [playing, speed, path.length]);

  const replay = useCallback(() => {
    setHead(0);
    setPlaying(true);
  }, []);

  // --- 軌跡點編修 ---

  const selectedPoints = useMemo(
    () => (tracks || []).filter((p) => selectedIds.has(p.id)),
    [tracks, selectedIds],
  );

  const selectedPhotos = useMemo(
    () => sorted.filter((p) => selectedPhotoIds.has(p.id)),
    [sorted, selectedPhotoIds],
  );

  const clearSelection = useCallback(() => {
    setSelectedIds(new Set());
    setSelectedPhotoIds(new Set());
    anchorIdxRef.current = null;
    setEditError(null);
  }, []);

  const enterEdit = useCallback(() => {
    setPlaying(false);
    clearSelection();
    setEditing(true);
  }, [clearSelection]);

  const exitEdit = useCallback(() => {
    setEditing(false);
    clearSelection();
  }, [clearSelection]);

  const submitEdits = useCallback(async (edits: TrackPointEdit[]) => {
    if (!onEditPoints || edits.length === 0) return;
    setEditBusy(true);
    setEditError(null);
    try {
      const ok = await onEditPoints(edits);
      // 失敗時保留選取，使用者才能直接重試而不用重選一次
      if (ok) clearSelection();
      else setEditError('儲存失敗，請再試一次');
    } finally {
      setEditBusy(false);
    }
  }, [onEditPoints, clearSelection]);

  const deleteSelected = useCallback(() => {
    if (selectedPoints.length === 0) return;
    if (!window.confirm(`確定刪除 ${selectedPoints.length} 個軌跡點？`)) return;
    // 後端是逐日改的（day_key 同時當作刪除的防護），跨日的選取要拆成多筆
    const byDay = new Map<string, number[]>();
    for (const p of selectedPoints) {
      const ids = byDay.get(p.day_key);
      if (ids) ids.push(p.id);
      else byDay.set(p.day_key, [p.id]);
    }
    void submitEdits(Array.from(byDay, ([dayKey, deleteIds]) => ({ dayKey, deleteIds, insert: [] })));
  }, [selectedPoints, submitEdits]);

  const mergeSelected = useCallback(() => {
    if (selectedPoints.length < 2) {
      setEditError('至少要選兩個點才能合併');
      return;
    }
    const { day_key: dayKey, seg } = selectedPoints[0];
    if (selectedPoints.some((p) => p.day_key !== dayKey || p.seg !== seg)) {
      setEditError('合併的點必須在同一天的同一段軌跡內');
      return;
    }

    const times = selectedPoints.map((p) => Date.parse(p.t_utc)).filter(Number.isFinite);
    if (times.length === 0) { setEditError('選到的點沒有有效時間'); return; }
    const t0 = Math.min(...times);
    const t1 = Math.max(...times);

    // 把時間區間內的點全部吸收，不只刪選到的 —— 中間漏掉幾個沒選到的點，
    // 合併完那裡還是一團亂跳，等於沒合併
    const absorbed = (tracks || [])
      .filter((p) => {
        if (p.day_key !== dayKey || p.seg !== seg) return false;
        const t = Date.parse(p.t_utc);
        return Number.isFinite(t) && t >= t0 && t <= t1;
      })
      .sort((a, b) => Date.parse(a.t_utc) - Date.parse(b.t_utc));
    if (absorbed.length < 2) { setEditError('沒有可以合併的點'); return; }

    const lat = absorbed.reduce((s, p) => s + p.lat, 0) / absorbed.length;
    const lng = absorbed.reduce((s, p) => s + p.lng, 0) / absorbed.length;
    const staySec = Math.max(1, Math.round((t1 - t0) / 1000));

    if (!window.confirm(
      `把 ${absorbed.length} 個點合併成一處停留（${humanDuration(staySec)}）？`,
    )) return;

    void submitEdits([{
      dayKey,
      deleteIds: absorbed.map((p) => p.id),
      // 兩個同座標的點（進入、離開），跟匯入時濃縮停留產生的形狀完全一樣。
      // 時間直接沿用原本的字串，免得格式跟既有資料對不上。
      // 少了離開點的話，停留期間拍的照片在時間軸上會全部落到下一個移動點之後
      insert: [
        { t: absorbed[0].t_utc, lat, lng, src: 'stay', seg, staySec },
        { t: absorbed[absorbed.length - 1].t_utc, lat, lng, src: 'stay', seg, staySec: null },
      ],
    }]);
  }, [selectedPoints, tracks, submitEdits]);

  // --- 軌跡點與照片的結合 ---
  //
  // 兩邊都是「同一個地點」的兩種記錄：軌跡是手機每隔幾秒記一次的實測位置，
  // 照片是相機在按下快門那一刻記的。哪一邊比較準沒有定論（相機的 GPS 收訊常常
  // 比手機好，但也可能是進了室內才定位到），所以兩個方向都留給使用者決定。

  /** 剛好一個軌跡點配一張照片才談得上結合。湊不齊就是 null */
  const mergePair = useMemo(() => {
    if (selectedPoints.length !== 1 || selectedPhotos.length !== 1) return null;
    return { point: selectedPoints[0], photo: selectedPhotos[0] };
  }, [selectedPoints, selectedPhotos]);

  /** 軌跡點搬到照片的位置 */
  const movePointToPhoto = useCallback(() => {
    if (!mergePair) return;
    const { point, photo } = mergePair;
    const n = orderById.get(point.id);
    if (!window.confirm(
      `把軌跡點${n ? ` #${n}` : ''} 移到「${photo.title}」的位置？`,
    )) return;
    void submitEdits([{
      dayKey: point.day_key,
      deleteIds: [point.id],
      // 刪掉再插一個新的 —— 後端沒有「只改座標」的操作。時間、段別、停留秒數
      // 原封不動抄過去，所以在動畫與段的統計上它還是同一個點，只是位置換了
      insert: [{
        t: point.t_utc,
        lat: photo.lat,
        lng: photo.lng,
        src: point.src ?? 'manual',
        seg: point.seg,
        staySec: point.stay_sec ?? null,
      }],
    }]);
  }, [mergePair, orderById, submitEdits]);

  /** 照片搬到軌跡點的位置。geo_source 會變成 manual，之後的內插補點不會再覆蓋它 */
  const movePhotoToPoint = useCallback(async () => {
    if (!mergePair || !onMovePhoto) return;
    const { point, photo } = mergePair;
    const n = orderById.get(point.id);
    if (!window.confirm(
      `把「${photo.title}」移到軌跡點${n ? ` #${n}` : ''} 的位置？`,
    )) return;
    setEditBusy(true);
    setEditError(null);
    try {
      if (await onMovePhoto(photo.id, point.lat, point.lng)) clearSelection();
      else setEditError('儲存失敗，請再試一次');
    } finally {
      setEditBusy(false);
    }
  }, [mergePair, onMovePhoto, orderById, clearSelection]);

  const canEdit = editable && !!onEditPoints && (tracks?.length ?? 0) > 0;

  return (
    <div style={{ position: 'relative', width: '100%' }}>
      <div ref={containerRef} style={{ width: '100%', height, borderRadius: 12, overflow: 'hidden' }} />

      {/*
        這裡曾經有一塊「這個範圍內還沒有帶座標的照片」的半透明遮罩。拿掉了：
        它的判斷只看照片與 GPS 軌跡，Google 足跡那層畫得好好的也照樣蓋上去，
        等於用一段建議把使用者真正想看的東西擋住。地圖沒東西看不看得出來，
        本來就不需要一層蓋在上面的東西來說明 —— 右上角的狀態列已經在講點數了。
      */}

      {canEdit && !editing && (
        <button
          onClick={enterEdit}
          style={{
            position: 'absolute', left: 12, top: 12, border: 'none', borderRadius: 8,
            padding: '6px 12px', cursor: 'pointer', fontSize: 13,
            background: 'rgba(255,255,255,.94)', color: '#0f172a',
            boxShadow: '0 2px 8px rgba(0,0,0,.15)',
          }}
        >
          ✎ 編輯軌跡點
        </button>
      )}

      {editing && (
        <div style={{
          position: 'absolute', left: 12, right: 12, bottom: 12, padding: '10px 14px',
          background: 'rgba(255,255,255,.96)', borderRadius: 10,
          boxShadow: '0 2px 12px rgba(0,0,0,.15)', display: 'flex',
          alignItems: 'center', gap: 10, flexWrap: 'wrap',
        }}>
          <span style={{ fontSize: 13, color: '#0f172a', fontWeight: 600, flexShrink: 0 }}>
            已選 {selectedPoints.length} 點
            {selectedPhotos.length > 0 && ` ・ ${selectedPhotos.length} 張照片`}
          </span>
          <span style={{ fontSize: 12, color: '#64748b', flex: '1 1 200px', minWidth: 0 }}>
            點擊軌跡點或照片選取，按住 Shift 點第二個軌跡點可連選一段
          </span>

          {/* 選到照片時才長出來 —— 平常這排已經四顆按鈕，再多兩顆會擠成一團 */}
          {selectedPhotos.length > 0 && (
            <>
              <button
                onClick={movePointToPhoto}
                disabled={editBusy || !mergePair}
                title="軌跡點的座標改成這張照片的座標"
                style={{
                  border: 'none', borderRadius: 8, padding: '6px 12px', fontSize: 13, flexShrink: 0,
                  background: mergePair ? '#0f766e' : '#e2e8f0',
                  color: mergePair ? '#fff' : '#94a3b8',
                  cursor: editBusy || !mergePair ? 'default' : 'pointer',
                }}
              >
                軌跡點 → 照片
              </button>
              <button
                onClick={movePhotoToPoint}
                disabled={editBusy || !mergePair || !onMovePhoto}
                title="照片的座標改成這個軌跡點的座標，並標記為手動指定"
                style={{
                  border: 'none', borderRadius: 8, padding: '6px 12px', fontSize: 13, flexShrink: 0,
                  background: mergePair && onMovePhoto ? '#2563eb' : '#e2e8f0',
                  color: mergePair && onMovePhoto ? '#fff' : '#94a3b8',
                  cursor: editBusy || !mergePair || !onMovePhoto ? 'default' : 'pointer',
                }}
              >
                照片 → 軌跡點
              </button>
            </>
          )}

          <button
            onClick={mergeSelected}
            disabled={editBusy || selectedPoints.length < 2}
            style={{
              border: 'none', borderRadius: 8, padding: '6px 12px', fontSize: 13, flexShrink: 0,
              background: selectedPoints.length < 2 ? '#e2e8f0' : '#16a34a',
              color: selectedPoints.length < 2 ? '#94a3b8' : '#fff',
              cursor: editBusy || selectedPoints.length < 2 ? 'default' : 'pointer',
            }}
          >
            合併成一個停留點
          </button>
          <button
            onClick={deleteSelected}
            disabled={editBusy || selectedPoints.length === 0}
            style={{
              border: 'none', borderRadius: 8, padding: '6px 12px', fontSize: 13, flexShrink: 0,
              background: selectedPoints.length === 0 ? '#e2e8f0' : '#dc2626',
              color: selectedPoints.length === 0 ? '#94a3b8' : '#fff',
              cursor: editBusy || selectedPoints.length === 0 ? 'default' : 'pointer',
            }}
          >
            刪除
          </button>
          <button
            onClick={clearSelection}
            disabled={editBusy || (selectedPoints.length === 0 && selectedPhotos.length === 0)}
            style={{
              border: '1px solid #cbd5e1', borderRadius: 8, padding: '5px 12px', fontSize: 13,
              background: '#fff', color: '#475569', flexShrink: 0,
              cursor: editBusy || (selectedPoints.length === 0 && selectedPhotos.length === 0)
                ? 'default' : 'pointer',
            }}
          >
            取消選取
          </button>
          <button
            onClick={exitEdit}
            disabled={editBusy}
            style={{
              border: '1px solid #cbd5e1', borderRadius: 8, padding: '5px 12px', fontSize: 13,
              background: '#fff', color: '#475569', cursor: editBusy ? 'default' : 'pointer',
              flexShrink: 0,
            }}
          >
            離開編輯
          </button>

          {editBusy && <span style={{ fontSize: 12, color: '#64748b' }}>儲存中…</span>}
          {editError && <span style={{ fontSize: 12, color: '#dc2626' }}>{editError}</span>}
        </div>
      )}

      {/* 沒有路徑就沒有東西可以播 —— 只有照片標記、沒開「連接照片位置」時就是這樣 */}
      {!editing && path.length > 1 && (
        <div style={{
          position: 'absolute', left: 12, right: 12, bottom: 12, padding: '10px 14px',
          background: 'rgba(255,255,255,.94)', borderRadius: 10,
          boxShadow: '0 2px 12px rgba(0,0,0,.15)', display: 'flex',
          alignItems: 'center', gap: 12, flexWrap: 'wrap',
        }}>
          <button
            onClick={() => (head >= maxIndex ? replay() : setPlaying((p) => !p))}
            style={{
              border: 'none', borderRadius: 8, padding: '6px 14px', cursor: 'pointer',
              background: '#2563eb', color: '#fff', fontSize: 14, flexShrink: 0,
            }}
          >
            {head >= maxIndex ? '重播' : playing ? '暫停' : '播放'}
          </button>

          <input
            type="range"
            min={0}
            max={maxIndex}
            step="any"
            value={head}
            onChange={(e) => { setPlaying(false); setHead(Number(e.target.value)); }}
            style={{ flex: '1 1 180px', minWidth: 140 }}
            aria-label="時間軸"
          />

          <select
            value={speed}
            onChange={(e) => setSpeed(Number(e.target.value))}
            style={{ fontSize: 13, padding: '4px 6px', borderRadius: 6, flexShrink: 0 }}
            aria-label="播放速度"
          >
            <option value={0.5}>0.5x</option>
            <option value={1}>1x</option>
            <option value={3}>3x</option>
            <option value={8}>8x</option>
          </select>

          {current && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, flex: '1 1 200px' }}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={current.url}
                alt={current.title}
                style={{ width: 40, height: 40, objectFit: 'cover', borderRadius: 6, flexShrink: 0 }}
              />
              <div style={{ fontSize: 12, lineHeight: 1.4, minWidth: 0 }}>
                <div style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {current.place_name || current.title}
                </div>
                <div style={{ color: '#64748b' }}>
                  {shortTime(current.local_time)}
                  {current.geo_source === 'timeline' && '（Google 時間軸）'}
                  {current.geo_source === 'segment' && '（打卡地點）'}
                  {current.geo_source === 'interpolated' && '（推估位置）'}
                  {current.geo_source === 'manual' && '（手動指定）'}
                </div>
              </div>
            </div>
          )}

          <div style={{ fontSize: 12, color: '#64748b', flexShrink: 0, display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ fontSize: 16 }} title="播放中的位置">
              {MOVER_EMOJI}
            </span>
            {headIndex + 1} / {path.length}
          </div>
        </div>
      )}
    </div>
  );
}
