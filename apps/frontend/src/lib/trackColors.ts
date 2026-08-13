/**
 * 地圖上每個人的軌跡顏色。
 *
 * **這份清單跟後端 `apps/backend/src/index.ts` 的 `TRACK_PALETTE` 必須一致** ——
 * 後端只收清單裡的值（不在清單裡回 400），這裡少一個顏色只是畫不出那顆色票，
 * 多一個顏色則會讓人按了之後被退回。兩邊要一起改。
 *
 * 為什麼是固定清單而不是自由取色：這幾個顏色在 OpenFreeMap positron 底圖上
 * 彼此分得開，也不會跟道路／水域／行政區界撞色。開放任意 hex 的話，
 * 有人選了淺灰就等於他的軌跡消失了。
 *
 * 「誰是什麼顏色」不在這裡算 —— 後端一律回算好的值（`track_color` 永遠有值，
 * 沒挑過就依 uid 給預設）。前端只負責畫色票列。
 */
export const TRACK_PALETTE: { hex: string; name: string }[] = [
  { hex: '#7c3aed', name: '紫' },
  { hex: '#2563eb', name: '藍' },
  { hex: '#0d9488', name: '青' },
  { hex: '#16a34a', name: '綠' },
  { hex: '#ca8a04', name: '芥末黃' },
  { hex: '#ea580c', name: '橘' },
  { hex: '#db2777', name: '桃紅' },
  { hex: '#dc2626', name: '紅' },
  { hex: '#0891b2', name: '天藍' },
  { hex: '#65a30d', name: '草綠' },
];

/**
 * 沒有任何身分資訊時的軌跡顏色（也是後端調色盤的第一個）。
 *
 * 用得到的地方：地圖上那些不屬於任何人的線 —— 舊資料還沒 backfill 到 user_id、
 * 或衍生資料（貼路結果）查不回擁有者。跟改動之前的貼路線同色，所以退到這裡
 * 看起來不會像壞掉。
 */
export const DEFAULT_TRACK_COLOR = TRACK_PALETTE[0].hex;
