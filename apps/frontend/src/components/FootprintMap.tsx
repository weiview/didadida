'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  MapLibreMap, NavigationControl, LngLatBounds,
  type GeoJSONSource, type MapLayerMouseEvent,
} from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import type { FootprintPoint, TrackPoint, TrackPointEdit, Vehicle } from '@/lib/api';
import { VEHICLES, vehicleEmoji, metersBetween, segmentKey } from '@/lib/vehicles';

// OpenFreeMap：免費、免 API key、無流量上限的向量圖磚。
// 不用 Google Maps 是因為它強制要求綁定信用卡的帳單帳戶。
const DEFAULT_STYLE = 'https://tiles.openfreemap.org/styles/positron';

interface Props {
  points: FootprintPoint[];
  /** GPS 軌跡點。有軌跡時，動畫就是沿著它跑 */
  tracks?: TrackPoint[];
  /**
   * 把照片位置也串進動畫路徑。
   * 預設關閉：照片之間拉直線是憑空捏造的路徑，兩張照片就會變成一條穿牆而過的直線。
   * 沒有軌跡的舊相簿才需要打開它。
   */
  connectPhotos?: boolean;
  /** 每段軌跡（key 為 'day_key#seg'）要用哪個交通工具圖示 */
  vehicleByKey?: Map<string, Vehicle>;
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
// 貼圖用 2 倍解析度畫、再以 pixelRatio 2 交給 maplibre，等於 CSS 上的 64px。
// 直接畫 64px 的話放大到 icon-size 1.5 會糊掉。
const THUMB_PX = 128;
const THUMB_PIXEL_RATIO = 2;

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
 * 把照片畫成地圖用的圓角小縮圖。
 *
 * 走 canvas 是因為 map.addImage 要的是像素資料，不是 <img>。
 * 這需要圖片是 CORS-clean，/api/photos/view/ 有回 Access-Control-Allow-Origin: *，
 * 所以 crossOrigin='anonymous' 成立；少了它 canvas 會被污染，getImageData 會直接丟例外。
 */
function loadThumb(url: string): Promise<ImageData> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onerror = () => reject(new Error('圖片載入失敗'));
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = THUMB_PX;
      canvas.height = THUMB_PX;
      const ctx = canvas.getContext('2d');
      if (!ctx) { reject(new Error('取不到 canvas context')); return; }

      // 白框 + 圓角，跟原本的圓點標記是同一套視覺語言。
      // 邊框與圓角跟著 THUMB_PX 等比例縮放，換解析度時視覺比例才不會跑掉。
      const border = Math.round(THUMB_PX * 0.055);
      const radius = Math.round(THUMB_PX * 0.16);

      roundedRectPath(ctx, 1, 1, THUMB_PX - 2, THUMB_PX - 2, radius);
      ctx.fillStyle = '#ffffff';
      ctx.fill();

      ctx.save();
      const inner = THUMB_PX - border * 2;
      roundedRectPath(ctx, border, border, inner, inner, Math.max(radius - border, 2));
      ctx.clip();
      // 置中裁切（cover），不要把照片壓扁
      const side = Math.min(img.width, img.height);
      ctx.drawImage(
        img,
        (img.width - side) / 2, (img.height - side) / 2, side, side,
        border, border, inner, inner,
      );
      ctx.restore();

      try {
        resolve(ctx.getImageData(0, 0, THUMB_PX, THUMB_PX));
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

export default function FootprintMap({
  points, tracks, connectPhotos = false, vehicleByKey, height = 520, styleUrl, onSelectPhoto,
  editable = false, onEditPoints, onMovePhoto,
}: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const rafRef = useRef<number | null>(null);
  const lastCameraIndex = useRef<number>(-1);
  // 地圖只建立一次，事件處理器會鎖住當時的 props。用 ref 讓它讀得到最新的資料
  const pathRef = useRef<PathNode[]>([]);
  const sortedRef = useRef<FootprintPoint[]>([]);
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

  // 軌跡按「哪一天的第幾段」切開。跨段不可以連線 —— 中間是關機或收不到訊號，
  // 直接接起來會憑空畫出一條沒走過的直線。後端已按 t_utc 排序，這裡只做分組。
  const trackLines = useMemo(() => {
    const groups = new Map<string, [number, number][]>();
    for (const p of tracks || []) {
      const key = segmentKey(p.day_key, p.seg);
      const line = groups.get(key);
      if (line) line.push([p.lng, p.lat]);
      else groups.set(key, [[p.lng, p.lat]]);
    }
    return Array.from(groups.values()).filter((line) => line.length >= 2);
  }, [tracks]);

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

    for (const p of tracks || []) {
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
  }, [tracks, sorted, connectPhotos, stays]);

  const maxIndex = Math.max(path.length - 1, 0);
  // head 是動畫算出來的浮點數，會被拿來當陣列索引，所以夾在合法範圍內再用。
  // 少了下界的話，播放起頭那一瞬間的負值會變成 path[-1]
  const headIndex = Number.isFinite(head)
    ? Math.min(Math.max(Math.floor(head), 0), maxIndex)
    : 0;
  const headTime = path[headIndex]?.t ?? null;
  // 播放頭所在那一段的交通工具。純照片路徑沒有段別，退回汽車
  const headSegKey = path[headIndex]?.segKey ?? null;
  const headVehicle: Vehicle = (headSegKey && vehicleByKey?.get(headSegKey)) || 'car';

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
        clusterRadius: 45,
        clusterMaxZoom: 15,
      });

      // 同一景點常常拍幾十張，不聚合會疊成一坨
      map.addLayer({
        id: 'photo-clusters',
        type: 'circle',
        source: 'photos',
        filter: ['has', 'point_count'],
        paint: {
          'circle-color': '#2563eb',
          'circle-opacity': 0.85,
          'circle-radius': ['step', ['get', 'point_count'], 16, 10, 22, 50, 30],
          'circle-stroke-width': 2,
          'circle-stroke-color': '#ffffff',
        },
      });
      map.addLayer({
        id: 'photo-cluster-count',
        type: 'symbol',
        source: 'photos',
        filter: ['has', 'point_count'],
        // 必須指定 OpenFreeMap 實際提供的字型；用 maplibre 預設的
        // "Open Sans Regular,Arial Unicode MS Regular" 會 404 而退化成本地字型
        layout: {
          'text-field': ['get', 'point_count_abbreviated'],
          'text-font': ['Noto Sans Bold'],
          'text-size': 12,
        },
        paint: { 'text-color': '#ffffff' },
      });

      // 單點樣式依座標來源區分，讓人一眼看出哪些足跡是推論出來的：
      //   manual=空心（使用者親手指定）、exif/timeline=實心不透明、
      //   segment/interpolated=半透明（規則或內插推估，不是量到的位置）
      map.addLayer({
        id: 'photo-points',
        type: 'circle',
        source: 'photos',
        filter: ['!', ['has', 'point_count']],
        paint: {
          'circle-radius': 7,
          'circle-color': [
            'match', ['get', 'geo_source'],
            'exif', '#2563eb',
            'timeline', '#0891b2',
            'segment', '#f59e0b',
            'interpolated', '#2563eb',
            'manual', '#ffffff',
            '#94a3b8',
          ],
          'circle-opacity': [
            'match', ['get', 'geo_source'],
            'exif', 1,
            'timeline', 1,
            'segment', 0.55,
            'interpolated', 0.45,
            'manual', 1,
            0.6,
          ],
          'circle-stroke-width': 2,
          'circle-stroke-color': [
            'match', ['get', 'geo_source'],
            'manual', '#2563eb',
            '#ffffff',
          ],
        },
      });

      // 縮圖疊在圓點之上。圓點那一層留著當底 —— 圖還沒載到（或載失敗）時
      // 至少還看得到位置，不會整個標記消失
      map.addLayer({
        id: 'photo-thumbs',
        type: 'symbol',
        source: 'photos',
        filter: ['!', ['has', 'point_count']],
        layout: {
          'icon-image': ['concat', 'photo-', ['to-string', ['get', 'id']]],
          // 跟著縮放走：拉近看得清楚，拉遠不會整片糊成一團。
          // interpolate 在頭尾兩個停靠點之外會夾住，這就是「不能大過頭」的上下限 ——
          // 貼圖是 64 CSS px，所以實際尺寸落在 38px（z≤10）到 96px（z≥17）之間。
          'icon-size': [
            'interpolate', ['linear'], ['zoom'],
            10, 0.6,
            14, 1.0,
            17, 1.5,
          ],
          // 照片本來就常常擠在一起，讓它們互相遮擋比整片消失好
          'icon-allow-overlap': true,
          'icon-ignore-placement': true,
        },
      });

      // 交通工具圖示。畫在最上層，它是動畫的主角
      for (const v of VEHICLES) {
        const img = emojiImage(v.emoji);
        if (img && !map.hasImage(`vehicle-${v.id}`)) map.addImage(`vehicle-${v.id}`, img);
      }
      map.addSource('vehicle', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      map.addLayer({
        id: 'vehicle-marker',
        type: 'symbol',
        source: 'vehicle',
        layout: {
          'icon-image': ['concat', 'vehicle-', ['get', 'vehicle']],
          'icon-size': 0.72,
          'icon-allow-overlap': true,
          'icon-ignore-placement': true,
          // 刻意不隨行進方向旋轉：emoji 的朝向每個字型都不一樣（🚗 向左、✈️ 向右上、
          // 🚶 側身），統一套一個角度一定會有幾個變成頭下腳上。維持直立最保險。
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

      // 縮圖採「用到才載」：maplibre 找不到 icon-image 就會發這個事件。
      // 一次把整個相簿的縮圖抓下來是白費頻寬 —— 聚合起來的照片根本不會畫出縮圖。
      map.on('styleimagemissing', (e: { id: string }) => {
        const id = e.id;
        if (!id.startsWith('photo-')) return;
        if (thumbPending.current.has(id) || thumbLoaded.current.size >= MAX_THUMBS) return;
        const photoId = Number(id.slice('photo-'.length));
        const photo = sortedRef.current.find((p) => p.id === photoId);
        if (!photo) return;

        thumbPending.current.add(id);
        loadThumb(photo.url)
          .then((data) => {
            // 這中間地圖可能已經被 remove，或別的路徑已經加過同一張
            if (!mapRef.current || mapRef.current.hasImage(id)) return;
            mapRef.current.addImage(id, data, { pixelRatio: THUMB_PIXEL_RATIO });
            thumbLoaded.current.add(id);
          })
          .catch(() => { /* 載不到就維持圓點，不需要打擾使用者 */ })
          .finally(() => { thumbPending.current.delete(id); });
      });

      map.on('click', 'photo-clusters', (e: MapLayerMouseEvent) => {
        const f = map.queryRenderedFeatures(e.point, { layers: ['photo-clusters'] })[0];
        const clusterId = f?.properties?.cluster_id;
        const src = map.getSource('photos') as GeoJSONSource;
        if (clusterId == null || !src) return;
        src.getClusterExpansionZoom(clusterId).then((zoom: number) => {
          map.easeTo({ center: (f.geometry as any).coordinates, zoom });
        }).catch(() => { /* 叢集已不存在，忽略 */ });
      });

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
      // 縮圖比底下的圓點大，只掛在圓點上的話點到縮圖邊緣會沒有反應
      map.on('click', 'photo-points', onPhotoClick);
      map.on('click', 'photo-thumbs', onPhotoClick);

      for (const layer of ['photo-points', 'photo-thumbs', 'photo-clusters']) {
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
    lastCameraIndex.current = -1;

    const src = map.getSource('photos') as GeoJSONSource | undefined;
    src?.setData({
      type: 'FeatureCollection',
      features: sorted.map((p) => ({
        type: 'Feature',
        properties: { id: p.id, geo_source: p.geo_source, title: p.title },
        geometry: { type: 'Point', coordinates: [p.lng, p.lat] },
      })),
    });

  }, [sorted, coords, ready]);

  // 路徑換了就把播放頭移到終點，維持「預設看到完整路線」的樣子
  useEffect(() => {
    setHead(path.length > 0 ? path.length - 1 : 0);
    setPlaying(false);
    lastCameraIndex.current = -1;
  }, [path]);

  // --- 軌跡 ---
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const src = map.getSource('gps-track') as GeoJSONSource | undefined;
    src?.setData({
      type: 'FeatureCollection',
      features: trackLines.map((line) => ({
        type: 'Feature',
        properties: {},
        geometry: { type: 'LineString', coordinates: line },
      })),
    });
  }, [trackLines, ready]);

  // --- 停留點 ---
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const src = map.getSource('stays') as GeoJSONSource | undefined;
    src?.setData({
      type: 'FeatureCollection',
      features: stays.map((s) => ({
        type: 'Feature',
        properties: { sec: s.sec, label: humanDuration(s.sec) },
        geometry: { type: 'Point', coordinates: [s.lng, s.lat] },
      })),
    });
  }, [stays, ready]);

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
    const all = [...coords, ...trackLines.flat()];
    if (all.length === 0) return;
    const bounds = all.reduce((b, c) => b.extend(c), new LngLatBounds(all[0], all[0]));
    map.fitBounds(bounds, { padding: 60, maxZoom: 13, duration: 600 });
  }, [coords, trackLines, ready]);

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

    // 交通工具停在路線頭端，跟線一起前進
    const vehicleSrc = map.getSource('vehicle') as GeoJSONSource | undefined;
    const headPos = cur.length > 0 ? cur[cur.length - 1] : null;
    if (vehicleSrc) {
      const seg = a?.segKey ?? null;
      // 沒有指定也猜不出來（例如純照片路徑）就用汽車，總比沒有圖示好
      const vehicle = (seg && vehicleByKey?.get(seg)) || 'car';
      vehicleSrc.setData({
        type: 'FeatureCollection',
        features: headPos ? [{
          type: 'Feature',
          properties: { vehicle },
          geometry: { type: 'Point', coordinates: headPos },
        }] : [],
      });
    }

    // 相機只在抵達新的節點時才移動；每幀都移會很暈
    if (playing && whole !== lastCameraIndex.current && a) {
      lastCameraIndex.current = whole;
      map.easeTo({ center: [a.lng, a.lat], duration: 600, essential: true });
    }
  }, [head, path, ready, playing, vehicleByKey]);

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
    lastCameraIndex.current = -1;
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

      {sorted.length === 0 && trackLines.length === 0 && (
        <div style={{
          position: 'absolute', inset: 0, display: 'flex', alignItems: 'center',
          justifyContent: 'center', background: 'rgba(255,255,255,.75)', borderRadius: 12,
          textAlign: 'center', padding: 24, fontSize: 14, color: '#475569',
        }}>
          這個範圍內還沒有帶座標的照片。<br />
          可以先用批次指定地點，或對有 GPS 的照片執行內插補點。
        </div>
      )}

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
            <span style={{ fontSize: 16 }} title="這一段的交通工具，可在下方逐段指定">
              {vehicleEmoji(headVehicle)}
            </span>
            {headIndex + 1} / {path.length}
          </div>
        </div>
      )}
    </div>
  );
}
