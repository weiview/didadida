import exifr from 'exifr';
import {
  normalizeGeo, formatWallClock, utcFromLocal,
  parseExifDateTime, geoOverwriteGuard, DEFAULT_TZ_OFFSET_MINUTES,
} from './geo';
import { listGpxFiles, fetchDriveMedia, moveDriveFile, renameDriveFolder, serviceAccountEmail } from './drive';
import { syncFtsForPhotos, deleteFtsForPhotos, ftsMatchExpr } from './fts';

export interface Env {
  DB: D1Database;
  BUCKET: R2Bucket;
  APP_PASSWORD: string;
  /**
   * 進站密碼（訪客）。**跟 APP_PASSWORD 是兩把不同的鑰匙**：這一把只換得到
   * 「看得到公開內容」的 token，換不到管理權，所以可以放心給家人朋友。
   *
   * **沒設就沒有人進得來** —— 不是「沒設就全站公開」。
   * 忘記設定的代價該是自己被鎖在外面，不是把整站默默攤開給全世界。
   * 管理員仍然可以用 Google 登入或 APP_PASSWORD 進來，不會真的把自己關死。
   */
  GUEST_PASSWORD?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  /*
   * 這裡以前有 ADMIN_EMAILS（可以當管理員的信箱，逗號分隔）。**已移除**：
   * 白名單自 0008 起是 D1 的 User 表，由站長在 /admin 維護，環境變數不該是第二份名單。
   * 遠端也不必再設這個 secret，設了也沒有人會讀。見 googleAdminCheck()。
   */
  /**
   * service account 金鑰 JSON 全文。scope 是完整的 drive（Phase 3 要搬檔），
   * 但看得到什麼由 Drive 的分享設定決定 —— 見 drive.ts 檔頭
   */
  GOOGLE_DRIVE_SA_KEY?: string;
  /** GPSLogger 上傳目的地資料夾的 Drive file id（只分享 Viewer 給 SA） */
  GOOGLE_DRIVE_FOLDER_ID?: string;
  /**
   * 照片主檔資料夾 `didadida/` 的覆寫。**平常不必設** —— 正常情況是網頁第一次
   * 上傳時自己建資料夾、把 id 存進 AppSetting。設了就以這裡為準，
   * 用途是把某個環境臨時指到別的資料夾
   */
  GOOGLE_DRIVE_PHOTOS_FOLDER_ID?: string;
  /** `didadida/trash/` 的覆寫。同上 */
  GOOGLE_DRIVE_TRASH_FOLDER_ID?: string;
  /**
   * map matching（軌跡貼路）用的 Valhalla 服務位址，例如
   * https://valhalla1.openstreetmap.de。放在設定裡而不是寫死在程式碼，
   * 是 FOSSGIS 使用條款明文要求的（「不要把服務網址硬寫進 app」），
   * 這樣要換實例或臨時關掉都不必改程式。沒設就等於這個功能關閉。
   */
  VALHALLA_URL?: string;
}

/** AppSetting 的 key。放這麼前面是因為路由與底下的 helper 都會用到 */
const SETTING_PHOTOS_FOLDER = "drive_photos_folder_id";
const SETTING_TRASH_FOLDER = "drive_trash_folder_id";
/*
 * Drive 的**唯一寫入身分**。
 *
 * 為什麼要存 refresh token（先前明確決定不存的東西）：`drive.file` 是 per-file
 * 授權，第二位管理員碰不到第一位建的子資料夾（2026-08-12 實測確認，Picker 授權
 * 根目錄也不會往下涵蓋）。要讓一家人共用同一份 Drive 資料夾，寫入者就只能有一個。
 * 於是所有人的上傳都改成跟後端換一張**這個帳號**的短效 access token。
 *
 * ⚠️ 同意畫面還在「測試中」的話，refresh token **7 天就會失效**，得重新連結一次。
 *    要根治只能把同意畫面發布到 Production。
 */
const SETTING_DRIVE_REFRESH_TOKEN = "drive_writer_refresh_token";
const SETTING_DRIVE_WRITER_EMAIL = "drive_writer_email";
const SETTING_DRIVE_LINKED_AT = "drive_writer_linked_at";
/**
 * 訪客看不看得到足跡地圖。**預設關**（沒有這一列就是關）。
 *
 * 為什麼是全站一個開關而不是每個訪客一個：訪客共用同一把 `GUEST_PASSWORD`，
 * 根本沒有「這個訪客」這種東西可以掛設定。
 */
const SETTING_GUEST_MAP = "guest_can_view_map";

/**
 * token 裡的身分。兩層，沒有第三層：
 *   - `admin`：所有編輯權限，看得到私密座標與軌跡。來源是 Google 登入或 APP_PASSWORD。
 *   - `guest`：只是「進得了站」。看到的內容與從前的匿名訪客完全一樣
 *     （applyGeoPrivacy 照樣把私密座標抹掉），差別只在匿名的人現在連清單都拿不到。
 *
 * 兩者都是同一把 HMAC 金鑰（APP_PASSWORD）簽的 —— 金鑰只是簽章用，
 * 換得到哪一種 token 才是由密碼決定的。
 */
type Role = 'admin' | 'guest';

/**
 * token 說了什麼。`role` 之外多了「是誰」—— 沒有這一段的話，站上永遠不知道
 * 這次操作是三個管理員裡的哪一個，也就沒有「自己的相簿」這回事。
 *
 * `uid` 為 null 的兩種來源，都當**站長**處理：
 *   1. APP_PASSWORD 密碼登入（那是站長自己的後路，理論上會補上 uid，
 *      但站上連一個 owner 都沒有時就補不上）。
 *   2. 0008 之前發出、還沒過期的舊 token。它們只可能在管理員手上，
 *      預設成權限最小的成員反而會讓站長自己突然動不了東西。
 */
interface Identity {
  role: Role;
  uid: number | null;
  email: string | null;
}

async function generateJWT(
  env: Env, role: Role = 'admin', user?: { id: number; email?: string | null } | null,
): Promise<string> {
  const encoder = new TextEncoder();
  const header = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = btoa(JSON.stringify({
    role,
    uid: user?.id ?? null,
    email: user?.email ?? null,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 86400 * 7,
  })); // 7 days
  const data = `${header}.${payload}`;

  const key = await crypto.subtle.importKey('raw', encoder.encode(env.APP_PASSWORD), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(data));
  const signatureB64 = btoa(String.fromCharCode(...new Uint8Array(signature))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  return `${data}.${signatureB64}`;
}

/**
 * 驗簽 + 驗到期，回傳這張 token 代表的身分；不合法一律 null。
 *
 * **沒有 role 欄位的當 admin** —— 那是加訪客層之前發出去的 token，只有管理員拿得到。
 * 反過來預設成 guest 的話，這次改動會把所有還沒過期的管理員降級，
 * 而且是安靜地降級（畫面上編輯工具消失，看起來像壞掉）。
 */
async function verifyJWT(token: string, env: Env): Promise<Identity | null> {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [header, payload, signature] = parts;

    const payloadObj = JSON.parse(atob(payload));
    if (payloadObj.exp < Math.floor(Date.now() / 1000)) return null;

    const data = `${header}.${payload}`;
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey('raw', encoder.encode(env.APP_PASSWORD), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);

    const sigBytes = Uint8Array.from(atob(signature.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));

    const ok = await crypto.subtle.verify('HMAC', key, sigBytes, encoder.encode(data));
    if (!ok) return null;
    return {
      role: payloadObj.role === 'guest' ? 'guest' : 'admin',
      uid: Number.isInteger(payloadObj.uid) ? payloadObj.uid : null,
      email: typeof payloadObj.email === 'string' ? payloadObj.email : null,
    };
  } catch (e) {
    return null;
  }
}

/** Authorization: Bearer 裡那張 token 的身分。沒帶、壞掉、過期都是 null */
async function tokenIdentity(request: Request, env: Env): Promise<Identity | null> {
  const authHeader = request.headers.get("Authorization");
  if (!authHeader) return null;
  const token = authHeader.replace("Bearer ", "");
  if (!token) return null;
  return await verifyJWT(token, env);
}

/**
 * 這次操作背後的**人**。token 只說了 uid，權限得回 D1 拿 ——
 * 寫在 token 裡的話，撤銷一個人的權限要等他手上那張過期（最長七天）才生效。
 */
interface Actor {
  uid: number | null;
  email: string | null;
  name: string | null;
  isOwner: boolean;
  canManageOthers: boolean;
}

/**
 * 同一個 request 只查一次 D1。
 *
 * isAuthorized() 在單一路由裡會被呼叫好幾次（閘門一次、快取判斷一次、
 * 權限檢查再一次），每一次都打一趟 D1 的話讀取量會平白翻好幾倍 ——
 * 而免費額度是最高宗旨。key 是 Request 物件本身，請求結束就整個被回收。
 */
const actorCache = new WeakMap<Request, Promise<Actor | null>>();

async function currentActor(request: Request, env: Env): Promise<Actor | null> {
  const cached = actorCache.get(request);
  if (cached) return cached;
  const pending = resolveActor(request, env);
  actorCache.set(request, pending);
  return pending;
}

async function resolveActor(request: Request, env: Env): Promise<Actor | null> {
  const identity = await tokenIdentity(request, env);
  if (!identity || identity.role !== 'admin') return null;

  // 沒有 uid 的舊 token／密碼登入：當站長（見 Identity 的註解）
  if (identity.uid == null) {
    const owner = await env.DB.prepare(
      "SELECT id, name, email FROM User WHERE role = 'owner' AND active = 1 ORDER BY id LIMIT 1"
    ).first<any>();
    if (owner) {
      return { uid: owner.id, email: owner.email, name: owner.name, isOwner: true, canManageOthers: true };
    }
    return { uid: null, email: identity.email, name: null, isOwner: true, canManageOthers: true };
  }

  const row = await env.DB.prepare(
    "SELECT id, name, email, role, can_manage_others, active FROM User WHERE id = ?"
  ).bind(identity.uid).first<any>();
  // 列不見了或被移出白名單 —— 手上那張 token 立刻失效，不等它過期
  if (!row || Number(row.active) !== 1) return null;

  const isOwner = row.role === 'owner';
  return {
    uid: row.id,
    email: row.email,
    name: row.name,
    isOwner,
    canManageOthers: isOwner || Number(row.can_manage_others) === 1,
  };
}

/**
 * 只認 /api/verify-password 或 Google 登入發出的**管理員** JWT，
 * 而且那個人現在還在白名單上。
 *
 * 以前這裡也接受裸的 APP_PASSWORD 當 bearer（backward compatibility），已經移除：
 * 那個密碼同時是 JWT 的簽章金鑰，一旦外流等於可以自簽任意 token，而且撤不掉。
 */
async function isAuthorized(request: Request, env: Env): Promise<boolean> {
  return (await currentActor(request, env)) !== null;
}

/**
 * 這個人動得了這本相簿／這張照片嗎。
 *
 * 規則就兩層（使用者原話）：站長與 can_manage_others=1 全開；其餘只動得了自己的。
 * 「自己的」＝ 相簿主人是我，**或**照片是我傳的 —— 任一相符就算數。
 */
function actorOwns(actor: Actor, row: { user_id?: any; uploaded_by?: any }): boolean {
  if (actor.canManageOthers) return true;
  if (actor.uid == null) return false;
  if (row.user_id != null && Number(row.user_id) === actor.uid) return true;
  if (row.uploaded_by != null && Number(row.uploaded_by) === actor.uid) return true;
  return false;
}

/**
 * 沒權限時統一的回應。訊息給前端直接顯示。
 *
 * 一定要帶上呼叫端的 CORS 標頭 —— 少了它，瀏覽器會在 JS 讀到之前就擋掉這個回應，
 * 使用者看到的是「網路錯誤」而不是「這不是你的相簿」。
 */
function forbidden(headers: Record<string, string>, message = "沒有權限修改別人的相簿或照片"): Response {
  return new Response(JSON.stringify({ error: message, reason: "forbidden" }), { status: 403, headers });
}

/**
 * 相簿的擁有權資料。找不到相簿回 null（呼叫端要回 404）。
 */
async function albumOwnership(env: Env, albumId: string | number): Promise<{ user_id: any } | null> {
  return await env.DB.prepare("SELECT user_id FROM Album WHERE id = ?").bind(albumId).first<any>();
}

/**
 * 照片的擁有權資料：上傳者 + 所屬相簿的主人。
 */
async function photoOwnership(env: Env, photoId: string | number): Promise<{ user_id: any; uploaded_by: any } | null> {
  return await env.DB.prepare(
    "SELECT a.user_id AS user_id, p.uploaded_by AS uploaded_by FROM Photo p JOIN Album a ON a.id = p.album_id WHERE p.id = ?"
  ).bind(photoId).first<any>();
}

/**
 * 移除不該對外曝光的座標 —— 也就是「打卡點」這一層。
 *
 * 注意：照片相關的 GET 路由都是公開的（軌跡那幾支已經改成一律要登入），所以座標
 * 必須在後端就拿掉 —— 只在前端不繪製地圖是無效的，按 F12 就能從 JSON 看到經緯度。
 * 相簿層級 (map_private) 或照片層級 (geo_private) 任一為私密，就不輸出座標。
 * 實務上閘門是相簿，而且 **map_private 預設 1（不公開）**：要讓一本相簿的打卡點
 * 對訪客現身，只能由管理者明確勾選。geo_private 預設 0
 * （見 migrate_geo_private_default.sql），只有被單獨標成私密的那幾張才會在
 * 已公開的相簿裡再被扣住。
 *
 * 傳入的 row 需含 map_private 欄位（由 JOIN Album 帶入），輸出時會移除該欄位。
 */
function applyGeoPrivacy(rows: any[], isAdmin: boolean): any[] {
  return rows.map((row) => {
    const { map_private, ...rest } = row;
    if (isAdmin) return rest;
    const visible = Number(map_private) === 0 && Number(rest.geo_private) === 0;
    if (visible) return rest;
    return { ...rest, lat: null, lng: null, place_name: null, geo_source: null };
  });
}

/**
 * 取得照片的「當地牆上時間」，統一成 'YYYY-MM-DD HH:MM:SS'。
 * 新資料直接用 taken_at_local；舊資料沒有這欄，就由 taken_at 加上時區推回來。
 *
 * 退路**不能**只把 ISO 截到秒（'2026-06-18T08:11:00.000Z' → '2026-06-18 08:11:00'）——
 * taken_at 是 UTC 瞬間而不是牆上時間，那樣讀台灣的照片會整整少 8 小時，
 * 行程段比對與時間軸定位會全部對到八小時前的位置。時區未知時用站台預設值，
 * 跟 geo.ts 的 normalizeGeo 同一個假設。
 *
 * 使用此常數的 SQL 必須把 Photo 表別名為 p。
 */
const LOCAL_TIME_EXPR =
  "COALESCE(p.taken_at_local, strftime('%Y-%m-%d %H:%M:%S', p.taken_at, "
  + `COALESCE(p.tz_offset_minutes, ${DEFAULT_TZ_OFFSET_MINUTES}) || ' minutes'))`;

/**
 * 貼路軌跡在 R2 的 key。跟原始 GPX 同一套規則用 encodeURIComponent 包起來：
 * day_key 就是 Drive 檔名，不保證不含斜線之類會在 R2 裡長出假目錄的字元。
 */
const matchedKey = (dayKey: string) => `tracks/${encodeURIComponent(dayKey)}.matched.json`;

/*
 * Google 時間軸的「紀念層」在 R2 的位置。
 *
 * 這一層刻意完全不進 D1：它不修正、不貼路、也不拿來推照片位置，
 * 所以沒有任何需要「查詢」的理由 —— 而那是 D1 唯一的價值。
 * 十二年份約 25 萬點，寫進 TrackPoint 要吃掉兩整天的免費寫入額度；
 * 存成 R2 月檔則是 145 次 Class A、約 10MB，佔免費額度千分之一。
 *
 * 順帶避開了 TrackDay.day_key 是單一主鍵的問題 —— 同一天要能同時
 * 有 GPSLogger 軌跡與時間軸軌跡，塞進同一張表就得改主鍵。
 */
const TIMELINE_INDEX_KEY = 'timeline/index.json';
const timelineMonthKey = (month: string) => `timeline/${month}.json`;
/** 嚴格比對而不是 encodeURIComponent：只放行 'YYYY-MM'，路徑穿越就無從談起 */
const TIMELINE_MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
/** 單月上限。最密的一個月約 280KB，12MB 已經是兩位數的餘裕 */
const TIMELINE_MONTH_MAX_BYTES = 12 * 1024 * 1024;

/**
 * 時間軸比對的可信門檻（分鐘）。照片時間與最近取樣點差距超過這個值，
 * 寫入時就降級（見 /api/photos/geo/from-timeline）。
 *
 * 10 分鐘的來由：前端把命中分成 ≤2 分（exact）、≤10 分（near）、其餘（loose）
 * 三桶，這裡切在 near 與 loose 的交界上，跟畫面顯示的分類一致。
 * 它跟前端那個「容差」滑桿是兩回事 —— 容差決定「要不要算命中」，
 * 這個決定「命中之後有多少權威」。
 */
const TIMELINE_LOOSE_GAP_MIN = 10;

/** 座標合法性檢查 —— 手動輸入與 API 傳入都要過這關 */
function isValidLatLng(lat: unknown, lng: unknown): boolean {
  return (
    typeof lat === 'number' && Number.isFinite(lat) && Math.abs(lat) <= 90 &&
    typeof lng === 'number' && Number.isFinite(lng) && Math.abs(lng) <= 180
  );
}

/** 時區偏移合法性檢查。真實時區介於 UTC-12 ~ UTC+14 且都是 15 分鐘的倍數 */
function isValidTzOffset(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v)
    && v >= -12 * 60 && v <= 14 * 60 && v % 15 === 0;
}

/**
 * 把請求送來的 photoIds 清成一串正整數。
 * 去重後截斷，避免單一請求就把 D1 的每日寫入額度吃掉一大塊。
 */
function sanitizePhotoIds(raw: unknown, max = 2000): number[] {
  if (!Array.isArray(raw)) return [];
  const ids = raw.map(Number).filter((n) => Number.isInteger(n) && n > 0);
  return [...new Set(ids)].slice(0, max);
}

/**
 * 把 id 陣列切成一塊一塊，因為 **D1 一句 SQL 最多只能綁 100 個參數**。
 * 超過就是 `D1_ERROR: too many SQL variables`，而且是在執行期才炸 —— 開發時
 * 選個三五張都好好的，使用者一次全選一百多張才踩到。
 *
 * `reserve` 是那句 SQL 除了 id 以外還要綁幾個（lat、lng、place_name 之類），
 * 從額度裡先扣掉。切出來的每塊各自 prepare，用 `env.DB.batch()` 一次送出去：
 * 一個 round trip，而且 batch 本身就是一筆交易，不會做到一半只更新了前 80 張。
 */
function chunkIds(ids: number[], reserve = 0, limit = 100): number[][] {
  const size = Math.max(1, limit - reserve);
  const out: number[][] = [];
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size));
  return out;
}

/** 給 chunkIds 切出來的每一塊產生 `?,?,?` */
const placeholdersFor = (chunk: unknown[]) => chunk.map(() => "?").join(",");

/** SQLite 日期修飾字串。-90 -> '-90 minutes'、90 -> '+90 minutes' */
const minutesModifier = (n: number) => `${n >= 0 ? '+' : ''}${n} minutes`;

/*
 * 三層快取。三層擋掉的是不同的東西，少任何一層都補不回來：
 *
 *   L1 瀏覽器（Cache-Control max-age）
 *       唯一能省下 **Workers 請求數**（免費 100K/天）的一層 —— L2 命中時 Worker
 *       其實已經跑起來了，那次請求照樣計費。
 *   L2 邊緣（caches.default）
 *       省的是 **D1 讀取列數與 R2 Class B 次數**。同一分鐘內全家人開首頁只有第一
 *       個人真的查資料庫。
 *   L3 R2 物件本身
 *       檔名帶時間戳、內容永遠不變，所以縮圖給一年的 immutable。
 *
 * ⚠️ 管理員一律跳過 L2（不讀也不寫）。照片查詢會跑 applyGeoPrivacy()，管理員拿到
 *    的是完整座標而訪客拿到的是 null；只要管理員的回應曾經進過共用的邊緣快取，
 *    家人就會拿到私密相簿的經緯度。在 cache key 裡加身分也做得到，但那種寫法漏
 *    一個地方就洩漏，直接跳過則不可能寫錯。
 */
async function withEdgeCache(
  request: Request,
  ctx: ExecutionContext,
  opts: {
    /** 瀏覽器可以放心用舊資料的秒數 */
    browserMaxAge: number;
    /** 邊緣保留的秒數，通常可以比瀏覽器久 */
    edgeMaxAge: number;
    /** true 就完全不碰快取。管理員請求務必給 true */
    skip: boolean;
  },
  produce: () => Promise<Response>,
): Promise<Response> {
  if (opts.skip) return produce();

  /*
   * cache key 把 Origin 併進 URL。回應帶的是逐一比對過的
   * Access-Control-Allow-Origin，prod、dev 與 localhost 三個前端各不相同，
   * 只用 URL 當 key 會把 prod 的 ACAO 餵給 dev 的頁面，瀏覽器直接擋掉。
   * 正規做法是 `Vary: Origin`，但 Cloudflare 的快取只認 Accept-Encoding 的 Vary，
   * 靠不住 —— 併進 key 才是這裡真的會生效的寫法。
   */
  const keyUrl = new URL(request.url);
  keyUrl.searchParams.set("__origin", request.headers.get("Origin") || "-");
  const cacheKey = new Request(keyUrl.toString(), { method: "GET" });

  const cache = caches.default;
  const hit = await cache.match(cacheKey);
  if (hit) return hit;

  const response = await produce();
  if (response.status === 200) {
    const cached = new Response(response.body, response);
    cached.headers.set(
      "Cache-Control",
      `public, max-age=${opts.browserMaxAge}, s-maxage=${opts.edgeMaxAge}`,
    );
    // 回應要用兩次（一次進快取、一次給使用者），body 只能讀一次，所以先 clone。
    // 寫入放 waitUntil：使用者不必等快取寫完才拿到資料。
    ctx.waitUntil(cache.put(cacheKey, cached.clone()));
    return cached;
  }
  return response;
}

/*
 * 對外可見的範圍，只有兩層，沒有第三層：
 *
 *   1. 軌跡（TrackPoint、貼路結果、Google 時間軸）—— **一律要登入**。
 *      訪客拿不到任何一個點，不管那天有沒有公開相簿。
 *   2. 照片打卡點（Photo.lat/lng/place_name）—— 相簿的 map_private = 0 才給，
 *      預設 1（不公開）。個別照片還能再用 geo_private 單獨扣住。見 applyGeoPrivacy。
 *
 * 之前這裡有一整套「公開相簿的時間窗 → 那段軌跡也公開」的機制
 * （publicTripWindows / overlapsTripWindows / isTrackDayPublic），已整個移除。
 * 移除的原因：一本相簿的時間窗是「最早那張到最晚那張」，跨年度的精選相簿
 * 會把整整一年的日常軌跡撐開成公開範圍，而使用者不會有任何感覺。
 * 現在的規則不必猜、不必調門檻 —— 軌跡就是不給訪客。
 */

// Rate Limiting (In-memory)
interface LoginAttempt {
  count: number;
  lockUntil?: number;
}
const loginAttempts = new Map<string, LoginAttempt>();

/*
 * Drive 資料夾 id 的來源有兩個，env 優先、AppSetting 次之。
 *
 * 正常情況兩個 id 都在 AppSetting：資料夾是**網頁自己建的**（瀏覽器只有
 * drive.file scope，看不見使用者手動建的資料夾），所以 id 到執行期才存在。
 * env 那條留著只是為了臨時把某個環境指到別的資料夾，平常不會設。
 *
 * 這三支（含下面的 drainDriveTrash）擺在 export default 外面是有意的 ——
 * 檔案裡多數輔助函式其實宣告在 fetch() 內部（縮排看不出來），scheduled() 讀不到。
 */
async function getSetting(env: Env, key: string): Promise<string | null> {
  const row = await env.DB.prepare("SELECT value FROM AppSetting WHERE key = ?").bind(key).first<any>();
  return typeof row?.value === "string" && row.value ? row.value : null;
}

async function setSetting(env: Env, key: string, value: string): Promise<void> {
  await env.DB
    .prepare("INSERT INTO AppSetting (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')")
    .bind(key, value)
    .run();
  settingMemo.delete(key);
}

/**
 * 「訪客能不能看足跡」這種開關會被**每一個訪客的每一次請求**問到
 * （`/api/auth/me`、`/api/footprint`），而訪客那條路線本來是刻意不碰 D1 的。
 * 所以在 isolate 裡快取 60 秒 —— 免費額度是最高宗旨，一個開關不值得
 * 每次都去讀一次資料庫。
 *
 * 60 秒是「站長改完設定，最慢多久全站生效」。`setSetting` 會直接把該 key
 * 踢掉，所以改設定的那個 isolate 是立刻生效的。
 */
const settingMemo = new Map<string, { value: string | null; at: number }>();
const SETTING_MEMO_TTL_MS = 60_000;

async function getSettingCached(env: Env, key: string): Promise<string | null> {
  const hit = settingMemo.get(key);
  if (hit && Date.now() - hit.at < SETTING_MEMO_TTL_MS) return hit.value;
  const value = await getSetting(env, key);
  settingMemo.set(key, { value, at: Date.now() });
  return value;
}

/** 訪客看不看得到足跡地圖。沒設定過＝關 */
async function guestCanViewMap(env: Env): Promise<boolean> {
  return (await getSettingCached(env, SETTING_GUEST_MAP)) === "1";
}

/**
 * 拿存著的 refresh token 換一張短效 access token（Drive 的唯一寫入身分）。
 *
 * 回傳的 `reason` 是給前端分辨用的，三種要走完全不同的路：
 *   `not_linked`  還沒連結過 —— 管理員按一次「連結」就好
 *   `expired`     refresh token 失效（多半是同意畫面還在測試中，7 天到期），
 *                 要重新連結。**不要自動重試**，那只會一直撞同一面牆
 *   `failed`      其他錯誤（網路、Google 暫時性問題），可以重試
 */
async function mintDriveWriterToken(
  env: Env,
): Promise<
  | { ok: true; accessToken: string; expiresIn: number; email: string | null }
  | { ok: false; reason: "not_linked" | "expired" | "failed"; detail: string }
> {
  const refreshToken = await getSetting(env, SETTING_DRIVE_REFRESH_TOKEN);
  if (!refreshToken) return { ok: false, reason: "not_linked", detail: "還沒有連結 Drive 寫入帳號" };
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    return { ok: false, reason: "failed", detail: "後端缺 GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET" };
  }

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  const data: any = await res.json().catch(() => null);

  if (!res.ok || !data?.access_token) {
    // invalid_grant＝被撤銷或過期，這種再試幾次都一樣，要人重新連結
    const expired = data?.error === "invalid_grant";
    return {
      ok: false,
      reason: expired ? "expired" : "failed",
      detail: String(data?.error_description || data?.error || `HTTP ${res.status}`),
    };
  }

  return {
    ok: true,
    accessToken: data.access_token,
    expiresIn: Number(data.expires_in) || 3600,
    email: await getSetting(env, SETTING_DRIVE_WRITER_EMAIL),
  };
}

async function driveFolders(env: Env): Promise<{ photos: string | null; trash: string | null }> {
  const [photos, trash] = await Promise.all([
    env.GOOGLE_DRIVE_PHOTOS_FOLDER_ID ? Promise.resolve(env.GOOGLE_DRIVE_PHOTOS_FOLDER_ID) : getSetting(env, SETTING_PHOTOS_FOLDER),
    env.GOOGLE_DRIVE_TRASH_FOLDER_ID ? Promise.resolve(env.GOOGLE_DRIVE_TRASH_FOLDER_ID) : getSetting(env, SETTING_TRASH_FOLDER),
  ]);
  return { photos, trash };
}

/**
 * 把待搬佇列裡的 Drive 檔真的搬進 `didadida/trash/`，一次搬 limit 個。
 *
 * 分批的理由跟 rebuild-fts 一樣但更硬：**Workers 一次請求的 subrequest 上限
 * （免費版 50）**，而搬一個檔要兩次 Drive 往返。所以這裡永遠只搬一小批，
 * 剩下的靠下一次觸發。三個觸發點：
 *   1. 刪除當下 ctx.waitUntil()  —— 單張刪除幾秒內就進 trash/，也是使用者會看的那次
 *   2. cron（見 wrangler.toml 的 [triggers]） —— 刪整本相簿留下的尾巴由它慢慢清
 *   3. POST /api/admin/drain-drive-trash —— 手動催
 * 以前只有第 3 點，而且沒有任何地方呼叫它，等於刪掉的檔永遠留在原資料夾。
 *
 * attempts >= 3 的就不再自動重試。那通常代表檔案被手動刪了、或 `didadida/`
 * 的 Editor 分享被拿掉 —— 一直重試只是白燒額度。留在表裡等人看。
 */
async function drainDriveTrash(env: Env, limit: number): Promise<{
  ok: boolean; moved: number; failed: string[]; remaining: number; gave_up: number; done: boolean;
}> {
  const empty = { moved: 0, failed: [] as string[], remaining: 0, gave_up: 0, done: true };
  const { trash: trashFolderId } = await driveFolders(env);
  if (!env.GOOGLE_DRIVE_SA_KEY || !trashFolderId) return { ok: false, ...empty };

  const { results: pending } = await env.DB.prepare(
    "SELECT id, drive_id FROM DriveTrash WHERE attempts < 3 ORDER BY id LIMIT ?"
  ).bind(limit).all<any>();

  let moved = 0;
  const failed: string[] = [];
  for (const row of pending) {
    try {
      await moveDriveFile(env.GOOGLE_DRIVE_SA_KEY, row.drive_id, trashFolderId);
      await env.DB.prepare("DELETE FROM DriveTrash WHERE id = ?").bind(row.id).run();
      moved++;
    } catch (e) {
      // 失敗不丟出去 —— 一顆壞檔不該讓整批停擺
      const msg = e instanceof Error ? e.message : String(e);
      await env.DB.prepare(
        "UPDATE DriveTrash SET attempts = attempts + 1, last_error = ? WHERE id = ?"
      ).bind(msg.slice(0, 200), row.id).run();
      failed.push(row.drive_id);
    }
  }

  const counts = await env.DB.prepare(`
    SELECT SUM(CASE WHEN attempts < 3 THEN 1 ELSE 0 END) AS remaining,
           SUM(CASE WHEN attempts >= 3 THEN 1 ELSE 0 END) AS gave_up
      FROM DriveTrash
  `).first<any>();
  const remaining = Number(counts?.remaining ?? 0);

  return { ok: true, moved, failed, remaining, gave_up: Number(counts?.gave_up ?? 0), done: remaining === 0 };
}

/**
 * 這個 Google access token 的主人可不可以當管理員。
 *
 * ⚠️ **一定要比對 `aud`。** tokeninfo 回的 email 只說明「這個 token 屬於誰」，
 * 沒說「是誰簽給他的」—— 隨便一個 app 拿同一個 Google 帳號簽出來的 token
 * 也帶著同一個 email。少了 aud 這一步，任何人都能用自家 app 的 token 冒充你。
 *
 * **白名單（D1 的 User 表，見 migrations/0008）是唯一的判準：表裡沒有這個信箱就直接拒絕，
 * 這裡不會替任何人建列。** 想登入得先請站長在 /admin 加進去。
 *
 * 曾經有一條 ADMIN_EMAILS 的 bootstrap（查無此人就看環境變數、命中就自動建一列），
 * 已移除 —— 那等於一份看不見的第二白名單：那些人沒登入過就不會出現在 /admin 上，
 * 站長既看不到也管不到。唯一的入口只能有一個。
 *
 * 站長自己不會被鎖在外面：0008 保證 User 表一定有 role='owner' 那一列。
 * 真的被鎖住（例如有人把 owner 停權了）只能開 D1 主控台下 SQL —— 那是刻意的，
 * 「這個站是誰的」不該由一個環境變數說了算。
 */
async function googleAdminCheck(
  env: Env, accessToken: string,
): Promise<{ ok: true; user: { id: number; email: string; name: string } } | { ok: false; reason: string }> {
  if (!env.GOOGLE_CLIENT_ID) return { ok: false, reason: "not_configured" };

  const res = await fetch(
    `https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(accessToken)}`
  );
  if (!res.ok) return { ok: false, reason: "token_invalid" };
  const info: any = await res.json();

  if (info.aud !== env.GOOGLE_CLIENT_ID) return { ok: false, reason: "wrong_audience" };
  if (String(info.email_verified) !== "true") return { ok: false, reason: "email_unverified" };

  const email = String(info.email || "").trim().toLowerCase();
  if (!email) return { ok: false, reason: "not_admin" };

  // 大小寫不敏感比對：Google 回的一律小寫，但表裡的是人手打進去的
  const row = await env.DB.prepare(
    "SELECT id, name, email, active FROM User WHERE lower(email) = ?"
  ).bind(email).first<any>();

  // 名單上沒有這個人 —— 到此為止，不建列、不放行
  if (!row) return { ok: false, reason: "not_admin" };

  // 在名單上但被停權。跟「從來不在名單上」分開回報，前端才講得出人話
  if (Number(row.active) !== 1) return { ok: false, reason: "revoked" };

  await env.DB.prepare("UPDATE User SET last_login_at = datetime('now') WHERE id = ?").bind(row.id).run();
  return { ok: true, user: { id: row.id, email: row.email, name: row.name } };
}

/**
 * 允許的前端來源。**同時是 CORS 白名單與登入導回的白名單。**
 *
 * 登入那條特別重要：導回的網址帶著管理員 JWT（在 fragment 裡），
 * 而導回的目標原本是直接取 Referer／Origin —— 那是攻擊者的網頁決定得了的東西，
 * 等於任何網站都能把你騙去登入然後收走 token。只能從這張表裡挑。
 */
const ALLOWED_ORIGINS = [
  "https://didadida-frontend.pages.dev",
  "https://dev.didadida-frontend.pages.dev",
  "http://localhost:3000",
];

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const pathname = url.pathname;
    const method = request.method;

const origin = request.headers.get("Origin") || "";
    const allowedOrigins = ALLOWED_ORIGINS;

    const allowOrigin = allowedOrigins.includes(origin) ? origin : allowedOrigins[0];

    // CORS Headers
    const headers = {
      "Access-Control-Allow-Origin": allowOrigin,
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Google-Token",
      "Content-Type": "application/json",
    };

    if (method === "OPTIONS") {
      // 進站閘門讓原本免預檢的 GET（/api/albums 那批）開始帶 Authorization，
      // 於是每一支都多一次 OPTIONS。快取一天，免得每次翻頁都來回兩趟。
      // 註：預檢快取是連查詢字串一起當鍵的，所以分頁還是各預檢一次，省不掉。
      return new Response(null, { headers: { ...headers, "Access-Control-Max-Age": "86400" } });
    }

    // Block non-TW IPs
    const country = (request as any).cf?.country;
    // Allow if country is TW, or if running locally (country is undefined, 'XX', 'T1' etc.)
    if (country && typeof country === 'string' && !['TW', 'XX', 'T1'].includes(country.toUpperCase())) {
      return new Response(JSON.stringify({ error: "Access Denied. Only accessible from Taiwan." }), {
        status: 403,
        headers
      });
    }

    /*
     * ── 進站閘門 ──────────────────────────────────────────────────────────────
     *
     * 整站不再對匿名請求開放。以前「GET 都公開」的那批（相簿清單、相簿內容、
     * 搜尋、標籤、足跡）現在都要一張 token，不管是 guest 還是 admin。
     *
     * 寫成**白名單 + 一道總閘**而不是在每支路由各加一行，是因為後者漏一支就等於
     * 沒鎖，而漏掉的那支通常是新加的 —— 新路由預設該是關的。
     *
     * 白名單只有兩類：
     *   1. 換 token 的入口（不然沒有人進得來）。
     *   2. **圖片**。它們是 <img src>，瀏覽器不會幫忙帶 Authorization，
     *      要擋就只能改用跨網域 cookie（SameSite=None），Safari／Chrome 的第三方
     *      cookie 封鎖會直接讓圖片全破。使用者已決定不走那條路：R2 的物件鍵
     *      要先拿到相簿 JSON 才知道，而相簿 JSON 現在是鎖著的。
     *
     * 位置很重要：**必須排在 withEdgeCache 之前**。閘門若放在各路由裡面，
     * 訪客的回應會先進共用的邊緣快取，之後匿名請求就直接命中那份快取拿到 200。
     */
    const isOpenPath =
      pathname === "/api/verify-password"
      || pathname === "/api/verify-guest"
      || pathname === "/api/auth/me"
      || pathname.startsWith("/api/auth/google/")
      || pathname.startsWith("/api/photos/view/")
      || /^\/api\/photos\/\d+\/full$/.test(pathname);

    if (!isOpenPath && !(await tokenIdentity(request, env))) {
      return new Response(JSON.stringify({ error: "locked" }), { status: 401, headers });
    }

    try {
if (method === "POST" && pathname === "/api/verify-password") {
        // 1. 強制延遲 (Delay)
        await new Promise(r => setTimeout(r, 2000));
        
        // 2. 計數鎖定 (Rate Limit)
        const ip = request.headers.get("CF-Connecting-IP") || "unknown";
        const attempt = loginAttempts.get(ip) || { count: 0 };
        
        if (attempt.lockUntil && attempt.lockUntil > Date.now()) {
          return new Response(JSON.stringify({ error: "Too many attempts. Locked for 10 minutes." }), { status: 429, headers });
        }
        
        const body: { password: string } = await request.json();
        if (body.password === env.APP_PASSWORD) {
          loginAttempts.delete(ip); // Reset on success
          // 密碼登入的是站長本人（那是他自己的後路）。查得到就把身分寫進 token，
          // 查不到（空資料庫）也照發 —— currentActor 會把沒有 uid 的當站長
          const owner = await env.DB.prepare(
            "SELECT id, email FROM User WHERE role = 'owner' AND active = 1 ORDER BY id LIMIT 1"
          ).first<any>();
          if (owner) {
            await env.DB.prepare("UPDATE User SET last_login_at = datetime('now') WHERE id = ?").bind(owner.id).run();
          }
          const token = await generateJWT(env, 'admin', owner);
          return new Response(JSON.stringify({ success: true, token }), { headers });
        }
        
        // On failure
        attempt.count += 1;
        if (attempt.count >= 5) {
          attempt.lockUntil = Date.now() + 10 * 60 * 1000; // 10 mins
        }
        loginAttempts.set(ip, attempt);
        
        return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers });
      }

      /*
       * 路由：進站密碼 → 訪客 token。
       *
       * 節流的計數器跟 verify-password **分開計**（key 加 `guest:` 前綴）：
       * 共用的話，家人打錯五次進站密碼會連帶把管理員登入鎖十分鐘，
       * 而那兩件事其實沒有關係。2 秒延遲與五次上限則刻意比照辦理 ——
       * 這把鑰匙開的門比較小，但它終究還是一把可以被慢慢猜的密碼。
       */
      if (method === "POST" && pathname === "/api/verify-guest") {
        if (!env.GUEST_PASSWORD) {
          // 沒設定就沒有人進得來。回 503 而不是 401，前端才分得出「密碼打錯」
          // 與「這個環境根本還沒設定」—— 後者叫使用者一直重打密碼是最糟的體驗
          return new Response(JSON.stringify({ error: "not_configured" }), { status: 503, headers });
        }

        await new Promise(r => setTimeout(r, 2000));

        const ip = "guest:" + (request.headers.get("CF-Connecting-IP") || "unknown");
        const attempt = loginAttempts.get(ip) || { count: 0 };
        if (attempt.lockUntil && attempt.lockUntil > Date.now()) {
          return new Response(JSON.stringify({ error: "Too many attempts. Locked for 10 minutes." }), { status: 429, headers });
        }

        const body: { password: string } = await request.json();
        if (body.password === env.GUEST_PASSWORD) {
          loginAttempts.delete(ip);
          const token = await generateJWT(env, 'guest');
          return new Response(JSON.stringify({ success: true, token }), { headers });
        }

        attempt.count += 1;
        if (attempt.count >= 5) attempt.lockUntil = Date.now() + 10 * 60 * 1000;
        loginAttempts.set(ip, attempt);

        return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers });
      }

      // 路由：確認手上的 token 還有效（沒過期、簽章對）
      //
      // 前端每次進站都靠這一條決定要不要顯示編輯介面 —— 只看 localStorage 有沒有
      // token 是不夠的，過期後那個 key 還在。刻意不套 verify-password 的 2 秒延遲
      // 與登入節流：它不接受密碼，沒有可暴力破解的東西，也沒有任何副作用。
      //
      // 加了訪客層之後這條也回報「進不進得了站」：401 代表手上什麼都沒有，
      // 前端該把進站畫面端出來；200 + admin:false 代表是訪客，可以瀏覽但沒有編輯權。
      if (method === "GET" && pathname === "/api/auth/me") {
        const identity = await tokenIdentity(request, env);
        if (!identity) {
          return new Response(JSON.stringify({ admin: false, guest: false, user: null }), { status: 401, headers });
        }
        // 管理員才查 D1（也才有東西可查）。訪客走這裡是每次進站都會發生的事，
        // 多一次讀取乘上每個家人的每次重整，不值得
        const actor = identity.role === 'admin' ? await currentActor(request, env) : null;
        // 足跡地圖對訪客開不開。管理員一律看得到，不必問設定
        const canViewMap = actor !== null || await guestCanViewMap(env);
        return new Response(JSON.stringify({
          // 白名單被撤掉的人 token 還沒過期 —— 這裡就要說 admin:false，
          // 不然前端會端出一整套按下去全是 403 的編輯介面
          admin: actor !== null,
          guest: identity.role === 'guest' || (identity.role === 'admin' && actor === null),
          can_view_map: canViewMap ? 1 : 0,
          user: actor ? {
            id: actor.uid, name: actor.name, email: actor.email,
            role: actor.isOwner ? 'owner' : 'member',
            can_manage_others: actor.canManageOthers ? 1 : 0,
          } : null,
        }), { headers });
      }

      /*
       * 路由：改自己的顯示名稱。只有這一個欄位 ——
       * 信箱是身分（改了等於換人），權限不能自己給自己加。
       */
      if (method === "PUT" && pathname === "/api/me") {
        const actor = await currentActor(request, env);
        if (!actor) {
          return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers });
        }
        if (actor.uid == null) {
          // 空資料庫的密碼登入，沒有列可以改
          return new Response(JSON.stringify({ error: "no_account" }), { status: 409, headers });
        }
        const body: { name?: string } = await request.json();
        const name = String(body.name ?? "").trim();
        if (!name) {
          return new Response(JSON.stringify({ error: "顯示名稱不能空白" }), { status: 400, headers });
        }
        if (name.length > 40) {
          return new Response(JSON.stringify({ error: "顯示名稱最多 40 個字" }), { status: 400, headers });
        }
        await env.DB.prepare("UPDATE User SET name = ? WHERE id = ?").bind(name, actor.uid).run();
        return new Response(JSON.stringify({
          success: true,
          user: {
            id: actor.uid, name, email: actor.email,
            role: actor.isOwner ? 'owner' : 'member',
            can_manage_others: actor.canManageOthers ? 1 : 0,
          },
        }), { headers });
      }

      /* ── 站長專用：站台開關 ────────────────────────────────────────────────
       *
       * 目前只有一個：訪客能不能看足跡地圖。跟白名單同一個理由歸站長 ——
       * 「訪客看得到什麼」是站的門，不是編輯權限。
       */
      if (pathname === "/api/admin/settings") {
        const actor = await currentActor(request, env);
        if (!actor) {
          return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers });
        }
        if (!actor.isOwner) {
          return new Response(JSON.stringify({ error: "只有站長可以改站台設定" }), { status: 403, headers });
        }

        if (method === "GET") {
          return new Response(JSON.stringify({
            guest_can_view_map: (await getSetting(env, SETTING_GUEST_MAP)) === "1" ? 1 : 0,
          }), { headers });
        }

        if (method === "PUT") {
          const body: { guest_can_view_map?: any } = await request.json();
          if (body.guest_can_view_map !== undefined) {
            await setSetting(env, SETTING_GUEST_MAP, body.guest_can_view_map ? "1" : "0");
          }
          return new Response(JSON.stringify({
            success: true,
            guest_can_view_map: (await getSetting(env, SETTING_GUEST_MAP)) === "1" ? 1 : 0,
          }), { headers });
        }
      }

      /* ── 站長專用：白名單管理 ──────────────────────────────────────────────
       *
       * 只有 role='owner' 進得來。can_manage_others 給的是「動別人的內容」，
       * **不包含「決定誰進得來」** —— 那是站的鑰匙，不是編輯權限。
       */
      if (pathname === "/api/admin/users" || pathname.startsWith("/api/admin/users/")) {
        const actor = await currentActor(request, env);
        if (!actor) {
          return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers });
        }
        if (!actor.isOwner) {
          return new Response(JSON.stringify({ error: "只有站長可以管理白名單" }), { status: 403, headers });
        }

        // 路由：白名單清單。附上「他名下有多少東西」，站長才知道移除他會影響什麼
        if (method === "GET" && pathname === "/api/admin/users") {
          const { results } = await env.DB.prepare(`
            SELECT u.id, u.name, u.email, u.role, u.can_manage_others, u.active,
                   u.last_login_at, u.created_at,
                   (SELECT COUNT(*) FROM Album a WHERE a.user_id = u.id) AS album_count,
                   (SELECT COUNT(*) FROM Photo p JOIN Album a ON a.id = p.album_id WHERE a.user_id = u.id) AS photo_count
              FROM User u
             ORDER BY (u.role = 'owner') DESC, u.active DESC, u.id
          `).all();
          return new Response(JSON.stringify(results), { headers });
        }

        // 路由：加一個人進白名單。只需要信箱 —— 他第一次 Google 登入就自動對上
        if (method === "POST" && pathname === "/api/admin/users") {
          const body: { email?: string; name?: string; can_manage_others?: any } = await request.json();
          const email = String(body.email ?? "").trim().toLowerCase();
          if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
            return new Response(JSON.stringify({ error: "請填一個看起來像信箱的東西" }), { status: 400, headers });
          }
          const name = String(body.name ?? "").trim() || email.split("@")[0];
          const canManage = body.can_manage_others ? 1 : 0;

          const existing = await env.DB.prepare(
            "SELECT id, active FROM User WHERE lower(email) = ?"
          ).bind(email).first<any>();
          if (existing) {
            // 曾經被移出白名單的人再加回來 —— 就是把 active 打開，他的相簿都還在
            await env.DB.prepare(
              "UPDATE User SET active = 1, can_manage_others = ?, name = ? WHERE id = ?"
            ).bind(canManage, name, existing.id).run();
            const row = await env.DB.prepare("SELECT id, name, email, role, can_manage_others, active FROM User WHERE id = ?")
              .bind(existing.id).first();
            return new Response(JSON.stringify({ success: true, restored: Number(existing.active) !== 1, user: row }), { headers });
          }

          const res = await env.DB.prepare(
            "INSERT INTO User (name, email, role, can_manage_others, active) VALUES (?, ?, 'member', ?, 1)"
          ).bind(name, email, canManage).run();
          const id = res.meta.last_row_id;
          const row = await env.DB.prepare("SELECT id, name, email, role, can_manage_others, active FROM User WHERE id = ?")
            .bind(id).first();
          return new Response(JSON.stringify({ success: true, user: row }), { headers });
        }

        /* ── 刪除帳號。跟「移出白名單」是完全不同的兩件事 ─────────────────────
         *
         * 移出白名單只是停權（active=0，列還在，隨時放他回來）。這裡是真的把
         * User 那一列刪掉，白名單上再也看不到他。**不可逆**。
         *
         * 兩個選填的清除範圍，由站長各自勾（都不勾就只是把帳號抹掉）：
         *
         *   albums=1  他建立的相簿整本刪掉。**連裡面別人傳的照片也一起沒了** ——
         *             相簿沒了，裡面的照片沒有地方可以放。
         *   photos=1  他上傳的照片刪掉，**包含放在別人相簿裡的那些**（照 uploaded_by 走，
         *             使用者指定）。兩個都勾就是聯集。
         *
         * 沒被勾到的東西不會消失，而是**改掛到站長名下**。這不是設計上的偏好，是
         * 資料庫逼出來的：Album.user_id 是 NOT NULL（沒有「無主相簿」這種狀態）
         * 而且是 ON DELETE CASCADE —— 先改掛再刪 User，順序反過來就會把他整個人的
         * 回憶連同 R2／Drive 上的孤兒檔案一起帶走。
         *
         * GET 同一條路徑＝刪之前先問「會少掉什麼」，站長才不是閉著眼睛勾。
         */
        const purgeMatch = pathname.match(/^\/api\/admin\/users\/(\d+)\/purge$/);
        if (purgeMatch && (method === "GET" || method === "DELETE")) {
          const targetId = Number(purgeMatch[1]);
          const target = await env.DB.prepare(
            "SELECT id, name, email, role FROM User WHERE id = ?"
          ).bind(targetId).first<any>();
          if (!target) {
            return new Response(JSON.stringify({ error: "找不到這個帳號" }), { status: 404, headers });
          }
          // 站長刪不得，理由同上面的權限修改：刪掉就沒有人能管白名單了
          if (target.role === 'owner' || targetId === actor.uid) {
            return new Response(JSON.stringify({ error: "站長的帳號不能刪除" }), { status: 400, headers });
          }

          if (method === "GET") {
            /*
             * photos_elsewhere 要掃 Photo.uploaded_by，而那一欄沒有索引 ——
             * 所以這個數字**只在站長真的打開刪除視窗時才算**，不塞進白名單清單。
             * 塞進去的話 /admin 每開一次就全表掃一遍，免費額度撐不住。
             */
            const counts = await env.DB.prepare(`
              SELECT
                (SELECT COUNT(*) FROM Album WHERE user_id = ?) AS albums,
                (SELECT COUNT(*) FROM Photo p JOIN Album a ON a.id = p.album_id
                  WHERE a.user_id = ?) AS photos_in_albums,
                (SELECT COUNT(*) FROM Photo WHERE uploaded_by = ?) AS photos_uploaded,
                (SELECT COUNT(*) FROM Photo p JOIN Album a ON a.id = p.album_id
                  WHERE p.uploaded_by = ? AND a.user_id <> ?) AS photos_elsewhere
            `).bind(targetId, targetId, targetId, targetId, targetId).first<any>();
            return new Response(JSON.stringify({
              id: targetId,
              email: target.email,
              albums: Number(counts?.albums ?? 0),
              photos_in_albums: Number(counts?.photos_in_albums ?? 0),
              photos_uploaded: Number(counts?.photos_uploaded ?? 0),
              photos_elsewhere: Number(counts?.photos_elsewhere ?? 0),
            }), { headers });
          }

          // 保留下來的相簿要有人接手，而接手的人是站長本人。極端情況下站上
          // 一個 owner 列都沒有（舊 token 密碼登入 + User 表被清過），那就別動
          if (actor.uid == null) {
            return new Response(JSON.stringify({ error: "站上找不到站長的帳號列，無法接手保留下來的內容" }), { status: 400, headers });
          }

          const dropAlbums = url.searchParams.get("albums") === "1";
          const dropPhotos = url.searchParams.get("photos") === "1";

          // 1. 要整本刪掉的相簿。drive_folder_id 一定要在刪列之前撈出來，
          //    列一刪就再也查不到該把哪個資料夾搬進 trash/
          const albums = dropAlbums
            ? (await env.DB.prepare(
                "SELECT id, drive_folder_id FROM Album WHERE user_id = ?"
              ).bind(targetId).all<any>()).results
            : [];
          const albumIds = new Set(albums.map((a) => Number(a.id)));
          // 有資料夾的那幾本，整個資料夾搬走就好，裡面的檔案不必再逐個登記
          //（理由見刪相簿那條路：逐檔搬會把 trash/ 攤平成幾千個散檔）
          const folderRows = albums.filter(
            (a) => typeof a.drive_folder_id === "string" && a.drive_folder_id
          );
          const folderedAlbums = new Set(folderRows.map((a) => Number(a.id)));

          /*
           * 2. 要刪的照片。兩個勾選取聯集：他相簿裡的（不管誰傳的）
           *    ＋ 他傳的（不管在誰的相簿裡）。
           *
           * 相簿用子查詢而不是把 id 攤成 IN (?,?,…)：D1 單一 statement 只吃
           * 100 個綁定參數，一百多本相簿就會 500（見 chunkIds 的說明）。
           */
          const clauses: string[] = [];
          const binds: any[] = [];
          if (dropAlbums) {
            clauses.push("album_id IN (SELECT id FROM Album WHERE user_id = ?)");
            binds.push(targetId);
          }
          if (dropPhotos) {
            clauses.push("uploaded_by = ?");
            binds.push(targetId);
          }
          const photos = clauses.length > 0
            ? (await env.DB.prepare(`
                SELECT id, album_id, url, file_name, thumb_url, thumb_sm_url,
                       drive_file_id, drive_original_id
                  FROM Photo WHERE ${clauses.join(" OR ")}
              `).bind(...binds).all<any>()).results
            : [];
          const photoIds = photos.map((p) => Number(p.id));

          // 3. R2 的實體檔案（主檔 + 800px + 400px）。一次最多 1000 個鍵
          if (photos.length > 0) {
            const keys = photos.flatMap((p) => r2KeysForPhoto(p));
            for (let i = 0; i < keys.length; i += 1000) {
              await env.BUCKET.delete(keys.slice(i, i + 1000));
            }
          }

          // 4. Drive：整本刪掉的相簿搬資料夾，其餘（別人相簿裡的照片、
          //    還有分資料夾之前的舊相簿）才逐檔登記。兩條路都不呼叫 files.delete
          if (folderRows.length > 0) {
            const stmt = env.DB.prepare("INSERT INTO DriveTrash (drive_id, photo_id) VALUES (?, NULL)");
            for (let i = 0; i < folderRows.length; i += 100) {
              await env.DB.batch(folderRows.slice(i, i + 100).map((a) => stmt.bind(a.drive_folder_id)));
            }
          }
          const loosePhotos = photos.filter((p) => !folderedAlbums.has(Number(p.album_id)));
          if (loosePhotos.length > 0) await queueDriveTrash(env, loosePhotos);

          if (photoIds.length > 0) {
            for (const part of chunkIds(photoIds)) {
              await env.DB.prepare(
                `DELETE FROM PhotoTag WHERE photo_id IN (${placeholdersFor(part)})`
              ).bind(...part).run();
            }

            /*
             * 被刪掉的照片如果正好是某本相簿的封面，封面要清掉，否則那本相簿
             * 會一直指著一個 404 的網址。只有**留下來的**相簿要處理 ——
             * 整本要刪的那幾本自己馬上就不在了。
             */
            const coverUrls = [...new Set(photos
              .filter((p) => !albumIds.has(Number(p.album_id)) && typeof p.url === "string" && p.url)
              .map((p) => p.url as string))];
            for (let i = 0; i < coverUrls.length; i += 90) {
              const part = coverUrls.slice(i, i + 90);
              await env.DB.prepare(
                `UPDATE Album SET cover_photo_url = NULL WHERE cover_photo_url IN (${placeholdersFor(part)})`
              ).bind(...part).run();
            }

            for (const part of chunkIds(photoIds)) {
              await env.DB.prepare(
                `DELETE FROM Photo WHERE id IN (${placeholdersFor(part)})`
              ).bind(...part).run();
            }
            // PhotoFts 是虛擬表，沒有 FK，不會跟著 Photo 一起消失
            await deleteFtsForPhotos(env.DB, photoIds);
          }

          // 5. 相簿本身。一條 statement 就掃完，不必按 id 切塊
          if (dropAlbums) {
            await env.DB.prepare("DELETE FROM Album WHERE user_id = ?").bind(targetId).run();
          }

          /*
           * 6. 沒被刪掉的東西改掛站長名下。**一定要排在刪 User 之前** ——
           *    Album.user_id 是 ON DELETE CASCADE，順序反過來就會把留下來的
           *    相簿連同照片一起被外鍵帶走，而且 R2 與 Drive 上的檔案不會跟著清。
           */
          const moved = await env.DB.prepare(
            "UPDATE Album SET user_id = ? WHERE user_id = ?"
          ).bind(actor.uid, targetId).run();
          // uploaded_by 沒有外鍵，不清會留下指向不存在帳號的 id
          //（前端的 canEdit 拿它跟自己的 uid 比對，id 被重用時會誤判）
          const orphaned = await env.DB.prepare(
            "UPDATE Photo SET uploaded_by = NULL WHERE uploaded_by = ?"
          ).bind(targetId).run();

          // 7. 人本身
          await env.DB.prepare("DELETE FROM User WHERE id = ?").bind(targetId).run();

          if (folderRows.length > 0 || loosePhotos.length > 0) {
            // 開頭幾個當場搬掉，剩下的交給 cron
            ctx.waitUntil(drainDriveTrash(env, 10).catch((e) => console.error("Drive 待搬佇列", e)));
          }

          return new Response(JSON.stringify({
            success: true,
            mode: "deleted",
            email: target.email,
            deleted_albums: albumIds.size,
            deleted_photos: photoIds.length,
            kept_albums: Number(moved.meta?.changes ?? 0),
            kept_photos: Number(orphaned.meta?.changes ?? 0),
          }), { headers });
        }

        const idMatch = pathname.match(/^\/api\/admin\/users\/(\d+)$/);
        if (idMatch && (method === "PUT" || method === "DELETE")) {
          const targetId = Number(idMatch[1]);
          const target = await env.DB.prepare(
            "SELECT id, name, email, role, can_manage_others, active FROM User WHERE id = ?"
          ).bind(targetId).first<any>();
          if (!target) {
            return new Response(JSON.stringify({ error: "找不到這個帳號" }), { status: 404, headers });
          }
          /*
           * 站長這一列動不得：降權或停用會讓站上再也沒有人能改白名單，
           * 而唯一的復原辦法是直接開 D1 主控台。這種門不該裝在網頁上。
           */
          if (target.role === 'owner') {
            return new Response(JSON.stringify({ error: "站長的權限不能在這裡修改" }), { status: 400, headers });
          }

          // 路由：改權限／改名／停權復權
          if (method === "PUT") {
            const body: { name?: string; can_manage_others?: any; active?: any } = await request.json();
            const sets: string[] = [];
            const binds: any[] = [];
            if (typeof body.name === "string") {
              const n = body.name.trim();
              if (!n) return new Response(JSON.stringify({ error: "顯示名稱不能空白" }), { status: 400, headers });
              sets.push("name = ?"); binds.push(n.slice(0, 40));
            }
            if (body.can_manage_others !== undefined) {
              sets.push("can_manage_others = ?"); binds.push(body.can_manage_others ? 1 : 0);
            }
            if (body.active !== undefined) {
              sets.push("active = ?"); binds.push(body.active ? 1 : 0);
            }
            if (sets.length === 0) {
              return new Response(JSON.stringify({ error: "沒有要改的東西" }), { status: 400, headers });
            }
            await env.DB.prepare(`UPDATE User SET ${sets.join(", ")} WHERE id = ?`).bind(...binds, targetId).run();
            const row = await env.DB.prepare("SELECT id, name, email, role, can_manage_others, active FROM User WHERE id = ?")
              .bind(targetId).first();
            return new Response(JSON.stringify({ success: true, user: row }), { headers });
          }

          /*
           * 路由：移出白名單。**一律停權（active=0），永遠不刪列。** 兩個理由：
           *
           * 1. Album.user_id 是 ON DELETE CASCADE，刪掉這一列會連他建過的相簿和
           *    照片一起消失（連 R2 與 Drive 上的檔案都不會被清，變成孤兒）。
           *    「這個人不能再進來」跟「刪掉他的回憶」是兩件事。
           * 2. 停權留在名單上看得見（前端標「已停權」），要放他回來就是再加一次；
           *    刪掉的話這個人就從畫面上蒸發，站長事後想不起來自己踢過誰。
           *
           * 名下有幾本相簿照樣回報，前端才講得出「他的東西還在」。
           * 真的要把一個人從名單上抹掉是另一顆按鈕：見上面的 `/purge`。
           */
          const owned = await env.DB.prepare(
            "SELECT COUNT(*) AS n FROM Album WHERE user_id = ?"
          ).bind(targetId).first<any>();
          const albumCount = Number(owned?.n ?? 0);
          await env.DB.prepare("UPDATE User SET active = 0 WHERE id = ?").bind(targetId).run();
          return new Response(JSON.stringify({ success: true, mode: "deactivated", album_count: albumCount }), { headers });
        }

        return new Response(JSON.stringify({ error: "Not Found" }), { status: 404, headers });
      }

      /*
       * 路由：取得相簿（分頁）
       *
       * 舊版用 ROW_NUMBER() OVER(PARTITION BY album_id) 一次撈出每本相簿的前 10 張
       * 預覽圖。那個窗口函式必須把整張 Photo 掃過一遍才算得出 rn，所以首頁每開一次
       * 就讀一次全部照片 —— 15 萬張時是 15 萬列，D1 一天 5M 列等於只夠開 33 次首頁。
       *
       * 改成每本相簿各送索引 seek，成本從「總照片數」變成「這一頁的相簿數 × 5」，
       * 不再隨照片數量成長。
       */
      if (method === "GET" && pathname === "/api/albums") {
       // 快取 60 秒，剛好對齊下面預覽圖的分鐘種子 —— 種子換人時快取也正好過期，
       // 不會出現「快取裡的舊種子」與「新算出來的種子」互相打架的空窗
       return withEdgeCache(request, ctx,
         { browserMaxAge: 60, edgeMaxAge: 60, skip: await isAuthorized(request, env) },
         async () => {
        const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 20) || 20, 1), 60);
        const offset = Math.max(Number(url.searchParams.get("offset") ?? 0) || 0, 0);
        const rawQuery = (url.searchParams.get("q") ?? "").trim();
        const tagIds = (url.searchParams.get("tags") ?? "")
          .split(",").map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(0, 50);

        /*
         * 篩選條件跟 /api/search 一樣，但比對的是「這本相簿本身」或「裡面有沒有
         * 符合的照片」。相簿名不進 PhotoFts（見 migration 0004），改用 LIKE 直接
         * 比對 Album 表 —— 那張表頂多幾百列，掃完的成本可以忽略，而且完全不必同步。
         */
        const where: string[] = [];
        const binds: any[] = [];
        if (rawQuery) {
          const matchExpr = ftsMatchExpr(rawQuery);
          const like = `%${rawQuery.replace(/[\\%_]/g, "\\$&")}%`;
          const clauses = [
            `a.name LIKE ? ESCAPE '\\'`,
            `IFNULL(a.description, '') LIKE ? ESCAPE '\\'`,
          ];
          binds.push(like, like);
          if (matchExpr) {
            clauses.push(`a.id IN (SELECT p.album_id FROM Photo p
                                    WHERE p.id IN (SELECT rowid FROM PhotoFts WHERE PhotoFts MATCH ?))`);
            binds.push(matchExpr);
          }
          where.push(`(${clauses.join(" OR ")})`);
        }
        if (tagIds.length > 0) {
          where.push(`a.id IN (SELECT p.album_id FROM Photo p
                                WHERE p.id IN (SELECT photo_id FROM PhotoTag WHERE tag_id IN (${placeholdersFor(tagIds)})))`);
          binds.push(...tagIds);
        }

        /*
         * 排序也得由後端決定 —— 清單既然是分頁的，前端手上永遠只有一部分，
         * 在瀏覽器裡排序只會把「這一頁」排好，跨頁的順序還是錯的。
         * 白名單比對而不是把參數拼進 SQL：這段是字串串接，不是繫結參數。
         */
        const orderBy = url.searchParams.get("sort") === "upload_date"
          ? "a.created_at DESC"
          : "a.sort_order ASC, a.created_at DESC";

        const { results: albums } = await env.DB.prepare(`
          SELECT a.* FROM Album a
          ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
          ORDER BY ${orderBy}
          LIMIT ? OFFSET ?
        `).bind(...binds, limit, offset).all();

        if (albums.length === 0) {
          return new Response(JSON.stringify({ albums: [], has_more: false }), { headers });
        }

        /*
         * 預覽圖的隨機起點。
         *
         * 種子跟著分鐘走而不是每次請求重擲：這條路由要能被邊緣快取，每次都給不同
         * 答案等於快取失效，而且同一分鐘內家人各自看到不同內容也沒有意義。
         * 每分鐘換一次，長期下來整本相簿都輪得到。
         * 再乘上 album_id 打散，否則所有相簿會同時跳到各自序列的同一個相對位置。
         */
        const minuteBucket = Math.floor(Date.now() / 60000);
        const seedFor = (albumId: number) =>
          Math.abs(Math.imul(minuteBucket + albumId * 7919, 2654435761)) % 2147483647;

        /*
         * 每本相簿送兩條：從隨機起點往後拿 5 張，再從序列開頭補 5 張。
         * 起點落在尾端時第一條會不足 5 筆，第二條負責繞回開頭補齊。
         * 兩條都走 idx_photo_album_shuffle 的 covering index，各自最多讀 5 列。
         */
        const previewSelect = (op: string) =>
          `SELECT COALESCE(thumb_sm_url, thumb_url, url) AS url
             FROM Photo WHERE album_id = ? AND shuffle_key ${op} ?
            ORDER BY shuffle_key LIMIT 5`;
        const statements = (albums as any[]).flatMap((a) => {
          const seed = seedFor(Number(a.id));
          return [
            env.DB.prepare(previewSelect(">=")).bind(a.id, seed),
            env.DB.prepare(previewSelect("<")).bind(a.id, seed),
          ];
        });
        const batched = await env.DB.batch<any>(statements);

        const albumsWithPhotos = (albums as any[]).map((album, i) => {
          // 同一張照片不可能同時滿足 >= 與 <，直接串接不會重複
          const rows = [...batched[i * 2].results, ...batched[i * 2 + 1].results];
          return { ...album, preview_photos: rows.slice(0, 5).map((p: any) => p.url) };
        });

        return new Response(JSON.stringify({
          albums: albumsWithPhotos,
          // 剛好等於 limit 時無法分辨是不是最後一頁，寧可讓前端多問一次空頁
          has_more: albums.length === limit,
        }), { headers });
         });
      }



      // 路由：查看 R2 照片
      //
      // 檔名帶上傳時間戳、內容不會被就地覆寫，所以可以給 immutable 的一年。
      // 這裡不分管理員：R2 物件本身沒有依身分變化的內容，沒有 applyGeoPrivacy
      // 那種洩漏問題。邊緣快取省下的是 R2 Class B 次數（免費 10M/月）。
      if (method === "GET" && pathname.startsWith("/api/photos/view/")) {
        return withEdgeCache(request, ctx,
          { browserMaxAge: 31536000, edgeMaxAge: 31536000, skip: false },
          async () => {
            const fileName = decodeURIComponent(pathname.split("/")[4]);
            const object = await env.BUCKET.get(fileName);

            if (object === null) {
              return new Response(JSON.stringify({ error: "Photo not found" }), { status: 404, headers });
            }

            const photoHeaders = new Headers();
            object.writeHttpMetadata(photoHeaders);
            photoHeaders.set("etag", object.httpEtag);
            photoHeaders.set("Access-Control-Allow-Origin", "*");
            // Cache-Control 由 withEdgeCache 統一覆寫，這裡不必再設

            return new Response(object.body, { headers: photoHeaders });
          });
      }

      /*
       * 路由：燈箱大圖。
       *
       * 這是唯一對外服務 Drive 內容的入口。Drive 的檔案沒有分享給任何人，只有
       * service account 讀得到，所以一定要經過 Worker 代理 —— 不能給前端 Drive 連結。
       *
       * **任何一步失敗都退回 R2**，包含 drive_file_id 還是 NULL 的舊照片、SA 沒設定、
       * Drive 當掉。燈箱永遠打得開，這是 [[縮圖成功就算數]] 那個決定的另一半：
       * Drive 只是加分，不是照片存在的必要條件。
       *
       * 快取分兩種，不能共用一套參數：
       *   - Drive 命中：那個 file id 的內容永遠不變 → 一年 immutable。
       *   - 退回 R2：drive_file_id 之後補傳就會變 → 只給 5 分鐘，不寫邊緣快取，
       *     否則補完 Drive 還要等一年才會有人真的走到新路徑。
       */
      if (method === "GET" && pathname.startsWith("/api/photos/")
          && pathname.endsWith("/full") && pathname.split("/").length === 5) {
        const photoId = pathname.split("/")[3];
        const cache = caches.default;
        const cacheKey = new Request(new URL(request.url).toString(), { method: "GET" });
        const hit = await cache.match(cacheKey);
        if (hit) return hit;

        const photo = await env.DB.prepare(
          "SELECT url, drive_file_id FROM Photo WHERE id = ?"
        ).bind(photoId).first<any>();
        if (!photo) {
          return new Response(JSON.stringify({ error: "Photo not found" }), { status: 404, headers });
        }

        const fallback = () => new Response(null, {
          status: 302,
          headers: {
            Location: photo.url,
            "Access-Control-Allow-Origin": "*",
            "Cache-Control": "public, max-age=300",
          },
        });

        if (!photo.drive_file_id || !env.GOOGLE_DRIVE_SA_KEY) return fallback();

        try {
          const upstream = await fetchDriveMedia(env.GOOGLE_DRIVE_SA_KEY, photo.drive_file_id);
          const full = new Response(upstream.body, {
            headers: {
              "Content-Type": upstream.headers.get("Content-Type") || "image/webp",
              "Access-Control-Allow-Origin": "*",
              "Cache-Control": "public, max-age=31536000, s-maxage=31536000, immutable",
            },
          });
          ctx.waitUntil(cache.put(cacheKey, full.clone()));
          return full;
        } catch (e) {
          // Drive 掛掉不該讓照片看不到。不快取這次，下次再試
          console.error("Drive 取檔失敗，退回 R2", e);
          return fallback();
        }
      }

      /*
       * 路由：單一相簿。
       *
       * 相簿頁本來是抓整份相簿清單再 find() 出這一本 —— 相簿清單改成分頁之後那招
       * 就壞了（要的那本可能在第 5 頁），而且本來也不該為了一本相簿把全部都抓來。
       */
      if (method === "GET" && pathname.startsWith("/api/albums/") && pathname.split("/").length === 4) {
        const albumId = pathname.split("/")[3];
        const album = await env.DB.prepare("SELECT * FROM Album WHERE id = ?").bind(albumId).first();
        if (!album) {
          return new Response(JSON.stringify({ error: "Album not found" }), { status: 404, headers });
        }
        return new Response(JSON.stringify(album), { headers });
      }

      // 路由：取得特定相簿的照片 (含 Tags)
      if (method === "GET" && pathname.startsWith("/api/albums/") && pathname.endsWith("/photos")) {
        // 同樣有座標差異，管理員跳過快取
        const albumIsAdmin = await isAuthorized(request, env);
        return withEdgeCache(request, ctx,
          { browserMaxAge: 30, edgeMaxAge: 300, skip: albumIsAdmin },
          async () => {
        const parts = pathname.split("/");
        const albumId = parts[3];

        const { results: rawPhotos } = await env.DB.prepare(`
          -- a.user_id 帶出來給前端判斷「這張是不是我的」。名字跟 actorOwns 讀的
          -- 那組欄位一致（user_id = 相簿主人、uploaded_by = 傳的人），前端才能
          -- 直接套同一條規則，不必自己再拼一次
          SELECT p.*, a.user_id AS user_id, a.map_private
          FROM Photo p
          LEFT JOIN Album a ON a.id = p.album_id
          WHERE p.album_id = ?
          ORDER BY p.sort_order ASC, p.created_at DESC
        `).bind(albumId).all();
        const photos = applyGeoPrivacy(rawPhotos as any[], albumIsAdmin);

        // 取得這些照片的標籤
        if (photos.length > 0) {
          const tagsQuery = `
            SELECT pt.photo_id, t.id, t.name
            FROM PhotoTag pt
            JOIN Tag t ON pt.tag_id = t.id
            JOIN Photo p ON pt.photo_id = p.id
            WHERE p.album_id = ?
          `;

          const { results: tags } = await env.DB.prepare(tagsQuery).bind(albumId).all();

          // 先建 Map 再逐張取，不要每張照片都去 filter 一次整份標籤 ——
          // 那是 O(照片數 × 標籤關聯數)，5000 張的相簿會直接超過單次 10ms CPU 上限
          const byPhoto = new Map<number, { id: number; name: string }[]>();
          for (const t of tags as any[]) {
            const list = byPhoto.get(Number(t.photo_id)) ?? [];
            list.push({ id: t.id, name: t.name });
            byPhoto.set(Number(t.photo_id), list);
          }
          for (const photo of photos) {
            (photo as any).tags = byPhoto.get(Number((photo as any).id)) ?? [];
          }
        }

        return new Response(JSON.stringify(photos), { headers });
          });
      }

      // 路由：取得所有正在使用的標籤
      //
      // 這條的 DISTINCT + JOIN 要掃過整張 PhotoTag（沒有辦法只靠索引就知道哪些
      // 標籤「有人用」），是少數會隨照片數成長的查詢。標籤清單幾乎不變，交給
      // 快取扛：五分鐘內只有第一個人真的掃。
      if (method === "GET" && pathname === "/api/tags") {
        return withEdgeCache(request, ctx,
          { browserMaxAge: 300, edgeMaxAge: 300, skip: await isAuthorized(request, env) },
          async () => {
            const { results } = await env.DB.prepare(`
              SELECT DISTINCT t.*
              FROM Tag t
              INNER JOIN PhotoTag pt ON t.id = pt.tag_id
              ORDER BY t.name ASC
            `).all();
            return new Response(JSON.stringify(results), { headers });
          });
      }

      /*
       * 路由：搜尋照片（取代舊的 /api/all-photos）
       *
       * 舊版一次回傳全站每一張照片，讓前端在瀏覽器裡用 includes() 過濾。首頁沒打
       * 關鍵字時那份資料根本沒被用到，卻每次都掃完整張 Photo 表，還在 Worker 裡跑
       * 一個 photos × tags 的雙層迴圈 —— 15 萬張時光那個迴圈就遠超單次 10ms CPU。
       *
       * 現在關鍵字交給 PhotoFts（見 fts.ts），標籤交給 idx_phototag_tag，兩者都是
       * 索引查詢，讀到的列數跟「命中幾張」成正比，而不是跟「總共有幾張」成正比。
       */
      if (method === "GET" && pathname === "/api/search") {
       // 搜尋結果會跑 applyGeoPrivacy，管理員與訪客拿到的座標不同 —— 管理員一律
       // 跳過邊緣快取，否則家人會從共用快取裡撈到私密相簿的經緯度
       const searchIsAdmin = await isAuthorized(request, env);
       return withEdgeCache(request, ctx,
         { browserMaxAge: 30, edgeMaxAge: 300, skip: searchIsAdmin },
         async () => {
        const rawQuery = (url.searchParams.get("q") ?? "").trim();
        const tagIds = (url.searchParams.get("tags") ?? "")
          .split(",").map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(0, 50);
        const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 60) || 60, 1), 200);
        const offset = Math.max(Number(url.searchParams.get("offset") ?? 0) || 0, 0);

        const matchExpr = rawQuery ? ftsMatchExpr(rawQuery) : null;
        // 有關鍵字但切不出任何 token（例如只打了標點）就是查無結果，
        // 不能當成「沒有條件」而把全站照片倒出來
        const impossible = rawQuery !== "" && matchExpr === null;
        if (impossible || (!matchExpr && tagIds.length === 0)) {
          return new Response(JSON.stringify({ photos: [], has_more: false }), { headers });
        }

        // 兩個條件都是子查詢而非 JOIN：JOIN 會因為一張照片命中多個標籤而重複列，
        // 得再補 DISTINCT，而 DISTINCT 會讓 SQLite 為了去重把結果集整個具體化。
        const where: string[] = [];
        const binds: any[] = [];
        if (matchExpr) {
          where.push(`p.id IN (SELECT rowid FROM PhotoFts WHERE PhotoFts MATCH ?)`);
          binds.push(matchExpr);
        }
        if (tagIds.length > 0) {
          where.push(`p.id IN (SELECT photo_id FROM PhotoTag WHERE tag_id IN (${placeholdersFor(tagIds)}))`);
          binds.push(...tagIds);
        }

        const { results: rawPhotos } = await env.DB.prepare(`
          SELECT p.*, a.name AS album_name, a.user_id AS user_id, a.map_private
          FROM Photo p
          LEFT JOIN Album a ON a.id = p.album_id
          WHERE ${where.join(" AND ")}
          ORDER BY p.taken_at DESC, p.created_at DESC
          LIMIT ? OFFSET ?
        `).bind(...binds, limit, offset).all();

        const photos = applyGeoPrivacy(rawPhotos as any[], searchIsAdmin);

        // 標籤只補這一頁的（最多 limit 張），而且用 Map 對應而不是每張照片 filter
        // 一次整份標籤 —— 那正是舊版的 O(n×m)。
        if (photos.length > 0) {
          const ids = photos.map((p: any) => Number(p.id));
          const tagResults = await env.DB.batch<any>(
            chunkIds(ids).map((c) => env.DB.prepare(
              `SELECT pt.photo_id, t.id, t.name FROM PhotoTag pt
                 JOIN Tag t ON t.id = pt.tag_id
                WHERE pt.photo_id IN (${placeholdersFor(c)})`
            ).bind(...c)),
          );
          const byPhoto = new Map<number, { id: number; name: string }[]>();
          for (const part of tagResults) {
            for (const row of part.results) {
              const list = byPhoto.get(Number(row.photo_id)) ?? [];
              list.push({ id: row.id, name: row.name });
              byPhoto.set(Number(row.photo_id), list);
            }
          }
          for (const photo of photos) {
            (photo as any).tags = byPhoto.get(Number((photo as any).id)) ?? [];
          }
        }

        return new Response(JSON.stringify({
          photos,
          has_more: photos.length === limit,
        }), { headers });
         });
      }

      /*
       * 路由：Google 時間軸比對用的照片清單。
       *
       * 這是唯一還會走完整張 Photo 表的讀取路徑，因為「哪張照片對得上哪個時間點」
       * 本來就得看過每一張。差別在於它只有管理員按下匯入時才跑一次，而不是每個
       * 訪客開首頁都跑；而且只取比對真正需要的四個欄位、用 id 當游標分批，
       * 單次呼叫的記憶體與 CPU 都是固定的。
       *
       * only_missing=1 時只回還沒有座標的照片。這一段沒有索引可用（idx_photo_geo_nn
       * 是 NOT NULL 的部分索引，剛好相反），還是得掃，但至少回傳量小很多。
       */
      if (method === "GET" && pathname === "/api/photos/geo-pending") {
        if (!(await isAuthorized(request, env))) {
          return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers });
        }
        const cursor = Number(url.searchParams.get("cursor") ?? 0) || 0;
        const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 1000) || 1000, 1), 2000);
        const onlyMissing = url.searchParams.get("only_missing") === "1";

        const { results: photos } = await env.DB.prepare(`
          SELECT id, lat, taken_at, taken_at_local
            FROM Photo
           WHERE id > ? ${onlyMissing ? "AND lat IS NULL" : ""}
           ORDER BY id LIMIT ?
        `).bind(cursor, limit).all();

        return new Response(JSON.stringify({
          photos,
          next_cursor: photos.length > 0 ? Number((photos[photos.length - 1] as any).id) : cursor,
          done: photos.length < limit,
        }), { headers });
      }

      /*
       * 路由：瀏覽器要往 Drive 建檔所需要的設定。
       *
       * 回這幾樣東西：
       *   client_id     本來就會出現在 OAuth 的網址列，不是機密
       *   sa_email      網頁建完資料夾後要把它加成 writer，否則後端讀不到裡面的檔
       *   兩個 folder id  已經建過就直接用；null 代表網頁該去建
       *   writer_*      Drive 上唯一的寫入身分（見 /api/drive/token 的說明）
       *
       * 鎖管理員不是因為內容敏感（都不是機密），而是只有上傳流程用得到它，
       * 沒有理由讓訪客知道這個站接在誰的 Drive 上。
       */
      if (method === "GET" && pathname === "/api/config/drive") {
        if (!(await isAuthorized(request, env))) {
          return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers });
        }
        const folders = await driveFolders(env);
        let saEmail: string | null = null;
        if (env.GOOGLE_DRIVE_SA_KEY) {
          try {
            saEmail = serviceAccountEmail(env.GOOGLE_DRIVE_SA_KEY);
          } catch (e) {
            console.error("SA 金鑰解析失敗", e);
          }
        }
        const [writerEmail, linkedAt] = await Promise.all([
          getSetting(env, SETTING_DRIVE_WRITER_EMAIL),
          getSetting(env, SETTING_DRIVE_LINKED_AT),
        ]);
        return new Response(JSON.stringify({
          client_id: env.GOOGLE_CLIENT_ID || null,
          sa_email: saEmail,
          photos_folder_id: folders.photos,
          trash_folder_id: folders.trash,
          // 所有人的上傳都用這個帳號的身分寫進 Drive；null＝還沒連結，誰都傳不了
          writer_email: writerEmail,
          writer_linked_at: linkedAt,
          // 少任何一項都上傳不了，讓前端一眼看出是哪裡沒設好
          ready: Boolean(env.GOOGLE_CLIENT_ID && saEmail && writerEmail),
        }), { headers });
      }

      /*
       * 路由：還沒搬上 Drive 的照片（「補傳 Drive」批次動作的來源）。
       *
       * 上傳時 Drive 失敗不會擋下照片（drive_file_id 留 NULL），舊照片也全都是
       * NULL，兩者在這裡看起來一樣 —— 本來就該一樣，補傳的動作完全相同。
       *
       * 回 title 是給補傳用的：使用者重選原始檔之後靠檔名對回照片，
       * 而 title 存的就是上傳當下的客戶端檔名（file_name 是加了時間戳的 R2 鍵，對不上）。
       * 會透露照片總數與上傳順序，所以跟 geo-pending 一樣鎖管理員。
       *
       * album_id 是選填的。補傳從相簿頁進去時帶上，一來清單短很多，
       * 二來避免不同相簿裡剛好同名的檔案互相對錯。
       */
      if (method === "GET" && pathname === "/api/photos/drive-pending") {
        if (!(await isAuthorized(request, env))) {
          return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers });
        }
        const cursor = Number(url.searchParams.get("cursor") ?? 0) || 0;
        const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 200) || 200, 1), 500);
        const albumId = Number(url.searchParams.get("album_id") ?? 0) || 0;
        const albumClause = albumId ? " AND album_id = ?" : "";

        const { results: photos } = await env.DB.prepare(`
          SELECT id, url, file_name, title
            FROM Photo
           WHERE id > ? AND drive_file_id IS NULL${albumClause}
           ORDER BY id LIMIT ?
        `).bind(...(albumId ? [cursor, albumId, limit] : [cursor, limit])).all();

        // 剩幾張要另外算：photos 只是這一批，進度條需要總數
        const remaining = await env.DB.prepare(
          `SELECT COUNT(*) AS n FROM Photo WHERE drive_file_id IS NULL${albumClause}`
        ).bind(...(albumId ? [albumId] : [])).first<any>();

        return new Response(JSON.stringify({
          photos,
          remaining: Number(remaining?.n ?? 0),
          next_cursor: photos.length > 0 ? Number((photos[photos.length - 1] as any).id) : cursor,
          done: photos.length < limit,
        }), { headers });
      }

      /*
       * 以下路由需要驗證。
       *
       * 這裡只回答「是不是站上的管理員」；「動不動得了這一本／這一張」是另一回事，
       * 由各路由自己用 writeActor 判斷（規則見 actorOwns）。
       * currentActor 對同一個 request 只查一次 D1，底下再叫幾次都不花額外讀取。
       */
      const requiresAuth = ["POST", "PUT", "DELETE"].includes(method);
      const writeActor = requiresAuth ? await currentActor(request, env) : null;
      if (requiresAuth && !writeActor) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers });
      }
      // 上面那一行已經擋掉 null，這個別名只是讓底下不必一路寫 `!`
      const me = writeActor as Actor;

      /** 這本相簿在不在我的管轄範圍。找不到相簿也回 false（呼叫端一律回 403/404） */
      const canTouchAlbum = async (albumId: string | number): Promise<boolean> => {
        if (me.canManageOthers) return true;
        const row = await albumOwnership(env, albumId);
        return row ? actorOwns(me, row) : false;
      };

      /** 這張照片在不在我的管轄範圍 */
      const canTouchPhoto = async (photoId: string | number): Promise<boolean> => {
        if (me.canManageOthers) return true;
        const row = await photoOwnership(env, photoId);
        return row ? actorOwns(me, row) : false;
      };

      /**
       * 一整批照片全都是我的嗎。批次類的端點（geo/*、reorder）用這個，
       * 一次 SQL 問完 —— 逐張問會讓一批兩百張變成兩百次讀取。
       * D1 的綁定參數上限是 100，所以要切塊（見 chunkIds）。
       */
      const canTouchPhotos = async (ids: (string | number)[]): Promise<boolean> => {
        if (me.canManageOthers) return true;
        if (me.uid == null) return false;
        const numeric = ids.map((v) => Number(v)).filter((v) => Number.isFinite(v));
        for (const chunk of chunkIds(numeric, 2)) {
          if (chunk.length === 0) continue;
          const row = await env.DB.prepare(`
            SELECT COUNT(*) AS n FROM Photo p JOIN Album a ON a.id = p.album_id
             WHERE p.id IN (${placeholdersFor(chunk)})
               AND a.user_id != ? AND (p.uploaded_by IS NULL OR p.uploaded_by != ?)
          `).bind(...chunk, me.uid, me.uid).first<any>();
          if (Number(row?.n ?? 0) > 0) return false;
        }
        return true;
      };

      /*
       * 全站共用的東西：GPS 軌跡、Google 時間軸、Drive 資料夾設定、維護工具。
       *
       * 它們不屬於任何一本相簿，「只能動自己的」在這裡沒有意義 —— 那是站的資產，
       * 而且軌跡本身就是「這台手機去過哪裡」。所以一律要 can_manage_others。
       * （白名單那幾支更嚴，是站長限定，而且在上面就先回應了。）
       */
      const isSharedResourceWrite =
        pathname.startsWith("/api/tracks/")
        || pathname.startsWith("/api/timeline/")
        || pathname === "/api/config/drive-folders"
        || pathname.startsWith("/api/admin/");
      if (requiresAuth && isSharedResourceWrite && !me.canManageOthers) {
        return forbidden(headers, "這是全站共用的資料，只有可以管理別人內容的帳號能修改");
      }

      /*
       * 路由：換一張 Drive 寫入用的短效 access token。
       *
       * 為什麼所有人都拿同一個帳號的 token：`drive.file` 是 per-file 授權，
       * 「誰建的檔誰才碰得到」。實測確認**根資料夾的 Picker 授權不會往下涵蓋
       * 別人建的子資料夾**，所以「每個管理員用自己的身分寫」這條路一定會在
       * 「A 建的相簿、B 要上傳」時撞 404。改成 Drive 上永遠只有一個寫入者，
       * 相簿是誰建的都無所謂。誰上傳的記在 D1，不靠 Drive 的擁有者欄位。
       *
       * token 不落地：只在記憶體裡活到過期，前端也只快取在變數。
       * 錯誤帶 reason 讓前端分辨「按一下就好」與「重新連結」。
       */
      if (method === "POST" && pathname === "/api/drive/token") {
        const minted = await mintDriveWriterToken(env);
        if (!minted.ok) {
          // 409：狀態不對（沒連結／過期），不是請求本身有問題，重試也沒用
          return new Response(JSON.stringify({ error: minted.detail, reason: minted.reason }), {
            status: minted.reason === "failed" ? 502 : 409,
            headers,
          });
        }
        return new Response(JSON.stringify({
          access_token: minted.accessToken,
          // 早 60 秒讓前端當作過期，免得剛好卡在邊界上送出請求
          expires_in: Math.max(minted.expiresIn - 60, 60),
          email: minted.email,
        }), { headers });
      }

      /*
       * 路由：登記網頁剛建好的 Drive 資料夾 id。
       *
       * **只寫一次，之後拒絕覆寫。** 換了資料夾等於所有既有照片的 drive_file_id
       * 都指向舊資料夾 —— 燈箱照樣讀得到（讀的是 file id 不是資料夾），但刪除會
       * 把檔案從舊資料夾搬進新的 trash，兩邊混在一起。真要換得人工介入，
       * 不該是一個 API 呼叫就能發生的事。
       */
      if (method === "POST" && pathname === "/api/config/drive-folders") {
        const body = await request.json().catch(() => ({})) as {
          photos_folder_id?: unknown; trash_folder_id?: unknown;
        };
        const photos = typeof body.photos_folder_id === "string" ? body.photos_folder_id : "";
        const trash = typeof body.trash_folder_id === "string" ? body.trash_folder_id : "";
        if (!photos || !trash) {
          return new Response(JSON.stringify({ error: "photos_folder_id 與 trash_folder_id 都必填" }), { status: 400, headers });
        }

        const existing = await driveFolders(env);
        if (existing.photos || existing.trash) {
          return new Response(JSON.stringify({
            error: "資料夾已經設定過了",
            photos_folder_id: existing.photos,
            trash_folder_id: existing.trash,
          }), { status: 409, headers });
        }

        const stmt = env.DB.prepare(
          "INSERT INTO AppSetting (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING"
        );
        await env.DB.batch([
          stmt.bind(SETTING_PHOTOS_FOLDER, photos),
          stmt.bind(SETTING_TRASH_FOLDER, trash),
        ]);
        return new Response(JSON.stringify({ success: true }), { headers });
      }

      /*
       * 路由：手動催一次待搬佇列。平常不需要按 —— 刪除當下會自己搬（見
       * drainDriveTrash 的說明），搬不完的由 cron 收尾。這支留著是為了「我現在就
       * 想看它動」跟卡住時的手動排查。
       */
      if (method === "POST" && pathname === "/api/admin/drain-drive-trash") {
        const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 10) || 10, 1), 20);
        const result = await drainDriveTrash(env, limit);
        if (!result.ok) {
          return new Response(JSON.stringify({
            error: "尚未設定 GOOGLE_DRIVE_SA_KEY，或 trash 資料夾還沒建起來（第一次上傳時網頁會自動建）",
          }), { status: 503, headers });
        }
        return new Response(JSON.stringify(result), { headers });
      }

      // 路由：重建全文檢索索引（分批）
      //
      // PhotoFts 的斷詞在 JS 裡做（見 fts.ts），沒辦法用 SQL trigger 補，所以
      // backfill 得走這裡。設計成帶 cursor 分批而不是一次跑完，有兩個理由：
      //   1. D1 每天只能寫 100K 列，一張照片約 5 列，一次灌完會直接撞額度
      //   2. Workers 單次呼叫的 CPU 只有 10ms，照片一多必定超時
      // 呼叫端拿到 next_cursor 就再打一次，拿到 done: true 才算完成。
      if (method === "POST" && pathname === "/api/admin/rebuild-fts") {
        const cursor = Number(url.searchParams.get("cursor") ?? 0) || 0;
        const limit = Math.min(Number(url.searchParams.get("limit") ?? 100) || 100, 200);

        const { results: photos } = await env.DB.prepare(
          `SELECT id FROM Photo WHERE id > ? ORDER BY id LIMIT ?`
        ).bind(cursor, limit).all();

        if (photos.length === 0) {
          return new Response(JSON.stringify({ processed: 0, done: true }), { headers });
        }

        await syncFtsForPhotos(env.DB, (photos as any[]).map((p) => Number(p.id)));

        const nextCursor = Number((photos as any[])[photos.length - 1].id);
        return new Response(JSON.stringify({
          processed: photos.length,
          next_cursor: nextCursor,
          done: photos.length < limit,
        }), { headers });
      }

      /*
       * 路由：重新排序相簿。
       *
       * 這一支要 can_manage_others：首頁的排列是**整個站共用的一份**，
       * 送上來的清單一定會蓋到別人的相簿。只挑自己的來更新會排出一個
       * 跟畫面上不一樣的順序，比擋下來更難懂。
       */
      if (method === "PUT" && pathname === "/api/albums/reorder") {
        if (!me.canManageOthers) return forbidden(headers, "相簿的排列順序是整站共用的，只有可以管理別人內容的帳號能調整");
        const body: { id: number; sort_order: number }[] = await request.json();
        const statements = body.map(item => env.DB.prepare("UPDATE Album SET sort_order = ? WHERE id = ?").bind(item.sort_order, item.id));
        if (statements.length > 0) await env.DB.batch(statements);
        return new Response(JSON.stringify({ success: true }), { headers });
      }

      // 路由：重新排序照片。相簿裡面的順序是相簿主人的事，逐張驗
      if (method === "PUT" && pathname === "/api/photos/reorder") {
        const body: { id: number; sort_order: number }[] = await request.json();
        if (!(await canTouchPhotos(body.map((i) => i.id)))) return forbidden(headers);
        const statements = body.map(item => env.DB.prepare("UPDATE Photo SET sort_order = ? WHERE id = ?").bind(item.sort_order, item.id));
        if (statements.length > 0) await env.DB.batch(statements);
        return new Response(JSON.stringify({ success: true }), { headers });
      }

      /*
       * 路由：新增相簿。
       *
       * user_id 從此是**登入的那個人**，不再一律寫死 1（那個 'Admin' 佔位帳號
       * 已經在 migrations/0008 改寫成站長本人）。這一欄就是後面所有
       * 「這是不是我的相簿」判斷的依據。
       */
      if (method === "POST" && pathname === "/api/albums") {
        const body: any = await request.json();
        if (!body.name) return new Response(JSON.stringify({ error: "Name is required" }), { status: 400, headers });
        // uid 為 null 只可能是「空資料庫 + 密碼登入」，退回站長那一列的 1
        const ownerId = me.uid ?? 1;
        await env.DB.prepare(
          "INSERT OR IGNORE INTO User (id, name, email, role, can_manage_others, active) VALUES (1, '站長', 'owner@didadida.local', 'owner', 1, 1)"
        ).run();
        const { success } = await env.DB.prepare("INSERT INTO Album (name, description, user_id) VALUES (?, ?, ?)")
          .bind(body.name, body.description || null, ownerId).run();
        return new Response(JSON.stringify({ success: success }), { headers });
      }

      // 路由：更新相簿設定 (封面照、封面文字等)
      if (method === "PUT" && pathname.startsWith("/api/albums/") && pathname.split("/").length === 4) {
        const albumId = pathname.split("/")[3];
        if (!(await canTouchAlbum(albumId))) return forbidden(headers);
        const body: any = await request.json();

        // Build the update query dynamically based on provided fields
        const updates: string[] = [];
        const values: any[] = [];
        
        if (body.name !== undefined) { updates.push("name = ?"); values.push(body.name); }
        if (body.cover_photo_url !== undefined) { updates.push("cover_photo_url = ?"); values.push(body.cover_photo_url); }
        if (body.cover_text !== undefined) { updates.push("cover_text = ?"); values.push(body.cover_text); }
        
        if (updates.length > 0) {
          const query = `UPDATE Album SET ${updates.join(", ")} WHERE id = ?`;
          values.push(albumId);
          await env.DB.prepare(query).bind(...values).run();
        }

        /*
         * 改了名字就順手把 Drive 上的資料夾也改掉，讓備份看起來跟站上一致。
         *
         * 丟給 waitUntil，**不擋回應也不管失敗**：資料夾 id 存在 D1，名字只是給人看的。
         * Drive 掛掉、SA 沒設、權限出問題 —— 任何一種都不該讓「相簿改名」這件事失敗。
         */
        if (body.name !== undefined && env.GOOGLE_DRIVE_SA_KEY) {
          const album = await env.DB.prepare(
            "SELECT drive_folder_id FROM Album WHERE id = ?"
          ).bind(albumId).first<any>();
          if (album?.drive_folder_id) {
            ctx.waitUntil(
              renameDriveFolder(env.GOOGLE_DRIVE_SA_KEY, album.drive_folder_id, String(body.name))
                .catch((e) => console.error("Drive 資料夾改名失敗（不影響相簿）", e))
            );
          }
        }

        return new Response(JSON.stringify({ success: true }), { headers });
      }

      /*
       * 路由：登記這本相簿在 Drive 上的資料夾 id。
       *
       * 資料夾是瀏覽器端建的（service account 沒配額建不了檔），建完回報這裡存下來。
       * **COALESCE 保護既有值**：兩個分頁同時第一次上傳有可能各建一個資料夾，
       * 先到的那個算數，後到的被忽略 —— 代價是 Drive 上多一個空資料夾，
       * 比起「照片散在兩個資料夾」好得多。回傳實際生效的 id 讓呼叫端拿去用。
       *
       * `rebind: true` 是唯一能蓋掉既有值的路，給的是一種真的會發生的死局：
       * 記著的資料夾是**另一個 Google 帳號**建的（多帳號各自寫入的舊做法留下來的），
       * 現在唯一的寫入身分看不見它，往後每一張都會 404。前端只在探路確定 404
       * 時才帶這個旗標。舊資料夾裡的檔案不受影響 —— 燈箱走 service account，
       * 它在根目錄就有權限，讀得到兩邊。
       */
      if (method === "POST" && pathname.startsWith("/api/albums/")
          && pathname.endsWith("/drive-folder") && pathname.split("/").length === 5) {
        const albumId = pathname.split("/")[3];
        if (!(await canTouchAlbum(albumId))) return forbidden(headers);
        const body: any = await request.json();
        const folderId = typeof body?.folder_id === "string" ? body.folder_id : null;
        if (!folderId) {
          return new Response(JSON.stringify({ error: "folder_id is required" }), { status: 400, headers });
        }

        await env.DB.prepare(
          body?.rebind === true
            ? "UPDATE Album SET drive_folder_id = ? WHERE id = ?"
            : "UPDATE Album SET drive_folder_id = COALESCE(drive_folder_id, ?) WHERE id = ?"
        ).bind(folderId, albumId).run();

        const album = await env.DB.prepare(
          "SELECT drive_folder_id FROM Album WHERE id = ?"
        ).bind(albumId).first<any>();
        if (!album) {
          return new Response(JSON.stringify({ error: "Album not found" }), { status: 404, headers });
        }

        return new Response(JSON.stringify({
          folder_id: album.drive_folder_id,
          // 使用者建的那個沒被採用 —— 呼叫端該改用回傳的這個，別再往自己建的那個丟檔
          kept_existing: album.drive_folder_id !== folderId,
        }), { headers });
      }

      // 路由：刪除相簿 (連同底下的照片)
      if (method === "DELETE" && pathname.startsWith("/api/albums/") && pathname.split("/").length === 4) {
        const albumId = pathname.split("/")[3];
        if (!(await canTouchAlbum(albumId))) return forbidden(headers);

        // 0. 這本相簿在 Drive 上的資料夾。整本刪掉時搬的是**資料夾**而不是裡面每一個檔
        const albumRow = await env.DB.prepare(
          "SELECT drive_folder_id FROM Album WHERE id = ?"
        ).bind(albumId).first<any>();
        const albumFolderId = typeof albumRow?.drive_folder_id === "string" && albumRow.drive_folder_id
          ? albumRow.drive_folder_id : null;

        // 1. 抓出這本相簿所有的照片
        //    縮圖的網址也要撈：只刪 file_name 會把兩張縮圖永遠留在 R2 佔額度
        //    drive id 也要撈：Photo 列一刪就再也查不到該搬哪些 Drive 檔
        const { results: photos } = await env.DB.prepare(
          "SELECT id, file_name, thumb_url, thumb_sm_url, drive_file_id, drive_original_id FROM Photo WHERE album_id = ?"
        ).bind(albumId).all();

        if (photos.length > 0) {
          // 2. 從 R2 刪除實體檔案（主檔 + 800px + 400px）
          //    R2 的 delete 一次最多吃 1000 個鍵，一本相簿可能上千張，得分批
          const keys = photos.flatMap((p) => r2KeysForPhoto(p));
          for (let i = 0; i < keys.length; i += 1000) {
            await env.BUCKET.delete(keys.slice(i, i + 1000));
          }

          // 4. 刪除所有這些照片的 Tag 關聯
          await env.DB.prepare(`DELETE FROM PhotoTag WHERE photo_id IN (SELECT id FROM Photo WHERE album_id = ?)`).bind(albumId).run();
        }

        /*
         * 3. Drive 的清理。**整本相簿刪掉時搬的是資料夾本身**，不是裡面的每一個檔。
         *
         * 逐檔搬有兩個問題：一千張照片＝兩千個檔＝四千次 Drive 往返（每個檔要
         * 讀 parents + PATCH），而且搬完 trash/ 底下會攤平成兩千個散檔 ——
         * 備份有一半的價值來自「出事那天人打得開、看得懂」，攤平就沒了。
         * 搬資料夾則永遠是一列、兩次往返，而且 trash/ 裡看到的就是原本那本相簿。
         *
         * 沒有資料夾 id 的（分資料夾之前上傳的舊照片）才退回逐檔登記。
         * 兩條路都不呼叫 files.delete —— 見 queueDriveTrash 的說明。
         */
        if (albumFolderId) {
          await env.DB.prepare(
            "INSERT INTO DriveTrash (drive_id, photo_id) VALUES (?, NULL)"
          ).bind(albumFolderId).run();
        } else if (photos.length > 0) {
          await queueDriveTrash(env, photos);
        }
        if (albumFolderId || photos.length > 0) {
          // 開頭幾個當場搬掉，剩下的交給 cron —— 逐檔那條路不可能一次搬完
          ctx.waitUntil(drainDriveTrash(env, 10).catch((e) => console.error("Drive 待搬佇列", e)));
        }


        // 5. 刪除這些照片紀錄
        await env.DB.prepare("DELETE FROM Photo WHERE album_id = ?").bind(albumId).run();

        // 6. 刪除相簿本身
        await env.DB.prepare("DELETE FROM Album WHERE id = ?").bind(albumId).run();

        // 7. PhotoFts 是虛擬表，沒有 FK，不會跟著 Photo 一起被刪掉
        await deleteFtsForPhotos(env.DB, photos.map((p: any) => Number(p.id)));

        return new Response(JSON.stringify({ success: true }), { headers });
      }

/*
 * 輔助函式：從 `/api/photos/view/<key>` 這種對外網址反推 R2 的物件鍵。
 *
 * 刪除縮圖時不能用「thumb_ + file_name」去猜。縮圖的副檔名跟著實際編碼格式走
 * （舊照片是 .jpg，Phase 2 之後是 .webp，不支援 WebP 的瀏覽器又會退回 .jpg），
 * 猜錯就是安靜地刪不到 —— 物件會永遠留在 R2 裡佔免費額度，而且完全沒有錯誤訊息。
 * thumb_url / thumb_sm_url 存的就是權威答案，直接從那裡拆。
 */
function r2KeyFromViewUrl(viewUrl: unknown): string | null {
  if (typeof viewUrl !== "string") return null;
  const marker = "/api/photos/view/";
  const at = viewUrl.indexOf(marker);
  if (at < 0) return null;
  const raw = viewUrl.slice(at + marker.length).split(/[?#]/)[0];
  if (!raw) return null;
  try {
    return decodeURIComponent(raw);
  } catch {
    // 不是合法的 percent-encoding 就當作沒編碼過，總比直接放棄好
    return raw;
  }
}

/** 一張照片在 R2 佔用的所有物件鍵（主檔 + 兩種縮圖），已去重且濾掉空值 */
function r2KeysForPhoto(photo: any): string[] {
  const keys = [
    typeof photo?.file_name === "string" ? photo.file_name : null,
    r2KeyFromViewUrl(photo?.thumb_url),
    r2KeyFromViewUrl(photo?.thumb_sm_url),
  ].filter((k): k is string => !!k);
  return [...new Set(keys)];
}

/**
 * 縮圖的副檔名要跟著實際的 content type 走，不能寫死 .jpg。
 * 舊版寫死副檔名不痛不癢是因為當時只有 JPEG 一種；現在混著 WebP，
 * 副檔名對不上會讓上面那個反推規則以外的任何猜測都失效。
 */
function thumbExtFor(contentType: string): string {
  if (contentType === "image/webp") return "webp";
  if (contentType === "image/png") return "png";
  return "jpg";
}

/**
 * 刪照片時，把它在 Drive 上的 4K 與原始檔登記到待搬佇列。
 *
 * **不在這裡真的搬。** 搬一個檔要兩次 Drive 往返，而 Workers 一次請求的
 * subrequest 有上限（免費版 50）—— 刪一本上千張的相簿當場搬不完。這裡只寫
 * D1（幾列，很便宜），實際搬移交給 /api/admin/drain-drive-trash 分批做。
 *
 * 順序很重要：**一定要在刪 Photo 列之前呼叫**。Photo 列一刪，那兩個 drive id
 * 就沒有任何地方記得了。
 *
 * **刻意不呼叫 files.delete。** R2 那邊刪掉就真的沒了，Drive 這份是最後一道
 * 後悔藥；要真的清空是使用者自己去 Drive 倒垃圾桶，不是由這支程式決定。
 */
async function queueDriveTrash(env: Env, photos: any[]): Promise<void> {
  const rows = photos.flatMap((p) => [
    { driveId: p?.drive_file_id, photoId: p?.id },
    { driveId: p?.drive_original_id, photoId: p?.id },
  ]).filter((r) => typeof r.driveId === "string" && r.driveId.length > 0);
  if (rows.length === 0) return;

  const stmt = env.DB.prepare("INSERT INTO DriveTrash (drive_id, photo_id) VALUES (?, ?)");
  // 每個 statement 各自綁 2 個參數，不會撞到單一 statement 的 100 個上限，
  // 但一次 batch 塞幾千個 statement 一樣會被 D1 擋，還是切一下
  for (let i = 0; i < rows.length; i += 100) {
    await env.DB.batch(rows.slice(i, i + 100).map((r) => stmt.bind(r.driveId, r.photoId ?? null)));
  }
}

// 輔助函式：計算 ArrayBuffer 的 SHA-256 Hex 雜湊
async function calculateFileHash(buffer: ArrayBuffer): Promise<string> {
  const hashBuffer = await crypto.subtle.digest("SHA-256", buffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

// 輔助函式：計算 Hamming Distance 漢明距離 (用於比對 pHash)
function hammingDistance(hex1: string, hex2: string): number {
  if (!hex1 || !hex2 || hex1.length !== hex2.length) return 999;
  let dist = 0;
  for (let i = 0; i < hex1.length; i++) {
    const val = parseInt(hex1[i], 16) ^ parseInt(hex2[i], 16);
    dist += (val & 1) + ((val >> 1) & 1) + ((val >> 2) & 1) + ((val >> 3) & 1);
  }
  return dist;
}

      // 路由：處理 R2 照片上傳
      if (method === "POST" && pathname === "/api/upload") {
        const formData = await request.formData();
        // 走 unknown：這個專案同時吃 workers-types 與 @types/node，FormData.get 的
        // 回傳型別會解析到不含 File 的那一份，直接 as File 會被 TS 擋下來。
        // 實際 runtime 是 Workers，取到的就是 File；下面仍有 !file 的檢查。
        const file = formData.get('file') as unknown as File | null;
        // thumb = 800px（相簿格線）、thumb_sm = 400px（首頁卡片與地圖標記）。
        // 舊版前端只送 thumb，這裡兩個都允許缺席，缺的欄位留 NULL 讓讀取端 COALESCE 退回去。
        const thumb = formData.get('thumb') as unknown as File | null;
        const thumbSm = formData.get('thumb_sm') as unknown as File | null;
        const albumId = formData.get('album_id') as string;
        const exifData = formData.get('exif') as string || null;
        const takenAt = formData.get('taken_at') as string || null;
        const clientPhash = formData.get('phash') as string || null;
        // 使用者在重複清單裡按了「照樣上傳」才會帶這個旗標
        const allowDuplicate = formData.get('allow_duplicate') === '1';

        if (!file || !albumId) {
          return new Response(JSON.stringify({ error: "File and album_id are required" }), { status: 400, headers });
        }
        // 往別人的相簿裡塞照片也是「動別人的相簿」
        if (!(await canTouchAlbum(albumId))) return forbidden(headers, "沒有權限上傳到別人的相簿");

        const allowedTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic'];
        if (!allowedTypes.includes(file.type.toLowerCase())) {
          return new Response(JSON.stringify({ error: "Invalid file type. Only images are allowed." }), { status: 400, headers });
        }

        const buffer = await file.arrayBuffer();
        const fileHash = await calculateFileHash(buffer);

        // 由 EXIF 推導座標與時區。前端送來的 exif 已把時間欄位保留為原始字串，
        // 這裡才能還原出未經時區位移的牆上時間。
        let parsedForGeo: any = null;
        try {
          parsedForGeo = exifData ? JSON.parse(exifData) : null;
        } catch (e) {
          console.warn("上傳的 exif 不是合法 JSON，略過地理正規化:", e);
        }
        const geo = normalizeGeo(parsedForGeo, takenAt);

        // geo 沒算出時間就退回前端送來的 takenAt，那是檔案時間而非快門時間
        const uploadTakenAt = geo.takenAtUtc || takenAt || null;
        const uploadTimeSource =
          geo.timeSource ?? (uploadTakenAt ? 'file_time' : null);

        /*
         * 重複偵測。**一定要排在 R2.put 前面** —— 判定重複之後才發現檔案已經寫進去，
         * 等於白佔一份免費額度，還得回頭刪（[[free-tier-is-top-priority]]）。
         *
         * 兩個依據，範圍限同一本相簿：
         * 1. `file_hash`：同一台電腦重傳同一個檔，前端縮圖的位元組一模一樣，抓得準。
         * 2. `taken_at`：縮圖參數一改、或換個瀏覽器，hash 就對不上了，但 EXIF 的
         *    快門時間不受縮圖影響。代價是連拍可能同秒 —— 所以是「問使用者」而不是
         *    「直接擋」，誤判的成本只有多按一下。
         *
         * 不比 pHash：本機上傳這條路從來沒送過 phash，欄位是 NULL，比了也是白比。
         */
        if (!allowDuplicate) {
          /*
           * 舊資料裡有一批 `taken_at` 存成字串 "null"（不是 SQL NULL），
           * 是早期某條路把 JS 的 null 直接塞進去留下的。萬一新上傳也算出這種值，
           * 「時間相同」會一口氣命中那一整批，看起來像每張都重複。當沒有時間處理。
           */
          const dupTakenAt = uploadTakenAt && uploadTakenAt !== 'null' ? uploadTakenAt : null;
          const { results: dupes } = await env.DB.prepare(
            `SELECT id, title, thumb_sm_url, thumb_url, url, taken_at, file_hash
               FROM Photo
              WHERE album_id = ?
                AND (file_hash = ? OR (? IS NOT NULL AND taken_at = ?))
              LIMIT 5`
          ).bind(albumId, fileHash, dupTakenAt, dupTakenAt).all<any>();

          if (dupes.length > 0) {
            return new Response(JSON.stringify({
              duplicate: true,
              // 讓前端講得出「哪裡像」：hash 一樣是同一個檔，只有時間一樣就是疑似
              reason: dupes.some((d: any) => d.file_hash === fileHash) ? 'same_file' : 'same_time',
              existing: dupes.map((d: any) => ({
                id: d.id,
                title: d.title,
                thumb_url: d.thumb_sm_url || d.thumb_url || d.url,
                taken_at: d.taken_at,
              })),
            }), { headers });
          }
        }

        const fileName = `${Date.now()}_${file.name.replace(/[^a-zA-Z0-9.-]/g, '_')}`;
        await env.BUCKET.put(fileName, buffer, {
          httpMetadata: { contentType: file.type }
        });
        
        const host = new URL(request.url).origin;

        /*
         * 兩個尺寸的縮圖各存一顆 R2 物件。
         *
         * 舊版只有一張 400px、而且是 `'image/jpeg', 1.0` 編碼的 —— q1.0 幾乎不壓縮，
         * 實測平均 118 KB，光縮圖在 15 萬張時就要 18 GB，本身就會撐爆 10 GB 免費額度。
         * 現在前端送 400px + 800px 的 WebP q80（10.9 + 41.3 KB），兩張加起來還不到舊版一張的一半。
         *
         * 物件鍵的副檔名跟著實際 content type 走：前端在不支援 WebP 編碼的瀏覽器上
         * 會退回 JPEG，寫死副檔名會讓 R2 上的鍵與內容不一致。
         */
        const baseName = fileName.replace(/\.[^/.]+$/, '');
        const putThumb = async (blob: File | null, prefix: string): Promise<string | null> => {
          if (!blob) return null;
          const contentType = blob.type || 'image/jpeg';
          const key = `${prefix}_${baseName}.${thumbExtFor(contentType)}`;
          await env.BUCKET.put(key, blob.stream(), { httpMetadata: { contentType } });
          return `${host}/api/photos/view/${encodeURIComponent(key)}`;
        };
        // 兩顆物件互不相干，併發送出省掉一趟 R2 往返
        const [thumbUrl, thumbSmUrl] = await Promise.all([
          putThumb(thumb, 'thumb'),
          putThumb(thumbSm, 'thumbsm'),
        ]);

        const fileUrl = `${host}/api/photos/view/${encodeURIComponent(fileName)}`;

        const inserted = await env.DB.prepare(
          // shuffle_key 由 SQL 直接產生：ALTER TABLE 不接受非常數的 DEFAULT，
          // 而漏填的照片 shuffle_key 是 NULL，會被 /api/albums 的預覽查詢整個跳過。
          // random() & 0x7FFFFFFF 保證落在 JS 安全整數內，後端才算得出同樣的種子。
          `INSERT INTO Photo
             (title, file_name, album_id, url, thumb_url, thumb_sm_url, exif, taken_at, file_hash, phash,
              lat, lng, geo_source, taken_at_local, tz_offset_minutes, time_source, uploaded_by, shuffle_key)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, (random() & 2147483647))`
        ).bind(
          file.name, fileName, albumId, fileUrl, thumbUrl, thumbSmUrl, exifData,
          uploadTakenAt, fileHash, clientPhash,
          geo.lat, geo.lng, geo.geoSource, geo.takenAtLocal, geo.tzOffsetMinutes,
          uploadTimeSource, me.uid,
        ).run();

        const newPhotoId = Number(inserted.meta?.last_row_id ?? 0);
        if (newPhotoId) await syncFtsForPhotos(env.DB, [newPhotoId]);

        // 回傳 id 與座標，前端才有辦法在上傳結束後認出「這一批」是哪幾張、
        // 以及其中哪幾張沒有 EXIF 位置需要補。
        return new Response(JSON.stringify({
          success: true,
          id: inserted.meta?.last_row_id ?? null,
          url: fileUrl,
          thumb_url: thumbUrl,
          thumb_sm_url: thumbSmUrl,
          file_hash: fileHash,
          lat: geo.lat,
          lng: geo.lng,
        }), { headers });
      }

      // 路由：更新照片資訊 (description, taken_at)
      if (method === "PUT" && pathname.startsWith("/api/photos/") && pathname.split("/").length === 4) {
        const photoId = pathname.split("/")[3];
        if (!(await canTouchPhoto(photoId))) return forbidden(headers);
        const body: any = await request.json();
        // body.taken_at 是 UTC 瞬間。改了它就必須同步重算 taken_at_local，
        // 否則兩欄會各說各話（顯示與行程段比對用 local、排序與軌跡比對用 taken_at）。
        // 這裡把瞬間視為權威、時區不變，用 tz 把 local 推回來。
        await env.DB.prepare(
          `UPDATE Photo SET
             description = ?,
             taken_at = ?,
             taken_at_local = strftime('%Y-%m-%d %H:%M:%S', ?,
               COALESCE(tz_offset_minutes, ${DEFAULT_TZ_OFFSET_MINUTES}) || ' minutes'),
             time_source = CASE WHEN ? IS NULL THEN NULL ELSE 'manual' END
           WHERE id = ?`
        ).bind(
          body.description || null,
          body.taken_at || null, body.taken_at || null, body.taken_at || null,
          photoId,
        ).run();
        await syncFtsForPhotos(env.DB, [Number(photoId)]);
        return new Response(JSON.stringify({ success: true }), { headers });
      }

      // 路由：刪除照片
      if (method === "DELETE" && pathname.startsWith("/api/photos/") && pathname.split("/").length === 4) {
        const photoId = pathname.split("/")[3];
        if (!(await canTouchPhoto(photoId))) return forbidden(headers);
        const photo = await env.DB.prepare(
          "SELECT id, file_name, url, thumb_url, thumb_sm_url, drive_file_id, drive_original_id FROM Photo WHERE id = ?"
        ).bind(photoId).first();
        if (!photo) return new Response(JSON.stringify({ error: "Photo not found" }), { status: 404, headers });

        // 主檔 + 兩張縮圖一起刪，只刪 file_name 會留下孤兒縮圖佔 R2 額度
        await env.BUCKET.delete(r2KeysForPhoto(photo));
        // Drive 的兩個檔登記待搬。務必在 DELETE FROM Photo 之前
        await queueDriveTrash(env, [photo]);
        // 單張刪除就當場搬進 trash/ —— 回應照樣先送出去，搬移在背景做
        ctx.waitUntil(drainDriveTrash(env, 10).catch((e) => console.error("Drive 待搬佇列", e)));
        await env.DB.prepare("DELETE FROM PhotoTag WHERE photo_id = ?").bind(photoId).run();
        // 如果該照片是某個相簿的封面，則清除該相簿的封面
        await env.DB.prepare("UPDATE Album SET cover_photo_url = NULL WHERE cover_photo_url = ?").bind(photo.url).run();
        await env.DB.prepare("DELETE FROM Photo WHERE id = ?").bind(photoId).run();
        await deleteFtsForPhotos(env.DB, [Number(photoId)]);
        return new Response(JSON.stringify({ success: true }), { headers });
      }

      /*
       * 路由：登記 Drive 檔案 id。
       *
       * 檔案是瀏覽器用**使用者本人的 Google 帳號**建的（service account 沒有儲存
       * 配額，建不了檔），5 MB 的原始檔也因此不必灌過 Worker。建完之後只把兩個
       * id 回報到這裡，D1 才知道燈箱該去哪裡拿大圖。
       *
       * 兩個 id 都是選填：4K 傳成功、原始檔失敗（或反過來）也要收，能記多少算多少。
       * 已經有值的那一欄不會被 NULL 蓋掉 —— 補傳重跑時不該把上次的成果洗掉。
       */
      if (method === "POST" && pathname.startsWith("/api/photos/")
          && pathname.endsWith("/drive") && pathname.split("/").length === 5) {
        const photoId = pathname.split("/")[3];
        if (!(await canTouchPhoto(photoId))) return forbidden(headers);
        const body = await request.json().catch(() => ({})) as {
          drive_file_id?: unknown; drive_original_id?: unknown;
        };
        const fileId = typeof body.drive_file_id === "string" && body.drive_file_id ? body.drive_file_id : null;
        const originalId = typeof body.drive_original_id === "string" && body.drive_original_id ? body.drive_original_id : null;

        if (!fileId && !originalId) {
          return new Response(JSON.stringify({ error: "drive_file_id 與 drive_original_id 至少要給一個" }), { status: 400, headers });
        }

        const res = await env.DB.prepare(`
          UPDATE Photo
             SET drive_file_id     = COALESCE(?, drive_file_id),
                 drive_original_id = COALESCE(?, drive_original_id)
           WHERE id = ?
        `).bind(fileId, originalId, photoId).run();

        if ((res.meta?.changes ?? 0) === 0) {
          return new Response(JSON.stringify({ error: "Photo not found" }), { status: 404, headers });
        }
        return new Response(JSON.stringify({ success: true }), { headers });
      }

      // 路由：新增照片標籤
      if (method === "POST" && pathname.startsWith("/api/photos/") && pathname.endsWith("/tags")) {
        const photoId = pathname.split("/")[3];
        if (!(await canTouchPhoto(photoId))) return forbidden(headers);
        const { tagName } = await request.json() as { tagName: string };
        if (!tagName) return new Response(JSON.stringify({ error: "Tag name required" }), { status: 400, headers });
        
        await env.DB.prepare("INSERT OR IGNORE INTO Tag (name) VALUES (?)").bind(tagName).run();
        const tag = await env.DB.prepare("SELECT id FROM Tag WHERE name = ?").bind(tagName).first();
        if (tag) {
          await env.DB.prepare("INSERT OR IGNORE INTO PhotoTag (photo_id, tag_id) VALUES (?, ?)").bind(photoId, tag.id).run();
          await syncFtsForPhotos(env.DB, [Number(photoId)]);
        }
        return new Response(JSON.stringify({ success: true, tag: { id: tag?.id, name: tagName } }), { headers });
      }

      // 路由：刪除照片標籤
      if (method === "DELETE" && pathname.startsWith("/api/photos/") && pathname.includes("/tags/")) {
        const parts = pathname.split("/");
        const photoId = parts[3];
        const tagId = parts[5];
        if (!(await canTouchPhoto(photoId))) return forbidden(headers);
        await env.DB.prepare("DELETE FROM PhotoTag WHERE photo_id = ? AND tag_id = ?").bind(photoId, tagId).run();
        // 清理完全沒有任何照片使用的孤立標籤
        await env.DB.prepare("DELETE FROM Tag WHERE id NOT IN (SELECT DISTINCT tag_id FROM PhotoTag)").run();
        await syncFtsForPhotos(env.DB, [Number(photoId)]);
        return new Response(JSON.stringify({ success: true }), { headers });
      }

      /*
       * 路由：Google OAuth 登入跳轉。**這是管理員登入的正門，不只是相簿匯入。**
       *
       * 一次要齊三樣權限：`openid email`（認人）、`drive.file`（照片備份）、
       * `photospicker`（相簿匯入）。合成一次的理由是 token 只有一個，
       * 不會兩邊搶同一個 localStorage 鍵互相蓋掉。
       *
       * **走整頁跳轉而不是 GIS 彈窗**，這是刻意的：彈窗要「短暫啟用狀態」才開得起來，
       * 而拿到的 token 只能放在記憶體，重整就沒了 —— 那正是「每次第一批照片都沒有
       * Drive 備份」的來源。跳轉沒有這兩個問題。當初避開跳轉是怕把選好的檔案清單
       * 弄丟，但授權移到登入這一刻就完全不衝突了。
       *
       * 沒有 access_type=offline：refresh token 我們不存（使用者選擇「過期就重新
       * 登入」），跟 Google 要一個轉頭就丟掉的長期憑證沒有意義。
       */
      if (method === "GET" && pathname === "/api/auth/google/login") {
        const urlObj = new URL(request.url);
        const albumId = urlObj.searchParams.get("state") || "";
        /*
         * 導回哪裡由 Referer／Origin 提示，但**一定要過 ALLOWED_ORIGINS 這關**。
         * 回程網址的 fragment 裡有管理員 JWT，照單全收等於誰都能把你騙去登入、
         * 再把 token 收進自己的網站。認不得的來源就留空，讓下面走預設值。
         */
        const referer = request.headers.get("referer") || request.headers.get("origin");
        let redirectHost = "";
        if (referer) {
          try {
            const candidate = new URL(referer).origin;
            if (ALLOWED_ORIGINS.includes(candidate)) redirectHost = candidate;
          } catch (e) {}
        }
        /*
         * `mode=drive_writer`：這一次登入的目的是**把這個帳號設成 Drive 的寫入身分**，
         * 所以要 `access_type=offline` + `prompt=consent` 才拿得到 refresh token
         * （Google 只在明確同意那一次給，之後同一個帳號再登入都不會再給）。
         * 平常登入不帶這個參數，行為完全不變。
         */
        const mode = urlObj.searchParams.get("mode") === "drive_writer" ? "drive_writer" : "";
        const combinedState = encodeURIComponent(JSON.stringify({ albumId, redirectHost, mode }));
        const clientId = env.GOOGLE_CLIENT_ID || "";
        const redirectUri = new URL(request.url).origin + "/api/auth/google/callback";
        const scope = [
          "openid",
          "email",
          "https://www.googleapis.com/auth/drive.file",
          "https://www.googleapis.com/auth/photospicker.mediaitems.readonly",
        ].join(" ");

        // prompt 吃空白分隔的清單：consent 是為了拿 refresh token，
        // select_account 是為了讓人挑「要當備份倉庫的是哪個帳號」而不是預設當下那個
        const extra = mode === "drive_writer"
          ? "&access_type=offline&prompt=" + encodeURIComponent("consent select_account") + "&include_granted_scopes=true"
          : "&prompt=select_account";
        const url = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=${encodeURIComponent(scope)}${extra}&state=${combinedState}`;
        return Response.redirect(url, 302);
      }

      // 路由：Google OAuth 回呼
      if (method === "GET" && pathname === "/api/auth/google/callback") {
        const urlObj = new URL(request.url);
        const code = urlObj.searchParams.get("code");
        const rawState = urlObj.searchParams.get("state") || "";
        let albumId = rawState;
        let redirectHost = "";
        let mode = "";
        try {
          const parsed = JSON.parse(decodeURIComponent(rawState));
          if (parsed && typeof parsed === "object") {
            albumId = parsed.albumId || "";
            mode = parsed.mode === "drive_writer" ? "drive_writer" : "";
            /*
             * state 是我們自己包的，但它繞過 Google 才回來，**中間誰都能換掉** ——
             * 拿我們的 client_id 自己組一個授權網址、把 redirectHost 寫成自家網站，
             * 騙人點下去就收得到回程 fragment 裡的管理員 JWT。所以這裡要再驗一次。
             */
            const candidate = String(parsed.redirectHost || "");
            if (ALLOWED_ORIGINS.includes(candidate)) redirectHost = candidate;
          }
        } catch (e) {}

        if (!code) return new Response("Missing code", { status: 400 });

        // 優先使用傳過來的 redirectHost。往上提到換 token 之前，失敗時也才有地方可回
        let baseFrontEndUrl = redirectHost || "https://didadida-frontend.pages.dev";
        if (!redirectHost && (urlObj.hostname.includes("localhost") || urlObj.hostname.includes("127.0.0.1"))) {
          baseFrontEndUrl = "http://localhost:3000";
        }
        const target = albumId ? `${baseFrontEndUrl}/album?id=${albumId}` : `${baseFrontEndUrl}/`;

        const clientId = env.GOOGLE_CLIENT_ID || "";
        const clientSecret = env.GOOGLE_CLIENT_SECRET || "";
        const redirectUri = new URL(request.url).origin + "/api/auth/google/callback";

        const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            code,
            client_id: clientId,
            client_secret: clientSecret,
            redirect_uri: redirectUri,
            grant_type: "authorization_code",
          }),
        });

        const tokenData: any = await tokenRes.json();

        /*
         * 換不到 token。**這裡以前直接把 Google 的原始回應和 client_id 印成 HTML
         * 給對方看** —— 那是開發期的除錯殘留。OAuth app 已經是發布狀態，這條回呼
         * 網址誰都打得到（隨便帶個 code 就進得來），等於把後端設定攤給匿名訪客。
         * 現在只回一個代碼，細節留給 Worker 的記錄檔。
         */
        if (!tokenData.access_token) {
          console.error("google token exchange failed", tokenData?.error, tokenData?.error_description);
          return Response.redirect(`${target}#authError=${encodeURIComponent("token_exchange_failed")}`, 302);
        }

        /*
         * 這條路現在同時是「管理員登入」，所以要驗身分再發自己的 JWT。
         * 不是管理員就只回錯誤代碼，連 Google token 都不給 —— 沒有用途，
         * 給了只是多一份會外流的東西。前端看到 authError 會改提供密碼登入。
         */
        const admitted = await googleAdminCheck(env, tokenData.access_token);
        if (!admitted.ok) {
          return Response.redirect(`${target}#authError=${encodeURIComponent(admitted.reason)}`, 302);
        }

        /*
         * token 放在 fragment（`#`）不是 query（`?`）。
         *
         * fragment 不會送到任何伺服器 —— 不進 Worker 的存取記錄、不進 Referer 標頭、
         * 也不會被 CDN 記下來。query 那份原本會跟著這些地方一起外流。
         * 前端讀完會馬上把它從網址列擦掉，免得留在瀏覽器歷史裡。
         */
        const frag = new URLSearchParams({
          token: await generateJWT(env, 'admin', admitted.user),
          googleToken: tokenData.access_token,
          googleExpiresIn: String(Number(tokenData.expires_in) || 3600),
        });

        /*
         * 這一次是來設定 Drive 寫入身分的：把 refresh token 收起來。
         *
         * 只在 `mode=drive_writer` 時存，平常登入一律不存 —— 存一份長期憑證是有
         * 代價的東西，不該因為某次登入剛好帶回來就默默留下。
         * 拿不到 refresh_token 幾乎都是同一個原因：這個帳號先前已經同意過，
         * Google 就不再給第二張。訊息要講清楚該去哪裡移除授權再來一次。
         */
        if (mode === "drive_writer") {
          if (typeof tokenData.refresh_token === "string" && tokenData.refresh_token) {
            await setSetting(env, SETTING_DRIVE_REFRESH_TOKEN, tokenData.refresh_token);
            await setSetting(env, SETTING_DRIVE_WRITER_EMAIL, admitted.user.email);
            await setSetting(env, SETTING_DRIVE_LINKED_AT, new Date().toISOString());
            frag.set("driveLinked", admitted.user.email);
          } else {
            frag.set("driveLinkError", "no_refresh_token");
          }
        }
        return Response.redirect(`${target}#${frag.toString()}`, 302);
      }

      // 路由：取得 Google 相簿列表
      if (method === "GET" && pathname === "/api/google/albums") {
        const googleToken = request.headers.get("X-Google-Token");
        
        const res1 = await fetch("https://photoslibrary.googleapis.com/v1/albums?pageSize=50&excludeNonAppCreatedData=false", {
          headers: { Authorization: `Bearer ${googleToken}` }
        });
        const data1 = await res1.json() as any;

        const res2 = await fetch("https://photoslibrary.googleapis.com/v1/sharedAlbums?pageSize=50&excludeNonAppCreatedData=false", {
          headers: { Authorization: `Bearer ${googleToken}` }
        });
        const data2 = await res2.json() as any;

        if (data1.error && data1.error.code === 401) {
          return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers });
        }

        const allAlbums = [...(data1.albums || []), ...(data2.sharedAlbums || [])];
        // 去除重複 (有些相簿可能兩邊都有)
        const uniqueAlbums = Array.from(new Map(allAlbums.map(item => [item.id, item])).values());

        return new Response(JSON.stringify({ albums: uniqueAlbums, debug: { data1, data2 } }), { headers });
      }

      // 路由：建立 Picker Session
      if (method === "POST" && pathname === "/api/google/picker/sessions") {
        const googleToken = request.headers.get("X-Google-Token");
        const res = await fetch("https://photospicker.googleapis.com/v1/sessions", {
          method: "POST",
          headers: { Authorization: `Bearer ${googleToken}`, "Content-Type": "application/json" }
        });
        const data = await res.json();
        return new Response(JSON.stringify(data), { headers });
      }

      // 路由：檢查 Picker Session 狀態並取得照片
      if (method === "GET" && pathname.startsWith("/api/google/picker/sessions/") && pathname.endsWith("/photos")) {
        const sessionId = pathname.split("/")[5];
        const googleToken = request.headers.get("X-Google-Token");
        
        // 1. 檢查狀態
        const statusRes = await fetch(`https://photospicker.googleapis.com/v1/sessions/${sessionId}`, {
          headers: { Authorization: `Bearer ${googleToken}` }
        });
        const statusData = await statusRes.json() as any;
        
        // Google Photospicker API: 當使用者點擊「完成/選擇」後，mediaItemsSet 會變為 true
        const isReady = statusData.mediaItemsSet === true || statusData.mediaItemsSet === "true";
        
        if (!isReady) {
          return new Response(JSON.stringify({ ready: false, statusData }), { headers });
        }
        
        // 2. 如果使用者選完了，就去抓照片清單
        const itemsRes = await fetch(`https://photospicker.googleapis.com/v1/mediaItems?sessionId=${sessionId}`, {
          headers: { Authorization: `Bearer ${googleToken}` }
        });
        const itemsData = await itemsRes.json() as any;
        const mediaItems = itemsData.mediaItems || [];
        
        return new Response(JSON.stringify({ ready: true, mediaItems, itemsData, statusData }), { headers });
      }

      // 路由：從 Google 相簿抓照片
      if (method === "GET" && pathname.startsWith("/api/google/albums/") && pathname.endsWith("/photos")) {
        const albumId = pathname.split("/")[4];
        const googleToken = request.headers.get("X-Google-Token");
        
        let body: any = { pageSize: 50 };
        if (albumId === "ALL_PHOTOS") {
          body = { pageSize: 1 };
        } else {
          body.albumId = albumId;
        }

        const res = await fetch("https://photoslibrary.googleapis.com/v1/mediaItems:search", {
          method: "POST",
          headers: { Authorization: `Bearer ${googleToken}`, "Content-Type": "application/json" },
          body: JSON.stringify(body)
        });
        const data = await res.json();
        return new Response(JSON.stringify(data), { headers });
      }

      // 路由：同步 Google 照片到 R2
      if (method === "POST" && pathname === "/api/google/sync-photo") {
        const body = await request.json() as any;
        const { targetAlbumId, googlePhotoUrl, filename, creationTime, exif, clientPhash } = body;
        
        const googleToken = request.headers.get("X-Google-Token");
        
        if (!googlePhotoUrl) {
          console.error("400 Bad Request - Missing googlePhotoUrl. Body received:", body);
          return new Response(JSON.stringify({ error: "Missing googlePhotoUrl" }), { status: 400, headers });
        }
        // 跟本機上傳同一條規矩：目標相簿不是我的就別下載了，早退一步省掉整趟傳輸
        if (!(await canTouchAlbum(targetAlbumId))) return forbidden(headers, "沒有權限上傳到別人的相簿");
        
        // 取得照片原始檔案 (Picker API 的 baseUrl 加上 =d 來下載原始解析度)
        let downloadUrl = googlePhotoUrl;
        if (!downloadUrl.includes("=")) {
          downloadUrl += "=d";
        }
        let fetchPhotoRes = await fetch(downloadUrl, {
          headers: {
            "Authorization": `Bearer ${googleToken}`
          }
        });

        // 如果帶 Token 失敗 (部分 Picker API baseUrl 不需要 Bearer Token)，則嘗試直接 fetch
        if (!fetchPhotoRes.ok) {
          fetchPhotoRes = await fetch(downloadUrl);
        }

        if (!fetchPhotoRes.ok) {
          const errText = await fetchPhotoRes.text();
          console.error("下載照片失敗:", fetchPhotoRes.status, errText);
          return new Response(JSON.stringify({ error: "Download failed", details: errText }), { status: 500, headers });
        }
        
        // 嘗試從 Content-Disposition 抓取 Google 給的原始檔名
        let finalTitle = filename;
        const contentDisposition = fetchPhotoRes.headers.get("Content-Disposition");
        if (contentDisposition) {
          const match = contentDisposition.match(/filename="?([^"]+)"?/);
          if (match && match[1]) {
            finalTitle = match[1];
          }
        }
        
        const baseNameMatch = finalTitle.match(/(.+?)(\.[^.]+$|$)/);
        const baseName = baseNameMatch ? baseNameMatch[1] : finalTitle;
        const ext = baseNameMatch ? baseNameMatch[2] : "";
        
        const arrayBuffer = await fetchPhotoRes.arrayBuffer();
        const fileHash = await calculateFileHash(arrayBuffer);
        
        let parsedExif = exif;
        let finalTakenAt = creationTime;
        try {
          // 在後端直接解析 EXIF
          // 不寫 ifd0：exifr 的 ifd0 本來就無法關閉（型別上也只收物件不收 boolean），
          // 開著 tiff 就一定會解析到，寫 `ifd0: true` 只是個沒有作用的型別錯誤
          const rawExif = await exifr.parse(arrayBuffer, { tiff: true, exif: true, gps: true });
          if (rawExif) {
            parsedExif = {
              Make: rawExif.Make || (exif ? exif.Make : undefined),
              Model: rawExif.Model || (exif ? exif.Model : undefined),
              FocalLength: rawExif.FocalLength || (exif ? exif.FocalLength : undefined),
              FNumber: rawExif.FNumber || (exif ? exif.FNumber : undefined),
              ISO: rawExif.ISO || (exif ? exif.ISO : undefined),
              ExposureTime: rawExif.ExposureTime || (exif ? exif.ExposureTime : undefined),
              DateTimeOriginal: rawExif.DateTimeOriginal || (exif ? exif.DateTimeOriginal : undefined),
              // GPS 用 ?? 而非 ||：赤道/本初子午線的 0 是合法座標，會被 || 誤判掉
              // 註：Google Picker 的 =d 下載一律移除位置資訊，這裡對 Google 來源預期為 undefined，
              // 保留是為了日後其他同步來源
              latitude: rawExif.latitude ?? (exif ? exif.latitude : undefined),
              longitude: rawExif.longitude ?? (exif ? exif.longitude : undefined),
              GPSAltitude: rawExif.GPSAltitude ?? (exif ? exif.GPSAltitude : undefined),
              // Google 的 =d 下載保留非位置類 EXIF，所以 OffsetTimeOriginal 通常還在，
              // 這批照片的時區反而能準確還原
              OffsetTimeOriginal: rawExif.OffsetTimeOriginal || (exif ? exif.OffsetTimeOriginal : undefined),
              GPSDateStamp: rawExif.GPSDateStamp || (exif ? exif.GPSDateStamp : undefined),
              GPSTimeStamp: rawExif.GPSTimeStamp || (exif ? exif.GPSTimeStamp : undefined)
            };
          }
        } catch (err) {
          console.error("Exif parsing error in backend", err);
        }

        // Workers 執行環境的時區固定為 UTC，exifr revive 出來的 Date 其 UTC 欄位
        // 即為原始牆上時間，normalizeGeo 內部以 UTC getter 取值，不會二次位移。
        const syncGeo = normalizeGeo(parsedExif, creationTime);
        if (syncGeo.takenAtUtc) finalTakenAt = syncGeo.takenAtUtc;

        // 多層檢測重複照片 (按優先度：1. 精確 Hash 2. EXIF 拍攝時間 3. pHash 視覺特徵 4. 檔名)
        const candidates = await env.DB.prepare(
          "SELECT * FROM Photo WHERE album_id = ?"
        ).bind(targetAlbumId).all();

        const existingPhotosMap = new Map<number, any>();

        for (const p of candidates.results as any[]) {
          // Layer 1: SHA-256 檔案完全相同
          if (p.file_hash && p.file_hash === fileHash) {
            existingPhotosMap.set(p.id, p);
          }
          // Layer 2: EXIF 拍攝時間完全一致
          else if (finalTakenAt && p.taken_at && new Date(p.taken_at).getTime() === new Date(finalTakenAt).getTime()) {
            existingPhotosMap.set(p.id, p);
          }
          // Layer 3: pHash 視覺相似 (漢明距離 <= 8 視為同一張圖)
          else if (clientPhash && p.phash && hammingDistance(clientPhash, p.phash) <= 8) {
            existingPhotosMap.set(p.id, p);
          }
          // Layer 4: 檔名完全相同或含 _new 後綴
          else if (p.title === finalTitle || p.title.startsWith(`${baseName}_new`)) {
            existingPhotosMap.set(p.id, p);
          }
        }

        const existingPhotos = Array.from(existingPhotosMap.values());

        const finalFileName = `${Date.now()}_${finalTitle.replace(/[^a-zA-Z0-9.-]/g, '_')}`;
        await env.BUCKET.put(finalFileName, arrayBuffer, {
          httpMetadata: { contentType: "image/jpeg" }
        });
        
        const host = new URL(request.url).origin;
        const fileUrl = `${host}/api/photos/view/${encodeURIComponent(finalFileName)}`;
        const finalExif = parsedExif ? JSON.stringify(parsedExif) : null;
        
        const tempPhoto = {
          title: finalTitle,
          file_name: finalFileName,
          album_id: targetAlbumId,
          url: fileUrl,
          taken_at: finalTakenAt || new Date().toISOString(),
          exif: finalExif,
          file_hash: fileHash,
          phash: clientPhash || null,
          lat: syncGeo.lat,
          lng: syncGeo.lng,
          geo_source: syncGeo.geoSource,
          taken_at_local: syncGeo.takenAtLocal,
          tz_offset_minutes: syncGeo.tzOffsetMinutes,
          time_source: syncGeo.timeSource
        };

        if (existingPhotos && existingPhotos.length > 0) {
          return new Response(JSON.stringify({ conflict: true, existingPhotos, tempPhoto }), { headers });
        }

        const syncInserted = await env.DB.prepare(
          // shuffle_key 見 /api/upload 的說明：漏填會讓照片永遠不出現在相簿預覽
          `INSERT INTO Photo
             (title, file_name, album_id, url, taken_at, exif, file_hash, phash,
              lat, lng, geo_source, taken_at_local, tz_offset_minutes, time_source, uploaded_by, shuffle_key)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, (random() & 2147483647))`
        ).bind(
          tempPhoto.title, tempPhoto.file_name, tempPhoto.album_id, tempPhoto.url,
          tempPhoto.taken_at, tempPhoto.exif, tempPhoto.file_hash, tempPhoto.phash,
          tempPhoto.lat, tempPhoto.lng, tempPhoto.geo_source,
          tempPhoto.taken_at_local, tempPhoto.tz_offset_minutes, tempPhoto.time_source,
          me.uid,
        ).run();

        const syncedId = Number(syncInserted.meta?.last_row_id ?? 0);
        if (syncedId) await syncFtsForPhotos(env.DB, [syncedId]);

        return new Response(JSON.stringify({ success: true, url: fileUrl }), { headers });
      }

      // 路由：處理照片衝突
      if (method === "POST" && pathname === "/api/google/resolve-conflict") {
        const body = await request.json() as any;
        const { decision, existingPhotos, tempPhoto, replacePhotoIds } = body;

        // album_id 也是前端送回來的。這一支會刪既有照片，權限一定要再驗一次
        if (tempPhoto?.album_id && !(await canTouchAlbum(tempPhoto.album_id))) {
          return forbidden(headers);
        }

        // tempPhoto 是由前端原樣送回來的，座標與來源標記都不能照單全收
        const tpLat = isValidLatLng(tempPhoto?.lat, tempPhoto?.lng) ? tempPhoto.lat : null;
        const tpLng = tpLat === null ? null : tempPhoto.lng;
        // 這條路徑只可能產出 'exif'（照片自帶 GPS），不接受前端宣稱更高的權威
        const tpGeoSource = tpLat !== null && tempPhoto?.geo_source === 'exif' ? 'exif' : null;
        const tpLocal = typeof tempPhoto?.taken_at_local === 'string' ? tempPhoto.taken_at_local : null;
        const tpTz = isValidTzOffset(tempPhoto?.tz_offset_minutes) ? tempPhoto.tz_offset_minutes : null;
        // 同理，同步流程不可能產生 'manual'，只放行 normalizeGeo 真的會回傳的值
        const tpTimeSource = ['offset_tag', 'gps_utc', 'file_time', 'assumed']
          .includes(tempPhoto?.time_source) ? tempPhoto.time_source : null;

        // replace 與 keep_both 都會插入一張新照片，兩邊共用同一個變數，
        // 收尾時再一次同步 FTS。skip 不會插入，維持 null。
        let replacedInsert: D1Result | null = null;

        if (decision === "skip") {
          // 刪除暫存在 R2 的新檔案
          await env.BUCKET.delete(tempPhoto.file_name);
        } else if (decision === "replace") {
          // 刪除多個舊檔案
          if (replacePhotoIds && Array.isArray(replacePhotoIds) && replacePhotoIds.length > 0) {
            const validIds: number[] = [];
            for (const id of replacePhotoIds) {
              const existingPhoto = (existingPhotos || []).find((p: any) => p.id === id);
              if (existingPhoto) validIds.push(existingPhoto.id);
            }
            if (validIds.length > 0) {
              /*
               * 要刪的物件鍵一律回 D1 查，不要用前端送回來的 existingPhotos。
               * 那份是 sync-photo 當時回給前端、再由前端原樣送回來的，既不保證帶得到
               * thumb_url / thumb_sm_url，也不保證跟現況一致 —— 少一個欄位的下場是
               * 縮圖被留在 R2 裡，沒有任何錯誤訊息。
               */
              const fetched = await env.DB.batch<any>(
                chunkIds(validIds).map((c) => env.DB.prepare(
                  `SELECT id, file_name, thumb_url, thumb_sm_url, drive_file_id, drive_original_id
                     FROM Photo WHERE id IN (${placeholdersFor(c)})`
                ).bind(...c)),
              );
              const stale = fetched.flatMap((part) => part.results as any[]);
              const keys = stale.flatMap((p: any) => r2KeysForPhoto(p));
              if (keys.length > 0) await env.BUCKET.delete(keys);
              await queueDriveTrash(env, stale);
              ctx.waitUntil(drainDriveTrash(env, 10).catch((e) => console.error("Drive 待搬佇列", e)));
              await env.DB.batch(
                chunkIds(validIds).map((c) => env.DB.prepare(
                  `DELETE FROM Photo WHERE id IN (${placeholdersFor(c)})`
                ).bind(...c)),
              );
              await deleteFtsForPhotos(env.DB, validIds);
            }
          }
          // 新增新檔案
          replacedInsert = await env.DB.prepare(
            // shuffle_key 見 /api/upload 的說明
            `INSERT INTO Photo
               (title, file_name, album_id, url, taken_at, exif, file_hash, phash,
                lat, lng, geo_source, taken_at_local, tz_offset_minutes, time_source, uploaded_by, shuffle_key)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, (random() & 2147483647))`
          ).bind(
            tempPhoto.title, tempPhoto.file_name, tempPhoto.album_id, tempPhoto.url,
            tempPhoto.taken_at, tempPhoto.exif, tempPhoto.file_hash || null, tempPhoto.phash || null,
            tpLat, tpLng, tpGeoSource, tpLocal, tpTz, tpTimeSource, me.uid,
          ).run();
        } else if (decision === "keep_both") {
          // 修改標題避免混淆
          const count = existingPhotos ? existingPhotos.length : 1;
          const newTitle = tempPhoto.title.replace(/(\.[^.]+)$/, `_new_${count}$1`);
          replacedInsert = await env.DB.prepare(
            // shuffle_key 見 /api/upload 的說明
            `INSERT INTO Photo
               (title, file_name, album_id, url, taken_at, exif,
                lat, lng, geo_source, taken_at_local, tz_offset_minutes, time_source, uploaded_by, shuffle_key)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, (random() & 2147483647))`
          ).bind(
            newTitle, tempPhoto.file_name, tempPhoto.album_id, tempPhoto.url,
            tempPhoto.taken_at, tempPhoto.exif,
            tpLat, tpLng, tpGeoSource, tpLocal, tpTz, tpTimeSource, me.uid,
          ).run();
        }

        const resolvedId = Number(replacedInsert?.meta?.last_row_id ?? 0);
        if (resolvedId) await syncFtsForPhotos(env.DB, [resolvedId]);

        return new Response(JSON.stringify({ success: true }), { headers });
      }

      // ===== 足跡地圖 =====

      // 路由：取得足跡點位
      // 時間篩選一律用當地牆上時間 —— 使用者說「3/1 我在京都」指的是當地時間。
      // 舊資料若無 taken_at_local，由 LOCAL_TIME_EXPR 從 taken_at 加時區推回來再比對。
      if (method === "GET" && pathname === "/api/footprint") {
        const isAdmin = await isAuthorized(request, env);
        /*
         * 訪客要看足跡得站長先開。**這一關必須擋在 withEdgeCache 前面** ——
         * 進到裡面就可能直接命中先前存下的 200，開關關掉也照樣把座標端出去。
         */
        if (!isAdmin && !(await guestCanViewMap(env))) {
          return forbidden(headers, "站長沒有開放訪客瀏覽足跡地圖");
        }
        // 這條的隱私過濾是寫在 SQL 的 WHERE 裡（不是 applyGeoPrivacy），但結果同樣
        // 依身分而異，一樣不能讓管理員的版本落進共用的邊緣快取
        return withEdgeCache(request, ctx,
          { browserMaxAge: 30, edgeMaxAge: 300, skip: isAdmin },
          async () => {
        const conds = ["p.lat IS NOT NULL", "p.lng IS NOT NULL"];
        const binds: any[] = [];

        // 非管理者只看得到雙層隱私都放行的照片
        if (!isAdmin) conds.push("a.map_private = 0", "p.geo_private = 0");

        const qAlbum = url.searchParams.get("album_id");
        if (qAlbum) { conds.push("p.album_id = ?"); binds.push(qAlbum); }
        const qFrom = url.searchParams.get("from");
        if (qFrom) { conds.push(`${LOCAL_TIME_EXPR} >= ?`); binds.push(qFrom); }
        const qTo = url.searchParams.get("to");
        if (qTo) { conds.push(`${LOCAL_TIME_EXPR} <= ?`); binds.push(qTo); }

        const { results } = await env.DB.prepare(`
          SELECT p.id, p.title, p.album_id, a.name AS album_name,
                 -- 地圖標記畫出來只有幾十像素，一律拿最小的 400px；
                 -- 舊照片沒有 thumb_sm_url 才逐級退回
                 COALESCE(p.thumb_sm_url, p.thumb_url, p.url) AS url,
                 p.lat, p.lng, p.place_name, p.geo_source,
                 ${LOCAL_TIME_EXPR} AS local_time,
                 -- 顯示用的是 local_time，但要跟 GPS 軌跡排到同一條時間軸上
                 -- 就得用 UTC，否則台北的照片會被擺到軌跡上錯 8 小時的位置
                 p.taken_at
          FROM Photo p
          LEFT JOIN Album a ON a.id = p.album_id
          WHERE ${conds.join(" AND ")}
          ORDER BY local_time ASC
        `).bind(...binds).all();

        return new Response(JSON.stringify(results), { headers });
          });
      }

      // 路由：列出行程段（會直接暴露地點，僅管理者可讀）
      if (method === "GET" && pathname === "/api/trip-segments") {
        if (!(await isAuthorized(request, env))) {
          return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers });
        }
        const qAlbum = url.searchParams.get("album_id");
        const { results } = qAlbum
          ? await env.DB.prepare(
              "SELECT * FROM TripSegment WHERE album_id = ? OR album_id IS NULL ORDER BY start_local ASC"
            ).bind(qAlbum).all()
          : await env.DB.prepare("SELECT * FROM TripSegment ORDER BY start_local ASC").all();
        return new Response(JSON.stringify(results), { headers });
      }

      // 路由：預覽批次指定地點的影響範圍
      // 這支專門處理「顯示順序 != 時間順序」的陷阱：使用者 shift 連選的是顯示順序上的
      // 連續區間，但推導出的時間區段可能涵蓋到其他未被選取的照片。先讓使用者看清楚再決定。
      if (method === "POST" && pathname === "/api/photos/geo/preview") {
        const body: any = await request.json();
        const ids: number[] = Array.isArray(body?.photoIds) ? body.photoIds.map(Number).filter(Number.isFinite) : [];
        if (ids.length === 0) {
          return new Response(JSON.stringify({ error: "photoIds is required" }), { status: 400, headers });
        }

        const selChunks = await env.DB.batch(
          chunkIds(ids).map((c) => env.DB.prepare(`
            SELECT p.id, p.album_id, p.geo_source, ${LOCAL_TIME_EXPR} AS local_time
            FROM Photo p WHERE p.id IN (${placeholdersFor(c)})
          `).bind(...c)),
        );
        const sel = selChunks.flatMap((r) => (r.results ?? []) as any[]);

        const times = (sel as any[]).map(r => r.local_time).filter(Boolean).sort();
        const startLocal = times[0] ?? null;
        const endLocal = times[times.length - 1] ?? null;
        const withExif = (sel as any[]).filter(r => r.geo_source === 'exif').length;
        const albumIds = Array.from(new Set((sel as any[]).map(r => r.album_id)));

        // 落在同一時間範圍、同相簿，卻沒被選到的照片
        let alsoInRange: any[] = [];
        if (startLocal && endLocal && albumIds.length > 0) {
          const aph = albumIds.map(() => "?").join(",");
          // 「排除已選取的那些」改在 JS 做，不寫成 NOT IN (?,?,…)：
          // 那串會把 id 全部塞進綁定參數，破 D1 的 100 個上限。這裡也切不了塊 ——
          // NOT IN 要一次排除全部，拆開跑每塊都會把別塊的 id 當成漏網之魚撈回來。
          // 相簿內、落在時間範圍內的照片本來就沒幾張，撈回來過濾很便宜。
          const { results } = await env.DB.prepare(`
            SELECT p.id, p.title, COALESCE(p.thumb_sm_url, p.thumb_url, p.url) AS url, ${LOCAL_TIME_EXPR} AS local_time
            FROM Photo p
            WHERE p.album_id IN (${aph})
              AND ${LOCAL_TIME_EXPR} BETWEEN ? AND ?
            ORDER BY local_time ASC
          `).bind(...albumIds, startLocal, endLocal).all();
          const selected = new Set(ids);
          alsoInRange = (results as any[]).filter((r) => !selected.has(r.id));
        }

        return new Response(JSON.stringify({
          selectedCount: sel.length,
          startLocal,
          endLocal,
          missingTimeCount: sel.length - times.length,
          existingExifCount: withExif,
          alsoInRange,
        }), { headers });
      }

      // 路由：批次指定地點
      // 同時寫入照片層級座標（事實）與選擇性建立 TripSegment（規則）。
      // 預設不覆蓋 geo_source='exif' 的照片 —— 照片自帶的 GPS 比手動指定可信。
      if (method === "POST" && pathname === "/api/photos/geo/batch") {
        const body: any = await request.json();
        const ids = sanitizePhotoIds(body?.photoIds);
        const { lat, lng } = body || {};

        if (ids.length === 0) {
          return new Response(JSON.stringify({ error: "photoIds is required" }), { status: 400, headers });
        }
        if (!isValidLatLng(lat, lng)) {
          return new Response(JSON.stringify({ error: "Invalid lat/lng" }), { status: 400, headers });
        }
        if (!(await canTouchPhotos(ids))) return forbidden(headers);

        const placeName = typeof body.placeName === 'string' ? body.placeName : null;
        const overwriteExif = body.overwriteExif === true;

        // 這是使用者親手指定，權威最高，唯一預設不動的是照片自帶的 GPS。
        // 用 IS NOT 而非 != ：後者遇到 geo_source IS NULL 會得到 NULL，
        // 反而把最需要寫入的「還沒定位」那些照片排除掉。
        const guard = overwriteExif ? "" : " AND geo_source IS NOT 'exif'";
        // lat、lng、place_name 三個綁定要先從 100 的額度裡扣掉
        const updChunks = await env.DB.batch(
          chunkIds(ids, 3).map((c) => env.DB.prepare(`
            UPDATE Photo SET lat = ?, lng = ?, place_name = ?, geo_source = 'manual'
            WHERE id IN (${placeholdersFor(c)})${guard}
          `).bind(lat, lng, placeName, ...c)),
        );
        const changed = updChunks.reduce((n, r) => n + ((r.meta as any)?.changes ?? 0), 0);

        // 推導時間區段
        const selChunks = await env.DB.batch(
          chunkIds(ids).map((c) => env.DB.prepare(`
            SELECT ${LOCAL_TIME_EXPR} AS local_time FROM Photo p WHERE p.id IN (${placeholdersFor(c)})
          `).bind(...c)),
        );
        const sel = selChunks.flatMap((r) => (r.results ?? []) as any[]);
        const times = (sel as any[]).map(r => r.local_time).filter(Boolean).sort();
        const startLocal = times[0] ?? null;
        const endLocal = times[times.length - 1] ?? null;

        let segmentId: number | null = null;
        if (body.createSegment === true && startLocal && endLocal) {
          const label = typeof body.label === 'string' && body.label.trim() ? body.label.trim() : (placeName || '未命名地點');
          const tz = Number.isFinite(body.tzOffsetMinutes) ? body.tzOffsetMinutes : null;
          const albumId = Number.isFinite(body.albumId) ? body.albumId : null;
          const res = await env.DB.prepare(`
            INSERT INTO TripSegment (album_id, label, start_local, end_local, lat, lng, place_name, tz_offset_minutes)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `).bind(albumId, label, startLocal, endLocal, lat, lng, placeName, tz).run();
          segmentId = (res.meta as any)?.last_row_id ?? null;
        }

        return new Response(JSON.stringify({
          success: true,
          updated: changed,
          skippedExif: ids.length - changed,
          startLocal,
          endLocal,
          segmentId,
        }), { headers });
      }

      // 路由：把行程段套用到還沒有座標的照片
      // 多個區段命中同一張照片時，取最晚建立的（後寫入的贏）。
      // geo_source='exif' 的照片永遠不動。
      if (method === "POST" && pathname === "/api/photos/geo/apply-segments") {
        const body: any = await request.json().catch(() => ({}));
        const albumId = Number.isFinite(body?.albumId) ? body.albumId : null;

        // 不指定相簿就是「全站沒座標的照片都套一遍」，那會動到別人的
        if (albumId === null) {
          if (!me.canManageOthers) return forbidden(headers, "只能對自己的相簿套用行程段");
        } else if (!(await canTouchAlbum(albumId))) {
          return forbidden(headers);
        }

        const { results: segments } = await env.DB.prepare(
          "SELECT * FROM TripSegment ORDER BY created_at ASC, id ASC"
        ).all();
        if (segments.length === 0) {
          return new Response(JSON.stringify({ success: true, updated: 0, reason: "no segments" }), { headers });
        }

        const { results: photos } = albumId !== null
          ? await env.DB.prepare(`
              SELECT p.id, p.album_id, ${LOCAL_TIME_EXPR} AS local_time
              FROM Photo p WHERE p.lat IS NULL AND p.album_id = ?
            `).bind(albumId).all()
          : await env.DB.prepare(`
              SELECT p.id, p.album_id, ${LOCAL_TIME_EXPR} AS local_time
              FROM Photo p WHERE p.lat IS NULL
            `).all();

        const stmts: D1PreparedStatement[] = [];
        for (const p of photos as any[]) {
          if (!p.local_time) continue;
          let hit: any = null;
          for (const s of segments as any[]) {
            const scoped = s.album_id === null || String(s.album_id) === String(p.album_id);
            if (scoped && p.local_time >= s.start_local && p.local_time <= s.end_local) hit = s;
          }
          if (!hit) continue;
          // 行程段是粗略規則，只贏得過內插；寫 'segment' 而非 'manual'，
          // 因為這是自動流程套用規則，不是使用者對這張照片親手指定。
          //
          // 刻意不寫 tz_offset_minutes：行程段的時區是「地點的時區」，
          // 而 tz_offset_minutes 是「taken_at_local 該用哪個時區讀」。
          // 在這裡改它會連帶讓照片顯示的拍攝時間整批位移（否則就破壞
          // taken_at === taken_at_local − tz 這條不變式），那是指定地點不該有的副作用。
          // 時區要改請走批次改時區，那是使用者明確的操作。
          stmts.push(env.DB.prepare(
            `UPDATE Photo SET lat = ?, lng = ?, place_name = ?, geo_source = 'segment'
             WHERE id = ?${geoOverwriteGuard('segment')}`
          ).bind(hit.lat, hit.lng, hit.place_name, p.id));
        }
        if (stmts.length > 0) await env.DB.batch(stmts);

        return new Response(JSON.stringify({ success: true, updated: stmts.length }), { headers });
      }

      /*
       * 路由：只補地名，座標一個字都不動。
       *
       * 存在的理由：相機自帶 GPS 的照片座標已經是最準的一份，缺的只有「這是哪裡」。
       * 走 /api/photos/geo/batch 會把 lat/lng 換成地名中心點、geo_source 蓋成
       * 'manual'，等於為了一個名字把精確座標降級成一個大概的位置。
       *
       * 所以這裡刻意不碰 lat/lng/geo_source —— 語意是「幫這個座標取個名字」，
       * 而不是「把這張照片移到那裡」。
       */
      if (method === "POST" && pathname === "/api/photos/geo/place-name") {
        if (!(await isAuthorized(request, env))) {
          return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers });
        }
        const body: any = await request.json().catch(() => ({}));
        const raw = Array.isArray(body?.items) ? body.items : [];
        const items = raw
          .filter((it: any) => Number.isInteger(it?.photoId) && it.photoId > 0
            && typeof it?.placeName === 'string' && it.placeName.trim())
          .slice(0, 2000)
          .map((it: any) => ({ photoId: it.photoId as number, placeName: (it.placeName as string).trim() }));

        if (items.length === 0) {
          return new Response(JSON.stringify({ error: "items is required" }), { status: 400, headers });
        }
        if (!(await canTouchPhotos(items.map((it: { photoId: number }) => it.photoId)))) return forbidden(headers);

        await env.DB.batch(items.map((it: { photoId: number; placeName: string }) =>
          env.DB.prepare("UPDATE Photo SET place_name = ? WHERE id = ?").bind(it.placeName, it.photoId)
        ));
        // place_name 是 FTS 的四個欄位之一，改了要跟著同步，否則搜地名會搜不到
        await syncFtsForPhotos(env.DB, items.map((it: { photoId: number }) => it.photoId));
        return new Response(JSON.stringify({ success: true, updated: items.length }), { headers });
      }

      /*
       * 路由：地名查詢（正向與反向），轉手給 Photon（komoot 的 OSM 地理編碼）。
       *
       * 為什麼要經過 Worker 而不是讓瀏覽器直接打：反向查詢送出去的是照片的實際
       * 座標。瀏覽器直連等於把「這台裝置在什麼時候查了哪些位置」交給第三方，
       * 而那正是這整個專案在防的事。理由跟 /api/tracks/match 轉手 Valhalla 一樣。
       * 正向查詢（打字搜地名）本來沒這個問題，一起收進來只是為了兩邊同一條路。
       *
       * 只給管理者：這兩條都只在管理工具裡用得到，開放出去就是一個免費的
       * 地理編碼代理，會被拿去打爆別人家的志工伺服器。
       */
      if (method === "GET" && (pathname === "/api/geo/search" || pathname === "/api/geo/reverse")) {
        if (!(await isAuthorized(request, env))) {
          return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers });
        }

        let upstream: string;
        if (pathname === "/api/geo/search") {
          const q = (url.searchParams.get("q") || "").trim();
          if (!q) return new Response(JSON.stringify({ features: [] }), { headers });
          upstream = `https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=6`;
        } else {
          const lat = Number(url.searchParams.get("lat"));
          const lng = Number(url.searchParams.get("lng"));
          if (!isValidLatLng(lat, lng)) {
            return new Response(JSON.stringify({ error: "Invalid lat/lng" }), { status: 400, headers });
          }
          // 取 5 筆而不是 1 筆：最近的那個常常是一條路或一棟房子，
          // 我們要的是「清水寺」這種地標。挑哪一筆由前端決定（見 geo.ts 的 pickPlaceName）
          upstream = `https://photon.komoot.io/reverse?lat=${lat}&lon=${lng}&limit=5`;
        }

        try {
          const res = await fetch(upstream, {
            headers: { "User-Agent": "didadida-photo-map (self-hosted, low volume)" },
          });
          if (!res.ok) {
            return new Response(JSON.stringify({ error: `Photon ${res.status}` }), { status: 502, headers });
          }
          return new Response(await res.text(), {
            headers: { ...headers, "Content-Type": "application/json" },
          });
        } catch (e: any) {
          return new Response(JSON.stringify({ error: String(e?.message || e) }), { status: 502, headers });
        }
      }

      // 路由：寫入由 Google 時間軸比對出來的位置
      // 比對全在瀏覽器內完成，這裡只收到「哪張照片在哪個座標」，
      // 原始的 Timeline.json（含住家標記與 WiFi MAC）不會離開使用者的電腦。
      if (method === "POST" && pathname === "/api/photos/geo/from-timeline") {
        const body: any = await request.json();
        const matches: any[] = Array.isArray(body?.matches) ? body.matches : [];
        if (matches.length === 0) {
          return new Response(JSON.stringify({ error: "matches is required" }), { status: 400, headers });
        }
        if (!(await canTouchPhotos(matches.map((m: any) => Number(m?.photoId)).filter(Number.isFinite)))) {
          return forbidden(headers);
        }

        const overwriteExif = body?.overwriteExif === true;

        const stmts: D1PreparedStatement[] = [];
        let invalid = 0;
        let loose = 0;
        for (const m of matches) {
          const id = Number(m?.photoId);
          if (!Number.isFinite(id) || !isValidLatLng(m?.lat, m?.lng)) { invalid++; continue; }
          const place = typeof m.placeName === 'string' ? m.placeName : null;
          const tz = Number.isFinite(m?.tzOffsetMinutes) ? m.tzOffsetMinutes : null;

          /*
           * 時間軸的權威隨「照片時間離最近取樣點多遠」浮動。
           *
           * gap 一分鐘的命中是「Google 剛好記到你在那裡」，比城市級的行程段準；
           * gap 二十分鐘的命中只是「那陣子你在那附近」，比不上使用者親手圈的行程段。
           * 兩者用同一個 GEO_RANK 等級寫入的話，後者會靜默蓋掉前者定好的地點。
           *
           * 所以超過門檻就降級到 interpolated 那一層：只填得了還沒有座標的照片，
           * 蓋不掉 segment。geo_source 一律還是寫 'timeline' —— 那是它真正的出處，
           * 降級改的是「能覆蓋誰」，不是「它從哪來」。
           *
           * gapMinutes 沒送（舊版前端）就當作可信，維持原本的行為。
           */
          const gap = Number(m?.gapMinutes);
          const rank = Number.isFinite(gap) && gap > TIMELINE_LOOSE_GAP_MIN ? 'interpolated' : 'timeline';
          if (rank === 'interpolated') loose++;
          // overwriteExif 只放行 'exif' 這一層，而且只對可信的命中放行；'manual' 是
          // 使用者親手指定的，任何自動流程都不得覆蓋，所以它不在放行範圍內。
          const guard = overwriteExif && rank === 'timeline'
            ? " AND geo_source IS NOT 'manual'"
            : geoOverwriteGuard(rank);

          stmts.push(env.DB.prepare(
            `UPDATE Photo
               SET lat = ?, lng = ?, place_name = COALESCE(?, place_name),
                   geo_source = 'timeline',
                   tz_offset_minutes = COALESCE(tz_offset_minutes, ?)
             WHERE id = ?${guard}`
          ).bind(m.lat, m.lng, place, tz, id));
        }

        let updated = 0;
        // D1 batch 有大小上限，分批送
        for (let i = 0; i < stmts.length; i += 100) {
          const res = await env.DB.batch(stmts.slice(i, i + 100));
          for (const r of res) updated += (r.meta as any)?.changes ?? 0;
        }

        return new Response(JSON.stringify({
          success: true,
          updated,
          invalid,
          loose,
          skipped: stmts.length - updated,
        }), { headers });
      }

      // 路由：批次切換照片層級的位置隱私
      if (method === "PUT" && pathname === "/api/photos/geo/privacy") {
        const body: any = await request.json();
        const ids = sanitizePhotoIds(body?.photoIds);
        if (ids.length === 0) {
          return new Response(JSON.stringify({ error: "photoIds is required" }), { status: 400, headers });
        }
        if (!(await canTouchPhotos(ids))) return forbidden(headers);
        const value = body?.geoPrivate === 0 || body?.geoPrivate === false ? 0 : 1;
        const res = await env.DB.batch(
          chunkIds(ids, 1).map((c) => env.DB.prepare(
            `UPDATE Photo SET geo_private = ? WHERE id IN (${placeholdersFor(c)})`
          ).bind(value, ...c)),
        );
        const updated = res.reduce((n, r) => n + ((r.meta as any)?.changes ?? 0), 0);
        return new Response(JSON.stringify({ success: true, updated }), { headers });
      }

      // 路由：切換相簿層級的地圖隱私
      if (method === "PUT" && pathname.startsWith("/api/albums/") && pathname.endsWith("/map-privacy")) {
        const albumId = pathname.split("/")[3];
        if (!(await canTouchAlbum(albumId))) return forbidden(headers);
        const body: any = await request.json();
        const value = body?.mapPrivate === 0 || body?.mapPrivate === false ? 0 : 1;
        await env.DB.prepare("UPDATE Album SET map_private = ? WHERE id = ?").bind(value, albumId).run();
        return new Response(JSON.stringify({ success: true, map_private: value }), { headers });
      }

      // 路由：刪除行程段
      if (method === "DELETE" && pathname.startsWith("/api/trip-segments/")) {
        const segId = pathname.split("/")[3];
        if (!me.canManageOthers) {
          // 沒綁相簿的行程段是全站共用的規則，只有能管別人內容的人動得了
          const seg = await env.DB.prepare("SELECT album_id FROM TripSegment WHERE id = ?").bind(segId).first<any>();
          if (!seg) return new Response(JSON.stringify({ error: "Not Found" }), { status: 404, headers });
          if (seg.album_id == null || !(await canTouchAlbum(seg.album_id))) return forbidden(headers);
        }
        await env.DB.prepare("DELETE FROM TripSegment WHERE id = ?").bind(segId).run();
        return new Response(JSON.stringify({ success: true }), { headers });
      }

      // ===== 手動編輯 =====
      // 不管照片有沒有 GPS、有沒有時區標籤，都要能靠手改到正確位置與時間。
      // 全站不變式：taken_at === taken_at_local − tz_offset_minutes。
      // 以下每個操作都必須維持它，否則排序（用 taken_at）與顯示／行程段比對
      //（用 taken_at_local）會各說各話。

      // 路由：單張照片的手動編輯（座標、地點名稱、拍攝時間、時區）
      // 手動是最高權威，寫進來之後任何自動流程都不會再覆蓋（見 geoOverwriteGuard）。
      //
      // 時間有兩種改法，語意刻意分開，請只送使用者真的動過的欄位：
      //   送 takenAtLocal      → 相機時鐘記錯了。牆上時間為準，taken_at 重算成 local − tz
      //   只送 tzOffsetMinutes → 瞬間沒錯，只是拿錯時區在顯示。taken_at 不動，local 重算成 taken_at + tz
      //   兩者都送             → 牆上時間與時區都由使用者指定，taken_at = local − tz
      if (method === "PUT" && /^\/api\/photos\/\d+\/geo$/.test(pathname)) {
        const photoId = Number(pathname.split("/")[3]);
        if (!(await canTouchPhoto(photoId))) return forbidden(headers);
        const body: any = await request.json().catch(() => ({}));

        const row = await env.DB.prepare(
          "SELECT tz_offset_minutes FROM Photo WHERE id = ?"
        ).bind(photoId).first() as any;
        if (!row) {
          return new Response(JSON.stringify({ error: "Photo not found" }), { status: 404, headers });
        }

        const sets: string[] = [];
        const binds: any[] = [];

        // 明確送 lat: null 代表「清掉這個位置」，整個欄位不存在才是「不要動」
        if ('lat' in body || 'lng' in body) {
          if (body.lat === null && body.lng === null) {
            sets.push("lat = NULL", "lng = NULL", "geo_source = NULL");
          } else if (isValidLatLng(body.lat, body.lng)) {
            sets.push("lat = ?", "lng = ?", "geo_source = 'manual'");
            binds.push(body.lat, body.lng);
          } else {
            return new Response(JSON.stringify({ error: "Invalid lat/lng" }), { status: 400, headers });
          }
        }
        if ('placeName' in body) {
          const pn = typeof body.placeName === 'string' ? body.placeName.trim() : '';
          sets.push("place_name = ?");
          binds.push(pn || null);
        }

        const hasTz = 'tzOffsetMinutes' in body;
        if (hasTz && !isValidTzOffset(body.tzOffsetMinutes)) {
          return new Response(JSON.stringify({ error: "Invalid tzOffsetMinutes" }), { status: 400, headers });
        }
        const tz = hasTz
          ? body.tzOffsetMinutes
          : (isValidTzOffset(row.tz_offset_minutes) ? row.tz_offset_minutes : DEFAULT_TZ_OFFSET_MINUTES);

        if ('takenAtLocal' in body) {
          const wc = parseExifDateTime(body.takenAtLocal);
          if (!wc) {
            return new Response(JSON.stringify({ error: "Invalid takenAtLocal" }), { status: 400, headers });
          }
          const localStr = formatWallClock(wc);
          sets.push("taken_at_local = ?", "taken_at = ?", "tz_offset_minutes = ?", "time_source = 'manual'");
          binds.push(localStr, utcFromLocal(localStr, tz), tz);
        } else if (hasTz) {
          // 只改時區：瞬間不動，牆上時間跟著新時區重算。這個操作對「瞬間準不準」
          // 沒有任何主張，所以 time_source 不動。
          // taken_at 為 NULL 時 strftime 回傳 NULL，local 也就留空，不變式仍然成立。
          sets.push("tz_offset_minutes = ?", "taken_at_local = strftime('%Y-%m-%d %H:%M:%S', taken_at, ?)");
          binds.push(tz, minutesModifier(tz));
        }

        if (sets.length === 0) {
          return new Response(JSON.stringify({ error: "nothing to update" }), { status: 400, headers });
        }
        binds.push(photoId);
        await env.DB.prepare(`UPDATE Photo SET ${sets.join(", ")} WHERE id = ?`).bind(...binds).run();

        const updated = await env.DB.prepare(
          `SELECT id, lat, lng, place_name, geo_source,
                  taken_at, taken_at_local, tz_offset_minutes, time_source
           FROM Photo WHERE id = ?`
        ).bind(photoId).first();
        return new Response(JSON.stringify({ success: true, photo: updated }), { headers });
      }

      // 路由：批次平移拍攝時間（相機時鐘走差了，例如 D800 每年慢約一分鐘）
      // 瞬間與牆上時間一起移動、時區不變 —— 兩者的差就是時區，得一起動才守得住不變式。
      if (method === "POST" && pathname === "/api/photos/geo/shift-time") {
        const body: any = await request.json().catch(() => ({}));
        const ids = sanitizePhotoIds(body?.photoIds);
        const minutes = body?.minutes;
        if (ids.length === 0) {
          return new Response(JSON.stringify({ error: "photoIds is required" }), { status: 400, headers });
        }
        // 一年以上的位移不會是時鐘誤差，那是打錯字
        if (!Number.isInteger(minutes) || minutes === 0 || Math.abs(minutes) > 366 * 24 * 60) {
          return new Response(JSON.stringify({ error: "Invalid minutes" }), { status: 400, headers });
        }
        if (!(await canTouchPhotos(ids))) return forbidden(headers);

        const mod = minutesModifier(minutes);
        // 一句 UPDATE 做完，不逐張讀回來在 JS 算：D1 免費額度是按寫入列數計費的，
        // 這樣整批只花 ids.length 列。同一句 UPDATE 裡右側取到的都是舊值。
        const res = await env.DB.batch(
          chunkIds(ids, 2).map((c) => env.DB.prepare(`
            UPDATE Photo SET
              taken_at = strftime('%Y-%m-%dT%H:%M:%fZ', taken_at, ?),
              taken_at_local = strftime('%Y-%m-%d %H:%M:%S', taken_at_local, ?),
              time_source = 'manual'
            WHERE id IN (${placeholdersFor(c)}) AND taken_at IS NOT NULL
          `).bind(mod, mod, ...c)),
        );

        const updated = res.reduce((n, r) => n + ((r.meta as any)?.changes ?? 0), 0);
        return new Response(JSON.stringify({
          success: true,
          updated,
          skippedNoTime: ids.length - updated,
        }), { headers });
      }

      // 路由：批次改時區（出國拍照但機身時區沒改）
      // taken_at 是對的 —— 相機時鐘走的還是原本那個時區的正確時間，換算出來的瞬間沒錯，
      // 錯的只是「拿哪個時區去顯示」。所以 taken_at 一律不動，只重算牆上時間。
      // 同理不動 time_source：這個操作對瞬間的可信度沒有任何主張。
      if (method === "POST" && pathname === "/api/photos/geo/set-timezone") {
        const body: any = await request.json().catch(() => ({}));
        const ids = sanitizePhotoIds(body?.photoIds);
        if (ids.length === 0) {
          return new Response(JSON.stringify({ error: "photoIds is required" }), { status: 400, headers });
        }
        if (!isValidTzOffset(body?.tzOffsetMinutes)) {
          return new Response(JSON.stringify({ error: "Invalid tzOffsetMinutes" }), { status: 400, headers });
        }
        if (!(await canTouchPhotos(ids))) return forbidden(headers);

        const tz = body.tzOffsetMinutes;
        const res = await env.DB.batch(
          chunkIds(ids, 2).map((c) => env.DB.prepare(`
            UPDATE Photo SET
              tz_offset_minutes = ?,
              taken_at_local = strftime('%Y-%m-%d %H:%M:%S', taken_at, ?)
            WHERE id IN (${placeholdersFor(c)}) AND taken_at IS NOT NULL
          `).bind(tz, minutesModifier(tz), ...c)),
        );

        const updated = res.reduce((n, r) => n + ((r.meta as any)?.changes ?? 0), 0);
        return new Response(JSON.stringify({
          success: true,
          updated,
          skippedNoTime: ids.length - updated,
        }), { headers });
      }

      // ===== GPS 軌跡 =====
      //
      // Worker 只做 Drive 的 I/O 與 D1 的讀寫。GPX 解析與抽稀在瀏覽器跑，
      // 所以不需要 cron，同步是使用者按下按鈕才發生的。

      // 路由：列出 Drive 上的 GPX 檔與各自的同步狀態
      // 會暴露檔名（＝出門的日期），僅管理者可讀
      if (method === "GET" && pathname === "/api/tracks/drive/files") {
        if (!(await isAuthorized(request, env))) {
          return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers });
        }
        if (!env.GOOGLE_DRIVE_SA_KEY || !env.GOOGLE_DRIVE_FOLDER_ID) {
          return new Response(JSON.stringify({
            error: "尚未設定 GOOGLE_DRIVE_SA_KEY 或 GOOGLE_DRIVE_FOLDER_ID",
          }), { status: 503, headers });
        }

        const files = await listGpxFiles(env.GOOGLE_DRIVE_SA_KEY, env.GOOGLE_DRIVE_FOLDER_ID);
        const { results: days } = await env.DB.prepare(
          "SELECT day_key, md5, point_count, synced_at, ingest_source FROM TrackDay"
        ).all();
        const byKey = new Map((days as any[]).map(d => [d.day_key, d]));

        // md5 相同就代表內容一個點都沒變 —— 每次 auto-send 都會動 modifiedTime，
        // 只看時間會把整天的檔案白抓白解析一遍
        const list = files.map(f => {
          const known = byKey.get(f.name);
          return {
            dayKey: f.name,
            driveFileId: f.id,
            md5: f.md5Checksum ?? null,
            modifiedTime: f.modifiedTime ?? null,
            size: f.size ? Number(f.size) : null,
            syncedPointCount: known?.point_count ?? 0,
            syncedAt: known?.synced_at ?? null,
            // 手動編輯過軌跡點的日子，ingest_source 會被改成 'manual'。
            // 重灌會整批刪掉那天的點，把手工修的東西一起洗掉，所以前端預設跳過它。
            ingestSource: known?.ingest_source ?? null,
            needsSync: !known || !f.md5Checksum || known.md5 !== f.md5Checksum,
          };
        });
        return new Response(JSON.stringify(list), { headers });
      }

      // 路由：代理單一 GPX 檔的原始 bytes 給前端解析
      if (method === "GET" && pathname.startsWith("/api/tracks/drive/file/")) {
        if (!(await isAuthorized(request, env))) {
          return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers });
        }
        if (!env.GOOGLE_DRIVE_SA_KEY) {
          return new Response(JSON.stringify({ error: "尚未設定 GOOGLE_DRIVE_SA_KEY" }), { status: 503, headers });
        }
        const fileId = decodeURIComponent(pathname.split("/")[5] || "");
        if (!fileId) {
          return new Response(JSON.stringify({ error: "file id is required" }), { status: 400, headers });
        }

        const upstream = await fetchDriveMedia(env.GOOGLE_DRIVE_SA_KEY, fileId);
        return new Response(upstream.body, {
          headers: { ...headers, "Content-Type": "application/gpx+xml" },
        });
      }

      // 路由：列出已同步的軌跡日
      //
      // 會暴露出門的日期，僅管理者可讀（同 /api/tracks/drive/files）。
      // 跟那條的差別：這裡問的是「D1 裡有什麼」，不需要 Drive 設定，
      // 所以就算 Drive 壞了或檔案被清掉，還原介面仍然打得開。
      if (method === "GET" && pathname === "/api/tracks/days") {
        if (!(await isAuthorized(request, env))) {
          return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers });
        }
        // drive_file_id / md5 也一起給：還原是走 ingest，而 ingest 會把這兩欄
        // 整個覆蓋掉，前端得原封不動送回來，否則下次同步會誤判成「檔案有變」
        // first_local_day / last_local_day：這批軌跡點實際落在哪一天（當地）。
        // day_key 是 Drive 檔名，不保證是日期（見上面的註解），前端的月曆要標
        // 「這天有沒有足跡」只能靠這兩欄，不能去解析檔名。
        //
        // 用相關子查詢而不是 GROUP BY 掃全表：idx_trackpoint_day 是
        // (day_key, t_utc)，day_key 給定之後 MIN/MAX 就是索引的頭尾兩次 seek，
        // 每天各兩筆。GROUP BY 會把整個 TrackPoint 掃過一遍，天數一多就是白花讀取額度。
        const { results } = await env.DB.prepare(`
          SELECT d.day_key, d.ingest_source, d.drive_file_id, d.md5, d.point_count,
                 d.tz_offset_minutes, d.synced_at, d.is_private,
                 d.raw_key IS NOT NULL AS has_raw,
                 strftime('%Y-%m-%d',
                   (SELECT MIN(p.t_utc) FROM TrackPoint p WHERE p.day_key = d.day_key),
                   COALESCE(d.tz_offset_minutes, ${DEFAULT_TZ_OFFSET_MINUTES}) || ' minutes'
                 ) AS first_local_day,
                 strftime('%Y-%m-%d',
                   (SELECT MAX(p.t_utc) FROM TrackPoint p WHERE p.day_key = d.day_key),
                   COALESCE(d.tz_offset_minutes, ${DEFAULT_TZ_OFFSET_MINUTES}) || ' minutes'
                 ) AS last_local_day
          FROM TrackDay d
          ORDER BY d.day_key DESC
        `).all();
        return new Response(JSON.stringify(results), { headers });
      }

      // 路由：讀回某一天的原始 GPX（給「恢復原始軌跡」用）
      // 原文就是完整的一日行蹤，比軌跡點更敏感，只給管理者
      if (method === "GET" && pathname.startsWith("/api/tracks/raw/")) {
        if (!(await isAuthorized(request, env))) {
          return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers });
        }
        const dayKey = decodeURIComponent(pathname.slice("/api/tracks/raw/".length));
        if (!dayKey) {
          return new Response(JSON.stringify({ error: "dayKey is required" }), { status: 400, headers });
        }
        const row = await env.DB.prepare(
          "SELECT raw_key FROM TrackDay WHERE day_key = ?"
        ).bind(dayKey).first<{ raw_key: string | null }>();
        if (!row?.raw_key) {
          return new Response(JSON.stringify({ error: "這一天沒有留存原始軌跡檔" }), { status: 404, headers });
        }
        const object = await env.BUCKET.get(row.raw_key);
        if (!object) {
          return new Response(JSON.stringify({ error: "原始軌跡檔已不存在" }), { status: 404, headers });
        }
        return new Response(object.body, {
          headers: { ...headers, "Content-Type": "application/gpx+xml" },
        });
      }

      // 路由：留存原始 GPX
      //
      // body 直接就是 GPX 原文 —— 前端同步時本來就已經把檔案下載到手上了，
      // 讓它順手上傳一份，比 Worker 再往 Drive 抓第二次省。
      if (method === "PUT" && pathname.startsWith("/api/tracks/raw/")) {
        const dayKey = decodeURIComponent(pathname.slice("/api/tracks/raw/".length));
        if (!dayKey) {
          return new Response(JSON.stringify({ error: "dayKey is required" }), { status: 400, headers });
        }
        const xml = await request.text();
        if (!xml.trim()) {
          return new Response(JSON.stringify({ error: "內容是空的" }), { status: 400, headers });
        }
        // key 用 encodeURIComponent 包起來：day_key 就是 Drive 檔名，
        // 不保證不含斜線之類會在 R2 裡長出假目錄的字元
        const rawKey = `tracks/${encodeURIComponent(dayKey)}.gpx`;
        await env.BUCKET.put(rawKey, xml, {
          httpMetadata: { contentType: "application/gpx+xml" },
        });
        // 這一天可能還沒 ingest（先存檔再寫點），所以用 UPDATE 而不是要求列已存在；
        // 影響 0 列也不算錯，ingest 之後再存一次就補上了
        await env.DB.prepare(
          "UPDATE TrackDay SET raw_key = ? WHERE day_key = ?"
        ).bind(rawKey, dayKey).run();
        return new Response(JSON.stringify({ success: true, dayKey, rawKey }), { headers });
      }

      /*
       * 路由：把一段軌跡送去 Valhalla 做 map matching（貼路），純轉手。
       *
       * 為什麼要繞 Worker 而不是讓前端直打：
       *   1. 隱私 —— 對方看到的是 Cloudflare 的 IP，不是使用者家裡的。
       *      送出去的是一串座標，等同完整行蹤，起點終點通常就是住家。
       *   2. FOSSGIS 條款要求服務網址不可以硬寫進 app，得能隨時換掉或關掉。
       *   3. 條款要求送出合法的 User-Agent，那是瀏覽器不給程式碼指定的標頭。
       *
       * Worker 這裡不解析回應內容，CPU 幾乎為零；解析與抽時間戳都在瀏覽器做。
       * 速率限制（每秒 1 次）由前端負責排隊 —— 那裡才知道總共要跑幾段。
       */
      if (method === "POST" && pathname === "/api/tracks/match") {
        if (!(await isAuthorized(request, env))) {
          return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers });
        }
        if (!env.VALHALLA_URL) {
          return new Response(JSON.stringify({
            error: "尚未設定 VALHALLA_URL，軌跡貼路功能未啟用",
          }), { status: 503, headers });
        }

        const body: any = await request.json().catch(() => ({}));
        const shape = (Array.isArray(body?.shape) ? body.shape : [])
          .filter((p: any) => isValidLatLng(p?.lat, p?.lon))
          .map((p: any) => ({ lat: p.lat, lon: p.lon }));
        if (shape.length < 2) {
          return new Response(JSON.stringify({ error: "至少要兩個點才能貼路" }), { status: 400, headers });
        }
        // Valhalla 對單次 trace 的點數有上限，而且點越多它算越久。
        // 貼路不需要 1Hz 的密度，前端會先抽稀到這個量級再送
        if (shape.length > 1000) {
          return new Response(JSON.stringify({ error: "單次最多 1000 點" }), { status: 400, headers });
        }
        // 白名單。這個值直接進第三方 API，而且錯的 costing 會貼到錯的路網上
        const COSTINGS = ['auto', 'bicycle', 'pedestrian', 'motorcycle', 'bus'];
        const costing = typeof body?.costing === 'string' && COSTINGS.includes(body.costing)
          ? body.costing : 'auto';

        const upstream = await fetch(`${env.VALHALLA_URL.replace(/\/+$/, '')}/trace_attributes`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            // 條款要求可識別的 User-Agent；X-Client-Id 是 Valhalla 維護者另外請求的
            "User-Agent": "didadida-photo-album (personal, https://github.com/)",
            "X-Client-Id": "didadida-photo-album",
          },
          body: JSON.stringify({
            shape,
            costing,
            // map_snap = 「這是一串 GPS 點，幫我貼到路上」。
            // 另一種 edge_walk 是給已經確定走在哪些路段的資料用的，不適用
            shape_match: "map_snap",
            // 只要形狀跟每個輸入點對到的位置，其餘屬性（速限、路名…）不必回，
            // 回應會小很多 —— 一天的軌跡差在幾百 KB
            // 屬性名是 'matched.point'（一個帶 lat/lon 的物件），不是
            // 'matched.point.lat' —— 寫成後者不會報錯，只會安靜地回一批
            // 只有 type 沒有座標的點，然後貼路整個算不出來
            filters: {
              attributes: ["shape", "matched.point", "matched.type"],
              action: "include",
            },
          }),
        });

        // 對方是單一台志工維護的伺服器，明文寫「不保證可用性」。
        // 壞掉的時候要讓前端安靜退回原本的線，所以錯誤原封不動往上傳
        const text = await upstream.text();
        return new Response(text, {
          status: upstream.ok ? 200 : 502,
          headers: { ...headers, "Content-Type": "application/json" },
        });
      }

      /*
       * 路由：讀 / 寫貼路後的軌跡。
       *
       * 存 R2 不存 D1：貼路的結果是密集的道路幾何，一天可以到上萬點，
       * 寫進 D1 會吃掉免費方案每日 10 萬列的寫入額度。而且它是衍生資料，
       * 掉了重跑一次就有，不值得佔資料庫。
       *
       * 沒有另開 matched_key 欄位 —— key 由 day_key 直接推得，
       * 拿不到就是還沒貼過，用 404 表示，省一次 schema 異動。
       */
      if (method === "GET" && pathname.startsWith("/api/tracks/matched/")) {
        const dayKey = decodeURIComponent(pathname.slice("/api/tracks/matched/".length));
        if (!dayKey) {
          return new Response(JSON.stringify({ error: "dayKey is required" }), { status: 400, headers });
        }
        // 軌跡一律要登入，貼路結果也是 —— 它就是從那些點推出來的
        if (!(await isAuthorized(request, env))) {
          return new Response(JSON.stringify({ error: "Not found" }), { status: 404, headers });
        }
        const object = await env.BUCKET.get(matchedKey(dayKey));
        if (!object) {
          return new Response(JSON.stringify({ error: "這一天還沒有貼路軌跡" }), { status: 404, headers });
        }
        return new Response(object.body, {
          headers: { ...headers, "Content-Type": "application/json" },
        });
      }

      if (method === "PUT" && pathname.startsWith("/api/tracks/matched/")) {
        if (!(await isAuthorized(request, env))) {
          return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers });
        }
        const dayKey = decodeURIComponent(pathname.slice("/api/tracks/matched/".length));
        if (!dayKey) {
          return new Response(JSON.stringify({ error: "dayKey is required" }), { status: 400, headers });
        }
        const json = await request.text();
        if (!json.trim()) {
          return new Response(JSON.stringify({ error: "內容是空的" }), { status: 400, headers });
        }
        await env.BUCKET.put(matchedKey(dayKey), json, {
          httpMetadata: { contentType: "application/json" },
        });
        return new Response(JSON.stringify({ success: true, dayKey }), { headers });
      }

      if (method === "DELETE" && pathname.startsWith("/api/tracks/matched/")) {
        if (!(await isAuthorized(request, env))) {
          return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers });
        }
        const dayKey = decodeURIComponent(pathname.slice("/api/tracks/matched/".length));
        if (!dayKey) {
          return new Response(JSON.stringify({ error: "dayKey is required" }), { status: 400, headers });
        }
        await env.BUCKET.delete(matchedKey(dayKey));
        return new Response(JSON.stringify({ success: true, dayKey }), { headers });
      }

      // 路由：寫入解析後的軌跡點
      // 冪等：同一個 day_key 重灌就是整批換掉，所以重複同步不會長出重複的點
      if (method === "POST" && pathname === "/api/tracks/ingest") {
        const body: any = await request.json().catch(() => ({}));
        const dayKey = typeof body?.dayKey === 'string' ? body.dayKey.trim() : '';
        if (!dayKey) {
          return new Response(JSON.stringify({ error: "dayKey is required" }), { status: 400, headers });
        }

        const rawPoints = Array.isArray(body?.points) ? body.points : [];
        // 上限擋的是「一次匯入十年份時間軸」那種會直接吃掉整天 D1 寫入額度的情況
        if (rawPoints.length > 20000) {
          return new Response(JSON.stringify({ error: "單次最多 20000 點" }), { status: 400, headers });
        }

        const points = rawPoints
          .filter((p: any) => isValidLatLng(p?.lat, p?.lng) && typeof p?.t === 'string' && p.t)
          .map((p: any) => ({
            t: p.t,
            lat: p.lat,
            lng: p.lng,
            src: typeof p.src === 'string' ? p.src : null,
            hdop: Number.isFinite(p?.hdop) ? p.hdop : null,
            seg: Number.isFinite(p?.seg) ? Math.trunc(p.seg) : 0,
            // 停留秒數由瀏覽器的 collapseStays 算好，這裡只收。0 或負數視同沒有
            staySec: Number.isFinite(p?.staySec) && p.staySec > 0 ? Math.trunc(p.staySec) : null,
          }));

        const stmts: D1PreparedStatement[] = [
          env.DB.prepare(
            `INSERT INTO TrackDay (day_key, ingest_source, drive_file_id, md5, point_count, tz_offset_minutes)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(day_key) DO UPDATE SET
               ingest_source = excluded.ingest_source,
               drive_file_id = excluded.drive_file_id,
               md5 = excluded.md5,
               point_count = excluded.point_count,
               tz_offset_minutes = excluded.tz_offset_minutes,
               synced_at = CURRENT_TIMESTAMP`
          ).bind(
            dayKey,
            typeof body?.ingestSource === 'string' ? body.ingestSource : 'gpslogger',
            body?.driveFileId ?? null,
            body?.md5 ?? null,
            points.length,
            isValidTzOffset(body?.tzOffsetMinutes) ? body.tzOffsetMinutes : null,
          ),
          env.DB.prepare("DELETE FROM TrackPoint WHERE day_key = ?").bind(dayKey),
        ];

        for (const p of points) {
          stmts.push(env.DB.prepare(
            "INSERT INTO TrackPoint (day_key, t_utc, lat, lng, src, hdop, seg, stay_sec) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
          ).bind(dayKey, p.t, p.lat, p.lng, p.src, p.hdop, p.seg, p.staySec));
        }

        await env.DB.batch(stmts);
        // 點整批換掉了，之前貼路的結果就對不上了。留著會讓地圖畫出一條
        // 跟現有軌跡無關的線，比沒有更糟 —— 直接丟掉，要用再貼一次
        await env.BUCKET.delete(matchedKey(dayKey));
        return new Response(JSON.stringify({
          success: true,
          dayKey,
          inserted: points.length,
          skipped: rawPoints.length - points.length,
        }), { headers });
      }

      // 路由：取得軌跡點供地圖繪製
      //
      // **一律要登入。** 軌跡是「我每天幾點在哪裡」的連續紀錄，訪客一個點都拿不到。
      // TrackDay.is_private 因此不再影響對外可見性（欄位留著，只當管理端的標記）。
      // 擋在這裡而不是前端不畫 —— 後者按 F12 就能從 JSON 看到經緯度。
      if (method === "GET" && pathname === "/api/tracks") {
        if (!(await isAuthorized(request, env))) {
          return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers });
        }
        const conds: string[] = [];
        const binds: any[] = [];

        const qFrom = url.searchParams.get("from");
        if (qFrom) { conds.push("p.t_utc >= ?"); binds.push(qFrom); }
        const qTo = url.searchParams.get("to");
        if (qTo) { conds.push("p.t_utc <= ?"); binds.push(qTo); }
        const qDay = url.searchParams.get("day_key");
        if (qDay) { conds.push("p.day_key = ?"); binds.push(qDay); }

        const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
        // 一定要有上限。軌跡一天就好幾百點，不設限的話「不選日期直接進地圖頁」
        // 會把好幾年份一次讀出來，D1 免費額度的每日讀取列數撐不住。
        const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 20000, 1), 50000);
        const { results } = await env.DB.prepare(`
          SELECT p.id, p.day_key, p.t_utc, p.lat, p.lng, p.src, p.seg, p.stay_sec
          FROM TrackPoint p
          JOIN TrackDay d ON d.day_key = p.day_key
          ${where}
          ORDER BY p.t_utc DESC
          LIMIT ?
        `).bind(...binds, limit).all();

        // 取最近的 N 點，但回傳仍要按時間遞增 —— 前端畫線與分段都假設是遞增的
        return new Response(JSON.stringify((results as any[]).reverse()), { headers });
      }

      // 路由：手動編修軌跡點（刪除、合併）
      //
      // 刪除與合併是同一個操作的兩種用法：合併就是「刪掉 N 個點，插入質心上的
      // 兩個點（進入、離開）」，跟匯入時的停留點濃縮產生的形狀完全一樣。
      // 質心與時間由前端算好送過來 —— Worker 只做 I/O，跟 GPX 解析放在瀏覽器同一個理由。
      if (method === "POST" && pathname === "/api/tracks/points/edit") {
        if (!(await isAuthorized(request, env))) {
          return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers });
        }
        const body: any = await request.json().catch(() => ({}));
        const dayKey = typeof body?.dayKey === 'string' ? body.dayKey.trim() : '';
        if (!dayKey) {
          return new Response(JSON.stringify({ error: "dayKey is required" }), { status: 400, headers });
        }

        const deleteIds = (Array.isArray(body?.deleteIds) ? body.deleteIds : [])
          .filter((n: any) => Number.isFinite(n)).map((n: any) => Math.trunc(n));
        const insert = (Array.isArray(body?.insert) ? body.insert : [])
          .filter((p: any) => isValidLatLng(p?.lat, p?.lng) && typeof p?.t === 'string' && p.t)
          .map((p: any) => ({
            t: p.t,
            lat: p.lat,
            lng: p.lng,
            src: typeof p.src === 'string' ? p.src : null,
            seg: Number.isFinite(p?.seg) ? Math.trunc(p.seg) : 0,
            staySec: Number.isFinite(p?.staySec) && p.staySec > 0 ? Math.trunc(p.staySec) : null,
          }));

        if (deleteIds.length === 0 && insert.length === 0) {
          return new Response(JSON.stringify({ error: "沒有要變更的內容" }), { status: 400, headers });
        }
        // 一次刪太多通常是前端選取邏輯出錯，而不是使用者真的想這麼做
        if (deleteIds.length > 5000) {
          return new Response(JSON.stringify({ error: "單次最多刪除 5000 點" }), { status: 400, headers });
        }

        const stmts: D1PreparedStatement[] = [];
        if (deleteIds.length > 0) {
          // 一定要同時比對 day_key：否則帶著別天的 id 進來就能刪掉任意軌跡點。
          // 上限是 5000 點，遠超過 D1 一句 100 個綁定參數的限制，一定要切塊
          for (const c of chunkIds(deleteIds, 1)) {
            stmts.push(env.DB.prepare(
              `DELETE FROM TrackPoint WHERE day_key = ? AND id IN (${placeholdersFor(c)})`
            ).bind(dayKey, ...c));
          }
        }
        for (const p of insert) {
          stmts.push(env.DB.prepare(
            "INSERT INTO TrackPoint (day_key, t_utc, lat, lng, src, hdop, seg, stay_sec) VALUES (?, ?, ?, ?, ?, NULL, ?, ?)"
          ).bind(dayKey, p.t, p.lat, p.lng, p.src, p.seg, p.staySec));
        }
        // 改成 'manual' 之後，前端的「立即同步足跡」預設會跳過這一天 ——
        // 重灌是整批刪掉再寫入，會把這裡的手工修改一起洗掉
        stmts.push(env.DB.prepare(
          `UPDATE TrackDay
           SET ingest_source = 'manual',
               point_count = (SELECT COUNT(*) FROM TrackPoint WHERE day_key = ?)
           WHERE day_key = ?`
        ).bind(dayKey, dayKey));

        await env.DB.batch(stmts);
        // 同 ingest：軌跡點動過，貼路的結果就過期了
        await env.BUCKET.delete(matchedKey(dayKey));
        return new Response(JSON.stringify({
          success: true, dayKey, deleted: deleteIds.length, inserted: insert.length,
        }), { headers });
      }

      /*
       * ---- Google 時間軸紀念層 ----
       *
       * 一律要登入才讀得到，連 GET 也是。/api/tracks 那套 is_private 逐日旗標
       * 在這裡沒有對應物（資料不在 D1，沒有地方掛旗標），而這一層是十二年
       * 不間斷的完整移動史 —— 沒有把它公開的合理預設。
       *
       * 原始的匯出檔本身永遠不會上傳：瀏覽器只送解析後的座標，
       * placeId、semanticType（含 INFERRED_HOME/WORK）、WiFi 掃描都不讀。
       */
      if (method === "GET" && pathname === "/api/timeline/index") {
        if (!(await isAuthorized(request, env))) {
          return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers });
        }
        const object = await env.BUCKET.get(TIMELINE_INDEX_KEY);
        // 還沒匯入過不是錯誤，回空索引讓前端不用區分這兩種情況
        if (!object) {
          return new Response(JSON.stringify({ months: [] }), { headers });
        }
        return new Response(object.body, {
          headers: { ...headers, "Content-Type": "application/json" },
        });
      }

      if (method === "PUT" && pathname === "/api/timeline/index") {
        if (!(await isAuthorized(request, env))) {
          return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers });
        }
        const body: any = await request.json().catch(() => null);
        if (!body || !Array.isArray(body.months)) {
          return new Response(JSON.stringify({ error: "months 必須是陣列" }), { status: 400, headers });
        }
        // 只留認得的欄位再存回去，索引才不會變成什麼都能塞的垃圾桶
        const months = body.months
          .filter((m: any) => typeof m?.monthKey === 'string' && TIMELINE_MONTH_RE.test(m.monthKey))
          .map((m: any) => ({
            monthKey: m.monthKey,
            points: Number.isFinite(m?.points) ? Math.trunc(m.points) : 0,
            days: Number.isFinite(m?.days) ? Math.trunc(m.days) : 0,
          }))
          .sort((a: any, b: any) => a.monthKey.localeCompare(b.monthKey));

        await env.BUCKET.put(TIMELINE_INDEX_KEY, JSON.stringify({
          months, updatedAt: new Date().toISOString(),
        }), { httpMetadata: { contentType: "application/json" } });
        return new Response(JSON.stringify({ success: true, months: months.length }), { headers });
      }

      if (method === "GET" && pathname.startsWith("/api/timeline/month/")) {
        if (!(await isAuthorized(request, env))) {
          return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers });
        }
        const month = pathname.slice("/api/timeline/month/".length);
        if (!TIMELINE_MONTH_RE.test(month)) {
          return new Response(JSON.stringify({ error: "月份格式必須是 YYYY-MM" }), { status: 400, headers });
        }
        const object = await env.BUCKET.get(timelineMonthKey(month));
        if (!object) {
          return new Response(JSON.stringify({ error: "這個月份還沒有資料" }), { status: 404, headers });
        }
        return new Response(object.body, {
          headers: { ...headers, "Content-Type": "application/json" },
        });
      }

      /*
       * 匯入是「整包覆蓋」而不是增量：Google 每次匯出的都是 2014 年到今天的
       * 全量 dump，不是新增的部分。所以這裡不做 md5 比對、不找差異，
       * 重上傳就是同一個 key 再 put 一次。
       */
      if (method === "PUT" && pathname.startsWith("/api/timeline/month/")) {
        if (!(await isAuthorized(request, env))) {
          return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers });
        }
        const month = pathname.slice("/api/timeline/month/".length);
        if (!TIMELINE_MONTH_RE.test(month)) {
          return new Response(JSON.stringify({ error: "月份格式必須是 YYYY-MM" }), { status: 400, headers });
        }
        const json = await request.text();
        if (json.length > TIMELINE_MONTH_MAX_BYTES) {
          return new Response(JSON.stringify({ error: "單月資料過大" }), { status: 413, headers });
        }
        // 存進去之前先確認它真的是 JSON —— R2 不會幫忙驗，
        // 壞掉的內容要等到幾個月後有人打開地圖才會發現
        let parsed: any;
        try {
          parsed = JSON.parse(json);
        } catch {
          return new Response(JSON.stringify({ error: "內容不是合法的 JSON" }), { status: 400, headers });
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          return new Response(JSON.stringify({ error: "內容必須是 { 日期: 點陣列 } 的物件" }), { status: 400, headers });
        }
        await env.BUCKET.put(timelineMonthKey(month), json, {
          httpMetadata: { contentType: "application/json" },
        });
        return new Response(JSON.stringify({
          success: true, month, days: Object.keys(parsed).length,
        }), { headers });
      }

      return new Response(JSON.stringify({ error: "Not Found" }), { status: 404, headers });
    } catch (error: any) {
      console.error("API Error: ", error.message, error.stack);
      return new Response(JSON.stringify({ error: error.message }), { status: 500, headers });
    }
  },

  /**
   * Cron：清 Drive 待搬佇列的尾巴。
   *
   * 刪除當下已經會搬掉前幾個，這裡負責整本相簿刪除留下的長尾。一次仍然只搬
   * 一小批 —— 免費版單次呼叫 50 個 subrequest，一個檔要兩次 Drive 往返。
   * 佇列空的時候這支只花一個 D1 查詢，一天 288 次對免費額度沒感覺。
   *
   * 本機 `wrangler dev` 不會自己跑 cron，要測就打 http://localhost:8787/__scheduled
   */
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      drainDriveTrash(env, 20)
        .then((r) => {
          if (r.ok && (r.moved > 0 || r.failed.length > 0)) {
            console.log(`Drive 待搬：搬走 ${r.moved}，失敗 ${r.failed.length}，還剩 ${r.remaining}`);
          }
        })
        .catch((e) => console.error("Drive 待搬佇列（cron）", e))
    );
  },
};
