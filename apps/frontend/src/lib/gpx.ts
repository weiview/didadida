// GPX 軌跡解析與抽稀，全程在瀏覽器內完成。
//
// 為什麼不在 Worker 解析：軌跡檔一天可以到幾萬個點，免費方案的 CPU 時間
// 撐不住 XML 解析＋Douglas-Peucker。Worker 只做 Drive I/O 與 D1 寫入，
// 解析放在瀏覽器就不需要 cron，同步是使用者按按鈕才發生。
//
// 已知的來源：GPSLogger for Android，輸出 GPX 1.0。
// 不要把 namespace 寫死 —— GPX 有 1.0（topografix GPX/1/0）與 1.1（GPX/1/1）
// 兩個 URI，換一支 app 就會變。

/** 一個軌跡點。欄位名對齊 POST /api/tracks/ingest 的 body */
export interface GpxPoint {
  /** UTC 瞬間，格式與 Photo.taken_at 一致（toISOString），之後才能直接字串比對 */
  t: string;
  lat: number;
  lng: number;
  /** GPSLogger 會寫 'gps' 或 'network'。GPX 沒有精度欄位，這是唯一的品質訊號 */
  src: string | null;
  hdop: number | null;
  /** 同一個 trkseg 才算連續。不同 seg 之間不可以連線 —— 中間是關機或沒訊號 */
  seg: number;
  /**
   * 停留秒數。由 collapseStays 產生：
   * 一段「待在原地亂跳」的點會被收成質心上的兩個點（進入、離開），
   * 進入的那個帶 staySec，離開的那個是 null。一般的移動點也是 null。
   */
  staySec?: number | null;
}

export interface GpxParseResult {
  points: GpxPoint[];
  /** trkseg 的數量，等於軌跡被切斷的段數 */
  segCount: number;
  /** 缺時間或座標不合法而被丟掉的點 */
  skipped: number;
  /** 解析失敗時的原因，成功為 null */
  error: string | null;
}

/**
 * 取子元素，忽略 namespace 前綴。
 * 實際的 GPX 幾乎都用預設 namespace（沒有前綴），所以先走一般的查詢；
 * 真的碰到 <gpx:trkpt> 才退到 namespace 萬用字元。
 */
function childrenByName(root: Element | Document, name: string): Element[] {
  const plain = root.getElementsByTagName(name);
  if (plain.length > 0) return Array.from(plain);
  if (typeof root.getElementsByTagNameNS !== 'function') return [];
  return Array.from(root.getElementsByTagNameNS('*', name));
}

/** 取第一個同名子元素的文字內容 */
function textOf(el: Element, name: string): string | null {
  const found = childrenByName(el, name)[0];
  const text = found?.textContent?.trim();
  return text ? text : null;
}

function isValidLatLng(lat: number, lng: number): boolean {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return false;
  // 恰好 (0,0) 在大西洋上，實務上都是「沒定到位」的哨兵值
  return !(lat === 0 && lng === 0);
}

/**
 * 解析 GPX 文字。
 * 多個 <trk> 底下的多個 <trkseg> 會被攤平成一串點，用 seg 編號區分段落。
 */
export function parseGpx(xml: string): GpxParseResult {
  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(xml, 'application/xml');
  } catch {
    return { points: [], segCount: 0, skipped: 0, error: 'XML 解析失敗' };
  }
  // DOMParser 不丟例外，失敗是塞一個 parsererror 元素進來
  if (doc.getElementsByTagName('parsererror').length > 0) {
    return { points: [], segCount: 0, skipped: 0, error: '這個檔案不是合法的 XML' };
  }

  const segs = childrenByName(doc, 'trkseg');
  if (segs.length === 0) {
    return { points: [], segCount: 0, skipped: 0, error: '找不到 trkseg，可能不是 GPX 軌跡檔' };
  }

  const points: GpxPoint[] = [];
  let skipped = 0;

  segs.forEach((segEl, seg) => {
    for (const pt of childrenByName(segEl, 'trkpt')) {
      const lat = Number(pt.getAttribute('lat'));
      const lng = Number(pt.getAttribute('lon'));
      if (!isValidLatLng(lat, lng)) { skipped++; continue; }

      // 沒有時間的點無法放到時間軸上，對這個功能沒有用處
      const rawTime = textOf(pt, 'time');
      if (!rawTime) { skipped++; continue; }
      const ms = Date.parse(rawTime);
      if (!Number.isFinite(ms)) { skipped++; continue; }

      const hdopRaw = textOf(pt, 'hdop');
      const hdop = hdopRaw === null ? null : Number(hdopRaw);

      points.push({
        t: new Date(ms).toISOString(),
        lat,
        lng,
        src: textOf(pt, 'src'),
        hdop: Number.isFinite(hdop as number) ? (hdop as number) : null,
        seg,
      });
    }
  });

  // GPX 理論上已按時間排好，但補記錄或跨段合併都可能亂序，
  // 之後的內插與照片比對都假設是遞增的
  points.sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : a.seg - b.seg));

  return { points, segCount: segs.length, skipped, error: null };
}

const EARTH_RADIUS_M = 6371000;

/** 兩點的地表距離（公尺）。haversine 的小角度近似版，幾十公里內夠用 */
function distanceM(a: GpxPoint, b: GpxPoint): number {
  const rad = Math.PI / 180;
  const cosLat = Math.cos(((a.lat + b.lat) / 2) * rad);
  const dx = (b.lng - a.lng) * rad * cosLat * EARTH_RADIUS_M;
  const dy = (b.lat - a.lat) * rad * EARTH_RADIUS_M;
  return Math.hypot(dx, dy);
}

/**
 * 停留點濃縮。
 *
 * 為什麼 Douglas-Peucker 治不了這件事：DP 保留的是「離直線最遠」的點，
 * 而室內亂跳的雜訊剛好就是那些點 —— 抽稀反而會專門把抖動留下來。
 * 停留是時間現象不是幾何現象，只能用「半徑 + 持續時間」判斷。
 *
 * 演算法（Li et al. 2008 的停留點偵測）：從第 i 點往後找，直到有一點離它
 * 超過 radiusM；如果中間這一串橫跨的時間 >= minSeconds，就是一次停留，
 * 收成質心上的兩個點（進入時刻、離開時刻），否則第 i 點照原樣留著。
 *
 * 輸出兩個點而不是一個，是為了讓停留期間拍的照片在時間軸上對得到位置；
 * 兩點同座標，畫線時長度為零，不影響路線外觀。
 *
 * @param radiusM    多大範圍內算「沒有移動」。60m 約等於一棟大樓 + GPS 室內飄移
 * @param minSeconds 待多久才算停留。太短會把等紅燈也吃掉
 */
export function collapseStays(points: GpxPoint[], radiusM = 60, minSeconds = 300): GpxPoint[] {
  if (points.length < 2) return points;

  const bySeg = groupBySeg(points);

  const out: GpxPoint[] = [];
  for (const seg of Array.from(bySeg.keys()).sort((a, b) => a - b)) {
    const pts = bySeg.get(seg)!;
    let i = 0;
    while (i < pts.length) {
      // 往後擴張到第一個離錨點超過半徑的位置
      let j = i + 1;
      while (j < pts.length && distanceM(pts[i], pts[j]) <= radiusM) j++;

      const lastIn = j - 1;
      const durationMs = Date.parse(pts[lastIn].t) - Date.parse(pts[i].t);
      if (lastIn > i && durationMs >= minSeconds * 1000) {
        let sumLat = 0;
        let sumLng = 0;
        for (let k = i; k <= lastIn; k++) { sumLat += pts[k].lat; sumLng += pts[k].lng; }
        const n = lastIn - i + 1;
        const lat = sumLat / n;
        const lng = sumLng / n;
        // src 取 'stay'，之後在地圖上可以跟一般點分開畫
        out.push({ t: pts[i].t, lat, lng, src: 'stay', hdop: null, seg, staySec: Math.round(durationMs / 1000) });
        out.push({ t: pts[lastIn].t, lat, lng, src: 'stay', hdop: null, seg, staySec: null });
        i = lastIn + 1;
      } else {
        out.push(pts[i]);
        i++;
      }
    }
  }

  out.sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : a.seg - b.seg));
  return out;
}

/**
 * 剔除折返尖峰。
 *
 * 定位偶爾會噴出一個離譜的點，下一點又跳回來，在圖上留下一根刺。
 * 判準是幾何的：A→B→C 三點，前後兩段都夠長（> minLegM），
 * 但頭尾直線距離 |AC| 卻遠小於折線長 |AB|+|BC| —— 這只有「跑出去又跑回來」
 * 才會發生，正常行進的三點 |AC| 會接近 |AB|+|BC|。
 *
 * 只看幾何，不看 hdop 也不看 src：實測過那兩個欄位跟位置誤差沒有相關性，
 * hdop=500 的點位置正常，而在家的 network 點比 gps 還準。
 *
 * 為什麼一定要在 extractTrips 之前跑：一根 200m 的刺配上 30 秒的間隔
 * 就是 24km/h，足以讓整段靜止的室內雜訊被誤判成一趟行程。
 *
 * 連續兩個尖峰不會一起砍（`drop.has(i - 1)` 那行）—— 前一點已經被判定為
 * 雜訊時，用它當 A 去量下一點沒有意義。
 *
 * @param minLegM 前後兩段各自至少要多長才值得檢查。太小會誤砍原地抖動
 * @param ratio   |AC| / (|AB|+|BC|) 低於多少算折返。0.35 約等於夾角小於 40°
 * @param maxGapS 三點之間任一段超過這個秒數就跳過 —— 中間可能真的移動過
 */
export function rejectSpikes(
  points: GpxPoint[],
  { minLegM = 40, ratio = 0.35, maxGapS = 300 }: { minLegM?: number; ratio?: number; maxGapS?: number } = {},
): GpxPoint[] {
  if (points.length < 3) return points;

  const bySeg = groupBySeg(points);
  const drop = new Set<GpxPoint>();
  const maxGapMs = maxGapS * 1000;

  for (const pts of Array.from(bySeg.values())) {
    for (let i = 1; i < pts.length - 1; i++) {
      const a = pts[i - 1];
      const b = pts[i];
      const c = pts[i + 1];
      if (drop.has(a)) continue;
      const tA = Date.parse(a.t);
      const tB = Date.parse(b.t);
      const tC = Date.parse(c.t);
      if (tB - tA > maxGapMs || tC - tB > maxGapMs) continue;
      const ab = distanceM(a, b);
      const bc = distanceM(b, c);
      if (ab <= minLegM || bc <= minLegM) continue;
      if (distanceM(a, c) < (ab + bc) * ratio) drop.add(b);
    }
  }

  return drop.size === 0 ? points : points.filter((p) => !drop.has(p));
}

/** 一趟移動。points 是原始密度的點，沒有抽稀 —— 貼路要密才貼得準 */
export interface Trip {
  points: GpxPoint[];
  /** 累積路程（公尺） */
  distanceM: number;
  /** 代表速度，取瞬時速度的 85 百分位。用來猜交通工具，避開起步與塞車的極端值 */
  speedKmh: number;
}

/**
 * 依速度切出「有在移動」的區段。
 *
 * 為什麼不用半徑式的停留偵測來切：停留半徑要多大，取決於當下是在家、在室內
 * 賣場、還是在騎樓下，同一個數字擺哪裡都不對。而「有沒有在移動」用速度判斷
 * 沒有這個問題 —— 靜止時的雜訊速度跟真的在走路差了一個數量級。
 *
 * 要連續 runLength 個點都超過 minKmh 才算開始移動，單點的假速度騙不過去。
 *
 * **minKmh 必須低到讓走路算數**（走路是 3–5 km/h）。這裡原本是 8，結果純走路
 * 的路段一趟都切不出來，夾在兩段開車中間的走路就在地圖上變成一個洞 ——
 * 而下游 vehicleFromSpeed 的 'walk' → pedestrian costing 也因此永遠走不到。
 *
 * 但光是把門檻調低不夠：室內雜訊的瞬時速度可以到 10–13 km/h，光看速度分不掉。
 * 真正把它濾掉的是 minSpreadM，兩個門檻要一起看才成立。
 *
 * 兩趟之間靜止不到 mergeGapMin 分鐘就併成同一趟（等紅燈、路邊停車），
 * 免得一段路被切成十幾個碎片、每個碎片各發一次貼路請求。
 *
 * @param minKmh        超過多少算在移動
 * @param runLength     要連續幾個點都超過門檻
 * @param mergeGapMin   兩段之間靜止幾分鐘以內就併回同一趟
 * @param minDistanceM  一趟至少要走多遠才留著
 * @param minSpreadM    一趟至少要涵蓋多大的地理範圍。低於這個數字代表人根本沒有
 *                      離開一個街廓 —— 那裡面不存在一條可以貼的路，不管它是賣場、
 *                      地下停車場還是公園。實測分離度極大（雜訊趟最大 368m、
 *                      真行程最小 872m），400–800m 之間取哪個數字結果都一樣。
 *                      這**不是**在偵測室內，只是在問「有沒有真的去到別的地方」
 * @param minPoints     一趟至少要有幾個點（Valhalla 太短的輸入貼不出東西）
 * @param maxTrips      一天最多幾趟。每一趟都是一次貼路請求，所以是硬上限：
 *                      先把 mergeGapMin 加倍重試，還是超過就只留最長的幾趟
 */
export function extractTrips(
  points: GpxPoint[],
  {
    minKmh = 2.5,
    runLength = 3,
    mergeGapMin = 5,
    minDistanceM = 300,
    minSpreadM = 500,
    minPoints = 8,
    maxTrips = 12,
  }: {
    minKmh?: number; runLength?: number; mergeGapMin?: number;
    minDistanceM?: number; minSpreadM?: number; minPoints?: number; maxTrips?: number;
  } = {},
): Trip[] {
  if (points.length < minPoints) return [];

  const bySeg = groupBySeg(points);
  let gapMin = mergeGapMin;
  let trips: Trip[] = [];

  // 最多放寬 4 次（5 → 40 分鐘），沿用 simplifyTrack 的作法。
  // 再放寬下去整天就會併成一趟，那條線會橫跨所有停留，反而更難看
  for (let attempt = 0; attempt < 4; attempt++) {
    trips = [];
    for (const seg of Array.from(bySeg.keys()).sort((a, b) => a - b)) {
      trips.push(...tripsInSegment(bySeg.get(seg)!, { minKmh, runLength, gapMin, minDistanceM, minSpreadM, minPoints }));
    }
    if (trips.length <= maxTrips) break;
    gapMin *= 2;
  }

  // 放寬只能併「時間相鄰」的段落，跨 trkseg 或隔了好幾小時的併不起來。
  // 所以最後補一刀硬砍：留最長的幾趟。短的那些本來也貼不出好看的線
  if (trips.length > maxTrips) {
    trips.sort((a, b) => b.distanceM - a.distanceM);
    trips = trips.slice(0, maxTrips);
  }

  trips.sort((a, b) => (a.points[0].t < b.points[0].t ? -1 : 1));
  return trips;
}

function tripsInSegment(
  pts: GpxPoint[],
  opts: {
    minKmh: number; runLength: number; gapMin: number;
    minDistanceM: number; minSpreadM: number; minPoints: number;
  },
): Trip[] {
  const { minKmh, runLength, gapMin, minDistanceM, minSpreadM, minPoints } = opts;
  if (pts.length < minPoints) return [];

  const ms = pts.map((p) => Date.parse(p.t));
  // 每點的瞬時速度（相對於前一點）。第 0 點沒有前一點，補 0
  const kmh = pts.map((p, i) => {
    if (i === 0) return 0;
    const dt = (ms[i] - ms[i - 1]) / 1000;
    return dt > 0 ? (distanceM(pts[i - 1], p) / dt) * 3.6 : 0;
  });

  const moving = new Array<boolean>(pts.length).fill(false);
  for (let i = 0; i + runLength <= pts.length; i++) {
    let ok = true;
    for (let k = i; k < i + runLength; k++) if (kmh[k] <= minKmh) { ok = false; break; }
    // 連上 i-1：kmh[i] 描述的是 i-1 → i 這一段，所以出發點是 i-1
    if (ok) for (let k = Math.max(0, i - 1); k < i + runLength; k++) moving[k] = true;
  }

  const spans: [number, number][] = [];
  let start = -1;
  for (let i = 0; i < pts.length; i++) {
    if (moving[i] && start < 0) start = i;
    else if (!moving[i] && start >= 0) { spans.push([start, i - 1]); start = -1; }
  }
  if (start >= 0) spans.push([start, pts.length - 1]);

  const merged: [number, number][] = [];
  for (const span of spans) {
    const last = merged[merged.length - 1];
    if (last && ms[span[0]] - ms[last[1]] <= gapMin * 60 * 1000) last[1] = span[1];
    else merged.push([span[0], span[1]]);
  }

  const out: Trip[] = [];
  for (const [a, b] of merged) {
    const slice = pts.slice(a, b + 1);
    if (slice.length < minPoints) continue;
    let total = 0;
    for (let i = 1; i < slice.length; i++) total += distanceM(slice[i - 1], slice[i]);
    if (total < minDistanceM) continue;
    // 走了兩公里卻沒離開一個街廓 —— 那是定位在原地繞，不是一趟行程。
    // 這一刀非砍不可：minKmh 低到讓走路算數之後，室內雜訊也會一起過關
    if (spreadM(slice) < minSpreadM) continue;
    // 代表速度取 85 百分位，跟 vehicles.ts 的 segmentSpeedKmh 同一套規則
    const inside = kmh.slice(a + 1, b + 1).filter((v) => Number.isFinite(v)).sort((x, y) => x - y);
    const speedKmh = inside.length ? inside[Math.min(inside.length - 1, Math.floor(inside.length * 0.85))] : 0;
    out.push({ points: slice, distanceM: total, speedKmh });
  }
  return out;
}

/**
 * 這一串點涵蓋的地理範圍：bounding box 對角線的長度（公尺）。
 *
 * 用它而不是「淨位移」（頭尾直線距離）：出去繞一圈再回到原點的散步，
 * 淨位移是 0 但範圍很大，那是真的走過的路，不該被當成雜訊丟掉。
 */
function spreadM(points: GpxPoint[]): number {
  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLng = Infinity;
  let maxLng = -Infinity;
  for (const p of points) {
    if (p.lat < minLat) minLat = p.lat;
    if (p.lat > maxLat) maxLat = p.lat;
    if (p.lng < minLng) minLng = p.lng;
    if (p.lng > maxLng) maxLng = p.lng;
  }
  return distanceM(
    { lat: minLat, lng: minLng } as GpxPoint,
    { lat: maxLat, lng: maxLng } as GpxPoint,
  );
}

function groupBySeg(points: GpxPoint[]): Map<number, GpxPoint[]> {
  const bySeg = new Map<number, GpxPoint[]>();
  for (const p of points) {
    const list = bySeg.get(p.seg);
    if (list) list.push(p);
    else bySeg.set(p.seg, [p]);
  }
  return bySeg;
}

/**
 * 等距長方投影。緯度差在幾十公里內誤差可以忽略，
 * 抽稀只需要「點離線段多遠」的相對量，不需要大地測量等級的精度。
 */
function project(p: GpxPoint, cosLatRef: number): [number, number] {
  const rad = Math.PI / 180;
  return [p.lng * rad * cosLatRef * EARTH_RADIUS_M, p.lat * rad * EARTH_RADIUS_M];
}

/** 點到線段的垂直距離（公尺） */
function perpDistance(p: [number, number], a: [number, number], b: [number, number]): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const lenSq = dx * dx + dy * dy;
  // 頭尾重合（原地不動）時退化成點到點的距離
  if (lenSq === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  const t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lenSq;
  const clamped = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(p[0] - (a[0] + clamped * dx), p[1] - (a[1] + clamped * dy));
}

/**
 * Douglas-Peucker，單一段落。
 * 用堆疊而不是遞迴 —— 一天上萬個點的話遞迴深度會爆掉。
 */
function simplifySegment(seg: GpxPoint[], toleranceM: number): GpxPoint[] {
  if (seg.length <= 2) return seg;

  const cosLatRef = Math.cos((seg[0].lat * Math.PI) / 180);
  const xy = seg.map((p) => project(p, cosLatRef));
  const keep = new Array<boolean>(seg.length).fill(false);
  keep[0] = true;
  keep[seg.length - 1] = true;

  const stack: [number, number][] = [[0, seg.length - 1]];
  while (stack.length > 0) {
    const [start, end] = stack.pop()!;
    let maxDist = -1;
    let maxIdx = -1;
    for (let i = start + 1; i < end; i++) {
      const d = perpDistance(xy[i], xy[start], xy[end]);
      if (d > maxDist) { maxDist = d; maxIdx = i; }
    }
    if (maxIdx > 0 && maxDist > toleranceM) {
      keep[maxIdx] = true;
      stack.push([start, maxIdx], [maxIdx, end]);
    }
  }

  // 停留點是 collapseStays 特意留下的語意點，不能被幾何抽稀吃掉 ——
  // 它常常剛好落在前後兩點的連線附近，正是 DP 最愛丟的那種點。
  // 多留幾個點不會讓線變形（keep 只會變成 DP 結果的超集）。
  for (let i = 0; i < seg.length; i++) {
    if (seg[i].src === 'stay') keep[i] = true;
  }

  return seg.filter((_, i) => keep[i]);
}

/**
 * 逐段抽稀。段與段之間不會互相影響，每段的頭尾一定保留。
 *
 * 停留不動的長時間區段會被壓成頭尾兩點，這是想要的行為：
 * 中間內插出來的位置跟原本一樣，但少寫幾千列 D1。
 *
 * @param toleranceM 容許的偏離公尺數。5 公尺約等於一般手機 GPS 的雜訊幅度。
 * @param maxPoints  上限。超過就把容差加倍重來，避免一次寫爆 D1 額度。
 */
export function simplifyTrack(points: GpxPoint[], toleranceM = 5, maxPoints = 8000): GpxPoint[] {
  if (points.length <= 2) return points;

  const bySeg = groupBySeg(points);

  let tolerance = toleranceM;
  let out: GpxPoint[] = [];
  // 最多放寬 6 次（5m → 320m）。再放寬下去軌跡就沒有意義了，直接讓它超標
  for (let attempt = 0; attempt < 6; attempt++) {
    out = [];
    for (const seg of Array.from(bySeg.keys()).sort((a, b) => a - b)) {
      out.push(...simplifySegment(bySeg.get(seg)!, tolerance));
    }
    if (out.length <= maxPoints) break;
    tolerance *= 2;
  }
  return out;
}
