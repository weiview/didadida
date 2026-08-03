// 交通工具的圖示、標籤與速度推測。
//
// 圖示用 emoji 而不是自畫的 SVG：地圖上的圖示是靠 canvas 畫成點陣圖再
// map.addImage 進去的，走的是作業系統的 emoji 字型，不是底圖樣式的 SDF 字型
// （OpenFreeMap 的 Noto Sans 沒有 emoji 字符，直接寫進 text-field 只會變豆腐）。
// 這樣一個字元就換到一個圖示，不用維護八張向量圖。

import type { TrackPoint, Vehicle } from './api';

export const VEHICLES: { id: Vehicle; label: string; emoji: string }[] = [
  { id: 'walk', label: '走路', emoji: '🚶' },
  { id: 'bike', label: '腳踏車', emoji: '🚲' },
  { id: 'motorbike', label: '機車', emoji: '🏍️' },
  { id: 'car', label: '汽車', emoji: '🚗' },
  { id: 'bus', label: '公車', emoji: '🚌' },
  { id: 'train', label: '火車', emoji: '🚆' },
  { id: 'plane', label: '飛機', emoji: '✈️' },
  { id: 'boat', label: '船', emoji: '⛴️' },
];

const BY_ID = new Map(VEHICLES.map((v) => [v.id, v]));

export function vehicleEmoji(v: Vehicle): string {
  return BY_ID.get(v)?.emoji ?? '📍';
}

export function vehicleLabel(v: Vehicle): string {
  return BY_ID.get(v)?.label ?? v;
}

const EARTH_RADIUS_M = 6371000;

/**
 * 兩點的地表距離（公尺）。等距長方近似，幾十公里內誤差可忽略。
 *
 * gpx.ts 裡另有一份一樣的實作，那是刻意的 —— 它屬於匯入路徑，
 * 會被單獨編譯出來在 Node 裡測試，不應該把整個 UI 端的相依拖進去。
 */
export function metersBetween(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const rad = Math.PI / 180;
  const cosLat = Math.cos(((aLat + bLat) / 2) * rad);
  const dx = (bLng - aLng) * rad * cosLat * EARTH_RADIUS_M;
  const dy = (bLat - aLat) * rad * EARTH_RADIUS_M;
  return Math.hypot(dx, dy);
}

function distanceM(a: TrackPoint, b: TrackPoint): number {
  return metersBetween(a.lat, a.lng, b.lat, b.lng);
}

/**
 * 依速度猜交通工具。
 *
 * 猜得出來的只有「速度級距」。機車／汽車／公車／船在速度上根本分不開 ——
 * 這正是每段可以手動指定的理由，手動值永遠蓋過這裡的結果。
 */
export function vehicleFromSpeed(kmh: number): Vehicle {
  if (kmh < 7) return 'walk';
  if (kmh < 20) return 'bike';
  if (kmh < 90) return 'car';
  if (kmh < 350) return 'train';
  return 'plane';
}

/**
 * 一段軌跡的代表速度（km/h）。
 *
 * 取瞬時速度的 85 百分位，不取平均：平均會被停等紅燈與停留點稀釋成走路速度，
 * 最大值又會被單一個 GPS 跳點灌成飛機。85 百分位大致等於「這段在跑的時候多快」。
 */
export function segmentSpeedKmh(points: TrackPoint[]): number {
  const speeds: number[] = [];
  for (let i = 1; i < points.length; i++) {
    const dtSec = (Date.parse(points[i].t_utc) - Date.parse(points[i - 1].t_utc)) / 1000;
    // 停留點的兩端相隔好幾小時、距離為零，算進來只會拉低整體速度
    if (dtSec <= 0 || dtSec > 600) continue;
    speeds.push((distanceM(points[i - 1], points[i]) / dtSec) * 3.6);
  }
  if (speeds.length === 0) return 0;
  speeds.sort((a, b) => a - b);
  return speeds[Math.min(speeds.length - 1, Math.floor(speeds.length * 0.85))];
}

/** 軌跡段的識別字串。整個前端都用這個當 key */
export function segmentKey(dayKey: string, seg: number): string {
  return `${dayKey}#${seg}`;
}

export interface SegmentInfo {
  key: string;
  dayKey: string;
  seg: number;
  points: TrackPoint[];
  from: string;
  to: string;
  speedKmh: number;
  /** 使用者指定的值，沒指定就是 null */
  manual: Vehicle | null;
  /** 依速度猜出來的值。手動指定時仍然算出來，選單才能顯示「自動會選什麼」 */
  guess: Vehicle;
  /** 實際要用的圖示：手動優先，否則用 guess */
  vehicle: Vehicle;
}

/** 把軌跡點切成段，並解出每段該用哪個交通工具 */
export function buildSegments(
  tracks: TrackPoint[],
  manualByKey: Map<string, Vehicle | null>,
): SegmentInfo[] {
  const groups = new Map<string, TrackPoint[]>();
  for (const p of tracks) {
    const key = segmentKey(p.day_key, p.seg);
    const list = groups.get(key);
    if (list) list.push(p);
    else groups.set(key, [p]);
  }

  const out: SegmentInfo[] = [];
  for (const [key, points] of Array.from(groups.entries())) {
    const speedKmh = segmentSpeedKmh(points);
    const manual = manualByKey.get(key) ?? null;
    const guess = vehicleFromSpeed(speedKmh);
    out.push({
      key,
      dayKey: points[0].day_key,
      seg: points[0].seg,
      points,
      from: points[0].t_utc,
      to: points[points.length - 1].t_utc,
      speedKmh,
      manual,
      guess,
      vehicle: manual ?? guess,
    });
  }
  out.sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));
  return out;
}
