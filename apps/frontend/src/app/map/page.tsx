'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import dynamic from 'next/dynamic';
import {
  fetchFootprint, fetchAlbums, fetchTripSegments, deleteTripSegment,
  setAlbumMapPrivacy,
  fetchDriveGpxFiles, fetchDriveGpxText, ingestTrack, fetchTracks,
  editTrackPoints,
  saveTrackRaw, fetchTrackRaw, fetchTrackDays, updatePhotoGeo,
  matchTrackShape, saveTrackMatched, fetchTrackMatched, deleteTrackMatched,
  fetchTimelineIndex, fetchTimelineMonth,
  type FootprintPoint, type Album, type TripSegment, type TrackPoint,
  type TrackPointEdit, type TrackDay, type MatchedTrack,
  type TimelineIndex, type TimelineMonthData,
} from '@/lib/api';
import { toLineStrings, segmentIndices, type TrackTuple } from '@/lib/timelineTrack';
import { useAdmin } from '@/lib/useAdmin';
import { parseGpx, simplifyTrack, collapseStays, rejectSpikes, extractTrips, type GpxPoint } from '@/lib/gpx';
import { subsampleForMatch, buildMatchedTrack, costingFor, type MatchInput } from '@/lib/mapmatch';
// 交通工具只剩貼路要用：Valhalla 的 costing 得知道這一趟是走路還是開車，
// 火車與飛機則整趟跳過（它們走的不是道路網）。地圖上一律是幽浮，
// 手動指定的介面也拿掉了，所以這裡只留「依速度猜」與它的中文名
import { vehicleLabel, vehicleFromSpeed } from '@/lib/vehicles';
import FootprintDayPicker, { monthOf, todayLocal } from '@/components/FootprintDayPicker';

// maplibre 需要 window，不能在伺服器端渲染
const FootprintMap = dynamic(() => import('@/components/FootprintMap'), {
  ssr: false,
  loading: () => <div style={{ height: 520, display: 'grid', placeItems: 'center', color: '#64748b' }}>地圖載入中…</div>,
});

// 只有按下按鈕才需要載入解析器，不拖累首次進頁
const TimelineImportModal = dynamic(() => import('@/components/TimelineImportModal'), { ssr: false });

/**
 * 把日期框的本地日（YYYY-MM-DD）換算成 UTC 瞬間，給軌跡查詢當邊界用。
 *
 * 軌跡存的是 t_utc，日期框給的卻是本地日。直接拿去比的話，台北（UTC+8）選 8/3
 * 實際撈到的是台北 8/3 08:00 起 —— 早上出門那段整段落在邊界外，地圖上的線
 * 就從路途一半開始。（照片那層沒這問題，後端比的是當地牆上時間。）
 *
 * 結尾沒有 Z 的 ISO 字串，瀏覽器一律當本地時間解讀，正好是要的語意。
 * 代價是以瀏覽器所在時區為準：人在國外看國內的軌跡，邊界會跟著差那幾小時。
 */
function localDayToUtc(day: string, endOfDay = false): string | undefined {
  const t = Date.parse(`${day}T${endOfDay ? '23:59:59.999' : '00:00:00'}`);
  return Number.isFinite(t) ? new Date(t).toISOString() : undefined;
}

/**
 * 要貼路的一天。帶著 md5 而不是只給 dayKey，是為了讓自動流程能用「剛剛同步下來的」
 * 那個值 —— 同步完 trackDays 還沒重載回來，這時去讀 state 會拿到舊的。
 */
interface MatchTarget {
  dayKey: string;
  md5: string | null;
}

/*
 * Google 時間軸貼路後的 day_key 前綴。
 *
 * 貼路結果存在 R2 的 `tracks/<day_key>.matched.json`，而時間軸的日子在 D1 的
 * TrackDay 裡根本沒有一列 —— 那一層是唯讀紀念層，刻意不進資料庫。加上前綴是
 * 為了讓這兩批結果在同一個 bucket 裡不會撞在一起，也讓後端一眼認得出
 * 「這個 key 沒有 TrackDay 可查，隱私要走另一條路」（見 isTrackDayPublic）。
 */
const TIMELINE_DAY_PREFIX = 'timeline:';
/**
 * 一次最多處理幾天的時間軸。
 * 這個數字同時擋住兩件事：讀取時每天一次 R2 GET，貼路時每趟一次 Valhalla 請求。
 * 沒有上限的話「不選日期」就等於一次讀十二年、打爆別人家的伺服器。
 */
const TIMELINE_MAX_DAYS = 62;

/** 上次自動同步的時間戳（毫秒）存這個 key */
const AUTO_SYNC_KEY = 'didadida:lastAutoSync';
/**
 * 自動同步的冷卻時間。在頁面之間切來切去、重新整理都會重新掛載，
 * 沒有冷卻的話每次都會多打一趟 Drive。額度上無所謂，但沒有意義。
 */
const AUTO_SYNC_COOLDOWN_MS = 60 * 60 * 1000;

export default function MapPage() {
  const [points, setPoints] = useState<FootprintPoint[]>([]);
  const [tracks, setTracks] = useState<TrackPoint[]>([]);
  const [albums, setAlbums] = useState<Album[]>([]);
  const [segments, setSegments] = useState<TripSegment[]>([]);
  const { isAdmin } = useAdmin();
  const [loading, setLoading] = useState(true);
  const [showTimelineImport, setShowTimelineImport] = useState(false);
  // 管理工具整區收合。預設收起來 —— 平常來這一頁是要看地圖的，
  // 而貼路與同步都已經自動化，工具區不再是每次都要用的東西
  const [showAdminTools, setShowAdminTools] = useState(false);
  const [syncing, setSyncing] = useState(false);
  // 同步過程逐行累積，每個檔案結束就更新一次 —— 這是一個會跑好幾秒的操作
  const [syncLog, setSyncLog] = useState<string[]>([]);
  // 停留點濃縮的參數是在匯入時寫死進資料的，改了參數就得繞過 md5 比對整批重灌
  const [forceSync, setForceSync] = useState(false);
  // D1 裡有的所有軌跡日（不受畫面上的日期篩選影響）。
  // 拿來算 gpsDays（決定哪幾天輪得到 Google 時間軸貼路）與查 has_raw / md5
  const [trackDays, setTrackDays] = useState<TrackDay[]>([]);

  /*
   * 地圖上畫哪幾層，已經不再是開關而是定案：
   *
   * 貼路軌跡是唯一畫出來的軌跡，動畫也沿著它跑。濃縮軌跡（綠線＋停留圈）與原始 GPX
   * 對照層都拿掉了 —— 它們是拿來檢查「貼路貼得準不準」的除錯工具，三條線疊在一起
   * 反而看不出東西。照片之間的連線也拿掉：那是推測出來的路徑，不是走過的路，
   * 地圖上只留一個一個的點。
   *
   * 這些常數留著而不是把 FootprintMap 的參數一起砍掉，是因為那些圖層在元件裡
   * 仍然完整可用，只是這一頁不用它們。要回頭比對時改這裡就行。
   */
  const SHOW_RAW_LINE = false;
  const SHOW_TRACK_LINE = false;
  const SHOW_MATCHED_LINE = true;
  const ANIMATE_ON = 'matched' as const;

  // 貼路（map matching）後的軌跡。存 R2、純檢視，不寫 D1
  const [matchedTracks, setMatchedTracks] = useState<TrackPoint[]>([]);
  const [matchedDays, setMatchedDays] = useState(0);
  const [matchedLoading, setMatchedLoading] = useState(false);
  // 貼路是一個會跑好幾十秒的操作（每秒只能打一次），逐段累積訊息
  const [matching, setMatching] = useState(false);
  const [matchLog, setMatchLog] = useState<string[]>([]);
  // 貼完之後要重讀 R2。日期與天數都沒變，只能靠這個計數器叫醒讀取的 effect
  const [matchedVersion, setMatchedVersion] = useState(0);
  // 這段範圍裡「R2 上還沒有貼路結果」的日子。自動貼路就照這份清單去補
  const [unmatchedKeys, setUnmatchedKeys] = useState<string[]>([]);
  /*
   * 這次進頁已經試著貼過的日子（不論成功與否）。
   *
   * 沒有這個閂會無限打轉：貼完 → matchedVersion 變動 → 重讀 R2 → 整天沒移動、
   * 或對方掛掉的日子照樣讀不到結果 → 又被列進 unmatchedKeys → 再貼一次。
   * FOSSGIS 是志工用捐款養的單一伺服器，這種迴圈直接就是在打人家。
   */
  const attemptedMatch = useRef<Set<string>>(new Set());
  /*
   * Google 時間軸的紀念層。跟上面三層完全獨立的一個開關 ——
   * 使用者要的是「兩個都開時顏色分得開、同時看得見」，而不是逐日互相讓位。
   *
   * 預設關：它是十二年的背景，不是今天要看的東西。
   */
  const [showTimeline, setShowTimeline] = useState(false);
  // 照片圓點／縮圖。預設開 —— 關掉是為了看清楚底下的軌跡線
  const [showPhotos, setShowPhotos] = useState(true);
  const [timelineIndex, setTimelineIndex] = useState<TimelineIndex | null>(null);
  const [timelineLines, setTimelineLines] = useState<[number, number][][]>([]);
  const [timelineStats, setTimelineStats] = useState<{ points: number; days: number } | null>(null);
  const [timelineLoading, setTimelineLoading] = useState(false);
  // 已經抓回來的月檔。切日期範圍時不重抓 —— 月檔是不可變的，抓過就一直有效
  const timelineCache = useRef<Map<string, TimelineMonthData>>(new Map());
  // 月檔存在 ref 裡（不想讓它進 deps 觸發重抓），但日期選擇器要靠它畫格子。
  // 抓完新的一個月就把這個數字加一，畫面才知道要重算
  const [timelineCacheVersion, setTimelineCacheVersion] = useState(0);

  // 開頁自動同步的一行狀態字。跟底下管理工具那個完整 log 是兩回事 ——
  // 自動跑的東西不該把整片 log 推到你臉上，但也不能完全無聲
  const [autoStatus, setAutoStatus] = useState<string | null>(null);
  // 自動同步一次掛載只跑一次。React 18 嚴格模式下 effect 會跑兩次，
  // 沒有這個閂的話同一次進頁會打兩趟 Drive
  const autoSyncStarted = useRef(false);

  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  // 日期選擇器目前翻到哪個月。跟 from/to 分開 —— 還沒選日期時也要能翻月份找足跡
  const [pickerMonth, setPickerMonth] = useState(() => monthOf(todayLocal()));
  const [albumId, setAlbumId] = useState<number | ''>('');
  // 目前這本相簿的照片橫跨哪段日期（本地日，YYYY-MM-DD）。
  // 選了相簿之後日期輸入框就鎖在這個範圍內
  const [albumSpan, setAlbumSpan] = useState<{ first: string; last: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const data = await fetchFootprint({
      from: from || undefined,
      // 結束日要含當天整日，否則 '2026-03-05 14:00' 會大於 '2026-03-05' 而被濾掉
      to: to ? `${to} 23:59:59` : undefined,
      albumId: albumId === '' ? undefined : albumId,
    });
    setPoints(data);
    setLoading(false);
  }, [from, to, albumId]);

  // 軌跡不隸屬任何相簿，只能用時間限縮。選了相簿卻不限縮的話，
  // 看 2024 年的相簿會冒出今年的軌跡。t_utc 是 UTC ISO，跟這裡的字串前綴相容。
  const range = useMemo(() => {
    // 使用者自己選了日期就以他為準
    if (from || to) {
      return {
        from: from ? localDayToUtc(from) : undefined,
        to: to ? localDayToUtc(to, true) : undefined,
        skip: false,
      };
    }
    // 「全部相簿」＋沒選日期＝沒有任何限縮，撈全部軌跡等於把幾年份的線
    // 疊在同一張圖上，看不出東西也白花讀取額度。這個狀態只顯示照片的點。
    if (albumId === '') return { from: undefined, to: undefined, skip: true };

    const times = points.map(p => p.taken_at).filter((t): t is string => !!t).sort();
    // 這個相簿的照片沒有可比對的時間，撈任何軌跡都只是雜訊
    if (times.length === 0) return { from: undefined, to: undefined, skip: true };
    // 前後各留 6 小時，把去程與回程的移動也包進來
    const PAD_MS = 6 * 60 * 60 * 1000;
    return {
      from: new Date(Date.parse(times[0]) - PAD_MS).toISOString(),
      to: new Date(Date.parse(times[times.length - 1]) + PAD_MS).toISOString(),
      skip: false,
    };
  }, [from, to, albumId, points]);

  // 地圖上這批照片實際涵蓋的日期。刻意只顯示、不回填上面的日期輸入框 ——
  // 填進去等於使用者選了日期，軌跡又會被載回來，跟「只看照片點」正好相反
  const photoSpan = useMemo(() => {
    const times = points.map(p => p.taken_at).filter((t): t is string => !!t).sort();
    if (times.length === 0) return null;
    return { first: times[0], last: times[times.length - 1] };
  }, [points]);

  /*
   * 選了相簿就把日期鎖在這本相簿照片的起訖日之間（上面那段「不回填」只適用
   * 全部相簿：那裡不填是為了不要把幾年份的軌跡撈回來，這裡剛好相反 ——
   * 已經限縮到一本相簿了，回填反而讓軌跡跟著照片一起出現）。
   *
   * 刻意再打一次不帶日期的 API，而不是拿畫面上的 points 去推：
   * points 已經被目前的日期條件篩過，用它回填會越縮越小 —— 手動改成
   * 3/1～3/2 之後範圍就再也回不到整本相簿了。
   */
  useEffect(() => {
    if (albumId === '') { setAlbumSpan(null); setFrom(''); setTo(''); return; }

    let cancelled = false;
    (async () => {
      const all = await fetchFootprint({ albumId });
      if (cancelled) return;
      // 篩選條件比對的是 local_time，這裡取的日期也得是本地日，不能用 taken_at
      const days = all
        .map(p => p.local_time)
        .filter((t): t is string => !!t)
        .map(t => t.slice(0, 10))
        .sort();
      if (days.length === 0) { setAlbumSpan(null); setFrom(''); setTo(''); return; }
      setAlbumSpan({ first: days[0], last: days[days.length - 1] });
      setFrom(days[0]);
      setTo(days[days.length - 1]);
    })();

    return () => { cancelled = true; };
  }, [albumId]);

  // 拆成基本型別再進 deps —— range 物件每次都是新的，照片重載時會白打一次 API
  const { from: trackFrom, to: trackTo, skip: skipTracks } = range;
  const loadTracks = useCallback(async () => {
    if (skipTracks) { setTracks([]); return; }
    setTracks(await fetchTracks({ from: trackFrom, to: trackTo }));
  }, [trackFrom, trackTo, skipTracks]);

  useEffect(() => {
    fetchAlbums().then(setAlbums);
  }, []);

  // 只有管理者讀得到（會暴露出門的日期）
  const loadTrackDays = useCallback(async () => {
    if (!isAdmin) { setTrackDays([]); return; }
    setTrackDays(await fetchTrackDays());
  }, [isAdmin]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { loadTracks(); }, [loadTracks]);
  useEffect(() => { loadTrackDays(); }, [loadTrackDays]);

  useEffect(() => {
    if (isAdmin) fetchTripSegments(albumId === '' ? undefined : albumId).then(setSegments);
  }, [isAdmin, albumId]);

  // 地圖上的手動編修（合併／刪除軌跡點）。跨日的選取會拆成多筆，逐筆送出。
  // 只要有一筆失敗就回報失敗，但已經成功的那幾筆不會回滾 —— 所以無論如何都重載一次
  const handleEditPoints = useCallback(async (edits: TrackPointEdit[]) => {
    let ok = true;
    for (const e of edits) {
      if (!(await editTrackPoints(e))) ok = false;
    }
    // 編修會把那一天標成 'manual'，還原清單要跟著更新
    await Promise.all([loadTracks(), loadTrackDays()]);
    return ok;
  }, [loadTracks, loadTrackDays]);

  // 地圖上把照片搬到軌跡點的位置。後端會把 geo_source 設成 'manual'，
  // 所以之後任何自動推論（行程段、內插）都不會再覆蓋它
  const handleMovePhoto = useCallback(async (photoId: number, lat: number, lng: number) => {
    const updated = await updatePhotoGeo(photoId, { lat, lng });
    if (!updated) return false;
    await load();
    return true;
  }, [load]);

  // 畫面上這批軌跡涵蓋哪幾天。壓成字串再進 deps —— 陣列每次重載都是新物件，
  // 直接放會讓底下的 effect 在每次編修軌跡後都重讀一輪 R2
  const rawDayKeys = useMemo(
    () => Array.from(new Set(tracks.map(p => p.day_key))).sort().join(','),
    [tracks],
  );

  /** 有 GPS 軌跡的日子（當地日）。一份 GPX 跨夜的話兩天都算 */
  const gpsDays = useMemo(() => {
    const days = new Set<string>();
    for (const d of trackDays) {
      if (!d.first_local_day) continue;
      const last = d.last_local_day ?? d.first_local_day;
      // 幾乎都是同一天，跨夜才會有第二天。用 Date 逐日推進，不要自己算月底
      for (let t = Date.parse(`${d.first_local_day}T00:00:00Z`);
           t <= Date.parse(`${last}T00:00:00Z`);
           t += 86400000) {
        days.add(new Date(t).toISOString().slice(0, 10));
      }
    }
    return days;
  }, [trackDays]);

  /**
   * 目前這段日期範圍裡，要拿 Google 時間軸來貼路的日子（YYYY-MM-DD）。
   *
   * **有 GPSLogger 軌跡的日子直接排除** —— 那一天的貼路以實測軌跡為準，
   * 時間軸只在「那天根本沒帶手機記軌跡」時才頂上。這是唯一的來源優先序，
   * 兩邊不會同時畫，也就不會有兩條線打架的問題。
   *
   * 只看索引不看月檔：月檔要真的去 R2 抓，而這份清單的用途是「哪幾天值得試著
   * 讀貼路結果 / 值得送去貼路」，用月的粒度先篩掉大半已經夠了。
   * 邊界各放寬一天 —— 範圍是 UTC 瞬間，月檔的日是當地日，兩者差幾小時。
   */
  const timelineDaysInRange = useMemo(() => {
    if (skipTracks || !trackFrom || !trackTo || !timelineIndex) return [];
    const months = new Set(timelineIndex.months.map(m => m.monthKey));
    if (months.size === 0) return [];

    const lo = Date.parse(trackFrom) - 86400000;
    const hi = Date.parse(trackTo) + 86400000;
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) return [];

    const out: string[] = [];
    for (let t = lo; t <= hi && out.length < TIMELINE_MAX_DAYS; t += 86400000) {
      const day = new Date(t).toISOString().slice(0, 10);
      if (months.has(day.slice(0, 7)) && !gpsDays.has(day)) out.push(day);
    }
    return out;
  }, [skipTracks, trackFrom, trackTo, timelineIndex, gpsDays]);

  // 壓成字串再進 deps，理由同 rawDayKeys
  const timelineDayKeys = timelineDaysInRange.join(',');

  /*
   * Google 時間軸紀念層。
   *
   * 跟其他三層完全不同的一條路：資料在 R2 的月檔裡，不經過 D1。
   * 這一層不修正、不貼路、不參與照片位置推論 —— 唯讀，就只是「我曾經走過這裡」。
   * 所以它不受 range.skip 的限制：沒選相簿也沒選日期時，其他層不載入是為了
   * 省 D1 讀取額度，而這一層根本不碰 D1，那個狀態正好就是「看整個十二年」。
   */
  const timelineMonths = useMemo(() => {
    const all = timelineIndex?.months.map(m => m.monthKey) ?? [];
    if (all.length === 0) return [];
    // 日期框沒填就是全都要。這一層預設關著，會打開它就代表確實想看
    if (!from && !to) return all;
    const lo = from ? from.slice(0, 7) : '';
    const hi = to ? to.slice(0, 7) : '9999-99';
    return all.filter(m => m >= lo && m <= hi);
  }, [timelineIndex, from, to]);

  // 索引很小（144 筆），進頁就抓一次，之後不再重抓。
  // 不等「顯示 Google 足跡」被打開 —— 日期選擇器要靠它知道哪幾個月有足跡，
  // 而那個判斷跟這一層畫不畫出來無關
  useEffect(() => {
    if (!isAdmin || timelineIndex) return;
    let cancelled = false;
    (async () => {
      const idx = await fetchTimelineIndex();
      if (!cancelled) setTimelineIndex(idx);
    })();
    return () => { cancelled = true; };
  }, [isAdmin, timelineIndex]);

  /*
   * 日期選擇器翻到的那個月，補抓它的月檔。
   *
   * 一次一個月、抓過就留在快取裡（月檔是不可變的），所以翻月份最多就是一次 R2 讀取。
   * 索引裡沒有的月份不抓 —— 那代表那個月本來就沒有 Google 足跡。
   */
  const [pickerMonthLoading, setPickerMonthLoading] = useState(false);
  useEffect(() => {
    if (!isAdmin || !timelineIndex) return;
    if (!timelineIndex.months.some(m => m.monthKey === pickerMonth)) return;
    if (timelineCache.current.has(pickerMonth)) return;

    let cancelled = false;
    (async () => {
      setPickerMonthLoading(true);
      try {
        const data = await fetchTimelineMonth(pickerMonth);
        if (cancelled) return;
        // 抓不到也記成空的：索引與月檔不同步時才會這樣，不要每次翻回來都再問一次
        timelineCache.current.set(pickerMonth, data ?? {});
        setTimelineCacheVersion(v => v + 1);
      } finally {
        if (!cancelled) setPickerMonthLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [isAdmin, timelineIndex, pickerMonth]);

  /*
   * 有照片的日子（當地日）。
   *
   * 月曆上只認軌跡的話，「有照片但沒帶手機」的日子會變成點不下去 —— 地圖上最主要
   * 的那一層反而看不到，這比讓人點到一天空的糟得多。
   *
   * 只在「沒有任何篩選」的那次載入時記下來，而且只增不減：篩過的 points 是子集，
   * 拿它覆蓋會讓月曆上可選的日子隨著篩選越來越少。
   */
  const [photoDays, setPhotoDays] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (from || to || albumId !== '' || points.length === 0) return;
    setPhotoDays(new Set(points.map(p => p.local_time.slice(0, 10))));
  }, [points, from, to, albumId]);

  /*
   * 日期選擇器上，這個月哪幾天有足跡 —— Google 足跡、GPS 軌跡、照片，三者任一。
   *
   * null 代表「不知道」，選擇器就整個月放行。什麼時候會不知道：
   * 非管理者（月檔與軌跡日都讀不到）、或索引還沒回來。寧可讓人選到一天空的，
   * 也不要因為資料還沒到就把有足跡的日子鎖住。
   */
  const pickerDays = useMemo(() => {
    if (!isAdmin || !timelineIndex) return null;
    const inIndex = timelineIndex.months.some(m => m.monthKey === pickerMonth);
    const monthData = timelineCache.current.get(pickerMonth);
    // 索引說這個月有東西，但月檔還沒抓回來 —— 這時還不知道是哪幾天
    if (inIndex && !monthData) return null;

    const days = new Set<string>(monthData ? Object.keys(monthData) : []);
    for (const d of Array.from(gpsDays)) if (d.startsWith(pickerMonth)) days.add(d);
    for (const d of Array.from(photoDays)) if (d.startsWith(pickerMonth)) days.add(d);
    return days;
    // timelineCacheVersion：月檔在 ref 裡，抓到新的一個月時要靠它重算
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAdmin, timelineIndex, pickerMonth, gpsDays, photoDays, timelineCacheVersion]);

  /** 哪幾年有足跡。年份選單只列這些，翻不到的年份本來就沒東西 */
  const footprintYears = useMemo(() => {
    const years = new Set<string>();
    for (const m of timelineIndex?.months ?? []) years.add(m.monthKey.slice(0, 4));
    for (const d of Array.from(gpsDays)) years.add(d.slice(0, 4));
    for (const d of Array.from(photoDays)) years.add(d.slice(0, 4));
    return Array.from(years).sort();
  }, [timelineIndex, gpsDays, photoDays]);

  const timelineMonthKeys = timelineMonths.join(',');
  useEffect(() => {
    if (!showTimeline || timelineMonths.length === 0) {
      setTimelineLines([]); setTimelineStats(null); setTimelineLoading(false);
      return;
    }
    let cancelled = false;
    (async () => {
      setTimelineLoading(true);
      try {
        const cache = timelineCache.current;
        for (const m of timelineMonths) {
          if (cache.has(m)) continue;
          const data = await fetchTimelineMonth(m);
          if (cancelled) return;
          // 抓不到（索引與月檔不同步）也記成空的，免得每次重算都再問一次
          cache.set(m, data ?? {});
        }

        // 月檔是整月的，但日期框可能只選了其中幾天 —— 這裡才做日的篩選
        const lines: [number, number][][] = [];
        let points = 0;
        let days = 0;
        for (const m of timelineMonths) {
          const monthData = cache.get(m);
          if (!monthData) continue;
          for (const day of Object.keys(monthData).sort()) {
            if (from && day < from) continue;
            if (to && day > to) continue;
            const pts = monthData[day] as TrackTuple[];
            if (!pts?.length) continue;
            points += pts.length;
            days++;
            // 一天一組線：跨夜不連。時間軸的日界線是照當下時區切的，
            // 硬把兩天接起來只會在出國那幾天畫出假的移動
            for (const line of toLineStrings(pts)) lines.push(line);
          }
        }
        if (cancelled) return;
        setTimelineLines(lines);
        setTimelineStats({ points, days });
      } finally {
        // 被取消時也要放掉：否則切日期切到一半離開，狀態列會永遠停在「讀取中」
        if (!cancelled) setTimelineLoading(false);
      }
    })();
    return () => { cancelled = true; };
    // timelineMonths 每次 memo 都是新陣列，壓成字串才不會每次都重跑
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showTimeline, timelineMonthKeys, from, to]);

  /*
   * 貼路軌跡：從 R2 讀回上次「軌跡貼路」跑出來的結果。
   * 這裡只讀不算 —— 貼路要打第三方 API，只在按下按鈕時才做。
   * 沒貼過的日子會 404，安靜略過就好。
   */
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setMatchedLoading(true);
      try {
        // GPS 軌跡的日子，加上有 Google 時間軸的日子（貼過才讀得到，沒貼就 404）。
        // 手機還沒開始記軌跡的那些年，地圖上的線就是靠後者來的
        const dayKeys = [
          ...(rawDayKeys ? rawDayKeys.split(',') : []),
          ...(timelineDayKeys ? timelineDayKeys.split(',').map(d => TIMELINE_DAY_PREFIX + d) : []),
        ];
        // 貼路的結果是整天的，日期範圍卻可以切在半天，所以逐點還要再濾一次
        const tMin = trackFrom ? Date.parse(trackFrom) : -Infinity;
        const tMax = trackTo ? Date.parse(trackTo) : Infinity;
        const out: TrackPoint[] = [];
        let days = 0;
        // 讀不到結果的日子。自動貼路就靠這份清單決定要處理誰 ——
        // 這裡本來就要逐天問一次 R2，順手記下來，不必再多打一輪
        const missing: string[] = [];

        for (const dayKey of dayKeys) {
          const data = await fetchTrackMatched(dayKey);
          if (cancelled) return;
          if (!data?.segments?.length) { missing.push(dayKey); continue; }

          let kept = 0;
          for (const s of data.segments) {
            // s.vehicle 存在 R2 裡（貼路當下用的 costing），這裡不讀 ——
            // 地圖上只有一個飛碟，不再需要「這趟是什麼車」來挑圖示
            for (const [lng, lat, t] of s.points) {
              if (!(t >= tMin && t <= tMax)) continue;
              out.push({
                // 負數 id：這些點不在 D1 裡，給個一看就知道不是真列的值，
                // 免得哪天不小心被當成可編輯的點送進 editTrackPoints
                id: -(out.length + 1),
                day_key: dayKey,
                t_utc: new Date(t).toISOString(),
                lat,
                lng,
                src: 'matched',
                seg: s.seg,
              });
              kept++;
            }
          }
          if (kept > 0) days++;
        }

        if (cancelled) return;
        setMatchedTracks(out);
        setMatchedDays(days);
        setUnmatchedKeys(missing);
      } finally {
        if (!cancelled) setMatchedLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [rawDayKeys, timelineDayKeys, trackFrom, trackTo, matchedVersion]);

  /**
   * 同步足跡的本體：列出 Drive 上的 GPX、只抓 md5 有變的，在瀏覽器裡解析與抽稀，
   * 再一天一次寫進 D1。沒有 cron —— 解析要用 DOMParser，Worker 沒有那個 API，
   * 硬搬過去等於把半個前端也搬進 Worker，還會讓 gpx.ts 變成前後端各一份。
   *
   * 手動按按鈕與開頁自動同步共用這一份，差別只在 force 與 quiet。
   *
   * @returns 真正寫進去的那幾天（要拿去接著貼路）；Drive 讀取失敗回 null，
   *          跟「沒有需要同步的」（回空陣列）分開 —— 失敗不該消耗自動同步的冷卻時間
   */
  const runSync = useCallback(async (
    { force = false, quiet = false }: { force?: boolean; quiet?: boolean } = {},
  ): Promise<MatchTarget[] | null> => {
    setSyncing(true);
    const log: string[] = ['正在讀取 Drive 檔案清單…'];
    setSyncLog([...log]);

    const { files, error } = await fetchDriveGpxFiles();
    if (error) {
      setSyncLog([`讀取失敗：${error}`]);
      setSyncing(false);
      return null;
    }

    // 強制模式忽略 md5，整批重灌 —— 停留點濃縮的結果是寫死在資料裡的，
    // 檔案內容沒變但演算法參數變了的時候，只有這條路能把舊資料換掉。
    // 平常則跳過手動編修過的日子：重灌是整批刪掉再寫入，會把手工合併／刪除的結果洗掉
    const edited = files.filter(f => f.ingestSource === 'manual');
    const todo = force ? files : files.filter(f => f.needsSync && f.ingestSource !== 'manual');
    const skipped = force ? 0 : files.filter(f => f.needsSync && f.ingestSource === 'manual').length;
    if (todo.length === 0) {
      setSyncLog([
        `Drive 上有 ${files.length} 個軌跡檔，沒有需要同步的。`
        + (skipped > 0 ? `（${skipped} 個手動編修過，已跳過）` : ''),
      ]);
      setSyncing(false);
      return [];
    }

    log.length = 0;
    log.push((quiet ? '自動同步：' : '')
      + (force
        ? `${files.length} 個軌跡檔，強制全部重新匯入`
          + (edited.length > 0 ? `（含 ${edited.length} 個手動編修過的，會被覆蓋）` : '')
        : `${files.length} 個軌跡檔，其中 ${todo.length} 個有更新`
          + (skipped > 0 ? `，另 ${skipped} 個手動編修過已跳過` : '')));
    setSyncLog([...log]);

    const ingested: MatchTarget[] = [];
    let total = 0;
    for (const f of todo) {
      const xml = await fetchDriveGpxText(f.driveFileId);
      if (!xml) {
        log.push(`${f.dayKey}：下載失敗`);
        setSyncLog([...log]);
        continue;
      }

      const parsed = parseGpx(xml);
      if (parsed.error) {
        log.push(`${f.dayKey}：${parsed.error}`);
        setSyncLog([...log]);
        continue;
      }

      // 先濃縮停留點再抽稀，順序不能反：抽稀保留的是「離直線最遠」的點，
      // 室內亂跳的雜訊剛好就是那些點，先抽稀等於把抖動挑出來留著
      const stayed = collapseStays(parsed.points);
      const simplified = simplifyTrack(stayed);
      const stayCount = simplified.filter(p => (p.staySec ?? 0) > 0).length;
      const result = await ingestTrack({
        dayKey: f.dayKey,
        driveFileId: f.driveFileId,
        md5: f.md5,
        ingestSource: 'gpslogger',
        points: simplified,
      });

      if (!result) {
        log.push(`${f.dayKey}：寫入失敗`);
      } else {
        // 留存原文（給「恢復原始軌跡」用）。必須排在 ingest 之後：
        // 後端是 UPDATE TrackDay，那一列還不存在的話 raw_key 會寫不進去。
        // 存檔失敗不算同步失敗 —— 軌跡點已經進 D1 了，只是這天還原不回來
        const rawSaved = await saveTrackRaw(f.dayKey, xml);
        total += result.inserted;
        // 只有留存成功的才值得接著貼路 —— 貼路只吃原始 GPX，沒有原文就貼不了
        if (rawSaved) ingested.push({ dayKey: f.dayKey, md5: f.md5 ?? null });
        const dropped = parsed.skipped > 0 ? `，${parsed.skipped} 點無時間被略過` : '';
        const stays = stayCount > 0 ? `，含 ${stayCount} 處停留` : '';
        const raw = rawSaved ? '' : '（原始檔留存失敗，這天無法還原）';
        log.push(
          `${f.dayKey}：${parsed.points.length} 點 / ${parsed.segCount} 段 → `
          + `濃縮停留 ${stayed.length} 點 → 抽稀後寫入 ${result.inserted} 點${stays}${dropped}${raw}`
        );
      }
      setSyncLog([...log]);
    }

    log.push(`同步完成，共寫入 ${total} 個軌跡點。`);
    setSyncLog([...log]);
    setSyncing(false);
    loadTracks();
    loadTrackDays();
    return ingested;
  }, [loadTracks, loadTrackDays]);

  /** 「立即同步足跡」按鈕。強制模式的開關只影響手動這條路 */
  const syncTracks = () => runSync({ force: forceSync });

  /**
   * 軌跡貼路：把畫面上這幾天的軌跡切成一趟一趟的移動，送去 Valhalla 做
   * map matching，讓線貼著實際的道路走，結果存進 R2。地圖上要看的就是這條線。
   *
   * 幾個刻意的選擇：
   * - 只吃原始 GPX。點太疏的話 map matching 會退化成「在兩點之間找一條路」，
   *   很容易編出一條你沒走過的路徑，所以沒有原始檔的日子寧可不貼。
   * - 送進去之前先剔尖峰、再依速度切成「一趟一趟的移動」。整天原封不動送過去
   *   的話，在家、在室內那幾個小時的定位雜訊會被 matcher 當成路徑，
   *   在原地繞出一團看不懂的線 —— 而那才是貼路結果難看的主因。
   * - 一趟一個請求，costing 依那一趟自己的速度決定。
   *   火車、飛機、船直接跳過 —— 它們走的不是道路網，硬貼會把航線扭成公路。
   * - 每秒只送一個請求。FOSSGIS 是志工用捐款養的單一伺服器，條款寫明的上限。
   * - 來源 md5 沒變的日子整天跳過。每一趟都是一次別人家的請求，不重打。
   */
  const runMatch = useCallback(async (
    targets: MatchTarget[],
    { quiet = false }: { quiet?: boolean } = {},
  ) => {
    setMatching(true);
    const log: string[] = [`${quiet ? '自動貼路：' : ''}${targets.length} 天，開始貼路…`];
    setMatchLog([...log]);

    const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
    let requests = 0;

    for (const { dayKey, md5 } of targets) {
      // 來源沒變就整天跳過。舊結果沒有 sourceMd5，會落到 undefined 而重跑一次
      const existing = await fetchTrackMatched(dayKey);
      if (md5 && existing?.sourceMd5 === md5) {
        log.push(`${dayKey}：來源未變，沿用上次結果（${existing.segments.length} 趟）`);
        setMatchLog([...log]);
        continue;
      }

      const xml = await fetchTrackRaw(dayKey);
      const parsed = xml ? parseGpx(xml) : null;
      if (!parsed || parsed.error) {
        log.push(`${dayKey}：讀不到原始檔${parsed?.error ? `（${parsed.error}）` : ''}，跳過`);
        setMatchLog([...log]);
        continue;
      }

      const trips = extractTrips(rejectSpikes(parsed.points));
      if (trips.length === 0) {
        // 這一天整天沒移動。清掉舊結果，免得畫面上留著一條跟現況無關的線
        await deleteTrackMatched(dayKey);
        log.push(`${dayKey}：${parsed.points.length} 點裡沒有一趟真正的移動，略過`);
        setMatchLog([...log]);
        continue;
      }

      log.push(`${dayKey}：${parsed.points.length} 點 → ${trips.length} 趟移動`);
      setMatchLog([...log]);

      const segments: MatchedTrack['segments'] = [];
      let dayPoints = 0;

      for (let i = 0; i < trips.length; i++) {
        const trip = trips[i];
        // 用這一趟自己的速度猜，不用整段 trkseg 的平均 ——
        // 那被中間的停留稀釋過，出門一趟會被猜成走路
        const vehicle = vehicleFromSpeed(trip.speedKmh);
        const costing = costingFor(vehicle);
        const label = `${dayKey} 第 ${i + 1} 趟`;
        if (!costing) {
          log.push(`${label}：${vehicleLabel(vehicle)}不走道路，跳過`);
          setMatchLog([...log]);
          continue;
        }

        const input = subsampleForMatch(
          trip.points.map(p => ({ lat: p.lat, lng: p.lng, t: Date.parse(p.t) } as MatchInput)),
          1000,
        );
        // 條款上限是每秒 1 次，多留一點餘裕
        if (requests > 0) await sleep(1100);
        requests++;
        const resp = await matchTrackShape(input.map(p => ({ lat: p.lat, lon: p.lng })), costing);
        const matched = resp ? buildMatchedTrack(input, resp) : null;
        if (!matched) {
          log.push(`${label}：貼路失敗${resp?.error ? `（${resp.error}）` : ''}`);
          setMatchLog([...log]);
          continue;
        }

        segments.push({
          // seg 用「第幾趟」而不是原本的 trkseg —— 地圖是照 seg 分組畫線的，
          // 同一個 trkseg 切出來的兩趟共用編號的話會被接成一條假路
          seg: i,
          costing,
          vehicle,
          points: matched.map(m => [m.lng, m.lat, Math.round(m.t)] as [number, number, number]),
        });
        dayPoints += matched.length;
      }

      if (segments.length === 0) {
        await deleteTrackMatched(dayKey);
        log.push(`${dayKey}：沒有貼出任何一趟`);
      } else {
        const ok = await saveTrackMatched(dayKey, {
          dayKey, builtAt: new Date().toISOString(), sourceMd5: md5 ?? undefined, segments,
        });
        log.push(
          `${dayKey}：${segments.length}/${trips.length} 趟貼路完成，${dayPoints} 點`
          + (ok ? '' : '（存檔失敗）')
        );
      }
      setMatchLog([...log]);
    }

    log.push(`貼路結束，共送出 ${requests} 個請求。`);
    setMatchLog([...log]);
    setMatching(false);
    setMatchedVersion(v => v + 1);
    return requests;
  }, []);

  /*
   * Google 時間軸貼路。
   *
   * 為什麼要有這條路：手機開始常駐記軌跡是很後來的事，在那之前的行程只剩
   * Google 時間軸這一份。那一層原本是唯讀的紀念層，畫出來是一條在建築物之間
   * 亂穿的直線 —— 把它送去貼路之後，那些年的行程也能有一條貼著路走的線。
   *
   * 跟 runMatch 共用同一套處理（切趟 → 依速度挑 costing → 逐趟送 Valhalla →
   * 存 R2），只有三個地方不同：
   * - 資料來源是 R2 的月檔而不是 GPX 原始檔，所以自己組出 GpxPoint[]。
   * - 時間軸的取樣是分鐘級而且會斷（沒開 app、沒訊號、飛機上），所以先照
   *   時間間隔與隱含速度切 seg。不切的話 extractTrips 會把中斷兩端接成一條
   *   假的移動，然後 matcher 會很認真地幫那條假移動找一條公路出來。
   * - day_key 加前綴（見 TIMELINE_DAY_PREFIX），跟 GPS 那批分開存。
   *
   * 這一步不回寫任何東西進 D1，時間軸仍然是唯讀層；產出的只是 R2 上的一份
   * 貼路結果，看不順眼隨時可以刪掉重跑。
   *
   * @param days 要貼的當地日（'YYYY-MM-DD'），由呼叫端先篩好。這裡不問、不擋 ——
   *             它是自動流程的一環，不是按鈕。
   */
  const runTimelineMatch = useCallback(async (days: string[]) => {
    if (days.length === 0) return 0;

    setMatching(true);
    const log: string[] = [`Google 時間軸：${days.length} 天，開始貼路…`];
    setMatchLog([...log]);

    const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
    let requests = 0;

    for (const day of days) {
      const month = day.slice(0, 7);
      let monthData = timelineCache.current.get(month);
      if (!monthData) {
        monthData = (await fetchTimelineMonth(month)) ?? {};
        timelineCache.current.set(month, monthData);
        setTimelineCacheVersion(v => v + 1);
      }
      const tuples = monthData[day] as TrackTuple[] | undefined;
      if (!tuples?.length) continue;

      const dayKey = TIMELINE_DAY_PREFIX + day;
      const sorted = tuples.slice().sort((a, b) => a[0] - b[0]);
      // 月檔是不可變的，但重新匯入會換掉整個月。用點數與頭尾時戳當版本記號，
      // 內容沒變就沿用上次結果，不重打別人家的 API
      const stamp = `tl:${sorted.length}:${sorted[0][0]}:${sorted[sorted.length - 1][0]}`;

      const existing = await fetchTrackMatched(dayKey);
      if (existing?.sourceMd5 === stamp) {
        log.push(`${day}：來源未變，沿用上次結果（${existing.segments.length} 趟）`);
        setMatchLog([...log]);
        continue;
      }

      // 切 seg：間隔超過 15 分鐘，或兩點之間的隱含速度超過 200 km/h（＝飛機，
      // 或匯出資料本身的跳點）就斷開，兩端不可以連成一段移動
      const segs = segmentIndices(sorted, { maxGapSec: 900 });
      const gpxPoints: GpxPoint[] = sorted.map(([sec, lat, lng], i) => ({
        t: new Date(sec * 1000).toISOString(),
        lat, lng, src: 'timeline', hdop: null, seg: segs[i], staySec: null,
      }));

      // minPoints 放寬到 5：時間軸是分鐘級取樣，一趟二十分鐘的車程也才十來點，
      // 用 GPX 那邊的 8 會把短程整批濾掉
      const trips = extractTrips(rejectSpikes(gpxPoints), { minPoints: 5 });
      if (trips.length === 0) {
        await deleteTrackMatched(dayKey);
        log.push(`${day}：${sorted.length} 點裡沒有一趟真正的移動，略過`);
        setMatchLog([...log]);
        continue;
      }

      log.push(`${day}：${sorted.length} 點 → ${trips.length} 趟移動`);
      setMatchLog([...log]);

      const segments: MatchedTrack['segments'] = [];
      let dayPoints = 0;

      for (let i = 0; i < trips.length; i++) {
        const trip = trips[i];
        const vehicle = vehicleFromSpeed(trip.speedKmh);
        const costing = costingFor(vehicle);
        const label = `${day} 第 ${i + 1} 趟`;
        if (!costing) {
          log.push(`${label}：${vehicleLabel(vehicle)}不走道路，跳過`);
          setMatchLog([...log]);
          continue;
        }

        const input = subsampleForMatch(
          trip.points.map(p => ({ lat: p.lat, lng: p.lng, t: Date.parse(p.t) } as MatchInput)),
          1000,
        );
        if (requests > 0) await sleep(1100);
        requests++;
        const resp = await matchTrackShape(input.map(p => ({ lat: p.lat, lon: p.lng })), costing);
        const matched = resp ? buildMatchedTrack(input, resp) : null;
        if (!matched) {
          log.push(`${label}：貼路失敗${resp?.error ? `（${resp.error}）` : ''}`);
          setMatchLog([...log]);
          continue;
        }

        segments.push({
          seg: i,
          costing,
          vehicle,
          points: matched.map(m => [m.lng, m.lat, Math.round(m.t)] as [number, number, number]),
        });
        dayPoints += matched.length;
      }

      if (segments.length === 0) {
        await deleteTrackMatched(dayKey);
        log.push(`${day}：沒有貼出任何一趟`);
      } else {
        const ok = await saveTrackMatched(dayKey, {
          dayKey, builtAt: new Date().toISOString(), sourceMd5: stamp, segments,
        });
        log.push(
          `${day}：${segments.length}/${trips.length} 趟貼路完成，${dayPoints} 點`
          + (ok ? '' : '（存檔失敗）')
        );
      }
      setMatchLog([...log]);
    }

    log.push(`時間軸貼路結束，共送出 ${requests} 個請求。`);
    setMatchLog([...log]);
    setMatching(false);
    setMatchedVersion(v => v + 1);
    return requests;
  }, []);

  /*
   * 自動貼路：選好日期就自己把這段範圍補齊，不再有按鈕。
   *
   * 來源優先序在 timelineDaysInRange 那邊就決定好了 —— 有 GPSLogger 軌跡的日子
   * 只走 GPS，沒有的才輪到 Google 時間軸，同一天不會兩邊都貼。
   *
   * 三道閂，缺一不可：
   * - 只補 unmatchedKeys（R2 上真的沒有結果的日子）。有結果就不重打。
   * - attemptedMatch：同一天這次進頁只試一次。貼不出來的日子（整天沒移動、
   *   對方掛掉）不會在「重讀→還是沒有→再貼」之間無限打轉。
   * - 等 matchedLoading 結束、且沒有別的貼路在跑。自動同步那條路也會呼叫
   *   runMatch，兩邊同時跑會把每秒一請求的自律破功。
   */
  useEffect(() => {
    if (!isAdmin || matching || matchedLoading || unmatchedKeys.length === 0) return;

    const todo = unmatchedKeys.filter(k => !attemptedMatch.current.has(k));
    if (todo.length === 0) return;

    const dayByKey = new Map(trackDays.map(d => [d.day_key, d]));
    const timelineDays: string[] = [];
    const gpsTargets: MatchTarget[] = [];
    // 這一輪真的做出判斷的 key。查不到 TrackDay 的先不標記 —— 那多半只是
    // 軌跡點先回來、日清單還在路上，標下去就等於這一天這次進頁再也不會貼
    const decided: string[] = [];
    for (const key of todo) {
      if (key.startsWith(TIMELINE_DAY_PREFIX)) {
        timelineDays.push(key.slice(TIMELINE_DAY_PREFIX.length));
        decided.push(key);
        continue;
      }
      const d = dayByKey.get(key);
      if (!d) continue;
      decided.push(key);
      // 沒留原始 GPX 的日子沒得貼（濃縮過的點會貼出你沒走過的路），
      // 但仍然算「判斷過」，不必每次重讀都再挑出來看一遍
      if (d.has_raw) gpsTargets.push({ dayKey: key, md5: d.md5 ?? null });
    }
    // 先標記再送出：中途失敗、或使用者切走日期，都不該讓這幾天再排隊一次
    for (const k of decided) attemptedMatch.current.add(k);
    if (gpsTargets.length === 0 && timelineDays.length === 0) return;

    (async () => {
      const total = gpsTargets.length + timelineDays.length;
      setAutoStatus(`貼路中…（${total} 天）`);
      let requests = 0;
      if (gpsTargets.length > 0) requests += await runMatch(gpsTargets, { quiet: true });
      if (timelineDays.length > 0) requests += await runTimelineMatch(timelineDays);
      setAutoStatus(requests > 0 ? `已貼路 ${total} 天，送出 ${requests} 個請求` : null);
    })();
    // trackDays 只是拿來查 has_raw/md5，它變動時 rawDayKeys 也會跟著變並重讀一輪，
    // 不需要它自己觸發這個 effect
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAdmin, matching, matchedLoading, unmatchedKeys, runMatch, runTimelineMatch]);

  /*
   * 開頁自動同步。取代 cron 的作法（見 runSync 的註解為什麼不做 cron）。
   *
   * 三個刻意的界線：
   * - 只有管理者：讀 Drive 的路由本來就只給管理者，訪客跑這個只會拿到 401。
   * - 不擋畫面：不 await 在渲染路徑上，地圖照常先畫，同步在背景跑。
   * - 絕不強制重灌：force 只走手動那條路。自動流程若把手動編修過的日子洗掉，
   *   你會在完全不知情的狀況下失去那些編輯。
   *
   * 有真的寫進新資料才接著貼路 —— ingest 成功時後端會刪掉那天的貼路結果，
   * 只同步不貼的話你隔天打開地圖會發現紫線無故消失。
   */
  useEffect(() => {
    if (!isAdmin || autoSyncStarted.current) return;
    autoSyncStarted.current = true;

    const last = Number(localStorage.getItem(AUTO_SYNC_KEY) ?? 0);
    if (Number.isFinite(last) && Date.now() - last < AUTO_SYNC_COOLDOWN_MS) return;

    (async () => {
      setAutoStatus('同步軌跡中…');
      const ingested = await runSync({ quiet: true });
      // null = Drive 讀取失敗。不寫時間戳，下次進頁還會再試一次
      if (!ingested) { setAutoStatus('同步失敗（詳見管理工具）'); return; }

      localStorage.setItem(AUTO_SYNC_KEY, String(Date.now()));
      if (ingested.length === 0) { setAutoStatus(null); return; }

      setAutoStatus(`已同步 ${ingested.length} 天，貼路中…`);
      const requests = await runMatch(ingested, { quiet: true });
      setAutoStatus(`已同步 ${ingested.length} 天，貼路 ${requests} 趟`);
    })();
  }, [isAdmin, runSync, runMatch]);

  const currentAlbum = albums.find(a => a.id === albumId);

  /*
   * 只看一天時，鏡頭要停的那個點：那天最早的一筆位置。
   *
   * 只在 from === to 時才給值 —— 選了一段範圍就還是「全部框進來」，
   * 停在第一天的起點會看不出這段範圍到底涵蓋了哪裡。
   *
   * 優先序是使用者的原話「當天 GPS 的第一個點」：先看兩份 GPS 軌跡（濃縮與貼路，
   * 同一趟的不同精度，取最早的那筆），沒有才退到 Google 足跡 ——
   * 2014 年那些早於 GPSLogger 的日子只有這一層，不退過去的話等於沒定位。
   * 最後才是照片，它連「有沒有在移動」都不表示。
   */
  const focusPoint = useMemo<[number, number] | null>(() => {
    if (!from || from !== to) return null;
    // 還在抓的時候手上這批資料是「上一次查詢」的，拿它定位會飛到跟這一天無關的
    // 地方，而且新的一批要是空的（那天什麼都沒有），鏡頭就再也沒有東西把它拉回來，
    // 直接卡在那裡。等載完再決定要不要動鏡頭
    if (loading) return null;

    let best: TrackPoint | null = null;
    for (const list of [tracks, matchedTracks]) {
      for (const p of list) if (best === null || p.t_utc < best.t_utc) best = p;
    }
    if (best) return [best.lng, best.lat];

    // 已經照日、照時間排好了（見上面組 timelineLines 的迴圈），取第一條的第一點
    const firstLine = timelineLines[0];
    if (firstLine?.length) return firstLine[0];

    let firstPhoto: FootprintPoint | null = null;
    for (const p of points) {
      if (!p.taken_at) continue;
      if (firstPhoto === null || p.taken_at < firstPhoto.taken_at!) firstPhoto = p;
    }
    // 全都沒有 taken_at（排不進時間軸）時退到後端給的順序，總比不定位好
    const photo = firstPhoto ?? points[0];
    return photo ? [photo.lng, photo.lat] : null;
  }, [from, to, loading, tracks, matchedTracks, timelineLines, points]);

  return (
    <div style={{ maxWidth: 1100, margin: '0 auto', padding: '24px 16px 60px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 18, flexWrap: 'wrap' }}>
        <Link href="/" style={{ fontSize: 14, color: '#2563eb', textDecoration: 'none' }}>← 回相簿</Link>
        <h1 style={{ fontSize: 24, margin: 0 }}>足跡地圖</h1>
      </div>

      <div style={{
        display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end',
        marginBottom: 16, padding: 14, background: '#f8fafc', borderRadius: 10,
      }}>
        {/*
          原本是兩個 <input type="date">。換掉的理由：那個框只吃 min/max，
          沒辦法把沒有足跡的日子鎖起來，而這裡十二年份的日子大半是空的。
          點一天＝就看那天（結束日跟著同一天），再點一個更後面的日子才變成範圍。
          min/max 仍然在選了相簿時鎖到該相簿的照片日期範圍。
        */}
        <FootprintDayPicker
          from={from}
          to={to}
          onChange={(f, t) => { setFrom(f); setTo(t); }}
          month={pickerMonth}
          onMonthChange={setPickerMonth}
          daysWithData={pickerDays}
          years={footprintYears}
          loading={pickerMonthLoading}
          min={albumSpan?.first}
          max={albumSpan?.last}
        />
        <label style={{ fontSize: 13 }}>
          <div style={{ marginBottom: 4, color: '#475569' }}>相簿</div>
          <select
            value={albumId}
            onChange={(e) => setAlbumId(e.target.value === '' ? '' : Number(e.target.value))}
            style={{ padding: '7px 10px', borderRadius: 7, border: '1px solid #cbd5e1', minWidth: 150 }}
          >
            <option value="">全部相簿</option>
            {albums.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </label>
        {(from || to || albumId !== '') && (
          <button
            onClick={() => { setFrom(''); setTo(''); setAlbumId(''); }}
            style={{ padding: '8px 14px', borderRadius: 7, border: '1px solid #cbd5e1', background: '#fff', cursor: 'pointer', fontSize: 13 }}
          >
            清除篩選
          </button>
        )}
        {/* 照片開關。預設開 —— 這一頁的主角本來就是照片。
            關掉是為了看清楚底下的線：同一個景點常常疊著幾十張縮圖，
            把整條路徑蓋得看不出貼路貼準了沒 */}
        <label style={{ fontSize: 13, display: 'flex', gap: 7, alignItems: 'center', cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={showPhotos}
            onChange={(e) => setShowPhotos(e.target.checked)}
          />
          <span title="地圖上的照片圓點、聚合數字與縮圖。關掉只是不畫，照片資料本身不受影響（縮圖也不會再去下載）。">
            顯示照片
          </span>
        </label>
        {/* 只有管理者：這一層是十二年不間斷的完整移動史，沒有公開的合理預設 */}
        {isAdmin && (
          <label style={{ fontSize: 13, display: 'flex', gap: 7, alignItems: 'center', cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={showTimeline}
              onChange={(e) => setShowTimeline(e.target.checked)}
            />
            <span title="從 Google 時間軸匯入的足跡，畫成最底層的桃紅色細線。唯讀 —— 不修正、不貼路，也不會拿來推算照片位置。跟貼路軌跡是兩個獨立開關，可以同時開著對照。">
              顯示 Google 足跡
            </span>
          </label>
        )}

        <div style={{ marginLeft: 'auto', fontSize: 13, color: '#64748b', textAlign: 'right' }}>
          <div>
            {loading ? '載入中…' : `${points.length} 個足跡點`}
            {tracks.length > 0 && ` ・ ${tracks.length} 個軌跡點`}
          </div>
          {autoStatus && (
            <div
              style={{ fontSize: 12, color: '#0891b2', marginTop: 2 }}
              title="開啟這一頁時會自動去 Drive 看有沒有新的軌跡檔（每小時最多一次）；另外選定日期後，這段範圍裡還沒貼過路的日子會自動補上 —— 有 GPS 軌跡的用軌跡，沒有的用 Google 時間軸。"
            >
              {autoStatus}
            </div>
          )}
          {!loading && photoSpan && (
            <div style={{ fontSize: 12, color: '#94a3b8', marginTop: 2 }}>
              {new Date(photoSpan.first).toLocaleDateString()} ～ {new Date(photoSpan.last).toLocaleDateString()}
              {albumId === '' && !from && !to && '（未載入軌跡）'}
            </div>
          )}
          {showTimeline && (
            <div style={{ fontSize: 12, color: '#db2777', marginTop: 2 }}>
              {timelineLoading ? `讀取 Google 足跡…（${timelineMonths.length} 個月）`
                : timelineStats && timelineStats.points > 0
                  ? `Google 足跡 ${timelineStats.points.toLocaleString()} 點 / ${timelineStats.days} 天`
                  : timelineIndex && timelineIndex.months.length === 0
                    ? '還沒匯入過 Google 足跡（管理工具裡有匯入按鈕）'
                    : '這段範圍沒有 Google 足跡'}
            </div>
          )}
          <div style={{ fontSize: 12, color: '#7c3aed', marginTop: 2 }}>
            {/* 貼路已經是自動的，所以這裡不再叫人去按什麼。剩下的只有兩種情況：
                正在補（matching）、或這段範圍根本沒有來源可以貼 */}
            {matchedLoading ? '讀取貼路軌跡…'
              : matching ? '貼路中…'
                : matchedTracks.length > 0
                  ? `貼路 ${matchedTracks.length} 點 / ${matchedDays} 天`
                  : skipTracks
                    ? ''
                    : tracks.length === 0 && timelineDaysInRange.length === 0
                      ? '這段範圍沒有可以貼路的軌跡'
                      : '這段範圍貼不出路徑（來源太疏或整天沒移動）'}
          </div>
        </div>
      </div>

      <FootprintMap
        points={points}
        showPhotos={showPhotos}
        albums={albums}
        tracks={tracks}
        editable={isAdmin}
        onEditPoints={handleEditPoints}
        onMovePhoto={handleMovePhoto}
        showRawLine={SHOW_RAW_LINE}
        matchedTracks={matchedTracks}
        showMatchedLine={SHOW_MATCHED_LINE}
        showTrackLine={SHOW_TRACK_LINE}
        animateOn={ANIMATE_ON}
        timelineLines={showTimeline ? timelineLines : undefined}
        focusPoint={focusPoint}
      />

      {/* 圖例只剩線。照片的點不再依座標來源分色（見 FootprintMap 的 photo-points 圖層）——
          一張照片的位置是量到的還是推出來的，是點開它才需要知道的事，
          不值得在每次看地圖時都佔一整排圖例 */}
      <div style={{ marginTop: 10, fontSize: 12.5, color: '#64748b', display: 'flex', gap: 16, flexWrap: 'wrap' }}>
        {showPhotos && <span style={{ color: '#2563eb' }}>● 照片</span>}
        <span style={{ color: '#7c3aed' }}>— 貼路軌跡（OSM 路網）</span>
        {showTimeline && <span style={{ color: '#db2777' }}>— Google 足跡（唯讀）</span>}
      </div>

      {isAdmin && (
        <div style={{ marginTop: 30 }}>
          {/* 整區收合。平常來這一頁是要看地圖的，貼路與同步也都自動化了，
              工具區留在展開狀態只是把地圖往上擠 */}
          <button
            onClick={() => setShowAdminTools(v => !v)}
            style={{
              display: 'flex', alignItems: 'center', gap: 8, padding: 0,
              border: 'none', background: 'none', cursor: 'pointer',
              fontSize: 18, fontWeight: 600, color: '#0f172a', marginBottom: 12,
            }}
          >
            <span style={{ fontSize: 13, color: '#94a3b8' }}>{showAdminTools ? '▾' : '▸'}</span>
            管理工具
          </button>

          {showAdminTools && (
          <>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 20 }}>
            <button
              onClick={() => setShowTimelineImport(true)}
              style={{ ...toolBtn, borderColor: '#0891b2', color: '#0891b2' }}
            >
              📍 從 Google 時間軸匯入
            </button>
            <button
              disabled={syncing}
              onClick={syncTracks}
              style={{ ...toolBtn, borderColor: '#16a34a', color: '#16a34a' }}
            >
              {syncing ? '同步中…' : '🛰️ 立即同步足跡'}
            </button>
            <label style={{
              fontSize: 12.5, color: '#64748b', display: 'flex',
              gap: 6, alignItems: 'center', cursor: 'pointer',
            }}>
              <input type="checkbox" checked={forceSync} onChange={(e) => setForceSync(e.target.checked)} />
              <span title="平常只會重抓內容有變的檔案。停留點濃縮的結果是匯入當下算好寫進資料庫的，調整參數後要勾這個才會重算。">
                強制重新匯入
              </span>
            </label>
            {/* 貼路沒有按鈕：選定日期就自動補齊（見上面那個自動貼路的 effect）。
                有 GPSLogger 軌跡的日子用實測軌跡，沒有的才用 Google 時間軸。
                進度在畫面右上角那行狀態字，細節在底下的 log */}
          </div>

          {matchLog.length > 0 && (
            <div style={{
              marginBottom: 20, padding: '12px 14px', background: '#faf5ff',
              border: '1px solid #e9d5ff', borderRadius: 9,
              fontSize: 12.5, lineHeight: 1.7, color: '#5b21b6',
            }}>
              {matchLog.map((line, i) => <div key={i}>{line}</div>)}
              {!matching && (
                <button
                  onClick={() => setMatchLog([])}
                  style={{
                    marginTop: 8, padding: '4px 10px', borderRadius: 6,
                    border: '1px solid #ddd6fe', background: '#fff', cursor: 'pointer', fontSize: 12,
                  }}
                >
                  收起
                </button>
              )}
              {/* OSM 的資料授權要求標註來源，貼路的幾何整條都來自那裡。
                  收折起來但不刪掉 —— 授權要求的是「有標註」，不是「一直攤在眼前」 */}
              <details style={{ marginTop: 8, fontSize: 11.5, color: '#7c3aed', opacity: 0.8 }}>
                <summary style={{ cursor: 'pointer' }}>資料來源與授權</summary>
                <div style={{ marginTop: 4 }}>
                  路網比對由 FOSSGIS e.V. 提供的 Valhalla 服務完成，道路資料 © OpenStreetMap contributors
                </div>
              </details>
            </div>
          )}

          {syncLog.length > 0 && (
            <div style={{
              marginBottom: 20, padding: '12px 14px', background: '#f8fafc',
              border: '1px solid #e2e8f0', borderRadius: 9,
              fontSize: 12.5, lineHeight: 1.7, color: '#475569',
            }}>
              {syncLog.map((line, i) => <div key={i}>{line}</div>)}
              {!syncing && (
                <button
                  onClick={() => setSyncLog([])}
                  style={{
                    marginTop: 8, padding: '4px 10px', borderRadius: 6,
                    border: '1px solid #cbd5e1', background: '#fff', cursor: 'pointer', fontSize: 12,
                  }}
                >
                  收起
                </button>
              )}
            </div>
          )}

          {currentAlbum && (
            <div style={{
              padding: 14, background: '#f8fafc', borderRadius: 10, marginBottom: 20, fontSize: 13.5,
            }}>
              <label style={{ display: 'flex', gap: 10, alignItems: 'flex-start', cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={Number(currentAlbum.map_private ?? 1) === 0}
                  onChange={async (e) => {
                    const ok = await setAlbumMapPrivacy(currentAlbum.id, !e.target.checked);
                    if (ok) fetchAlbums().then(setAlbums);
                  }}
                  style={{ marginTop: 3 }}
                />
                <span>
                  公開「{currentAlbum.name}」的足跡地圖
                  <span style={{ display: 'block', color: '#64748b', fontSize: 12.5 }}>
                    預設為私密。即使開啟，個別標記為私密的照片仍不會出現在地圖上。
                  </span>
                </span>
              </label>
            </div>
          )}

          <h3 style={{ fontSize: 15, marginBottom: 8 }}>行程段（{segments.length}）</h3>
          {segments.length === 0 ? (
            <p style={{ fontSize: 13.5, color: '#64748b' }}>
              還沒有行程段。到相簿中選取照片後按「指定地點」，並勾選「同時建立行程段」即可建立。
            </p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {segments.map(s => (
                <div key={s.id} style={{
                  display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px',
                  border: '1px solid #e2e8f0', borderRadius: 9, fontSize: 13.5, flexWrap: 'wrap',
                }}>
                  <strong style={{ minWidth: 110 }}>{s.label}</strong>
                  <span style={{ color: '#64748b' }}>{s.start_local} ~ {s.end_local}</span>
                  <span style={{ color: '#94a3b8', fontSize: 12 }}>
                    {s.lat.toFixed(4)}, {s.lng.toFixed(4)}
                  </span>
                  <button
                    onClick={async () => {
                      if (!confirm(`刪除行程段「${s.label}」？已套用到照片上的地點不會被移除。`)) return;
                      if (await deleteTripSegment(s.id)) {
                        setSegments(prev => prev.filter(x => x.id !== s.id));
                      }
                    }}
                    style={{
                      marginLeft: 'auto', padding: '5px 12px', borderRadius: 6,
                      border: '1px solid #fecaca', background: '#fff', color: '#dc2626',
                      cursor: 'pointer', fontSize: 12.5,
                    }}
                  >
                    刪除
                  </button>
                </div>
              ))}
            </div>
          )}
          </>
          )}
        </div>
      )}

      <TimelineImportModal
        isOpen={showTimelineImport}
        onClose={() => setShowTimelineImport(false)}
        onDone={() => load()}
        onTrackUploaded={() => {
          // 月檔內容整個換掉了，快取裡的舊資料不能再用。
          // 索引也設回 null，讓上面的 effect 重抓一次
          timelineCache.current.clear();
          setTimelineIndex(null);
          setShowTimeline(true);
        }}
      />
    </div>
  );
}

const toolBtn: React.CSSProperties = {
  padding: '9px 16px', borderRadius: 8, border: '1px solid #cbd5e1',
  background: '#fff', cursor: 'pointer', fontSize: 13.5,
};
