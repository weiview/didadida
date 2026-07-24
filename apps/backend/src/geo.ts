// EXIF 地理座標與時區正規化。
//
// 註：本檔在 apps/backend/src/geo.ts 與 apps/frontend/src/lib/geo.ts 各有一份相同副本。
// 上傳路徑由前端解析 EXIF、Google 同步路徑由後端解析，兩邊都需要同一套邏輯。
// 專案的 workspaces 尚未建立 packages/ 共用套件，目前以複製取代建置設定的複雜度。
// **修改時請同步兩邊**。

export interface NormalizedGeo {
  lat: number | null;
  lng: number | null;
  /** 有座標時為 'exif'，否則 null（留給行程段/內插填） */
  geoSource: 'exif' | null;
  /** UTC 瞬間 ISO 字串，用於排序與去重 */
  takenAtUtc: string | null;
  /** 牆上時間 'YYYY-MM-DD HH:MM:SS'，用於顯示與行程段比對 */
  takenAtLocal: string | null;
  tzOffsetMinutes: number | null;
}

/** 地球上實際存在的最大時區偏移為 UTC+14 */
const MAX_TZ_OFFSET_MINUTES = 14 * 60;

export interface WallClock {
  y: number; mo: number; d: number; h: number; mi: number; s: number;
}

/**
 * 解析 EXIF OffsetTimeOriginal（tag 0x9011），如 "+09:00"。
 * 這是時區的第一層來源，最準確 —— iPhone (iOS 11+) 與近年 Android 都會寫。
 */
export function parseOffsetTime(raw: unknown): number | null {
  if (typeof raw !== 'string') return null;
  // 部分相機會在字串尾端補 NUL，先清掉
  const m = raw.replace(/\0/g, '').trim().match(/^([+-])(\d{1,2}):?(\d{2})$/);
  if (!m) return null;
  const minutes = Number(m[2]) * 60 + Number(m[3]);
  if (!Number.isFinite(minutes) || minutes > MAX_TZ_OFFSET_MINUTES) return null;
  return m[1] === '-' ? -minutes : minutes;
}

/**
 * 解析 EXIF 日期時間字串 'YYYY:MM:DD HH:MM:SS'。
 * EXIF 此欄位不帶時區，讀出來的就是拍攝當下的牆上時間。
 *
 * 也接受 Date 物件（exifr 預設會 revive），但那已被 exifr 以執行環境時區解讀過，
 * 這裡以 UTC getter 取回原始數字才不會二次位移。
 */
export function parseExifDateTime(raw: unknown): WallClock | null {
  if (raw instanceof Date) {
    if (Number.isNaN(raw.getTime())) return null;
    return {
      y: raw.getUTCFullYear(), mo: raw.getUTCMonth() + 1, d: raw.getUTCDate(),
      h: raw.getUTCHours(), mi: raw.getUTCMinutes(), s: raw.getUTCSeconds(),
    };
  }
  if (typeof raw !== 'string') return null;
  const m = raw.replace(/\0/g, '').trim()
    .match(/^(\d{4})[:\-](\d{2})[:\-](\d{2})[T ](\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  const wc: WallClock = {
    y: +m[1], mo: +m[2], d: +m[3], h: +m[4], mi: +m[5], s: +m[6],
  };
  // EXIF 未設定時間時常見全為 0
  if (wc.y < 1900 || wc.mo < 1 || wc.mo > 12 || wc.d < 1 || wc.d > 31) return null;
  return wc;
}

/** 把牆上時間當成 UTC 來取毫秒數（用於與 GPS UTC 相減求偏移） */
export function wallClockAsUtcMs(wc: WallClock): number {
  return Date.UTC(wc.y, wc.mo - 1, wc.d, wc.h, wc.mi, wc.s);
}

/** GPSDateStamp 'YYYY:MM:DD' + GPSTimeStamp [h,m,s] 組成真正的 UTC 毫秒數 */
export function gpsUtcMs(dateStamp: unknown, timeStamp: unknown): number | null {
  if (typeof dateStamp !== 'string') return null;
  const dm = dateStamp.replace(/\0/g, '').trim().match(/^(\d{4})[:\-](\d{2})[:\-](\d{2})$/);
  if (!dm) return null;

  let h = 0, mi = 0, s = 0;
  if (Array.isArray(timeStamp) && timeStamp.length >= 3) {
    [h, mi, s] = timeStamp.map(Number);
  } else if (typeof timeStamp === 'string') {
    const tm = timeStamp.trim().match(/^(\d{1,2}):(\d{2}):(\d{2}(?:\.\d+)?)$/);
    if (!tm) return null;
    h = +tm[1]; mi = +tm[2]; s = +tm[3];
  } else {
    return null;
  }
  if (![h, mi, s].every(Number.isFinite)) return null;

  return Date.UTC(+dm[1], +dm[2] - 1, +dm[3], h, mi, Math.round(s));
}

/**
 * 推導拍攝當下的時區偏移（分鐘）。
 *   第一層：OffsetTimeOriginal，直接可用。
 *   第二層：GPSDateStamp/GPSTimeStamp 記的是 UTC，DateTimeOriginal 是牆上時間，
 *           兩者相減就是偏移。只要照片有 GPS 就一定算得出來，不需查任何時區資料庫。
 *   第三層（不在此處）：由呼叫端以行程段的 tz_offset_minutes 兜底。
 */
export function deriveTzOffsetMinutes(exif: any): number | null {
  const direct = parseOffsetTime(exif?.OffsetTimeOriginal);
  if (direct !== null) return direct;

  const wc = parseExifDateTime(exif?.DateTimeOriginal);
  const utcMs = gpsUtcMs(exif?.GPSDateStamp, exif?.GPSTimeStamp);
  if (!wc || utcMs === null) return null;

  const diffMinutes = (wallClockAsUtcMs(wc) - utcMs) / 60000;
  if (!Number.isFinite(diffMinutes) || Math.abs(diffMinutes) > MAX_TZ_OFFSET_MINUTES) return null;

  // 真實時區都是 15 分鐘的倍數；四捨五入到 15 分可吸收相機時鐘的少量誤差。
  // 相機時鐘若偏離超過 7.5 分鐘，推出來的偏移就會差一格，屬已知限制。
  return Math.round(diffMinutes / 15) * 15;
}

const pad = (n: number, len = 2) => String(Math.abs(n)).padStart(len, '0');

/** 格式化為 'YYYY-MM-DD HH:MM:SS'（與 TripSegment.start_local/end_local 同格式才能直接字串比對） */
export function formatWallClock(wc: WallClock): string {
  return `${pad(wc.y, 4)}-${pad(wc.mo)}-${pad(wc.d)} ${pad(wc.h)}:${pad(wc.mi)}:${pad(wc.s)}`;
}

/** 由 UTC 毫秒數與偏移算出牆上時間 */
export function wallClockFromUtc(utcMs: number, offsetMinutes: number): WallClock {
  const d = new Date(utcMs + offsetMinutes * 60000);
  return {
    y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate(),
    h: d.getUTCHours(), mi: d.getUTCMinutes(), s: d.getUTCSeconds(),
  };
}

/**
 * 取出十進位座標。
 * 優先用 exifr 已換算好的 latitude/longitude；退而求其次才用 DMS 陣列 + Ref。
 * 缺 Ref 時不猜半球 —— 猜錯會把台北放到南半球，寧可回 null。
 */
export function toDecimalCoord(
  decimal: unknown,
  dms: unknown,
  ref: unknown,
  max: number,
): number | null {
  if (typeof decimal === 'number' && Number.isFinite(decimal) && Math.abs(decimal) <= max) {
    return decimal;
  }

  let magnitude: number | null = null;
  if (Array.isArray(dms) && dms.length >= 1) {
    const [d = 0, m = 0, s = 0] = dms.map(Number);
    if ([d, m, s].every(Number.isFinite)) magnitude = Math.abs(d) + Math.abs(m) / 60 + Math.abs(s) / 3600;
  } else if (typeof dms === 'number' && Number.isFinite(dms)) {
    magnitude = Math.abs(dms);
  }
  if (magnitude === null || magnitude > max) return null;

  const r = typeof ref === 'string' ? ref.replace(/\0/g, '').trim().toUpperCase() : '';
  if (r === 'S' || r === 'W') return -magnitude;
  if (r === 'N' || r === 'E') return magnitude;
  return null;
}

/**
 * 把一份（已通過白名單的）EXIF 物件正規化成可直接寫入 DB 的地理與時間欄位。
 *
 * @param exif        白名單後的 EXIF 物件
 * @param fallbackIso 沒有 DateTimeOriginal 時的備援時間（如 Google 的 creationTime）
 */
export function normalizeGeo(exif: any, fallbackIso?: string | null): NormalizedGeo {
  const out: NormalizedGeo = {
    lat: null, lng: null, geoSource: null,
    takenAtUtc: null, takenAtLocal: null, tzOffsetMinutes: null,
  };
  if (!exif || typeof exif !== 'object') exif = {};

  // --- 座標 ---
  const lat = toDecimalCoord(exif.latitude, exif.GPSLatitude, exif.GPSLatitudeRef, 90);
  const lng = toDecimalCoord(exif.longitude, exif.GPSLongitude, exif.GPSLongitudeRef, 180);
  // 恰好 (0, 0) 是「無 GPS」的經典哨兵值（大西洋上的空海域），視為沒有座標
  if (lat !== null && lng !== null && !(lat === 0 && lng === 0)) {
    out.lat = lat;
    out.lng = lng;
    out.geoSource = 'exif';
  }

  // --- 時區與時間 ---
  out.tzOffsetMinutes = deriveTzOffsetMinutes(exif);

  const wc = parseExifDateTime(exif.DateTimeOriginal);
  if (wc) {
    out.takenAtLocal = formatWallClock(wc);
    // 牆上時間扣掉偏移 = 真正的 UTC 瞬間。無偏移時只能當作已是 UTC，
    // 此時 taken_at 會有誤差，待行程段補上 tz 後可重算。
    out.takenAtUtc = new Date(
      wallClockAsUtcMs(wc) - (out.tzOffsetMinutes ?? 0) * 60000,
    ).toISOString();
  } else if (fallbackIso) {
    const ms = Date.parse(fallbackIso);
    if (Number.isFinite(ms)) {
      out.takenAtUtc = new Date(ms).toISOString();
      out.takenAtLocal = formatWallClock(wallClockFromUtc(ms, out.tzOffsetMinutes ?? 0));
    }
  }

  return out;
}
