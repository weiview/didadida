/**
 * 「傳了 12 張照片、2 支影片」這句話。
 *
 * **三個地方共用**：帳號牌的通知清單、左下角那則提示、以及往後任何要講
 * 「這一批是什麼」的地方。分開各寫一份的話，同一批東西在兩個角落會用不同的
 * 量詞（照片是「張」、影片是「支」）——那種不一致比講得不夠漂亮更難看。
 *
 * ⚠️ 零的那一半整個不講，不要寫成「0 支影片」。
 */
export function uploadSummary(photos: number, videos: number): string {
  const parts: string[] = [];
  if (photos > 0) parts.push(`${photos} 張照片`);
  if (videos > 0) parts.push(`${videos} 支影片`);
  // 兩邊都是 0 理論上進不來（後端與 announceUpload 都擋著），但清單是照
  // D1 的舊列畫的，講一句籠統的話總比畫出一行空白好
  return parts.length ? parts.join("、") : "新的東西";
}
