// Google Maps 時間軸（Timeline）解析與照片位置比對。
//
// 全程在瀏覽器內完成，原始檔案永遠不會上傳 —— 這份檔案的敏感度高於整個相簿：
// 裡面有被標成 HOME 的座標、住家 WiFi 的 MAC 位址、以及完整的移動史。
// 只有比對結果（photo_id + 座標）會送到後端。
//
// 支援的格式：
//   A. 手機版匯出（2024 年底之後）：{ semanticSegments, rawSignals, userLocationProfile }
//   B. 舊版 Takeout Records.json：{ locations: [{ latitudeE7, longitudeE7, timestamp }] }
//   C. 舊版語意月檔：{ timelineObjects: [{ placeVisit | activitySegment }] }

/** 時間軸上的一個取樣點 */
export interface TimelineSample {
  /** 真正的 UTC 毫秒數 */
  utcMs: number;
  /** 當下的 UTC 偏移（分鐘）。舊格式可能沒有，為 null */
  offsetMin: number | null;
  lat: number;
  lng: number;
  /** 停留地點的名稱（若有） */
  label?: string;
}

export interface ParseResult {
  samples: TimelineSample[];
  format: 'phone' | 'records' | 'semantic' | 'unknown';
  /** 被略過的敏感區塊，用來對使用者交代我們沒有讀它 */
  skipped: string[];
}

const MAX_TZ_OFFSET_MINUTES = 14 * 60;

/**
 * 解析座標。Google 在不同格式裡用了完全不同的表示法：
 *   "50.0506312°, 14.3439906°"（手機版，帶度數符號）
 *   "geo:50.050631,14.343990"
 *   { latitudeE7: 500506312, longitudeE7: 143439906 }（舊版，整數放大 1e7）
 */
export function parseLatLng(raw: unknown): { lat: number; lng: number } | null {
  if (typeof raw === 'string') {
    const s = raw.replace(/geo:/i, '').replace(/°/g, '').trim();
    const parts = s.split(/[,\s]+/).filter(Boolean);
    if (parts.length < 2) return null;
    const lat = Number(parts[0]);
    const lng = Number(parts[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
    // 恰好 (0,0) 是「無定位」的哨兵值
    if (lat === 0 && lng === 0) return null;
    return { lat, lng };
  }
  if (raw && typeof raw === 'object') {
    const o = raw as any;
    if (Number.isFinite(o.latitudeE7) && Number.isFinite(o.longitudeE7)) {
      const lat = o.latitudeE7 / 1e7;
      const lng = o.longitudeE7 / 1e7;
      if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
      if (lat === 0 && lng === 0) return null;
      return { lat, lng };
    }
    if (typeof o.latLng === 'string') return parseLatLng(o.latLng);
    if (typeof o.LatLng === 'string') return parseLatLng(o.LatLng);
  }
  return null;
}

/**
 * 解析帶時區的 ISO 時間，同時取出偏移量。
 * 手機版的時間長這樣："2024-04-03T08:13:57.000+02:00" —— 尾端的 +02:00 就是當下時區，
 * 這正好是照片缺少的 tz_offset_minutes。
 */
export function parseIsoWithOffset(raw: unknown): { utcMs: number; offsetMin: number | null } | null {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    // 舊版 timestampMs 是字串或數字的毫秒數
    return { utcMs: raw, offsetMin: null };
  }
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (/^\d+$/.test(s)) return { utcMs: Number(s), offsetMin: null };

  const utcMs = Date.parse(s);
  if (!Number.isFinite(utcMs)) return null;

  let offsetMin: number | null = null;
  const m = s.match(/([+-])(\d{2}):?(\d{2})$/);
  if (m) {
    const v = Number(m[2]) * 60 + Number(m[3]);
    if (v <= MAX_TZ_OFFSET_MINUTES) offsetMin = m[1] === '-' ? -v : v;
  } else if (/Z$/i.test(s)) {
    offsetMin = 0;
  }
  return { utcMs, offsetMin };
}

function pushSample(out: TimelineSample[], coord: unknown, time: unknown, explicitOffset?: unknown, label?: string) {
  const c = parseLatLng(coord);
  const t = parseIsoWithOffset(time);
  if (!c || !t) return;
  const off = Number.isFinite(explicitOffset as number)
    ? (explicitOffset as number)
    : t.offsetMin;
  out.push({ utcMs: t.utcMs, offsetMin: off ?? null, lat: c.lat, lng: c.lng, label });
}

/** 解析整份 Timeline JSON，回傳依時間排序的取樣點 */
export function parseTimeline(json: any): ParseResult {
  const samples: TimelineSample[] = [];
  const skipped: string[] = [];
  let format: ParseResult['format'] = 'unknown';

  // --- A. 手機版匯出 ---
  const segments = json?.semanticSegments ?? (Array.isArray(json) ? json : null);
  if (Array.isArray(segments) && segments.length > 0 && segments.some((s: any) => s?.timelinePath || s?.visit || s?.startTime)) {
    format = 'phone';
    for (const seg of segments) {
      const segOffset = seg?.startTimeTimezoneUtcOffsetMinutes;

      // 停留地點：整段時間都在同一個座標
      const visitLoc = seg?.visit?.topCandidate?.placeLocation;
      if (visitLoc) {
        const label = seg?.visit?.topCandidate?.semanticType || undefined;
        pushSample(samples, visitLoc.latLng ?? visitLoc, seg.startTime, segOffset, label);
        if (seg.endTime) pushSample(samples, visitLoc.latLng ?? visitLoc, seg.endTime, seg?.endTimeTimezoneUtcOffsetMinutes ?? segOffset, label);
      }

      // 移動路徑：逐點的座標與時間
      if (Array.isArray(seg?.timelinePath)) {
        const segStart = parseIsoWithOffset(seg.startTime);
        for (const p of seg.timelinePath) {
          if (p?.time) {
            pushSample(samples, p.point ?? p, p.time, segOffset);
          } else if (segStart && Number.isFinite(Number(p?.durationMinutesOffsetFromStartTime))) {
            // 部分匯出用「距離起點幾分鐘」而非絕對時間
            const ms = segStart.utcMs + Number(p.durationMinutesOffsetFromStartTime) * 60000;
            pushSample(samples, p.point ?? p, ms, segOffset ?? segStart.offsetMin);
          }
        }
      }

      // 移動路段的起訖點
      const act = seg?.activity;
      if (act) {
        pushSample(samples, act?.start?.latLng ?? act?.start, seg.startTime, segOffset);
        pushSample(samples, act?.end?.latLng ?? act?.end, seg.endTime, seg?.endTimeTimezoneUtcOffsetMinutes ?? segOffset);
      }
    }

    // rawSignals 的 position 精度最高，一併採用；
    // 但 wifiScan（含 MAC 位址）與 activityRecord 完全不讀。
    if (Array.isArray(json?.rawSignals)) {
      let usedPositions = 0;
      for (const sig of json.rawSignals) {
        const pos = sig?.position;
        if (!pos) continue;
        const before = samples.length;
        pushSample(samples, pos.LatLng ?? pos.latLng ?? pos, pos.timestamp ?? sig.timestamp);
        if (samples.length > before) usedPositions++;
      }
      if (usedPositions > 0) skipped.push(`rawSignals：採用 ${usedPositions} 筆 GPS 讀數，未讀取 WiFi 掃描與活動辨識`);
      else skipped.push('rawSignals：未讀取');
    }
    if (json?.userLocationProfile) {
      skipped.push('userLocationProfile（住家/公司標記）：未讀取');
    }
  }

  // --- B. 舊版 Records.json ---
  if (samples.length === 0 && Array.isArray(json?.locations)) {
    format = 'records';
    for (const loc of json.locations) {
      pushSample(samples, loc, loc.timestamp ?? loc.timestampMs);
    }
  }

  // --- C. 舊版語意月檔 ---
  if (samples.length === 0 && Array.isArray(json?.timelineObjects)) {
    format = 'semantic';
    for (const obj of json.timelineObjects) {
      const pv = obj?.placeVisit;
      if (pv) {
        const loc = pv.location;
        pushSample(samples, loc, pv?.duration?.startTimestamp ?? pv?.duration?.startTimestampMs, undefined, loc?.name);
        pushSample(samples, loc, pv?.duration?.endTimestamp ?? pv?.duration?.endTimestampMs, undefined, loc?.name);
      }
      const as = obj?.activitySegment;
      if (as) {
        pushSample(samples, as.startLocation, as?.duration?.startTimestamp ?? as?.duration?.startTimestampMs);
        pushSample(samples, as.endLocation, as?.duration?.endTimestamp ?? as?.duration?.endTimestampMs);
        if (Array.isArray(as?.waypointPath?.waypoints)) {
          // waypoints 沒有各自的時間，均分在整段之間
          const s = parseIsoWithOffset(as?.duration?.startTimestamp ?? as?.duration?.startTimestampMs);
          const e = parseIsoWithOffset(as?.duration?.endTimestamp ?? as?.duration?.endTimestampMs);
          const wps = as.waypointPath.waypoints;
          if (s && e && wps.length > 1) {
            wps.forEach((w: any, i: number) => {
              const t = s.utcMs + ((e.utcMs - s.utcMs) * i) / (wps.length - 1);
              pushSample(samples, { latitudeE7: w.latE7, longitudeE7: w.lngE7 }, t, s.offsetMin);
            });
          }
        }
      }
    }
  }

  samples.sort((a, b) => a.utcMs - b.utcMs);
  return { samples, format, skipped };
}

/** 取樣點在「當地牆上時間」的毫秒數，用於與照片的牆上時間比對 */
function wallMs(s: TimelineSample, fallbackOffsetMin: number): number {
  return s.utcMs + (s.offsetMin ?? fallbackOffsetMin) * 60000;
}

/** 'YYYY-MM-DD HH:MM:SS' → 當成 UTC 解讀的毫秒數（純粹作為牆上時間的可比較數值） */
export function localStringToMs(local: string): number {
  const m = local.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return NaN;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] ?? 0));
}

export interface MatchInput {
  id: number;
  /** 牆上時間 'YYYY-MM-DD HH:MM:SS' */
  localTime: string;
}

export interface MatchResult {
  photoId: number;
  lat: number;
  lng: number;
  placeName?: string;
  tzOffsetMinutes?: number;
  /** 照片時間與最近取樣點的差距（分鐘），越小越可信 */
  gapMinutes: number;
}

export interface MatchOptions {
  /** 照片時間與取樣點的最大容許差距（分鐘） */
  toleranceMinutes?: number;
  /** 取樣點沒有時區資訊時的預設偏移（分鐘），台灣為 480 */
  fallbackOffsetMinutes?: number;
}

/**
 * 用牆上時間把照片對到時間軸上的位置。
 *
 * 為什麼用牆上時間而不是 UTC：舊照片的 taken_at 是「牆上時間被當成 UTC」存下來的，
 * 直接當 UTC 比對會整批偏掉。而牆上時間在兩邊指的是同一件事 —— 照片上寫 09:30，
 * 時間軸還原出來當地也是 09:30，不管人在哪個時區都對得上。
 */
export function matchPhotosToTimeline(
  photos: MatchInput[],
  samples: TimelineSample[],
  options: MatchOptions = {},
): MatchResult[] {
  const tolerance = (options.toleranceMinutes ?? 30) * 60000;
  const fallbackOffset = options.fallbackOffsetMinutes ?? 0;
  if (samples.length === 0) return [];

  const wall = samples.map((s) => wallMs(s, fallbackOffset));
  const out: MatchResult[] = [];

  for (const p of photos) {
    const t = localStringToMs(p.localTime);
    if (!Number.isFinite(t)) continue;

    // 二分搜尋出第一個 >= t 的取樣點
    let lo = 0, hi = wall.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (wall[mid] < t) lo = mid + 1; else hi = mid;
    }
    const after = lo < wall.length ? lo : -1;
    const before = lo > 0 ? lo - 1 : -1;

    const dBefore = before >= 0 ? t - wall[before] : Infinity;
    const dAfter = after >= 0 ? wall[after] - t : Infinity;
    if (dBefore > tolerance && dAfter > tolerance) continue;

    let lat: number, lng: number, gap: number, label: string | undefined, off: number | null;

    if (before >= 0 && after >= 0 && dBefore <= tolerance && dAfter <= tolerance) {
      // 前後都在容許範圍內 → 依時間比例內插，位置更貼近實際
      const span = wall[after] - wall[before];
      const r = span > 0 ? (t - wall[before]) / span : 0;
      lat = samples[before].lat + (samples[after].lat - samples[before].lat) * r;
      lng = samples[before].lng + (samples[after].lng - samples[before].lng) * r;
      gap = Math.min(dBefore, dAfter);
      const nearer = dBefore <= dAfter ? before : after;
      label = samples[nearer].label;
      off = samples[nearer].offsetMin;
    } else {
      const idx = dBefore <= dAfter ? before : after;
      lat = samples[idx].lat;
      lng = samples[idx].lng;
      gap = Math.min(dBefore, dAfter);
      label = samples[idx].label;
      off = samples[idx].offsetMin;
    }

    out.push({
      photoId: p.id,
      lat: Number(lat.toFixed(6)),
      lng: Number(lng.toFixed(6)),
      placeName: label,
      tzOffsetMinutes: off ?? undefined,
      gapMinutes: Math.round(gap / 60000),
    });
  }

  return out;
}
