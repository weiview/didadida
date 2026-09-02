'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import dynamic from 'next/dynamic';
import {
  fetchFootprint, fetchAllAlbums, fetchTripSegments, deleteTripSegment,
  setAlbumMapPrivacy,
  fetchDriveGpxFiles, fetchDriveGpxText, ingestTrack, fetchTracks,
  editTrackPoints,
  saveTrackRaw, fetchTrackRaw, fetchTrackDays, updatePhotoGeo,
  matchTrackShape, saveTrackMatched, fetchTrackMatched,
  fetchTimelineIndex, fetchTimelineMonth, fetchTrackMembers,
  type FootprintPoint, type Album, type TripSegment, type TrackPoint,
  type TrackPointEdit, type TrackDay, type MatchedTrack, type TrackMember,
  type TimelineIndex, type TimelineMonthData,
} from '@/lib/api';
import { DEFAULT_TRACK_COLOR } from '@/lib/trackColors';
import { toLineStrings, segmentIndices, type TrackTuple } from '@/lib/timelineTrack';
import { useAdmin } from '@/lib/useAdmin';
import { parseGpx, simplifyTrack, collapseStays, rejectSpikes, extractTrips } from '@/lib/gpx';
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
 * 由 Google 時間軸驅動的那些軌跡點，day_key 用這個前綴。
 *
 * 這些點不在 D1 的 TrackDay 裡（時間軸是唯讀紀念層，刻意不進資料庫），前綴是為了
 * 讓它們的 segmentKey（'day_key#seg'）不會跟 GPS 那批撞號 —— 兩邊的 seg 都從 0 起算。
 *
 * 後端也有一份同名常數（見 isTrackDayPublic），那邊是給 R2 上舊的貼路結果用的。
 * 前端已經不再送時間軸去貼路，但那些檔案還躺在 bucket 裡，所以後端那份先留著。
 */
const TIMELINE_DAY_PREFIX = 'timeline:';
/**
 * 一次最多處理幾天的時間軸。
 * 沒有上限的話「不選日期」就等於一次把十二年的月檔全部拉下來。
 */
const TIMELINE_MAX_DAYS = 62;

/**
 * 上次自動同步的時間戳（毫秒）存這個 key。
 * 代跑（替別人同步）是**每個人各一個** key：`<這個>:u<uid>` ——
 * 共用一個的話，站長自己剛同步過就會把全家的都當成剛跑過而整批跳過。
 */
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
  /**
   * 這一頁的管理工具（同步 Drive 軌跡、貼路、匯入 Google 時間軸、行程段）動到的
   * 都是**全站共用**的一份資料，後端只放行 can_manage_others 的人。一般成員看得到
   * 軌跡（GET 沒擋），但不該端出那些按鈕 —— 按了只會拿到 403。
   */
  const {
    isAdmin, canManageOthers, canViewMap, canUseTools, convoyOverlapPct, babyAvatar,
    checking: checkingAuth, user,
  } = useAdmin();
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [showTimelineImport, setShowTimelineImport] = useState(false);
  // 管理工具整區收合。預設收起來 —— 平常來這一頁是要看地圖的，
  // 而貼路與同步都已經自動化，工具區不再是每次都要用的東西
  const [showAdminTools, setShowAdminTools] = useState(false);
  // 行程段那一份也收起來（同一套收合寫法）。它是一張會愈長愈長的規則清單，
  // 攤開時把上面的同步、貼路那些按鈕整個推到看不見的地方
  const [showSegments, setShowSegments] = useState(false);
  const [syncing, setSyncing] = useState(false);
  // 同步過程逐行累積，每個檔案結束就更新一次 —— 這是一個會跑好幾秒的操作
  const [syncLog, setSyncLog] = useState<string[]>([]);
  // 停留點濃縮的參數是在匯入時寫死進資料的，改了參數就得繞過 md5 比對整批重灌
  const [forceSync, setForceSync] = useState(false);
  // 手動上傳 GPX 用的隱藏 file input。按鈕自己畫，原生那顆長得跟頁面格格不入
  const gpxInputRef = useRef<HTMLInputElement>(null);
  // D1 裡有的所有軌跡日（不受畫面上的日期篩選影響）。
  // 拿來算 gpsDays（決定哪幾天輪得到 Google 時間軸貼路）與查 has_raw / md5
  const [trackDays, setTrackDays] = useState<TrackDay[]>([]);

  /*
   * 站上有哪些家人、各是什麼顏色。地圖上的線要靠它把 user_id 換成顏色與人名。
   * 只有一個人的站台不會端出篩選列（見下面的 showMemberFilter）。
   */
  const [members, setMembers] = useState<TrackMember[]>([]);
  /*
   * 被關掉的成員。存「關掉的」而不是「開著的」是刻意的 ——
   * 站長之後加了新家人，他預設就是看得到的，不必回頭來這裡補勾。
   *
   * 這是**顯示篩選不是隱私牆**（使用者定調）：家人本來就互相看得到，
   * 關掉只是這一刻不想讓那條線擋住畫面。
   */
  const [hiddenUsers, setHiddenUsers] = useState<Set<number>>(new Set());

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
  // 代跑（替全家同步）也是一次掛載只跑一次，理由同上
  const autoSweepStarted = useRef(false);
  /*
   * 自動同步排成一條鏈，不並行。自己那一份與代跑的每一個人各自是一段，
   * 但它們共用 syncing／syncLog 那一份畫面狀態，而且都要打 Drive 與
   * Valhalla（後者條款寫明每秒最多一個請求）—— 同時跑起來的話 log 會互相
   * 蓋掉，看起來像同步錯亂。同 resolveDuplicate 那條佇列的規矩。
   */
  const syncChain = useRef<Promise<void>>(Promise.resolve());

  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  // 日期選擇器目前翻到哪個月。跟 from/to 分開 —— 還沒選日期時也要能翻月份找足跡
  const [pickerMonth, setPickerMonth] = useState(() => monthOf(todayLocal()));
  /**
   * 「時間點」那個下拉目前選的值 —— 那一分鐘起點的 **UTC 毫秒**，型別是字串
   * （<option> 的 value 只有字串）。只有選了**單獨一天**才有意義 ——
   * 跨好幾天的時候「14:30」指的是哪一天沒有答案。
   */
  const [jumpTime, setJumpTime] = useState('');
  /**
   * 送給地圖的跳轉要求。`nonce` 是為了讓「同一個時間再送一次」也算數
   * （鏡頭被拖走之後想跳回角色身上），見 FootprintMap 的 `seekTo`。
   */
  const [seekTo, setSeekTo] = useState<{ t: number; nonce: number } | null>(null);
  const seekNonce = useRef(0);
  const [albumId, setAlbumId] = useState<number | ''>('');
  /** 選了一個時間點就直接送給地圖（沒有另外一顆「跳」了）。 */
  const seekToMs = useCallback((ms: number) => {
    if (!Number.isFinite(ms)) return;
    seekNonce.current += 1;
    setSeekTo({ t: ms, nonce: seekNonce.current });
  }, []);
  // 目前這本相簿的照片橫跨哪段日期（本地日，YYYY-MM-DD）。
  // 選了相簿之後日期輸入框就鎖在這個範圍內
  const [albumSpan, setAlbumSpan] = useState<{ first: string; last: string } | null>(null);

  const load = useCallback(async () => {
    // 訪客沒被開放看足跡時後端會回 403，這裡先不打 —— 主控台不必多一行紅字
    if (!canViewMap) { setPoints([]); setLoading(false); return; }
    setLoading(true);
    const data = await fetchFootprint({
      from: from || undefined,
      // 結束日要含當天整日，否則 '2026-03-05 14:00' 會大於 '2026-03-05' 而被濾掉
      to: to ? `${to} 23:59:59` : undefined,
      albumId: albumId === '' ? undefined : albumId,
    });
    setPoints(data);
    setLoading(false);
  }, [from, to, albumId, canViewMap]);

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
    if (albumId === '' || !canViewMap) { setAlbumSpan(null); setFrom(''); setTo(''); return; }

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
  }, [albumId, canViewMap]);

  /*
   * 拆成基本型別再進 deps —— range 物件每次都是新的，照片重載時會白打一次 API。
   *
   * 訪客不打這支：軌跡一律要登入（後端會回 401，這裡不打是省一趟白費的請求）。
   * 訪客在這一頁看到的只有相簿的打卡點，而那還要相簿自己被設成公開。
   */
  const { from: trackFrom, to: trackTo, skip: skipTracks } = range;

  /*
   * 要撈哪幾個人的軌跡。全都看得到時送 undefined（不帶 ?user_id=）。
   *
   * 篩選推到後端而不是撈回來再濾：`/api/tracks` 的點數上限是**全域**的，
   * 三個人同框等於每個人只剩三分之一的天數。只看一個人時就不該把別人的點
   * 也讀出來 —— 那既吃掉那個上限，也白花 D1 的讀取額度
   * （[[free-tier-is-top-priority]]）。
   *
   * 壓成字串再進 deps：Set 每次 render 都是新物件。
   */
  const visibleUserIds = useMemo(() => {
    if (hiddenUsers.size === 0) return '';
    return members.map(m => m.id).filter(id => !hiddenUsers.has(id)).join(',');
  }, [members, hiddenUsers]);

  const loadTracks = useCallback(async () => {
    if (!isAdmin || skipTracks) { setTracks([]); return; }
    // 全部關掉：不必打 API，答案一定是空的
    if (hiddenUsers.size > 0 && !visibleUserIds) { setTracks([]); return; }
    setTracks(await fetchTracks({
      from: trackFrom,
      to: trackTo,
      userIds: visibleUserIds ? visibleUserIds.split(',').map(Number) : undefined,
    }));
    // hiddenUsers 只透過 visibleUserIds 影響結果，但「全關」那條捷徑要看得到它
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAdmin, trackFrom, trackTo, skipTracks, visibleUserIds, hiddenUsers.size]);

  useEffect(() => {
    // 看不到這一頁的人不必為了一個畫不出來的下拉選單去撈整份相簿清單
    if (!canViewMap) { setAlbums([]); return; }
    fetchAllAlbums().then(setAlbums);
  }, [canViewMap]);

  // 只有管理者讀得到（會暴露出門的日期）
  const loadTrackDays = useCallback(async () => {
    if (!isAdmin) { setTrackDays([]); return; }
    setTrackDays(await fetchTrackDays());
  }, [isAdmin]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { loadTracks(); }, [loadTracks]);
  useEffect(() => { loadTrackDays(); }, [loadTrackDays]);

  // 家人清單很小（一個家庭幾筆），進頁抓一次就夠。訪客不打（後端 401）
  useEffect(() => {
    if (!isAdmin) { setMembers([]); return; }
    let cancelled = false;
    fetchTrackMembers().then(list => { if (!cancelled) setMembers(list); });
    return () => { cancelled = true; };
  }, [isAdmin]);

  /** user_id → 顏色。FootprintMap 的 match 運算式吃這個 */
  const trackColors = useMemo(() => {
    const out: Record<number, string> = {};
    for (const m of members) out[m.id] = m.track_color;
    return out;
  }, [members]);

  /** user_id → 頭像。播放時坐在車上的那顆大頭 */
  const trackAvatars = useMemo(() => {
    const out: Record<number, string | null> = {};
    for (const m of members) out[m.id] = m.avatar ?? null;
    return out;
  }, [members]);

  /** user_id → 固定坐哪個位子（站長開車、指定的那位坐副駕）。沒指定的不列 */
  const trackSeats = useMemo(() => {
    const out: Record<number, 'driver' | 'passenger'> = {};
    for (const m of members) if (m.seat) out[m.id] = m.seat;
    return out;
  }, [members]);

  /** 我自己的顏色。Google 紀念層永遠是我自己的時間軸，跟著我的顏色走 */
  const myColor = user?.track_color || DEFAULT_TRACK_COLOR;
  const myUserId = user?.id ?? null;

  /*
   * 篩選列只在「站上真的不只一個人」時才端出來。
   * 一個人的站台勾一個永遠打勾的框，只是多一排看不懂的東西。
   */
  const showMemberFilter = isAdmin && members.length > 1;

  /** 我自己被篩掉了。我名下那些不經過 /api/tracks 的層（Google 歷史）要自己收 */
  const meHidden = myUserId != null && hiddenUsers.has(myUserId);

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
   * 目前這段日期範圍裡，要拿 Google 時間軸當軌跡的日子（YYYY-MM-DD）。
   *
   * **有 GPSLogger 軌跡的日子直接排除** —— 那一天以實測軌跡為準，時間軸只在
   * 「那天根本沒帶手機記軌跡」時才頂上。這是唯一的來源優先序，兩邊不會同時畫，
   * 也就不會有兩條線打架的問題。
   *
   * 只看索引不看月檔：月檔要真的去 R2 抓，而這份清單的用途是「哪幾天值得去抓月檔」，
   * 用月的粒度先篩掉大半已經夠了。
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
   * 沒有 GPSLogger 軌跡的那些日子，直接拿 Google 時間軸的原始點當軌跡。
   *
   * 本來是把它們送去 Valhalla 貼路的，貼出來的結果不理想（時間軸是分鐘級取樣，
   * 一段路只有十幾個點，matcher 常常挑到平行的另一條路、或把等紅燈的抖動
   * 認成繞了一圈），現在整條路拿掉了 —— 原始點雖然是折線，至少它是真的紀錄。
   *
   * 這批點跟貼路結果一樣是「畫出來給人看＋跑動畫」用的衍生資料：
   * id 給負數、不進 D1、不可編輯。
   */
  const [timelineTracks, setTimelineTracks] = useState<TrackPoint[]>([]);
  useEffect(() => {
    const days = timelineDayKeys ? timelineDayKeys.split(',') : [];
    if (days.length === 0) { setTimelineTracks([]); return; }

    let cancelled = false;
    (async () => {
      const cache = timelineCache.current;
      const months = Array.from(new Set(days.map(d => d.slice(0, 7)))).sort();
      let fetched = false;
      for (const m of months) {
        if (cache.has(m)) continue;
        const data = await fetchTimelineMonth(m);
        if (cancelled) return;
        // 抓不到（索引與月檔不同步）也記成空的，免得每次重算都再問一次
        cache.set(m, data ?? {});
        fetched = true;
      }
      // 月檔在 ref 裡，日期選擇器要靠這個計數器才知道有新的一個月可以畫格子
      if (fetched && !cancelled) setTimelineCacheVersion(v => v + 1);

      // 月檔是整月的、日是當地日，而日期範圍是 UTC 瞬間，所以逐點還要再濾一次
      const tMin = trackFrom ? Date.parse(trackFrom) : -Infinity;
      const tMax = trackTo ? Date.parse(trackTo) : Infinity;
      const out: TrackPoint[] = [];
      for (const day of days) {
        const tuples = cache.get(day.slice(0, 7))?.[day] as TrackTuple[] | undefined;
        if (!tuples?.length) continue;
        const sorted = tuples.slice().sort((a, b) => a[0] - b[0]);
        // 切段的門檻沿用畫線那一套（超過一小時沒取樣、或隱含速度 >200km/h）：
        // 沒開 app、沒訊號、飛機上那幾段不可以連成一條線
        const segs = segmentIndices(sorted);
        for (let i = 0; i < sorted.length; i++) {
          const [sec, lat, lng] = sorted[i];
          const t = sec * 1000;
          if (t < tMin || t > tMax) continue;
          out.push({
            // 負數 id：這些點不在 D1 裡，給個一看就知道不是真列的值，
            // 免得哪天不小心被當成可編輯的點送進 editTrackPoints
            id: -(out.length + 1),
            day_key: TIMELINE_DAY_PREFIX + day,
            t_utc: new Date(t).toISOString(),
            lat,
            lng,
            src: 'timeline',
            seg: segs[i],
            // 時間軸月檔存在「我自己的」R2 命名空間裡，看到的永遠是自己的
            user_id: myUserId,
          });
        }
      }
      if (!cancelled) setTimelineTracks(out);
    })();

    return () => { cancelled = true; };
  }, [timelineDayKeys, trackFrom, trackTo, myUserId]);

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

  /*
   * 每個月檔的版本號 ＝ 索引裡那個月的點數。掛在網址上（`?v=`）讓後端敢回
   * `immutable`，於是同一個月只會真的下載一次，之後每次打開地圖都是從瀏覽器
   * 自己的快取拿 —— 這就是「Google 足跡每次登入都重跑一次」的那段等待。
   * 重新匯入會讓點數變、網址跟著變，舊的那份就自動退場。
   *
   * ⚠️ 放在 ref 裡而不是直接讀 state：底下那個算折線的 effect 刻意沒把索引
   *    列進相依（索引每次抓回來都是新物件，列進去等於每次進頁都重算一輪），
   *    ref 才拿得到最新值又不會多觸發一次。
   */
  const monthVersions = useRef<Map<string, number>>(new Map());
  useEffect(() => {
    monthVersions.current = new Map(
      (timelineIndex?.months ?? []).map(m => [m.monthKey, m.points]),
    );
  }, [timelineIndex]);

  // 索引很小（144 筆），進頁就抓一次，之後不再重抓。
  // 不等「顯示 Google 足跡」被打開 —— 日期選擇器要靠它知道哪幾個月有足跡，
  // 而那個判斷跟這一層畫不畫出來無關
  // canUseTools：沒有工具權限的人整個人不出現在地圖上（連他自己看也一樣，
  // 見後端 TRACK_MEMBER_COND）。Google 紀念層是他自己的另一半足跡，
  // 留著只會變成一條沒有名字的線 —— 索引不抓，這一層就整層不存在
  useEffect(() => {
    if (!isAdmin || !canUseTools || timelineIndex) return;
    let cancelled = false;
    (async () => {
      const idx = await fetchTimelineIndex();
      if (!cancelled) setTimelineIndex(idx);
    })();
    return () => { cancelled = true; };
  }, [isAdmin, canUseTools, timelineIndex]);

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
        const data = await fetchTimelineMonth(pickerMonth, monthVersions.current.get(pickerMonth));
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
    // ⚠️ local_time 會是 null（「指定地點」可以只給座標不給時間，影片與掃描的
    //    老照片就是這種）。少了這道 filter，整個 /map 會在這裡丟
    //    「Cannot read properties of null」而被錯誤邊界接成一頁 Application error。
    setPhotoDays(new Set(
      points.map(p => p.local_time).filter((t): t is string => !!t).map(t => t.slice(0, 10)),
    ));
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
          const data = await fetchTimelineMonth(m, monthVersions.current.get(m));
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
        // 只有 GPS 軌跡的日子。Google 時間軸那批不再貼路，改由 timelineTracks
        // 直接拿原始點畫（見上面），不必來這裡問 R2
        const dayKeys = rawDayKeys ? rawDayKeys.split(',') : [];
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
          // ⚠️ 只有「檔案不存在」才算沒貼過。`segments: []` 是貼過了、貼不出東西
          // （整天沒移動、火車飛機、Valhalla 掛掉），那是一筆有效的紀錄 ——
          // 把它也算成 missing 的話這幾天會每次進地圖都重跑一輪解析與請求，
          // 而結果永遠還是空的。來源真的變了時後端 ingest 會自己刪掉這個檔
          if (!data) { missing.push(dayKey); continue; }
          if (!data.segments?.length) continue;

          let kept = 0;
          for (const s of data.segments) {
            // s.vehicle 存在 R2 裡（貼路當下用的 costing），這裡不讀 ——
            // 地圖上只有一台車，不再需要「這趟是什麼車」來挑圖示
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
  }, [rawDayKeys, trackFrom, trackTo, matchedVersion]);

  /**
   * 同步足跡的本體：列出 Drive 上的 GPX、只抓 md5 有變的，在瀏覽器裡解析與抽稀，
   * 再一天一次寫進 D1。
   *
   * ⚠️⚠️ **解析永遠留在瀏覽器，不要再提「搬去 Worker 排 cron」這件事。**
   * 免費版的 scheduled handler 跟一般請求一樣只有 **10ms CPU**（15 分鐘那個數字
   * 是牆上時間不是 CPU），而實測光是掃一天的 GPX（Worker 沒有 DOMParser，
   * 只能 regex）就要 5000 點 9ms／1 萬點 19ms／2 萬點 35ms —— 一天的軌跡動輒
   * 上萬點，一開跑就超時，而且是**安靜地**超時。順帶還會讓 gpx.ts 變成前後端
   * 各一份。瀏覽器的 CPU 不用錢，所以「每天固定自動同步」改成**代跑**：
   * 可管理全站內容的人一進 /map，就順手把每個綁好資料夾的成員也掃一遍
   * （`subject`），寫入那三支路由本來就對他開著。
   *
   * 手動按按鈕與開頁自動同步共用這一份，差別只在 force 與 quiet。
   *
   * @param subject 代跑的對象；不給就是同步自己那一份
   * @returns 真正寫進去的那幾天（要拿去接著貼路）；Drive 讀取失敗回 null，
   *          跟「沒有需要同步的」（回空陣列）分開 —— 失敗不該消耗自動同步的冷卻時間
   */
  const runSync = useCallback(async (
    { force = false, quiet = false, subject }: {
      force?: boolean;
      quiet?: boolean;
      subject?: { uid: number; name: string | null };
    } = {},
  ): Promise<MatchTarget[] | null> => {
    setSyncing(true);
    // 代跑時每一行都要寫出是誰的，不然畫面上看起來像自己的軌跡憑空多出好幾天
    const who = subject ? `${subject.name || `#${subject.uid}`}：` : '';
    const log: string[] = [`${who}正在讀取 Drive 檔案清單…`];
    setSyncLog([...log]);

    const { files, error, code } = await fetchDriveGpxFiles(subject?.uid);
    if (error) {
      setSyncLog([who + (code === 'track_folder_unbound' ? error : `讀取失敗：${error}`)]);
      setSyncing(false);
      // 還沒綁資料夾不是失敗，是還沒設定。回空陣列讓開頁自動同步安靜地結束
      // （回 null 的話它會判定成 Drive 掛了，每次進地圖都跳一次紅字）
      return code === 'track_folder_unbound' ? [] : null;
    }

    // 強制模式忽略 md5，整批重灌 —— 停留點濃縮的結果是寫死在資料裡的，
    // 檔案內容沒變但演算法參數變了的時候，只有這條路能把舊資料換掉。
    // 平常則跳過 ingest_source='manual' 的日子：那是「人決定過內容」的日子
    // （手動編修過軌跡點，或整個檔是手動上傳的），重灌會整批刪掉再寫入，
    // 把那些決定洗掉而且不會有人發現
    const edited = files.filter(f => f.ingestSource === 'manual');
    const todo = force ? files : files.filter(f => f.needsSync && f.ingestSource !== 'manual');
    const skipped = force ? 0 : files.filter(f => f.needsSync && f.ingestSource === 'manual').length;
    if (todo.length === 0) {
      setSyncLog([
        `${who}Drive 上有 ${files.length} 個軌跡檔，沒有需要同步的。`
        + (skipped > 0 ? `（${skipped} 個手動編修或上傳過，已跳過）` : ''),
      ]);
      setSyncing(false);
      return [];
    }

    log.length = 0;
    log.push((quiet ? '自動同步：' : '') + who
      + (force
        ? `${files.length} 個軌跡檔，強制全部重新匯入`
          + (edited.length > 0 ? `（含 ${edited.length} 個手動編修或上傳過的，會被覆蓋）` : '')
        : `${files.length} 個軌跡檔，其中 ${todo.length} 個有更新`
          + (skipped > 0 ? `，另 ${skipped} 個手動編修或上傳過已跳過` : '')));
    setSyncLog([...log]);

    const ingested: MatchTarget[] = [];
    let total = 0;
    for (const f of todo) {
      const xml = await fetchDriveGpxText(f.driveFileId);
      if (!xml) {
        log.push(`${f.fileName}：下載失敗`);
        setSyncLog([...log]);
        continue;
      }

      const parsed = parseGpx(xml);
      if (parsed.error) {
        log.push(`${f.fileName}：${parsed.error}`);
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
        log.push(`${f.fileName}：寫入失敗`);
      } else {
        // 留存原文（給「恢復原始軌跡」用）。必須排在 ingest 之後：
        // 後端是 UPDATE TrackDay，那一列還不存在的話 raw_key 會寫不進去。
        // 存檔失敗不算同步失敗 —— 軌跡點已經進 D1 了，只是這天還原不回來
        //
        // 用 result.dayKey 而不是 f.dayKey：多身分之後 key 由後端依身分重組，
        // 送進去的跟寫出來的不保證一樣，用錯的那個會存到一個沒有 TrackDay 的 key 上
        const rawSaved = await saveTrackRaw(result.dayKey, xml);
        total += result.inserted;
        // 只有留存成功的才值得接著貼路 —— 貼路只吃原始 GPX，沒有原文就貼不了
        if (rawSaved) ingested.push({ dayKey: result.dayKey, md5: f.md5 ?? null });
        const dropped = parsed.skipped > 0 ? `，${parsed.skipped} 點無時間被略過` : '';
        const stays = stayCount > 0 ? `，含 ${stayCount} 處停留` : '';
        const raw = rawSaved ? '' : '（原始檔留存失敗，這天無法還原）';
        log.push(
          `${f.fileName}：${parsed.points.length} 點 / ${parsed.segCount} 段 → `
          + `濃縮停留 ${stayed.length} 點 → 抽稀後寫入 ${result.inserted} 點${stays}${dropped}${raw}`
        );
      }
      setSyncLog([...log]);
    }

    log.push(`${who}同步完成，共寫入 ${total} 個軌跡點。`);
    setSyncLog([...log]);
    setSyncing(false);
    loadTracks();
    loadTrackDays();
    return ingested;
  }, [loadTracks, loadTrackDays]);

  /** 「立即同步足跡」按鈕。強制模式的開關只影響手動這條路 */
  const syncTracks = () => runSync({ force: forceSync });

  /**
   * 手動選 GPX 上傳。走的是跟 Drive 同步**一模一樣**的管線
   * （parseGpx → collapseStays → simplifyTrack → ingest → 留存原文），
   * 差別只有三處：
   *
   * - 檔案從 `<input type=file>` 來，不經過 Drive，所以沒有 driveFileId／md5。
   * - `ingestSource: 'manual'`：往後 Drive 同步會**跳過**這幾天。手動傳上來的
   *   通常是「Drive 上沒有、或不想被自動覆蓋」的那一份，被自動流程洗掉會很難查。
   * - day_key 用檔名（後端會依身分補前綴）。**同名就是同一天，會整批換掉** ——
   *   重傳同一個檔是修正，不是新增。
   *
   * 為什麼每個成員都要有這條路：GPSLogger 只傳得到自己的 Drive，資料夾還沒
   * 分享／綁定之前他一個點都同步不進來；舊手機匯出的、朋友給的 GPX 也只有這條路。
   */
  const uploadGpxFiles = useCallback(async (fileList: FileList | null) => {
    const files = Array.from(fileList ?? []);
    if (files.length === 0 || syncing) return;

    setSyncing(true);
    const log: string[] = [`準備匯入 ${files.length} 個檔案…`];
    setSyncLog([...log]);

    const ingested: MatchTarget[] = [];
    let total = 0;
    for (const file of files) {
      const xml = await file.text().catch(() => null);
      if (xml === null) {
        log.push(`${file.name}：讀取失敗`);
        setSyncLog([...log]);
        continue;
      }

      const parsed = parseGpx(xml);
      if (parsed.error) {
        log.push(`${file.name}：${parsed.error}`);
        setSyncLog([...log]);
        continue;
      }

      const stayed = collapseStays(parsed.points);
      const simplified = simplifyTrack(stayed);
      const stayCount = simplified.filter(p => (p.staySec ?? 0) > 0).length;
      const result = await ingestTrack({
        dayKey: file.name,
        ingestSource: 'manual',
        points: simplified,
      });

      if (!result) {
        log.push(`${file.name}：寫入失敗`);
      } else {
        // 同 Drive 那條路：一定要用後端回傳的 key，送進去的那個不保證相同
        const rawSaved = await saveTrackRaw(result.dayKey, xml);
        total += result.inserted;
        if (rawSaved) ingested.push({ dayKey: result.dayKey, md5: null });
        const dropped = parsed.skipped > 0 ? `，${parsed.skipped} 點無時間被略過` : '';
        const stays = stayCount > 0 ? `，含 ${stayCount} 處停留` : '';
        const raw = rawSaved ? '' : '（原始檔留存失敗，這天無法還原）';
        log.push(
          `${file.name}：${parsed.points.length} 點 / ${parsed.segCount} 段 → `
          + `濃縮停留 ${stayed.length} 點 → 抽稀後寫入 ${result.inserted} 點${stays}${dropped}${raw}`
        );
      }
      setSyncLog([...log]);
    }

    log.push(`匯入完成，共寫入 ${total} 個軌跡點。`
      // 貼路是那個 effect 依「畫面上選的日期」自動補的，所以只在有原文時提一句，
      // 不保證馬上發生 —— 傳的是三年前那一天就得先把日期切過去
      + (ingested.length > 0 ? '把日期切到那幾天就會自動貼路。' : ''));
    setSyncLog([...log]);
    setSyncing(false);
    loadTracks();
    loadTrackDays();
  }, [syncing, loadTracks, loadTrackDays]);

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
   * - ⚠️⚠️ **貼不出東西也要留下紀錄**（`segments: []` ＋ `emptyReason`），
   *   不可以 `deleteTrackMatched()`。刪掉的話那一天在 R2 上就跟「還沒貼過」
   *   一模一樣，每次進地圖都會被 `unmatchedKeys` 挑出來重跑一輪整天的解析
   *   （而結果永遠還是空的）—— 使用者看到的就是「每次登入都重跑一次」。
   *   唯一的例外是**請求真的失敗**（Valhalla 掛掉）：那是暫時的，維持沒有檔案
   *   讓它下次再試。真正該讓結果消失的時機只有「那一天的點被重寫」，
   *   而 `POST /api/tracks/ingest` 已經在後端自己刪了。
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
        log.push(`${dayKey}：來源未變，沿用上次結果（`
          + (existing.segments.length > 0
            ? `${existing.segments.length} 趟`
            // 空結果是「上次貼過了，貼不出東西」的紀錄，不是還沒貼
            : existing.emptyReason === 'no_trips' ? '整天沒有移動' : '沒有走道路的趟')
          + '）');
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
        // 這一天整天沒移動。⚠️ 存一份空結果而不是刪掉：刪掉的話畫面上是清乾淨了，
        // 但這一天在 R2 上就跟「還沒貼過」一模一樣，下次進地圖又會被挑出來
        // 重解析一次整天的點，結果永遠還是空的
        await saveTrackMatched(dayKey, {
          dayKey, builtAt: new Date().toISOString(), sourceMd5: md5 ?? undefined,
          emptyReason: 'no_trips', segments: [],
        });
        log.push(`${dayKey}：${parsed.points.length} 點裡沒有一趟真正的移動，略過`);
        setMatchLog([...log]);
        continue;
      }

      log.push(`${dayKey}：${parsed.points.length} 點 → ${trips.length} 趟移動`);
      setMatchLog([...log]);

      const segments: MatchedTrack['segments'] = [];
      let dayPoints = 0;
      // 送出去卻沒貼回來的趟數。「這一天貼不出東西」有兩種原因，處理方式相反：
      // 火車飛機不走道路是**永久**的（記下來，別再問），Valhalla 掛掉是**暫時**的
      // （志工維護的單機，壞掉是預期內的事）—— 把暫時的記成永久等於那一天再也
      // 不會有貼路軌跡，除非來源檔的 md5 剛好變了
      let failed = 0;

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
          failed++;
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

      if (segments.length === 0 && failed > 0) {
        // 送出去的請求真的失敗了。⚠️ 這一天**不留紀錄**（R2 上維持沒有這個檔），
        // 下次才會被 unmatchedKeys 挑出來再試一次
        log.push(`${dayKey}：${failed} 趟都貼路失敗，這一天先留著，之後會再試`);
      } else if (segments.length === 0) {
        // 每一趟都是火車／飛機／船。這是檔案本身決定的，重跑一百次結果一樣 ——
        // 存一份空結果把它結案，不然每次進地圖都會再解析一次整天的點
        await saveTrackMatched(dayKey, {
          dayKey, builtAt: new Date().toISOString(), sourceMd5: md5 ?? undefined,
          emptyReason: 'no_match', segments: [],
        });
        log.push(`${dayKey}：${trips.length} 趟都不走道路，沒有貼出任何一趟`);
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
   * 自動貼路：選好日期就自己把這段範圍補齊，不再有按鈕。
   *
   * 只有 GPSLogger 的軌跡會走這裡。Google 時間軸曾經也送去貼路，效果不理想
   * （分鐘級取樣太疏，matcher 常常挑到平行的另一條路）—— 現在那些日子直接
   * 用原始點畫，見 timelineTracks。
   *
   * 三道閂，缺一不可：
   * - 只補 unmatchedKeys（R2 上真的沒有結果的日子）。有結果就不重打。
   * - attemptedMatch：同一天這次進頁只試一次。貼不出來的日子（整天沒移動、
   *   對方掛掉）不會在「重讀→還是沒有→再貼」之間無限打轉。
   * - 等 matchedLoading 結束、且沒有別的貼路在跑。自動同步那條路也會呼叫
   *   runMatch，兩邊同時跑會把每秒一請求的自律破功。
   */
  useEffect(() => {
    // isAdmin（任何登入的成員）而不是 canManageOthers：軌跡是各自的，
    // 每個人都要貼得了自己那幾天。後端 saveTrackMatched 仍逐日擋。
    // canUseTools 則是站長給不給他寫入 —— 沒給的人這條路整條不跑（不然
    // 只會安靜地被後端 403，畫面上顯示成「一直貼不出來」）
    if (!isAdmin || !canUseTools || matching || matchedLoading || unmatchedKeys.length === 0) return;

    const todo = unmatchedKeys.filter(k => !attemptedMatch.current.has(k));
    if (todo.length === 0) return;

    const dayByKey = new Map(trackDays.map(d => [d.day_key, d]));
    const gpsTargets: MatchTarget[] = [];
    // 這一輪真的做出判斷的 key。查不到 TrackDay 的先不標記 —— 那多半只是
    // 軌跡點先回來、日清單還在路上，標下去就等於這一天這次進頁再也不會貼
    const decided: string[] = [];
    for (const key of todo) {
      const d = dayByKey.get(key);
      if (!d) continue;
      decided.push(key);
      // 沒留原始 GPX 的日子沒得貼（濃縮過的點會貼出你沒走過的路），
      // 但仍然算「判斷過」，不必每次重讀都再挑出來看一遍
      if (d.has_raw) gpsTargets.push({ dayKey: key, md5: d.md5 ?? null });
    }
    // 先標記再送出：中途失敗、或使用者切走日期，都不該讓這幾天再排隊一次
    for (const k of decided) attemptedMatch.current.add(k);
    if (gpsTargets.length === 0) return;

    // 排進同一條鏈：代跑會讓自動同步跑上好幾分鐘，而 `matching` 是 state
    // （設下去要等下一次 render 才看得到），光靠上面那道閂擋不住這中間插進來的
    // 這一輪 —— 兩邊同時打 Valhalla 就破了「每秒一個請求」的自律
    syncChain.current = syncChain.current.then(async () => {
      setAutoStatus(`貼路中…（${gpsTargets.length} 天）`);
      const requests = await runMatch(gpsTargets, { quiet: true });
      setAutoStatus(requests > 0 ? `已貼路 ${gpsTargets.length} 天，送出 ${requests} 個請求` : null);
    });
    // trackDays 只是拿來查 has_raw/md5，它變動時 rawDayKeys 也會跟著變並重讀一輪，
    // 不需要它自己觸發這個 effect
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAdmin, canUseTools, matching, matchedLoading, unmatchedKeys, runMatch]);

  /*
   * 開頁自動同步。取代 cron 的作法（見 runSync 的註解為什麼不做 cron）。
   *
   * 三個刻意的界線：
   * - 只有登入的成員：讀 Drive 的那條路由要身分（各人讀各人綁定的資料夾），
   *   訪客跑這個只會拿到 401。
   * - 不擋畫面：不 await 在渲染路徑上，地圖照常先畫，同步在背景跑。
   * - 絕不強制重灌：force 只走手動那條路。自動流程若把手動編修過的日子洗掉，
   *   你會在完全不知情的狀況下失去那些編輯。
   *
   * 有真的寫進新資料才接著貼路 —— ingest 成功時後端會刪掉那天的貼路結果，
   * 只同步不貼的話你隔天打開地圖會發現紫線無故消失。
   */
  useEffect(() => {
    // 沒有工具權限的人不自動同步：那支路由後端擋 403，跑了只會在畫面右上角
    // 留一行「同步失敗」嚇人
    if (!isAdmin || !canUseTools || autoSyncStarted.current) return;
    autoSyncStarted.current = true;

    const last = Number(localStorage.getItem(AUTO_SYNC_KEY) ?? 0);
    if (Number.isFinite(last) && Date.now() - last < AUTO_SYNC_COOLDOWN_MS) return;

    syncChain.current = syncChain.current.then(async () => {
      setAutoStatus('同步軌跡中…');
      const ingested = await runSync({ quiet: true });
      // null = Drive 讀取失敗。不寫時間戳，下次進頁還會再試一次
      if (!ingested) { setAutoStatus('同步失敗（詳見管理工具）'); return; }

      localStorage.setItem(AUTO_SYNC_KEY, String(Date.now()));
      if (ingested.length === 0) { setAutoStatus(null); return; }

      setAutoStatus(`已同步 ${ingested.length} 天，貼路中…`);
      const requests = await runMatch(ingested, { quiet: true });
      setAutoStatus(`已同步 ${ingested.length} 天，貼路 ${requests} 趟`);
    });
  }, [isAdmin, canUseTools, runSync, runMatch]);

  /*
   * 代跑：可管理全站內容的人一進 /map，順手把**每個綁好 Drive 資料夾的成員**
   * 也同步一遍（見 runSync 的註解為什麼不是 cron）。
   *
   * 它要解的問題是：GPSLogger 每天都在往各自的 Drive 丟檔，但那些檔只有
   * 「本人自己打開 /map」才會被匯進來 —— 家裡多半只有站長會開地圖，
   * 於是其他人的足跡可以躺在 Drive 上好幾個月沒進站。
   *
   * ⚠️ 四個刻意的界線：
   * - **一個一個跑，不並行**（syncChain）：Drive 與 Valhalla 都禁不起同時開好幾條。
   * - **每個人各自的冷卻時間戳**，而且**失敗不寫** —— 某個人的資料夾權限掉了
   *   不該連累其他人，下次進頁還要再試他一次。
   * - **永遠不 force**：force 會把手動編修過的日子整批洗掉，那是別人的資料。
   * - `has_track_folder` 是 undefined（邊快取裡還躺著舊版後端的回應）時**當作沒綁**，
   *   不然會對每一個成員各打一趟 Drive 只為了拿到一個 503。
   *
   * members 是非同步回來的，所以這支 effect 靠「有沒有人可掃」自己決定何時開跑，
   * 而不是搶在 members 之前把閂關掉。
   */
  useEffect(() => {
    if (!canManageOthers || !canUseTools || autoSweepStarted.current) return;
    const others = members.filter(m => m.has_track_folder && m.id !== user?.id);
    if (others.length === 0) return;
    autoSweepStarted.current = true;

    syncChain.current = syncChain.current.then(async () => {
      for (const m of others) {
        const who = m.name || `#${m.id}`;
        const key = `${AUTO_SYNC_KEY}:u${m.id}`;
        const last = Number(localStorage.getItem(key) ?? 0);
        if (Number.isFinite(last) && Date.now() - last < AUTO_SYNC_COOLDOWN_MS) continue;

        setAutoStatus(`同步 ${who} 的軌跡中…`);
        const ingested = await runSync({ quiet: true, subject: { uid: m.id, name: m.name } });
        if (!ingested) { setAutoStatus(`${who} 的軌跡同步失敗（詳見管理工具）`); continue; }

        localStorage.setItem(key, String(Date.now()));
        if (ingested.length === 0) { setAutoStatus(null); continue; }

        setAutoStatus(`${who}：已同步 ${ingested.length} 天，貼路中…`);
        const requests = await runMatch(ingested, { quiet: true });
        setAutoStatus(`${who}：已同步 ${ingested.length} 天，貼路 ${requests} 趟`);
      }
    });
  }, [canManageOthers, canUseTools, members, user?.id, runSync, runMatch]);

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
  /*
   * 地圖上那條線、以及動畫沿著跑的那份軌跡。
   *
   * 兩個來源接在一起：有 GPSLogger 的日子用貼路結果（貼著 OSM 路網），沒有的
   * 用 Google 時間軸的原始點（折線）。同一天不會兩邊都有 —— 優先序在
   * timelineDaysInRange 就篩掉了。
   *
   * 混在同一份而不是各畫一層：FootprintMap 的動畫只認一份軌跡，分開畫的話
   * 播放到跨越兩種來源的那一天就會斷掉。
   */
  const routeTracks = useMemo(
    // 貼路那半邊是從 tracks 的日子推出來的，已經被伺服器端篩過了；
    // Google 歷史那半邊繞過 D1 自己去 R2 撈，所以要在這裡自己收
    () => [...matchedTracks, ...(meHidden ? [] : timelineTracks)],
    [matchedTracks, timelineTracks, meHidden],
  );

  /*
   * 換一天就把「時間點」清掉。時間本身不帶日期，留著那個值會讓下一天的畫面
   * 停在一個使用者沒有要求過的時刻 —— 而且他很可能根本沒發現那個框還填著東西。
   */
  useEffect(() => { setJumpTime(''); setSeekTo(null); }, [from, to]);

  /*
   * 「時間點」下拉的選項：**當天真的有 GPS 紀錄的每一分鐘**（使用者要求），
   * 不是一個什麼都填得進去的時間框 —— 沒有紀錄的時刻跳過去只會被夾到頭尾，
   * 看起來像壞掉。
   *
   * 來源取動畫真的在走的那一份（`routeTracks` ＝ 貼路 ＋ Google 時間軸），
   * 還沒貼路時退回原始軌跡 `tracks`；兩邊的時間戳本來就是同一批。
   * ⚠️ `TrackPoint.t_utc` 是**字串**，要 Date.parse 才拿得到毫秒。
   * 一天最多 1440 個選項，全在瀏覽器算，不多打任何一次 API。
   */
  const jumpTimes = useMemo(() => {
    const out: { t: number; label: string }[] = [];
    if (!from || from !== to) return out;
    const src = routeTracks.length > 0 ? routeTracks : tracks;
    const seen = new Set<number>();
    for (const p of src) {
      const ms = Date.parse(p.t_utc);
      if (!Number.isFinite(ms)) continue;
      const minute = Math.floor(ms / 60000) * 60000;
      if (seen.has(minute)) continue;
      seen.add(minute);
      out.push({
        t: minute,
        label: new Date(minute).toLocaleTimeString('zh-TW', {
          hour: '2-digit', minute: '2-digit', hour12: false,
        }),
      });
    }
    out.sort((a, b) => a.t - b.t);
    return out;
  }, [from, to, routeTracks, tracks]);

  const focusPoint = useMemo<[number, number] | null>(() => {
    if (!from || from !== to) return null;
    // 還在抓的時候手上這批資料是「上一次查詢」的，拿它定位會飛到跟這一天無關的
    // 地方，而且新的一批要是空的（那天什麼都沒有），鏡頭就再也沒有東西把它拉回來，
    // 直接卡在那裡。等載完再決定要不要動鏡頭
    if (loading) return null;

    let best: TrackPoint | null = null;
    for (const list of [tracks, routeTracks]) {
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
  }, [from, to, loading, tracks, routeTracks, timelineLines, points]);

  // 還在問後端「我是誰」。這半秒留白 —— 先畫出地圖再收回去，或先說找不到
  // 再冒出整張地圖，兩種都很難看
  if (checkingAuth) return <div style={{ maxWidth: 1100, margin: '0 auto', padding: '24px 16px 60px' }} />;

  /*
   * 站長沒開放訪客看足跡。**不解釋、不給登入入口** —— 訪客身上不留任何
   * 升級身分的提示（跟 /admin 同一套處理）。真正的閘門在後端：`/api/footprint`
   * 對沒開放的訪客一律 403，把網址背起來也拿不到座標。
   */
  if (!canViewMap) {
    return (
      <div style={{ maxWidth: 1100, margin: '0 auto', padding: '24px 16px 60px' }}>
        <Link href="/" style={{ fontSize: 14, color: '#2563eb', textDecoration: 'none' }}>← 回相簿</Link>
        <h1 style={{ fontSize: 24, marginTop: 18 }}>找不到這一頁</h1>
      </div>
    );
  }

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
        {/*
          跳到當天的某個時刻：角色（車與車上的人）直接搬到那一刻的位置，鏡頭跟過去。
          ⚠️ 只有**選了單獨一天**才給選 —— 跨好幾天時「14:30」指的是哪一天沒有答案。
          ⚠️ 選項只列**當天真的有 GPS 紀錄的分鐘**（見 jumpTimes），而且選下去就直接跳，
             沒有另外一顆「跳」（使用者拍板）。代價是：<select> 的值沒變不會發 change，
             所以「鏡頭拖走之後想回到同一個時刻」要改選旁邊那一分鐘。
        */}
        <label style={{ fontSize: 13 }}>
          <div style={{ marginBottom: 4, color: '#475569' }}>時間點</div>
          <select
            value={jumpTime}
            disabled={jumpTimes.length === 0}
            onChange={(e) => {
              setJumpTime(e.target.value);
              if (e.target.value) seekToMs(Number(e.target.value));
            }}
            title={
              !from || from !== to
                ? '先選一個單獨的日子'
                : jumpTimes.length === 0
                  ? '這一天沒有 GPS 紀錄'
                  : '角色會跳到這一刻的位置'
            }
            style={{
              padding: '6px 10px', borderRadius: 7, border: '1px solid #cbd5e1',
              fontSize: 13, minWidth: 120,
              background: jumpTimes.length === 0 ? '#f1f5f9' : '#fff',
            }}
          >
            <option value="">
              {!from || from !== to
                ? '先選一個單獨的日子'
                : jumpTimes.length === 0
                  ? '這天沒有 GPS 紀錄'
                  : '選一個時刻'}
            </option>
            {jumpTimes.map((o) => (
              <option key={o.t} value={o.t}>{o.label}</option>
            ))}
          </select>
        </label>
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
        {isAdmin && canUseTools && (
          <label style={{ fontSize: 13, display: 'flex', gap: 7, alignItems: 'center', cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={showTimeline}
              onChange={(e) => setShowTimeline(e.target.checked)}
            />
            <span title="從 Google 時間軸匯入的足跡，畫成最底層的細線，顏色跟著你自己的軌跡色。唯讀 —— 不修正、不貼路，也不會拿來推算照片位置。跟貼路軌跡是兩個獨立開關，可以同時開著對照。">
              顯示 Google 足跡
            </span>
          </label>
        )}
        {/*
          成員篩選。**這是顯示篩選，不是隱私牆** —— 收起來只是畫面清爽一點，
          不代表誰的軌跡被保護了（後端本來就讓所有管理員看得到彼此的）。
          只有一個人時整排不出現：勾一個永遠打勾的框沒有意義。
          濾掉的人不送進 /api/tracks（那支的 20000 點上限是全站共用的，
          少載一個人就是多留一點額度給看得到的人）。
        */}
        {showMemberFilter && members.map(m => {
          const hidden = hiddenUsers.has(m.id);
          return (
            <label
              key={m.id}
              style={{ fontSize: 13, display: 'flex', gap: 7, alignItems: 'center', cursor: 'pointer' }}
            >
              <input
                type="checkbox"
                checked={!hidden}
                onChange={(e) => setHiddenUsers(prev => {
                  const next = new Set(prev);
                  if (e.target.checked) next.delete(m.id); else next.add(m.id);
                  return next;
                })}
              />
              <span
                title={`地圖上只顯示打勾的人。取消勾選只是不畫，資料還在。`}
                style={{ display: 'flex', gap: 5, alignItems: 'center', opacity: hidden ? 0.5 : 1 }}
              >
                <span style={{
                  width: 10, height: 10, borderRadius: '50%',
                  background: m.track_color, flexShrink: 0,
                }} />
                {m.name || `#${m.id}`}
              </span>
            </label>
          );
        })}

        <div style={{ marginLeft: 'auto', fontSize: 13, color: '#64748b', textAlign: 'right' }}>
          <div>
            {loading ? '載入中…' : `${points.length} 個足跡點`}
            {tracks.length > 0 && ` ・ ${tracks.length} 個軌跡點`}
          </div>
          {autoStatus && (
            <div
              style={{ fontSize: 12, color: '#0891b2', marginTop: 2 }}
              title="開啟這一頁時會自動去 Drive 看有沒有新的軌跡檔（每小時最多一次）；另外選定日期後，這段範圍裡還沒貼過路的 GPS 軌跡會自動補上。沒有 GPS 軌跡的日子直接用 Google 歷史的原始點畫，不貼路。"
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
            <div style={{ fontSize: 12, color: myColor, marginTop: 2 }}>
              {timelineLoading ? `讀取 Google 足跡…（${timelineMonths.length} 個月）`
                : timelineStats && timelineStats.points > 0
                  ? `Google 足跡 ${timelineStats.points.toLocaleString()} 點 / ${timelineStats.days} 天`
                  : timelineIndex && timelineIndex.months.length === 0
                    ? '還沒匯入過 Google 足跡（管理工具裡有匯入按鈕）'
                    : '這段範圍沒有 Google 足跡'}
            </div>
          )}
          {/* 軌跡整條線是登入才有的東西，訪客連「這段範圍沒有軌跡」都不該看到 ——
              那句話會讓人以為換個日期就找得到 */}
          {isAdmin && <div style={{ fontSize: 12, color: '#7c3aed', marginTop: 2 }}>
            {/* 貼路已經是自動的，所以這裡不再叫人去按什麼。剩下的只有兩種情況：
                正在補（matching）、或這段範圍根本沒有軌跡 */}
            {matchedLoading ? '讀取軌跡…'
              : matching ? '貼路中…'
                : routeTracks.length > 0
                  ? `軌跡 ${routeTracks.length} 點`
                    + (matchedDays > 0 ? `／貼路 ${matchedDays} 天` : '')
                    + (timelineTracks.length > 0 ? `／Google 歷史 ${timelineTracks.length} 點` : '')
                  : skipTracks
                    ? ''
                    : tracks.length === 0 && timelineDaysInRange.length === 0
                      ? '這段範圍沒有軌跡'
                      : '這段範圍畫不出軌跡（來源太疏或整天沒移動）'}
          </div>}
        </div>
      </div>

      <FootprintMap
        points={points}
        showPhotos={showPhotos}
        tracks={tracks}
        editable={isAdmin}
        onEditPoints={handleEditPoints}
        onMovePhoto={handleMovePhoto}
        showRawLine={SHOW_RAW_LINE}
        matchedTracks={routeTracks}
        showMatchedLine={SHOW_MATCHED_LINE}
        showTrackLine={SHOW_TRACK_LINE}
        animateOn={ANIMATE_ON}
        convoyOverlapPct={convoyOverlapPct}
        trackColors={trackColors}
        trackAvatars={trackAvatars}
        trackSeats={trackSeats}
        babyAvatar={babyAvatar}
        timelineColor={myColor}
        // 我自己被篩掉時，我的 Google 紀念層也跟著收 —— 那一層畫的就是我
        timelineLines={showTimeline && !meHidden ? timelineLines : undefined}
        focusPoint={focusPoint}
        seekTo={seekTo}
        // 點縮圖就跳去那本相簿。地圖上看到一張照片時，下一個想做的事
        // 幾乎都是「看那天其他張」—— 編輯模式下點擊是選取，FootprintMap 自己擋掉了
        onSelectPhoto={(p) => router.push(`/album?id=${p.album_id}`)}
      />

      {/* 圖例只剩線。照片的點不再依座標來源分色（見 FootprintMap 的 photo-points 圖層）——
          一張照片的位置是量到的還是推出來的，是點開它才需要知道的事，
          不值得在每次看地圖時都佔一整排圖例 */}
      <div style={{ marginTop: 10, fontSize: 12.5, color: '#64748b', display: 'flex', gap: 16, flexWrap: 'wrap' }}>
        {showPhotos && <span style={{ color: '#2563eb' }}>● 照片</span>}
        {/* 同一條線兩種來源：有 GPS 的日子是貼路結果，沒有的是 Google 歷史原始點。
            不分色 —— 兩者的差別看線本身就知道（一個貼著路走，一個是折線）。
            訪客畫面上沒有這條線，圖例也就不列 */}
        {/* 多人時圖例改成列人名 —— 「哪條線是誰」是看多身分地圖時最先要問的事。
            只有一個人就維持原本那句，不必為了一個人做一份色票對照表 */}
        {isAdmin && (showMemberFilter
          ? members.filter(m => !hiddenUsers.has(m.id)).map(m => (
            <span key={m.id} style={{ color: m.track_color }}>— {m.name || `#${m.id}`}</span>
          ))
          : <span style={{ color: myColor }}>
            — 軌跡（GPS 貼 OSM 路網{timelineTracks.length > 0 ? '／Google 歷史原始點' : ''}）
          </span>)}
        {showTimeline && <span style={{ color: myColor }}>— Google 足跡（唯讀）</span>}
      </div>

      {/*
        軌跡從 0009 起是「每個人各自一份」，所以這一區對**所有登入的成員**開放 ——
        同步自己的 Drive 資料夾、手動上傳自己的 GPX、貼自己的路，後端都只讓他
        動到自己那幾天（canTouchTrackDay）。區塊內真正全站共用的東西（行程段）
        才另外用 canManageOthers 收起來。訪客沒有 isAdmin，整區看不到。

        再往上還有一層 canUseTools（見後端 migrations/0016）：站長可以對個別成員
        關掉「寫」而保留「看」。關掉的人這一整區不出現 —— 端出來再讓每顆按鈕
        403，比不端出來難懂得多。
      */}
      {isAdmin && canUseTools && (
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
            {canManageOthers ? '管理工具' : '我的足跡工具'}
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
            {/* 手動上傳。Drive 資料夾還沒綁好的人、或想補一個 Drive 上沒有的舊檔，
                只有這條路。檔案不上傳到 Drive，只有解析後的點進 D1、原文進 R2 */}
            <button
              disabled={syncing}
              onClick={() => gpxInputRef.current?.click()}
              style={{ ...toolBtn, borderColor: '#7c3aed', color: '#7c3aed' }}
              title="直接選手機或電腦上的 .gpx 檔匯入。同名的檔案視為同一天，會整批取代。"
            >
              📄 手動上傳 GPX
            </button>
            <input
              ref={gpxInputRef}
              type="file"
              accept=".gpx,application/gpx+xml,text/xml"
              multiple
              hidden
              onChange={(e) => {
                uploadGpxFiles(e.target.files);
                // 清掉才選得了同一個檔第二次（改完內容重傳是常見動作）
                e.target.value = '';
              }}
            />
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
                    const turningPublic = e.target.checked;
                    /*
                     * 轉公開一定要再確認一次。這是全站唯一會把座標交給訪客的開關，
                     * 而 checkbox 是最容易誤點的控制項 —— 點錯的代價與點對的代價不對稱，
                     * 所以只擋這個方向；轉回私密不問。
                     *
                     * 訊息裡把「會被公開幾個點」講出來，不要只寫「確定嗎」——
                     * 使用者要能判斷的是數量與範圍，不是自己剛剛有沒有按到。
                     */
                    if (turningPublic) {
                      const n = points.filter(p => p.album_id === currentAlbum.id).length;
                      const ok = confirm(
                        `要公開「${currentAlbum.name}」的打卡點嗎？\n\n`
                        + `任何人不必登入就能在地圖上看到這本相簿的${n > 0 ? ` ${n} 個` : ''}拍攝位置`
                        + `（含經緯度與地點名稱）。\n`
                        + `軌跡不受影響，訪客一律看不到。\n\n`
                        + `個別標記為私密的照片仍不會出現。隨時可以再關掉。`,
                      );
                      // 取消時要主動觸發一次重繪，把 DOM 上已經被勾起來的框推回去 ——
                      // state 沒變的話 React 不會重新渲染，畫面會停在「已勾選」的假象
                      if (!ok) { setAlbums(prev => [...prev]); return; }
                    }
                    const ok = await setAlbumMapPrivacy(currentAlbum.id, !turningPublic);
                    if (ok) fetchAllAlbums().then(setAlbums);
                  }}
                  style={{ marginTop: 3 }}
                />
                <span>
                  公開「{currentAlbum.name}」的打卡點
                  <span style={{ display: 'block', color: '#64748b', fontSize: 12.5 }}>
                    預設不公開。開啟後訪客只看得到這本相簿的拍攝位置，軌跡一律不公開。
                    個別標記為私密的照片仍不會出現在地圖上。
                  </span>
                </span>
              </label>
            </div>
          )}

          {/* 行程段是全站共用的一份（不屬於任何人的軌跡），所以維持只給
              can_manage_others 的人。一般成員看到刪除鈕只會拿到 403 */}
          {canManageOthers && (
          <>
          <button
            onClick={() => setShowSegments(v => !v)}
            style={{
              display: 'flex', alignItems: 'center', gap: 8, padding: 0,
              border: 'none', background: 'none', cursor: 'pointer',
              fontSize: 15, fontWeight: 600, color: '#0f172a', marginBottom: 8,
            }}
          >
            <span style={{ fontSize: 13, color: '#94a3b8' }}>{showSegments ? '▾' : '▸'}</span>
            行程段（{segments.length}）
          </button>
          {!showSegments ? null : segments.length === 0 ? (
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
