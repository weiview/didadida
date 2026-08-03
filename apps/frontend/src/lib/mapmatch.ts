import { metersBetween } from './vehicles';

/**
 * 軌跡貼路（map matching）的瀏覽器端組裝。
 *
 * 分工：Worker 只負責把座標轉手給 Valhalla（隱私與條款的理由寫在後端路由旁），
 * 解碼與時間戳還原都在這裡做 —— 這批運算不該花 Worker 的免費 CPU 額度。
 */

/** 送進 Valhalla 的一個點。t 是毫秒 epoch，貼路後要還原回去給動畫用 */
export interface MatchInput {
  lat: number;
  lng: number;
  t: number;
}

/** 貼路後的一個點。密度由道路幾何決定，會比輸入多得多 */
export interface MatchedPoint {
  lat: number;
  lng: number;
  /** 由前後兩個對上的輸入點依沿線距離內插而來 */
  t: number;
}

/** Valhalla trace_attributes 回應裡我們用得到的部分 */
export interface TraceResponse {
  shape?: string;
  matched_points?: { lat?: number; lon?: number; type?: string }[];
  error?: string;
}

/**
 * Google polyline 解碼。Valhalla 用 6 位精度，Google 自己是 5 —— 傳錯的話
 * 座標會差 10 倍，線會飛到地圖外，是這裡最容易踩的坑。
 */
export function decodePolyline(str: string, precision = 6): [number, number][] {
  const factor = Math.pow(10, precision);
  const out: [number, number][] = [];
  let index = 0;
  let lat = 0;
  let lng = 0;

  while (index < str.length) {
    let result = 0;
    let shift = 0;
    let byte = 0;
    do {
      byte = str.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lat += (result & 1) ? ~(result >> 1) : (result >> 1);

    result = 0;
    shift = 0;
    do {
      byte = str.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lng += (result & 1) ? ~(result >> 1) : (result >> 1);

    out.push([lat / factor, lng / factor]);
  }
  return out;
}

/**
 * 抽稀到 Valhalla 吃得下的量。
 *
 * 貼路不需要 1Hz 的密度 —— 演算法是把點序列對到路網上，一條路上多給 30 個點
 * 不會讓它更確定走的是哪條路，只會讓請求變大、對方算更久。均勻取樣就夠了，
 * 但頭尾一定要留：那兩點決定了整段要從哪貼到哪。
 */
export function subsampleForMatch<T>(points: T[], max = 1000): T[] {
  if (points.length <= max) return points;
  const out: T[] = [];
  const step = (points.length - 1) / (max - 1);
  for (let i = 0; i < max; i++) out.push(points[Math.round(i * step)]);
  return out;
}

/**
 * 把 Valhalla 的回應組回帶時間戳的點列。
 *
 * 回應給的是兩樣東西：`shape` 是貼在路上的完整幾何（我們要畫的線），
 * `matched_points` 則是每個「送出去的點」被貼到哪 —— 兩者一一對應且沿線有序。
 * 拿後者當錨點，把原本的時間依沿線距離內插到 shape 的每個頂點上，
 * 結果就能直接餵給既有的動畫與分段邏輯，不必另開一套。
 *
 * 貼不出來（伺服器回錯、點太少、對上的錨點不足）一律回 null，
 * 讓呼叫端安靜退回原本的線 —— 對方是志工維護的單機，壞掉是預期內的事。
 */
export function buildMatchedTrack(sent: MatchInput[], resp: TraceResponse): MatchedPoint[] | null {
  const shape = decodePolyline(resp?.shape || '');
  if (shape.length < 2) return null;

  // 沿線累積距離，內插的座標軸
  const cum = new Array<number>(shape.length).fill(0);
  for (let i = 1; i < shape.length; i++) {
    cum[i] = cum[i - 1] + metersBetween(shape[i - 1][0], shape[i - 1][1], shape[i][0], shape[i][1]);
  }

  // 錨點：(沿線距離, 原本的時間)
  const anchors: { d: number; t: number }[] = [];
  const mp = resp.matched_points || [];
  let cursor = 0;
  for (let i = 0; i < mp.length && i < sent.length; i++) {
    const m = mp[i];
    // 'unmatched' 是 Valhalla 明說「這個點我貼不上去」（離路太遠、在室內…），
    // 拿它當錨點會把時間釘在錯的位置上
    if (!m || m.type === 'unmatched') continue;
    if (!Number.isFinite(m.lat) || !Number.isFinite(m.lon)) continue;
    const t = sent[i].t;
    if (!Number.isFinite(t)) continue;

    // 找這個貼上去的點落在 shape 的哪個頂點。matched_points 沿線有序，
    // 所以指標只往前走；已經走過最佳解 5 公里就不可能更近了，停手
    let best = cursor;
    let bestDist = Infinity;
    for (let k = cursor; k < shape.length; k++) {
      const d = metersBetween(m.lat!, m.lon!, shape[k][0], shape[k][1]);
      if (d < bestDist) { bestDist = d; best = k; }
      else if (cum[k] - cum[best] > 5000) break;
    }
    cursor = best;

    const last = anchors[anchors.length - 1];
    // 距離不遞減、時間嚴格遞增 —— 內插與動畫都假設時間軸是單調的。
    // 距離可以相等：那就是停留，時間在原地往前走，動畫剛好會停在那裡
    if (last && (cum[best] < last.d || t <= last.t)) continue;
    anchors.push({ d: cum[best], t });
  }

  if (anchors.length < 2) return null;

  const out: MatchedPoint[] = [];
  let a = 0;
  for (let k = 0; k < shape.length; k++) {
    const d = cum[k];
    // 嚴格小於：停留會產生兩個距離相同、時間不同的錨點，用 <= 會直接跳過前者，
    // 整段的起點就變成「離開的時間」而不是「抵達的時間」
    while (a < anchors.length - 2 && anchors[a + 1].d < d) a++;
    const p0 = anchors[a];
    const p1 = anchors[a + 1];
    const span = p1.d - p0.d;
    const ratio = span > 0 ? (d - p0.d) / span : 0;
    out.push({ lat: shape[k][0], lng: shape[k][1], t: p0.t + (p1.t - p0.t) * ratio });
  }
  return out;
}

/**
 * 專案的交通工具對到 Valhalla 的 costing。
 * 回 null 代表這段不該貼路 —— 火車、飛機、船走的不是道路網，
 * 硬貼會把航線扭成一條沿著公路的假路徑，比原本的直線還糟。
 */
export function costingFor(vehicle: string | null | undefined): string | null {
  switch (vehicle) {
    case 'walk': return 'pedestrian';
    case 'bike': return 'bicycle';
    case 'motorbike': return 'motorcycle';
    case 'bus': return 'bus';
    case 'car': return 'auto';
    case 'train':
    case 'plane':
    case 'boat': return null;
    // 沒指定交通工具的段一律當汽車。實務上絕大多數的移動都是，
    // 而 auto 的路網最完整，貼錯的代價最小
    default: return 'auto';
  }
}
