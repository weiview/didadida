// 時區選項與顯示格式。
//
// 這裡刻意不放進前後端共用的 geo.ts —— 那份檔案是語意與運算規則（值域、權威順序、
// 換算），兩邊必須逐字一致；下拉選單要顯示哪些地名純粹是介面決定，後端用不到。
// 合法性檢查在後端（isValidTzOffset：UTC-12 ~ UTC+14 且為 15 分鐘的倍數），
// 這份清單只是把常用的挑出來，不是值域定義。

/** 把偏移分鐘數格式化成 'UTC+08:00' */
export function formatTzOffset(minutes: number): string {
  const sign = minutes < 0 ? '-' : '+';
  const abs = Math.abs(minutes);
  const hh = String(Math.floor(abs / 60)).padStart(2, '0');
  const mm = String(abs % 60).padStart(2, '0');
  return `UTC${sign}${hh}:${mm}`;
}

/** 常用時區。地名只是幫助辨認，同一個偏移量還有很多其他地方 */
export const TZ_OPTIONS: { minutes: number; hint: string }[] = [
  { minutes: -660, hint: '中途島' },
  { minutes: -600, hint: '夏威夷' },
  { minutes: -540, hint: '阿拉斯加' },
  { minutes: -480, hint: '美國西岸' },
  { minutes: -420, hint: '丹佛' },
  { minutes: -360, hint: '芝加哥' },
  { minutes: -300, hint: '美國東岸' },
  { minutes: -240, hint: '加拿大大西洋' },
  { minutes: -180, hint: '巴西、阿根廷' },
  { minutes: 0, hint: '英國、冰島' },
  { minutes: 60, hint: '中歐' },
  { minutes: 120, hint: '東歐、南非' },
  { minutes: 180, hint: '莫斯科、土耳其' },
  { minutes: 240, hint: '杜拜' },
  { minutes: 300, hint: '巴基斯坦' },
  { minutes: 330, hint: '印度' },
  { minutes: 345, hint: '尼泊爾' },
  { minutes: 360, hint: '孟加拉' },
  { minutes: 420, hint: '泰國、越南' },
  { minutes: 480, hint: '台灣、香港、中國' },
  { minutes: 540, hint: '日本、韓國' },
  { minutes: 570, hint: '澳洲中部' },
  { minutes: 600, hint: '澳洲東岸、關島' },
  { minutes: 720, hint: '紐西蘭' },
];

/** 下拉選單用的顯示字串，例如 'UTC+09:00　日本、韓國' */
export function tzOptionLabel(o: { minutes: number; hint: string }): string {
  return o.hint ? `${formatTzOffset(o.minutes)}　${o.hint}` : formatTzOffset(o.minutes);
}

/**
 * 確保清單裡有 minutes 這個選項。
 * 資料庫存的偏移量不見得在上面的常用清單裡（值域比清單大得多），
 * 少了它下拉選單會顯示成別的時區，看起來像資料被改掉了。
 */
export function tzOptionsIncluding(minutes: number | null | undefined): { minutes: number; hint: string }[] {
  if (minutes == null || TZ_OPTIONS.some((o) => o.minutes === minutes)) return TZ_OPTIONS;
  return [...TZ_OPTIONS, { minutes, hint: '' }].sort((a, b) => a.minutes - b.minutes);
}
