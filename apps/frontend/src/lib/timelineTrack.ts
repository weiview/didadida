// Google 時間軸 →「紀念層」軌跡。
//
// 跟 googleTimeline.ts 是兩條路，刻意不共用 parseTimeline：
//
// parseTimeline 把 visit（停留地點）、activity（路段起訖）、timelinePath（移動取樣）、
// rawSignals（GPS 讀數）通通壓平成一條時間序列。對「照片對時間找位置」來說那是對的 ——
// 停留點的座標正是照片最可能的位置。但拿來畫線就完全錯了：
// semanticSegments 是語意邊界而不是連續 GPS，一段在公司結束、下一段一秒後在別處開始，
// 接起來就是一條橫跨市區的假直線。
//
// 實測 12 年的匯出檔：全部混用有 1,455 段 >200km/h 的假位移，
// 只留 path + raw 之後剩 323 段（78% 消失），而且那 323 段裡多數是真的搭飛機。
// 逐來源的爆掉比率：path→path 0.1%、raw→raw 0.0%，但 path→visit 4.2%、path→act 3.1%。
//
// 這一層唯讀：不修正、不貼路、不參與照片位置推論。它只是「我曾經走過這裡」。

import { parseLatLng, parseIsoWithOffset } from './googleTimeline';

/** [UTC 秒, 緯度, 經度, 時區偏移分鐘] —— 用陣列而不是物件，25 萬點差在好幾 MB */
export type TrackTuple = [number, number, number, number];

export interface TimelineMonth {
  /** 'YYYY-MM' */
  monthKey: string;
  /** 當地日（'YYYY-MM-DD'）→ 該日的點，已按時間遞增 */
  days: Record<string, TrackTuple[]>;
  points: number;
}

export interface ExtractResult {
  months: TimelineMonth[];
  points: number;
  days: number;
  firstDay: string;
  lastDay: string;
  /** 對使用者交代哪些區塊被丟掉、為什麼 */
  notes: string[];
}

/** 沒有時區資訊時當台北。時間軸手機版每筆都自帶，實際上很少用到 */
const FALLBACK_OFFSET_MIN = 480;

interface Raw {
  utcMs: number;
  offsetMin: number;
  lat: number;
  lng: number;
}

/** 當地日。日界線要用當下的時區切，不然出國那幾天會整批跑到隔壁日 */
function localDay(utcMs: number, offsetMin: number): string {
  return new Date(utcMs + offsetMin * 60000).toISOString().slice(0, 10);
}

/**
 * 只抽出真正的移動取樣：semanticSegments[].timelinePath 與 rawSignals[].position。
 * visit 與 activity 一概不讀 —— 連它們的座標都不讀，所以被標成
 * INFERRED_HOME／INFERRED_WORK 的地點根本不會離開這台電腦。
 */
export function extractTrackMonths(json: any): ExtractResult {
  const raws: Raw[] = [];
  const notes: string[] = [];

  const push = (coord: unknown, time: unknown, explicitOffset?: unknown) => {
    const c = parseLatLng(coord);
    const t = parseIsoWithOffset(time);
    if (!c || !t) return;
    const off = Number.isFinite(explicitOffset as number)
      ? (explicitOffset as number)
      : t.offsetMin;
    raws.push({ utcMs: t.utcMs, offsetMin: off ?? FALLBACK_OFFSET_MIN, lat: c.lat, lng: c.lng });
  };

  let pathPts = 0;
  let skippedVisit = 0;
  let skippedAct = 0;
  for (const seg of json?.semanticSegments ?? []) {
    const segOffset = seg?.startTimeTimezoneUtcOffsetMinutes;
    if (seg?.visit) skippedVisit++;
    if (seg?.activity) skippedAct++;

    if (!Array.isArray(seg?.timelinePath)) continue;
    const segStart = parseIsoWithOffset(seg.startTime);
    for (const p of seg.timelinePath) {
      const before = raws.length;
      if (p?.time) {
        push(p.point ?? p, p.time, segOffset);
      } else if (segStart && Number.isFinite(Number(p?.durationMinutesOffsetFromStartTime))) {
        // 部分匯出用「距離起點幾分鐘」而非絕對時間
        const ms = segStart.utcMs + Number(p.durationMinutesOffsetFromStartTime) * 60000;
        push(p.point ?? p, ms, segOffset ?? segStart.offsetMin);
      }
      if (raws.length > before) pathPts++;
    }
  }

  let rawPts = 0;
  for (const sig of json?.rawSignals ?? []) {
    const pos = sig?.position;
    if (!pos) continue;
    const before = raws.length;
    push(pos.LatLng ?? pos.latLng ?? pos, pos.timestamp ?? sig.timestamp);
    if (raws.length > before) rawPts++;
  }

  if (pathPts) notes.push(`移動路徑取樣 ${pathPts.toLocaleString()} 點`);
  if (rawPts) notes.push(`GPS 讀數 ${rawPts.toLocaleString()} 點`);
  if (skippedVisit) notes.push(`未讀取 ${skippedVisit.toLocaleString()} 段停留地點（含住家／公司標記）`);
  if (skippedAct) notes.push(`未讀取 ${skippedAct.toLocaleString()} 段行程起訖點`);
  if (json?.userLocationProfile) notes.push('未讀取 userLocationProfile');
  if (Array.isArray(json?.rawSignals)) notes.push('未讀取 WiFi 掃描與活動辨識');

  raws.sort((a, b) => a.utcMs - b.utcMs);

  // 同一秒重複的點去掉：timelinePath 與 rawSignals 常常記到同一個瞬間，
  // 留著只會多出一堆 dt=0 的腿，畫線與算速度都得為它們寫例外
  const byMonth = new Map<string, Record<string, TrackTuple[]>>();
  const dayKeys = new Set<string>();
  let total = 0;
  let lastSec = NaN;
  for (const r of raws) {
    const sec = Math.round(r.utcMs / 1000);
    if (sec === lastSec) continue;
    lastSec = sec;

    const day = localDay(r.utcMs, r.offsetMin);
    const month = day.slice(0, 7);
    let days = byMonth.get(month);
    if (!days) { days = {}; byMonth.set(month, days); }
    (days[day] ??= []).push([
      sec,
      Number(r.lat.toFixed(6)),
      Number(r.lng.toFixed(6)),
      r.offsetMin,
    ]);
    dayKeys.add(day);
    total++;
  }

  const months: TimelineMonth[] = Array.from(byMonth.entries())
    .map(([monthKey, days]): TimelineMonth => ({
      monthKey,
      days,
      points: Object.keys(days).reduce((n, d) => n + days[d].length, 0),
    }))
    .sort((a, b) => a.monthKey.localeCompare(b.monthKey));

  const sortedDays = Array.from(dayKeys).sort();
  return {
    months,
    points: total,
    days: dayKeys.size,
    firstDay: sortedDays[0] ?? '',
    lastDay: sortedDays[sortedDays.length - 1] ?? '',
    notes,
  };
}

// --- 畫線 ---

/**
 * 超過這個速度就不連線。
 *
 * 剩下的跳點不刪、只斷線：刪點是竄改，斷線只是不宣稱「這兩點之間是連續移動」。
 * 而且真的有搭飛機 —— 大阪→桃園那 1,703 公里本來就不該畫成一條橫跨台灣海峽的直線，
 * 但那趟飛行的兩端都應該留在地圖上。
 */
const MAX_KMH = 200;
/** 超過一小時沒有取樣就斷開。時間軸的取樣中位數是 120 秒，一小時已是它的 30 倍 */
const MAX_GAP_SEC = 3600;

const R = 6371000;
const rad = (d: number) => (d * Math.PI) / 180;
function metersBetween(a: TrackTuple, b: TrackTuple): number {
  const dLat = rad(b[1] - a[1]);
  const dLng = rad(b[2] - a[2]);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

/**
 * 把一串點切成可以連的線段，回傳 [lng, lat] 陣列的陣列。
 * 單點的段丟掉 —— 一個點畫不出線，留著只是讓 GeoJSON 變大。
 */
export function toLineStrings(points: TrackTuple[]): [number, number][][] {
  const out: [number, number][][] = [];
  let cur: [number, number][] = [];

  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    if (i > 0) {
      const prev = points[i - 1];
      const dt = p[0] - prev[0];
      const kmh = dt > 0 ? (metersBetween(prev, p) / dt) * 3.6 : Infinity;
      if (dt > MAX_GAP_SEC || kmh > MAX_KMH) {
        if (cur.length >= 2) out.push(cur);
        cur = [];
      }
    }
    cur.push([p[2], p[1]]);
  }
  if (cur.length >= 2) out.push(cur);
  return out;
}

/**
 * 每個點屬於第幾段連續移動。斷點的判準與 toLineStrings 完全一樣，只是回傳
 * 編號而不是幾何 —— 給貼路用：要先切成「確定是連續移動」的段，matcher 才不會
 * 很認真地幫一段中斷（沒開 app、飛機上）編出一條它其實沒走過的公路。
 *
 * 貼路那邊用的門檻比畫線嚴（斷線只是不宣稱連續，貼路是真的會生出一條路徑），
 * 所以 maxGapSec 開放覆寫；速度上限沿用同一個值。
 */
export function segmentIndices(
  points: TrackTuple[],
  { maxGapSec = MAX_GAP_SEC, maxKmh = MAX_KMH }: { maxGapSec?: number; maxKmh?: number } = {},
): number[] {
  const out: number[] = [];
  let seg = 0;
  for (let i = 0; i < points.length; i++) {
    if (i > 0) {
      const dt = points[i][0] - points[i - 1][0];
      const kmh = dt > 0 ? (metersBetween(points[i - 1], points[i]) / dt) * 3.6 : Infinity;
      if (dt > maxGapSec || kmh > maxKmh) seg++;
    }
    out.push(seg);
  }
  return out;
}
