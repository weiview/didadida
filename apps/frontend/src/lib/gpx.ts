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

  const bySeg = new Map<number, GpxPoint[]>();
  for (const p of points) {
    const list = bySeg.get(p.seg);
    if (list) list.push(p);
    else bySeg.set(p.seg, [p]);
  }

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

  const bySeg = new Map<number, GpxPoint[]>();
  for (const p of points) {
    const list = bySeg.get(p.seg);
    if (list) list.push(p);
    else bySeg.set(p.seg, [p]);
  }

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
