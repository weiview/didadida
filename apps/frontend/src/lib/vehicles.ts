// 交通工具的標籤與速度推測。
//
// 這裡的交通工具**不是拿來畫圖示的**，是拿來決定貼路要用哪個 Valhalla costing
// （見 mapmatch.ts 的 costingFor）—— 走路的軌跡套汽車路網會被吸到馬路上。
// 地圖上一律只畫一個飛碟（MOVER_EMOJI）：依速度猜出來的交通工具本來就常常猜錯
// （機車與汽車在速度上根本分不開），畫成一堆真實的車輛圖示等於把猜測當事實展示。
// 飛碟不宣稱任何事，就只是「這個東西正在移動」。
//
// 用 emoji 而不是自畫的 SVG：地圖上的圖示是靠 canvas 畫成點陣圖再 map.addImage
// 進去的，走的是作業系統的 emoji 字型，不是底圖樣式的 SDF 字型（OpenFreeMap 的
// Noto Sans 沒有 emoji 字符，直接寫進 text-field 只會變豆腐）。

import type { Vehicle } from './api';

/** 地圖上唯一的移動圖示。動畫的頭端與播放列都用它 */
export const MOVER_EMOJI = '🛸';

// 只有 vehicleLabel 用得到（貼路的 log 要寫出中文名）。
// 手動指定交通工具的介面已經拿掉，所以這份表不再對外
const VEHICLES: { id: Vehicle; label: string }[] = [
  { id: 'walk', label: '走路' },
  { id: 'bike', label: '腳踏車' },
  { id: 'motorbike', label: '機車' },
  { id: 'car', label: '汽車' },
  { id: 'bus', label: '公車' },
  { id: 'train', label: '火車' },
  { id: 'plane', label: '飛機' },
  { id: 'boat', label: '船' },
];

const BY_ID = new Map(VEHICLES.map((v) => [v.id, v]));

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

/**
 * 依速度猜交通工具。
 *
 * 猜得出來的只有「速度級距」。機車／汽車／公車／船在速度上根本分不開，
 * 所以這裡刻意只回幾個粗級距 —— 它的唯一用途是挑 Valhalla 的 costing，
 * 而 costingFor 本來就把機車／公車／汽車對到同一個 auto。
 */
export function vehicleFromSpeed(kmh: number): Vehicle {
  if (kmh < 7) return 'walk';
  if (kmh < 20) return 'bike';
  if (kmh < 90) return 'car';
  if (kmh < 350) return 'train';
  return 'plane';
}

/** 軌跡段的識別字串。整個前端都用這個當 key */
export function segmentKey(dayKey: string, seg: number): string {
  return `${dayKey}#${seg}`;
}
