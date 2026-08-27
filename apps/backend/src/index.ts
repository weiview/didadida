import {
  normalizeGeo, formatWallClock, utcFromLocal,
  parseExifDateTime, geoOverwriteGuard, DEFAULT_TZ_OFFSET_MINUTES,
} from './geo';
import {
  listGpxFiles, listSharedFolders, fetchDriveMedia, fetchDriveMediaRange,
  moveDriveFile, renameDriveFolder, serviceAccountEmail,
  listFolderFiles, probeDriveFile,
} from './drive';
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
  /*
   * 這裡以前有 DRIVE_WRITER_REFRESH_TOKEN（站長的 Drive 寫入 refresh token）。
   * **2026-08-21 移除**：它跟 `User.google_refresh_token`（0017）是同一個東西，
   * 而多出來的那份會**擋住自癒** —— 判斷「登入要不要跳同意畫面」看的是「有沒有值」，
   * secret 只要還在（哪怕 Google 早就回 invalid_grant）站長就再也跳不出同意畫面。
   * 實際卡死過：畫面叫站長重新登入，但登入這條路永遠補不回那份授權。
   * 見 driveWriterOwner()。遠端的 secret 已經一併刪掉，設了也沒有人會讀。
   */
  /**
   * 照片主檔資料夾 `didadida/` 的覆寫。**平常不必設** —— 正常情況是網頁第一次
   * 上傳時自己建資料夾、把 id 存進 AppSetting。設了就以這裡為準，
   * 用途是把某個環境臨時指到別的資料夾
   */
  GOOGLE_DRIVE_PHOTOS_FOLDER_ID?: string;
  /** `didadida/trash/` 的覆寫。同上 */
  GOOGLE_DRIVE_TRASH_FOLDER_ID?: string;
  /**
   * 這個環境在 Drive 上的根資料夾名稱（`wrangler.toml` 的 `[vars]`，不是機密）。
   *
   * 三個環境全都寫進**同一個** Drive（站長的），所以名字必須分開，
   * 否則 `findOwnFolder` 會照名字找到別的環境那一個，資料就混在一起了：
   * local `local.didadida` / dev `dev.didadida` / prod `didadida`。
   * 沒設的話由 driveRootFolderName() 依請求的 hostname 判斷。
   */
  DRIVE_ROOT_FOLDER?: string;
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
 * Drive 的寫入身分以前在這裡有三個 AppSetting 鍵（drive_writer_refresh_token /
 * _email / _linked_at）。**2026-08-21 全部移除**，改讀站長那一列的
 * `User.google_refresh_token`。見 driveWriterOwner()。
 */
/**
 * 訪客看不看得到足跡地圖。**預設關**（沒有這一列就是關）。
 *
 * 為什麼是全站一個開關而不是每個訪客一個：訪客共用同一把 `GUEST_PASSWORD`，
 * 根本沒有「這個訪客」這種東西可以掛設定。
 */
const SETTING_GUEST_MAP = "guest_can_view_map";
/**
 * 訪客看不看得到照片留言。**預設關**，理由同上面那個開關，再加一條隱私：
 * 留言一定帶著留言者的顯示名稱，開了就等於把家人的名字給任何知道訪客密碼的人。
 *
 * 訪客**永遠寫不了**留言，那不是開關 —— Comment.user_id 是 NOT NULL 指向 User，
 * 訪客在 D1 裡沒有對應的列（見 migrations/0013）。
 */
const SETTING_GUEST_COMMENTS = "guest_can_view_comments";
/**
 * 地圖上「兩個人這一趟算不算一起出遊」的重疊率門檻，單位是百分比。
 * 沒設過＝`CONVOY_PCT_DEFAULT`。
 *
 * 為什麼是全站一格而不是每個人一欄：它問的是「這兩條路像不像同一條」，
 * 是判定規則的靈敏度，不是誰的偏好 —— 同一天同一段路，A 看跟 B 看必須是同一個答案，
 * 不然兩個人在講同一趟旅行時會看到不同的隊形。
 *
 * 實際的重疊計算全在瀏覽器（貼路結果本來就在前端手上），後端只保管這個數字。
 */
const SETTING_CONVOY_PCT = "convoy_overlap_pct";
/** 預設 70%：真正同車的貼路重疊通常 >90%，留給停車場、路口岔開很多餘裕 */
const CONVOY_PCT_DEFAULT = 70;
/** 低於 30% 等於「路過就算同遊」，高於 100 無意義。站長調得動的範圍 */
const CONVOY_PCT_MIN = 30;
const CONVOY_PCT_MAX = 100;
/**
 * 不開放的照片要不要**連看得到的人也先糊掉**。**預設關**（沒有這一列就是關）。
 *
 * ⚠️ 這跟「不要做馬賽克 UI」那條規矩不衝突，因為對象完全不同：
 *   - 沒權限的人 → 那一格**整個不存在**（SQL 就濾掉了）。端出一格馬賽克等於
 *     告訴他「這裡有一張你不能看的照片」，那才是被禁止的做法。
 *   - 看得到的人（站長與 can_manage_others）→ 這個開關管的是他們自己那一份。
 *     用途是「旁邊有人的時候不要一捲就整片跳出來」，不是權限。
 *
 * 所以這個值**只發給看得到不開放照片的人**（見 /api/auth/me）——
 * 對其他人它連存在都不必存在，也省掉一次設定讀取。
 * 遮罩本身純粹在瀏覽器（CSS filter），後端不因此少送任何位元組。
 */
const SETTING_RESTRICTED_BLUR = "restricted_blur";

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

/*
 * ── 媒體的簽章網址 ────────────────────────────────────────────────────────
 *
 * `<img src>` 與 `<video src>` 不會帶 Authorization，所以媒體路由沒辦法靠進站閘門
 * 那張 token 保護。原本的護欄是「網址猜不到」—— R2 的物件鍵帶時間戳與亂數、
 * 頭像檔名帶亂數，那個護欄在它們身上是成立的。
 *
 * ⚠️ 但 `/api/photos/:id/full` 吃的是 **AUTOINCREMENT 的流水號**，「猜不到」這件事
 *    在它身上從來沒成立過：任何台灣 IP 不必帶 token，從 1 數上去就能把整個站的
 *    Drive 4K 原圖抓完。這一組簽章補的就是那個洞。
 *
 * 為什麼是「一張站上通行的媒體 token」，不是「每張照片一組簽章」：
 * 相簿內容那支路由**不分頁**（5000 張的相簿一次回完），逐張簽等於一次請求裡跑
 * 5000 趟 crypto.subtle.sign —— 遠超單次 10ms CPU。而 /full 回的是圖片位元組，
 * 內容不隨身分變化（沒有 applyGeoPrivacy 那種洩漏問題），所以「證明你進得了站」
 * 就是剛好的粒度：擋掉的是完全沒有 token 的人，而那正是這個洞。
 *
 * 有效期跟進站 token 同一個 7 天。它是跟著 `/api/auth/me` 一起發的，不可能活得比
 * 拿到它的那張 token 久 —— 也就不需要另一套續期邏輯，每次進站就換一張新的。
 *
 * ⚠️ 驗過之後**一定要把 mt 從 cache key 裡拿掉**（見 /full 那條路由）。留著的話
 *    每個人、每次登入都是一份獨立的邊緣快取，Drive 取檔次數直接乘上人數。
 */
const MEDIA_TOKEN_TTL_SEC = 86400 * 7;

/*
 * 票有**兩種粒度**（0020 起）。
 *
 * 一般的那張還是「不綁人」—— 它只證明「這個網址是站上發出來的」，內容不隨身分
 * 變化的照片共用同一份邊緣快取，這是刻意的（綁人＝每個人一份快取，Drive 取檔
 * 次數直接乘上人數）。
 *
 * 升級版那張多證明一件事：**持票人可以管理全站內容**。它只在一個地方有差別 ——
 * 被標成「不開放」的那幾張（Photo.restricted），一般票拿不到位元組。
 * 為什麼不是每張不開放的照片各簽一組：那要在相簿內容那支不分頁的路由裡逐張簽，
 * 5000 張就是 5000 趟 HMAC，遠超單次 10ms CPU（跟當初決定發「一張通行票」
 * 是同一個理由）。
 *
 * 代價講清楚：升級票發出去之後**七天內不會因為權限被撤而失效**。撤掉權限的
 * 下一秒，那個人手上那張還能取得不開放照片的位元組，直到過期或重新登入換票。
 * 進站 token 本身沒有這個問題（每次都回頭查 D1），是這張刻意不查 D1 的票才有。
 * 要修得讓 /full 每次都 currentActor()，那就等於為了少數幾張照片，讓每一張大圖
 * 都多一次 D1 讀取 —— 不划算。
 */
type MediaScope = 'none' | 'basic' | 'admin';

/**
 * 簽章的內容：到期時間 ＋ 粒度。
 * 粒度一定要進 payload，否則把升級票尾巴那個 `.a` 拔掉／加上就換了一個粒度。
 */
const mediaTokenPayload = (exp: string, scope: 'basic' | 'admin') =>
  scope === 'admin' ? `media:admin:${exp}` : `media:${exp}`;

async function mediaHmacKey(env: Env, usage: "sign" | "verify"): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw", new TextEncoder().encode(env.APP_PASSWORD),
    { name: "HMAC", hash: "SHA-256" }, false, [usage],
  );
}

/**
 * 發一張媒體 token。
 *
 * 格式 `<到期的 epoch 秒>.<base64url 的 HMAC>`，升級票在尾巴多一段 `.a`。
 * **刻意讓一般票的格式一個字都沒變** —— 已經躺在家人瀏覽器 localStorage 裡的
 * 那些票在這次部署之後照樣驗得過，不會有一段「大圖全破」的空窗。
 */
async function mintMediaToken(env: Env, scope: 'basic' | 'admin' = 'basic'): Promise<string> {
  const exp = String(Math.floor(Date.now() / 1000) + MEDIA_TOKEN_TTL_SEC);
  const key = await mediaHmacKey(env, "sign");
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(mediaTokenPayload(exp, scope)));
  const b64 = btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return scope === 'admin' ? `${exp}.${b64}.a` : `${exp}.${b64}`;
}

/**
 * 驗一張媒體 token，回傳它的粒度。沒帶、格式不對、過期、簽章不符一律 'none'。
 *
 * 粒度是由票尾巴那段自己宣告、再拿去驗簽的 —— 宣告成 admin 但簽的是一般票，
 * 驗簽當場就不過，所以自稱不會變成事實。
 */
async function verifyMediaToken(raw: string | null, env: Env): Promise<MediaScope> {
  if (!raw) return 'none';
  const parts = raw.split(".");
  if (parts.length !== 2 && !(parts.length === 3 && parts[2] === "a")) return 'none';
  const [exp, sig] = parts;
  if (!exp || !sig) return 'none';
  const scope: 'basic' | 'admin' = parts.length === 3 ? 'admin' : 'basic';
  // 先看到期再驗簽：過期的不必花 CPU 算 HMAC
  if (!/^\d+$/.test(exp) || Number(exp) < Math.floor(Date.now() / 1000)) return 'none';
  try {
    const key = await mediaHmacKey(env, "verify");
    const sigBytes = Uint8Array.from(
      atob(sig.replace(/-/g, "+").replace(/_/g, "/")),
      c => c.charCodeAt(0),
    );
    const ok = await crypto.subtle.verify(
      "HMAC", key, sigBytes, new TextEncoder().encode(mediaTokenPayload(exp, scope)));
    return ok ? scope : 'none';
  } catch {
    return 'none';
  }
}

/**
 * 同一個 request 只驗一次簽。
 *
 * 閘門驗過一次，/full 那條路由還要再問一次「這張票是不是升級版」——
 * 沒有這層 memo 就是同一個請求算兩趟 HMAC。理由與作法跟 actorCache 一樣。
 */
const mediaScopeCache = new WeakMap<Request, Promise<MediaScope>>();

function requestMediaScope(request: Request, url: URL, env: Env): Promise<MediaScope> {
  const cached = mediaScopeCache.get(request);
  if (cached) return cached;
  const pending = verifyMediaToken(url.searchParams.get("mt"), env);
  mediaScopeCache.set(request, pending);
  return pending;
}

/**
 * 這個路徑是不是「靠簽章網址進來」的媒體路由。
 *
 * **只有這張表上的路徑認 mt** —— 一張 mt 不可以拿去讀相簿 JSON、留言或軌跡，
 * 它證明的只是「這個網址是站上發出來的」，不是一個身分。
 * 再加路徑進來要一條一條寫，不要改成 startsWith("/api/photos/") 之類的寬鬆比對。
 *
 * `/video` 跟 `/full` 同一個理由在這裡：<video src> 一樣不會帶 Authorization，
 * 而它吃的也是同一組流水號。
 */
function isSignedMediaPath(pathname: string): boolean {
  return /^\/api\/photos\/\d+\/(full|video)$/.test(pathname);
}

/**
 * 地圖上每個人的軌跡顏色。固定調色盤，家人自己從裡面挑一個（見 PUT /api/me）。
 *
 * 為什麼是固定清單而不是自由取色：這幾個顏色是挑過的 —— 在 OpenFreeMap positron
 * 底圖上彼此分得開、也不會跟道路／水域／行政區界撞色。開放任意 hex 的話，
 * 有人選了淺灰就等於他的軌跡消失了。
 *
 * 第一個是紫色，也就是原本貼路線的顏色 —— uid 1 沒挑過色時退回的預設值，
 * 讓既有畫面在這次改動前後長得一樣。
 *
 * **前端有一份同樣的清單**（`apps/frontend/src/lib/trackColors.ts`），色票列要畫得出來。
 * 兩邊要一起改。
 */
const TRACK_PALETTE = [
  '#7c3aed', // 紫（原本的貼路線）
  '#2563eb', // 藍
  '#0d9488', // 青
  '#16a34a', // 綠
  '#ca8a04', // 芥末黃
  '#ea580c', // 橘
  '#db2777', // 桃紅
  '#dc2626', // 紅
  '#0891b2', // 天藍
  '#65a30d', // 草綠
] as const;

/**
 * 這個人在地圖上該是什麼顏色。
 *
 * 沒挑過色（`track_color` 是 NULL）也一定要有一個 —— 而且**不能所有人同色**，
 * 不然多身分足跡在沒人動過設定之前完全看不出誰是誰。依 uid 輪流分配，
 * 家庭規模（≤ 10 人）內不會重複。
 *
 * 後端一律回**算好的顏色**，前端不必再做一次退讓；代價是分不出「他挑的就是紫」
 * 跟「他沒挑，預設是紫」—— 那個差別對畫面沒有意義。
 */
function trackColorFor(uid: number | null, stored: string | null | undefined): string {
  if (stored) return stored;
  const n = uid && uid > 0 ? uid : 1;
  return TRACK_PALETTE[(n - 1) % TRACK_PALETTE.length];
}

/**
 * 使用者挑的顏色。null／空字串＝清掉（退回 trackColorFor 的預設）；
 * 不在調色盤裡就是 undefined（呼叫端回 400）。
 *
 * 只收清單內的值，理由同 TRACK_PALETTE 的註解：自由取色會讓人把自己調成看不見的。
 * 舊資料若存了清單外的顏色照樣畫得出來 —— 這裡擋的是寫入，不是讀取。
 */
function normalizeTrackColor(raw: unknown): string | null | undefined {
  if (raw == null) return null;
  const s = String(raw).trim().toLowerCase();
  if (!s) return null;
  return (TRACK_PALETTE as readonly string[]).includes(s) ? s : undefined;
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
  /**
   * 可以把照片**加進**別人建的相簿（上傳／從 Google 相簿匯入）。預設開。
   *
   * 跟 canManageOthers 分開的理由見 migrations/0010：加一張照片主人自己刪得掉，
   * 刪相簿、改名這些破壞性的動作不會因為這一欄而放行。
   */
  canAddToOthers: boolean;
  /** 可以調整別人相簿裡的照片順序。預設關 —— 那是相簿主人的版面 */
  canReorderOthers: boolean;
  /**
   * 可以留言／回覆。預設開（見 migrations/0013）。
   *
   * **不受 canManageOthers 短路**，跟上面那兩欄不一樣：留言不是「動別人的內容」，
   * 是自己發言。站長要能把一個嘴巴很吵的帳號單獨閉麥，而不必連帶收回他的管理權。
   */
  canComment: boolean;
  /** 看得到留言。預設開。關掉的人燈箱裡整塊留言區都不會出現，理由同上不短路 */
  canViewComments: boolean;
  /**
   * 看得到足跡地圖（照片座標＋家人的 GPS 軌跡）。預設開（見 migrations/0014）。
   *
   * 一樣**不受 canManageOthers 短路** —— 管不管得動別人的相簿，跟該不該看到
   * 家人「誰什麼時候在哪裡」的連續紀錄是兩回事。只有站長永遠是開的。
   */
  canViewMap: boolean;
  /**
   * 動得了軌跡資料的管理工具（見 migrations/0016）：Google 時間軸匯入、
   * Drive 同步足跡、手動上傳 GPX、貼路、改軌跡點。預設開，新加入的人由站長決定。
   *
   * **看與寫是兩件事** —— canViewMap 管的是看得到地圖，這一欄管的是寫得進去。
   * 一樣不受 canManageOthers 短路，只有站長永遠是開的。
   */
  canUseTools: boolean;
  /**
   * 他自己那個 GPSLogger Drive 資料夾（見 migrations/0009）。
   * 跟著 Actor 一起帶出來是因為它就在同一列上 —— 另外查一次是白花讀取額度。
   */
  trackFolderId: string | null;
  /**
   * 他的軌跡在地圖上的顏色。**永遠是算好的值**（沒挑過就依 uid 給預設，
   * 見 trackColorFor），所以拿到的一定不是 null。同一列上，理由同 trackFolderId。
   */
  trackColor: string;
  /**
   * 頭像的 R2 檔名（見 migrations/0015）。null ＝ 沒設過。
   * 要給前端的是網址，用 avatarUrl() 換 —— 這裡存的是檔名，同一列上順手帶出來。
   */
  avatarKey: string | null;
}

/* ── 頭像 ──────────────────────────────────────────────────────────────────
 *
 * 一張圖兩用（使用者定調）：留言區的圓形頭像 ＋ 地圖上坐在小車上的大頭。
 * 所以它是去背圖，前端縮到 256px 見方、保 alpha 之後才上傳（見 lib/avatar.ts）。
 *
 * D1 只存檔名，R2 鍵與對外網址都由這兩個函式拼 —— 檔名帶亂數尾碼，
 * 那是這條白名單路由唯一的護欄（詳見 migrations/0015 的註解）。
 */

/** R2 上的物件鍵 */
const avatarR2Key = (name: string) => `avatars/${name}`;

/** 對外網址。沒設頭像回 null，前端據此退回預設頭像 */
const avatarUrl = (host: string, name: string | null | undefined): string | null =>
  name ? `${host}/api/users/avatar/${name}` : null;

/**
 * 頭像檔名的白名單。**路徑穿越的唯一防線** —— 這個值會被接到 R2 鍵上，
 * 不擋的話 `../` 之類的東西可以撈到桶子裡的任何物件。
 */
const AVATAR_NAME_RE = /^[A-Za-z0-9_-]+\.(webp|png)$/;

/** 上傳上限。256px 見方的 WebP 通常 10～30KB，PNG 退路也不該超過這個數 */
const AVATAR_MAX_BYTES = 512 * 1024;

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
      "SELECT id, name, email, track_color, avatar_key, track_drive_folder_id FROM User WHERE role = 'owner' AND active = 1 ORDER BY id LIMIT 1"
    ).first<any>();
    if (owner) {
      return {
        uid: owner.id, email: owner.email, name: owner.name,
        isOwner: true, canManageOthers: true,
        canAddToOthers: true, canReorderOthers: true,
        canComment: true, canViewComments: true, canViewMap: true, canUseTools: true,
        trackFolderId: owner.track_drive_folder_id ?? null,
        trackColor: trackColorFor(owner.id, owner.track_color),
        avatarKey: owner.avatar_key ?? null,
      };
    }
    return {
      uid: null, email: identity.email, name: null,
      isOwner: true, canManageOthers: true,
      canAddToOthers: true, canReorderOthers: true,
      canComment: true, canViewComments: true, canViewMap: true, canUseTools: true, trackFolderId: null,
      trackColor: trackColorFor(null, null),
      avatarKey: null,
    };
  }

  const row = await env.DB.prepare(
    `SELECT id, name, email, role, can_manage_others, can_add_to_others, can_reorder_others,
            can_comment, can_view_comments, can_view_map, can_use_tools, notif_seen_at,
            active, track_color, avatar_key, track_drive_folder_id
       FROM User WHERE id = ?`
  ).bind(identity.uid).first<any>();
  // 列不見了或被移出白名單 —— 手上那張 token 立刻失效，不等它過期
  if (!row || Number(row.active) !== 1) return null;

  const isOwner = row.role === 'owner';
  const canManageOthers = isOwner || Number(row.can_manage_others) === 1;
  return {
    uid: row.id,
    email: row.email,
    name: row.name,
    isOwner,
    canManageOthers,
    // 全開的人不必再看細項；其餘照各自那一欄（0010 之前的舊列讀不到欄位＝NaN，
    // 那時 migration 還沒套，整站的寫入本來就會壞，不在這裡補救）
    canAddToOthers: canManageOthers || Number(row.can_add_to_others) === 1,
    canReorderOthers: canManageOthers || Number(row.can_reorder_others) === 1,
    // 留言那兩欄**不吃 canManageOthers 的短路**（見 Actor 的註解）。
    // 站長自己是例外 —— 他要看得到、也要講得了話，不然沒人管得動留言區
    canComment: isOwner || Number(row.can_comment) === 1,
    canViewComments: isOwner || Number(row.can_view_comments) === 1,
    canViewMap: isOwner || Number(row.can_view_map) === 1,
    canUseTools: isOwner || Number(row.can_use_tools) === 1,
    trackFolderId: row.track_drive_folder_id ?? null,
    trackColor: trackColorFor(row.id, row.track_color),
    avatarKey: row.avatar_key ?? null,
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

/*
 * ── 「不開放」的照片（0020）─────────────────────────────────────────────────
 *
 * Photo.restricted = 1 的那一格，**只有可管理全站內容的人看得到**（站長與
 * can_manage_others=1）。其餘成員與訪客眼中它整個不存在：相簿內容、搜尋、
 * 首頁的相簿預覽圖、足跡地圖、待補清單全部濾掉，大圖／影片的位元組也拿不到。
 *
 * ⚠️ 過濾**一定要寫在 SQL 的 WHERE 裡**，不可以查出來再於 Worker 裡篩掉 ——
 *    分頁的 LIMIT 會因此少給幾筆（前端看到的是「有下一頁但翻不出東西」），
 *    而且座標與隱私那條老規矩本來就是這樣（見 CLAUDE.md「一進來就該知道的坑」）。
 *
 * ⚠️ 相對地，**不要為它另外做一層「馬賽克／點不開」的 UI**。使用者要的是看不到，
 *    端出一格點下去說沒權限，等於告訴所有人「這裡有一張你不能看的照片」。
 */
const canSeeRestricted = (actor: Actor | null): boolean => !!actor?.canManageOthers;

/** WHERE 片段。用到它的 SQL 必須把 Photo 別名為 `p`（跟 LOCAL_TIME_EXPR 同一個規矩） */
const RESTRICTED_VISIBLE_COND = "p.restricted = 0";

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

/** 原始 GPX 在 R2 的 key。跟 matchedKey 同一套規則 */
const rawTrackKey = (dayKey: string) => `tracks/${encodeURIComponent(dayKey)}.gpx`;

/*
 * ---- 軌跡的 day_key 前綴 ----
 *
 * day_key 原本就是 Drive 上的檔名，而兩個家庭成員同一天都會產出
 * '20260813.gpx' —— ingest 是「整批刪掉再插入」，不加前綴就會互相洗掉。
 *
 * 前綴規則：**uid 1 無前綴，其餘 'u<uid>:'**。uid 1 是既有資料的擁有者，
 * 這是資料歷史而不是權限判斷，所以用 uid 而不是 role='owner'。
 * 詳細理由（為什麼不改主鍵、為什麼站長不加前綴）見 migrations/0009。
 *
 * 擁有權的唯一權威永遠是 TrackDay.user_id，前綴只負責讓 key 不撞。
 */
const TRACK_LEGACY_UID = 1;
const TRACK_KEY_PREFIX_RE = /^u(\d+):/;

/** 這個人的某個 Drive 檔名對應到哪個 day_key */
function trackDayKeyFor(uid: number | null, name: string): string {
  if (uid == null || uid === TRACK_LEGACY_UID) return name;
  return `u${uid}:${name}`;
}

/** 去掉前綴還原成 Drive 檔名。沒有前綴就原樣回傳 */
function stripTrackKeyPrefix(dayKey: string): string {
  return dayKey.replace(TRACK_KEY_PREFIX_RE, '');
}

/**
 * 這個 day_key 的字面上宣稱屬於誰。
 *
 * 只在資料庫還沒有這一列時當作意圖判讀（例如第一次同步），
 * **不是**授權依據 —— 有列的時候一律以 TrackDay.user_id 為準。
 */
function trackKeyClaimedUid(dayKey: string): number {
  const m = dayKey.match(TRACK_KEY_PREFIX_RE);
  return m ? Number(m[1]) : TRACK_LEGACY_UID;
}

/** 這一天的軌跡是誰的。找不到回 null（呼叫端要回 404 或當成新的一天） */
async function trackDayOwnership(env: Env, dayKey: string): Promise<{ user_id: any } | null> {
  return await env.DB.prepare("SELECT user_id FROM TrackDay WHERE day_key = ?").bind(dayKey).first<any>();
}

/**
 * 這個人的 GPSLogger 軌跡要去哪個 Drive 資料夾拿。沒綁定回 null。
 *
 * 每個人只能傳到**自己的** Drive —— GPSLogger 的 scope 只有 `drive.file`，
 * 看不到也寫不進別人建的資料夾（上游 issue #1173），所以「全家傳進站長的
 * Drive」在技術上不存在。各自把自己的資料夾分享給同一個 SA 信箱，
 * 站長在 /admin 綁定，這裡就查得到。
 *
 * uid 1 退回 `GOOGLE_DRIVE_FOLDER_ID` 環境變數：那是多身分之前就設好的站長資料夾，
 * 讓既有部署不必重設 secret 也不必去後台點一次。
 */
function trackFolderFor(env: Env, actor: Actor): string | null {
  if (actor.trackFolderId) return actor.trackFolderId;
  if (actor.uid == null || actor.uid === TRACK_LEGACY_UID) return env.GOOGLE_DRIVE_FOLDER_ID ?? null;
  return null;
}

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
 *
 * ---- 多身分（P1）----
 *
 * 每個人各自匯入自己的時間軸，所以 key 依 uid 分開放。規則跟 day_key 前綴一致：
 * **uid 1 用舊 key，其餘放進 `timeline/u<uid>/`** —— 站長既有的那包不必搬，
 * 而搬 R2 物件是要一個一個 copy + delete 的。
 *
 * 匯入語意仍然是「整包覆蓋」（Google 每次匯出都是 2014 年至今的全量 dump），
 * 只是現在各自覆蓋自己那一包。
 */
const timelineIndexKey = (uid: number | null) =>
  uid == null || uid === TRACK_LEGACY_UID ? 'timeline/index.json' : `timeline/u${uid}/index.json`;
const timelineMonthKey = (uid: number | null, month: string) =>
  uid == null || uid === TRACK_LEGACY_UID ? `timeline/${month}.json` : `timeline/u${uid}/${month}.json`;
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
    /**
     * 內容版本號，給了就併進 cache key。**帶得到不開放內容的清單一定要給** ——
     * 那是唯一能讓已經寫進邊緣快取的舊清單失效的辦法（見 bumpContentEpoch）。
     */
    epoch?: string | null;
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
  if (opts.epoch) keyUrl.searchParams.set("__v", opts.epoch);
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

/** 站上內容的版本號。推一格，所有共用的邊緣快取清單就整批失效（見 bumpContentEpoch） */
const SETTING_CONTENT_EPOCH = "content_epoch";

/**
 * 讀內容版本號。
 *
 * ⚠️ **刻意不走 getSettingCached** —— isolate 記憶體那份自己有 60 秒 TTL，而這個
 *    值存在的唯一理由就是「馬上生效」，再快取一層等於把要解的問題往後搬 60 秒。
 *
 * 代價是每一次**訪客**的清單請求多讀一列 AppSetting（主鍵單列）。這其實比縮短
 * 快取時間便宜：清單那幾支一次要掃幾百到幾千列，多讀一列換到的是「edgeMaxAge
 * 維持 300 秒」而不是被迫砍到 30 秒。成員本來就 skip 快取，一次都不會讀到。
 */
async function contentEpoch(env: Env): Promise<string> {
  return (await getSetting(env, SETTING_CONTENT_EPOCH)) || "0";
}

/**
 * 內容的「誰看得到」變了，把版本號往前推一格（目前只有「不開放」會呼叫）。
 *
 * 為什麼需要這個東西：`withEdgeCache` 只對**訪客**寫共用的邊緣快取（成員一律
 * skip），而 **Cache API 沒有辦法從程式裡精準清掉** —— `cache.delete` 只作用在
 * 當下這一個機房。所以做法不是去清舊的，而是**換一把 key 讓舊的再也沒有人問得到**，
 * 剩下的交給它自己過期。
 */
async function bumpContentEpoch(env: Env): Promise<void> {
  await setSetting(env, SETTING_CONTENT_EPOCH, String(Date.now()));
}

/** 訪客看不看得到足跡地圖。沒設定過＝關 */
async function guestCanViewMap(env: Env): Promise<boolean> {
  return (await getSettingCached(env, SETTING_GUEST_MAP)) === "1";
}

/**
 * 足跡相關路由的共同守門。回 `null` ＝放行，回 Response ＝直接把它送出去。
 *
 * ⚠️ **軌跡不吃 guest_can_view_map**：那個全站開關管的是 `/api/footprint`
 *    （照片落點），GPS 軌跡是連續的行蹤紀錄，敏感度差一級，一律限成員。
 *    所以這裡是「先要是成員（401），再看他那一欄（403）」兩段。
 *
 * currentActor 有 WeakMap 快取，同一個請求裡叫幾次都只查一次 D1。
 */
async function guardTrackAccess(
  request: Request, env: Env, headers: Record<string, string>,
): Promise<Response | null> {
  const actor = await currentActor(request, env);
  if (!actor) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers });
  }
  if (!actor.canViewMap) return forbidden(headers, "站長沒有開放你瀏覽足跡地圖");
  return null;
}

/*
 * 「這個人算不算足跡的參與者」的 SQL 片段（`u` 是 User 的別名）。
 *
 * 沒有工具權限的人**整個不出現在地圖上** —— 名字、篩選列、圖例、軌跡線、
 * 動畫上的車全都沒有（使用者定調 2026-08-20）。理由：他既然放不進東西，
 * 名字掛在圖例上只會讓人問「這條線是誰的」；而且他自己看到的畫面要跟
 * 別人看到的一樣，不然同一張地圖兩個人看到不同結果，日後很難解釋。
 *
 * ⚠️ **一定要在 SQL 裡濾**，不能撈回來再挑（同座標那條坑）—— 濾掉的是別人的
 * 行蹤，回應裡根本不該出現。
 * ⚠️ `d.user_id` 可能是 NULL（0009 之前的舊列，那些是站長的），**要放行**。
 */
const TRACK_MEMBER_COND = "(u.role = 'owner' OR u.can_use_tools = 1)";

/**
 * 會**動到軌跡資料**的路由再多擋一道（見 migrations/0016）。
 *
 * 用法是接在 guardTrackAccess 後面 —— 看不到地圖的人連這一關都走不到，
 * 而看得到的人不代表寫得進去。currentActor 是同一個請求的 WeakMap 快取，不多查 D1。
 *
 * 蓋到的是：Drive 掃描與同步、手動上傳 GPX、貼路、覆蓋／刪除貼路結果、
 * 改軌跡點、上傳 Google 時間軸。純讀取的那幾支（列出天數、拿軌跡、拿貼路結果）不擋。
 */
async function guardTrackTools(
  request: Request, env: Env, headers: Record<string, string>,
): Promise<Response | null> {
  const actor = await currentActor(request, env);
  if (!actor) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers });
  }
  if (!actor.canUseTools) return forbidden(headers, "站長沒有開放你使用足跡的管理工具");
  return null;
}

async function guestCanViewComments(env: Env): Promise<boolean> {
  return (await getSettingCached(env, SETTING_GUEST_COMMENTS)) === "1";
}

/**
 * 同遊判定的重疊率門檻（%）。讀不到、壞值、超出範圍一律退回預設 ——
 * 這個數字只是靈敏度，寧可安靜地用預設值，也不要讓地圖因為一格設定壞掉而不畫車。
 */
async function convoyOverlapPct(env: Env): Promise<number> {
  const n = Number(await getSettingCached(env, SETTING_CONVOY_PCT));
  if (!Number.isFinite(n) || n < CONVOY_PCT_MIN || n > CONVOY_PCT_MAX) return CONVOY_PCT_DEFAULT;
  return Math.round(n);
}

/**
 * 不開放的照片要不要對「看得到的人」也先蓋一層模糊。沒設過＝關。
 *
 * 走 getSettingCached（60 秒 memo）—— 它跟著 /api/auth/me 回去，
 * 而那一條是每個人每次進站都會打的。
 */
async function restrictedBlurOn(env: Env): Promise<boolean> {
  return (await getSettingCached(env, SETTING_RESTRICTED_BLUR)) === "1";
}

/** 留言內文上限。比 Story 的 200 寬，但別讓人在燈箱側欄貼一篇文章 */
const COMMENT_MAX_LEN = 1000;

/**
 * 從內文裡把 `@[123]` 挑出來。
 *
 * **刻意由後端自己解析，不收前端送來的 mentions 陣列** —— 那等於讓瀏覽器決定
 * 要通知誰，隨手改一下就能對全家人洗版。畫面上看得到的 @ 與實際發出的通知
 * 必須是同一個來源，這裡就是那個來源。
 */
function parseMentions(body: string): number[] {
  const ids = new Set<number>();
  for (const m of body.matchAll(/@\[(\d+)\]/g)) {
    const id = Number(m[1]);
    if (Number.isFinite(id) && id > 0) ids.add(id);
  }
  return [...ids];
}

/**
 * 這個環境的 Drive 根資料夾要叫什麼。
 *
 * 三個環境的備份都寫進站長同一個 Drive，名字不分開的話 `findOwnFolder`
 * （照名字找自己建過的資料夾）會讓 prod 直接接管 local 建的那一個。
 *
 * **hostname 排在 var 前面**：`wrangler dev` 跑的是預設環境，會連帶讀到 prod 那份
 * `DRIVE_ROOT_FOLDER = "didadida"`，只有從請求位址才看得出「這其實是本機」。
 * 本機以外就照 `[vars]`，沒設就退回 `didadida`（＝prod）。
 */
function driveRootFolderName(env: Env, url: URL): string {
  const host = url.hostname;
  if (host === "localhost" || host === "127.0.0.1" || host === "[::1]") return "local.didadida";
  return env.DRIVE_ROOT_FOLDER || "didadida";
}

/**
 * Drive 的**唯一寫入身分**＝站長本人的 Google 授權。
 *
 * 為什麼寫入者只能有一個：`drive.file` 是 per-file 授權，第二位管理員碰不到
 * 第一位建的子資料夾（2026-08-12 實測確認，Picker 授權根目錄也不會往下涵蓋）。
 * 要讓一家人共用同一份 Drive 資料夾，就只能全部由同一個帳號建檔。
 *
 * **憑據就是站長那一列的 `User.google_refresh_token`**（0017）—— 跟「從 Google
 * 相簿匯入」用的是同一份，登入 scope 本來就含 `drive.file`（GOOGLE_LOGIN_SCOPES）。
 * 以前另外存了兩份（`AppSetting.drive_writer_refresh_token` ＋ 環境 secret），
 * **2026-08-21 拿掉**：同一個東西存三個地方，而且壞掉的那份會擋住自癒，
 * 讓「請站長重新登入一次」變成一句做不到的指示（見 Env 裡那段說明）。
 *
 * 現在只有一份，而且是**站長每次 Google 登入都會刷新**的那一份：失效時
 * mintUserGoogleToken() 就地清成 NULL → 下次登入的回呼發現這個人沒有 →
 * 自動補跳一次同意畫面收回來。整條路不需要任何人去點「連結」。
 *
 * 停權（active=0）的站長不算數：那是「這個人現在不該碰站上任何東西」的意思。
 */
async function driveWriterOwner(env: Env): Promise<{ id: number; email: string | null } | null> {
  const row = await env.DB.prepare(
    `SELECT id, email FROM User
      WHERE role = 'owner' AND active = 1
        AND google_refresh_token IS NOT NULL AND TRIM(google_refresh_token) <> ''
      ORDER BY id LIMIT 1`
  ).first<any>();
  return row ? { id: Number(row.id), email: (row.email as string) ?? null } : null;
}

/**
 * 拿站長的 refresh token 換一張短效 access token（Drive 的唯一寫入身分）。
 *
 * 回傳的 `reason` 是給前端分辨用的，三種要走完全不同的路：
 *   `not_linked`  站長還沒用 Google 登入過 —— 他登入一次就自己有了
 *   `expired`     refresh token 失效（被撤銷、或換過 OAuth client）。
 *                 **不要自動重試**，那只會一直撞同一面牆。那份已經就地清成 NULL，
 *                 站長下次登入時回呼會自動補跳同意畫面收一份新的回來
 *   `failed`      其他錯誤（網路、Google 暫時性問題），可以重試
 *
 * 換發、isolate 快取、invalid_grant 自癒全部共用 mintUserGoogleToken() ——
 * 站長的 Drive 寫入 token 跟他自己匯入相簿用的**本來就是同一張**，沒有理由換兩次，
 * 也沒有理由讓兩條路各自寫一份自癒邏輯（那正是先前會分岔壞掉的地方）。
 */
async function mintDriveWriterToken(
  env: Env,
): Promise<
  | { ok: true; accessToken: string; expiresIn: number; email: string | null }
  | { ok: false; reason: "not_linked" | "expired" | "failed"; detail: string }
> {
  const owner = await driveWriterOwner(env);
  if (!owner) {
    return { ok: false, reason: "not_linked", detail: "站長還沒用 Google 登入過，後端沒有 Drive 授權" };
  }

  const minted = await mintUserGoogleToken(env, owner.id);
  if (!minted.ok) return minted;
  return {
    ok: true,
    accessToken: minted.token,
    // mintUserGoogleToken 快取時已經先扣了 60 秒，這裡照它剩下的時間回
    expiresIn: Math.max(Math.round((minted.expiresAt - Date.now()) / 1000), 60),
    email: owner.email,
  };
}

/* ── 匯入用的 Google 身分 ───────────────────────────────────────────────────
 *
 * 上面那一份（mintDriveWriterToken）是站長的 Drive 寫入身分，全站共用一個帳號。
 * 這裡是另一件事：**從 Google 相簿匯入一定要照片主人自己的身分** ——
 * 站長的帳號看不到別人的 Google 相簿，這件事沒辦法共用。
 *
 * 以前那張 token 是登入時發給瀏覽器、存在 localStorage 的短效 access token，
 * **一小時就過期**；過期之後按「從 Google 相簿匯入」會整頁跳去 Google 再授權
 * 一次 —— 明明剛剛就是用 Google 登進來的，而且跳走會把頁面狀態全弄丟。
 * 現在後端收下每個人自己的 refresh token（`User.google_refresh_token`，0017），
 * 要用的時候當場換一張短效的，前端從此完全不碰 Google token。
 */

/**
 * 換好的短效 token 放在 isolate 記憶體裡。
 *
 * Picker 是**每 2 秒輪詢一次**直到使用者選完，沒有這層快取的話每一次輪詢都要
 * 多一趟 D1 讀取加一趟 Google 換發。key 是 uid，值撐到過期前 60 秒。
 * isolate 被回收就整個沒了，那沒關係 —— 重換一張而已。
 */
const userGoogleTokens = new Map<number, { token: string; expiresAt: number }>();

async function mintUserGoogleToken(
  env: Env, uid: number,
): Promise<
  | { ok: true; token: string; expiresAt: number }
  | { ok: false; reason: "not_linked" | "expired" | "failed"; detail: string }
> {
  const cached = userGoogleTokens.get(uid);
  if (cached && cached.expiresAt > Date.now()) {
    return { ok: true, token: cached.token, expiresAt: cached.expiresAt };
  }

  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    return { ok: false, reason: "failed", detail: "後端缺 GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET" };
  }

  const row = await env.DB.prepare(
    "SELECT google_refresh_token AS t FROM User WHERE id = ?"
  ).bind(uid).first<any>();
  /*
   * 沒存過＝這個人從沒走過帶同意畫面的那次登入（或者是用密碼登入的站長，
   * 那條路根本沒經過 Google）。回呼那邊會自己補跳一次同意畫面，所以
   * 前端只要請他用 Google 重新登入一次就會有。
   */
  const refresh = String(row?.t || "").trim();
  if (!refresh) return { ok: false, reason: "not_linked", detail: "這個帳號還沒有 Google 授權" };

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: refresh,
      grant_type: "refresh_token",
    }),
  });
  const data: any = await res.json().catch(() => null);

  if (!res.ok || !data?.access_token) {
    /*
     * invalid_grant＝被撤銷或過期。**就地清掉**：留著只會讓每次匯入都撞同一面牆，
     * 清掉之後下一次登入的回呼才判定得出「這個人沒有」而補跳一次同意畫面。
     * 跟 mintDriveWriterToken 清掉 D1 那份是同一個自癒手法。
     */
    if (data?.error === "invalid_grant") {
      await env.DB.prepare("UPDATE User SET google_refresh_token = NULL WHERE id = ?").bind(uid).run();
      userGoogleTokens.delete(uid);
      return { ok: false, reason: "expired", detail: "Google 授權過期了" };
    }
    return {
      ok: false, reason: "failed",
      detail: String(data?.error_description || data?.error || `HTTP ${res.status}`),
    };
  }

  const expiresIn = Number(data.expires_in) || 3600;
  // 早 60 秒就當作過期，免得剛好卡在邊界上送出請求
  const expiresAt = Date.now() + (expiresIn - 60) * 1000;
  userGoogleTokens.set(uid, { token: data.access_token, expiresAt });
  return { ok: true, token: data.access_token, expiresAt };
}

/**
 * Google 相簿那幾支共用的入口：認人 → 換一張他自己的 Google token。
 *
 * 拿不到一律回 **409 `google_reauth`**，不是 401 —— 401 在這個站是進站閘門
 * 「沒有 token」的意思（`{"error":"locked"}`），前端看到會把人踢回登入頁。
 * 這裡的情況完全不同：站上的身分好好的，只有 Google 那一半要補，
 * 前端該做的是在原地顯示一行「請用 Google 重新登入一次」。
 */
async function googleUserAuth(
  request: Request, env: Env, headers: Record<string, string>,
): Promise<{ ok: true; token: string } | { ok: false; res: Response }> {
  const actor = await currentActor(request, env);
  if (!actor || actor.uid == null) {
    return {
      ok: false,
      res: new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers }),
    };
  }
  const minted = await mintUserGoogleToken(env, actor.uid);
  if (!minted.ok) {
    return {
      ok: false,
      res: new Response(JSON.stringify({
        error: "google_reauth", reason: minted.reason, message: minted.detail,
      }), { status: 409, headers }),
    };
  }
  return { ok: true, token: minted.token };
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


/* ── Drive 備份對帳 ────────────────────────────────────────────────────────
 *
 * 「網站上一張照片，Drive 上就該有一份 4K ＋ 一份原始檔」——
 * 這件事沒有任何地方在保證。上傳的 Drive 那一段是**在瀏覽器裡**跑的，
 * 網頁關掉、分頁睡著、token 過期、recordPhotoDrive 那一下剛好斷線，
 * 每一種都會留下一半的結果，而且**兩邊都安靜**：
 *
 *   D1 有、Drive 沒有 → 照片看起來好好的，直到某天想看原圖才發現沒了
 *   Drive 有、D1 沒有 → 檔案永遠躺在那裡佔空間，沒有任何一列指著它
 *
 * 所以要有人定期去對。這支就是那個人：cron 每次挑**一本**相簿，
 * 把 D1 那本的 Photo 列跟 Drive 資料夾的實際內容兩邊比對。
 *
 * 為什麼一次一本：Workers 免費版單次呼叫 50 個 subrequest，而列一頁檔就是一次。
 * 分次做完一輪之後閒置 24 小時（DRIVE_AUDIT_IDLE_MS），閒著的那些 tick
 * 只花一次 AppSetting 讀取 —— 免費額度是最高宗旨。
 *
 * ⚠️ 這支**會動 Drive 上的檔**（把孤兒丟進待搬佇列），三道閘一道都不能拿掉，
 *    見 auditDriveAlbum 裡的說明。它一樣不呼叫 files.delete —— 走的是既有的
 *    DriveTrash → moveDriveFile → `didadida/trash/`，連重試都是現成的。
 */
const SETTING_DRIVE_AUDIT = "drive_audit";

/** 一輪掃完之後閒置多久才開始下一輪 */
const DRIVE_AUDIT_IDLE_MS = 24 * 60 * 60 * 1000;

/**
 * 孤兒檔至少要這麼舊才敢動。
 *
 * 這是三道閘裡最重要的一道：照片是「先傳 Drive，再回報 id 給 D1」，
 * 中間那個空窗期檔案在 Drive 上、D1 還沒有 —— 長得跟孤兒一模一樣。
 * 空窗正常只有幾秒，但補傳失敗的人可能隔天才回來按重試。留一天綽綽有餘。
 */
const DRIVE_AUDIT_ORPHAN_MIN_AGE_MS = 24 * 60 * 60 * 1000;

/** 一本相簿一次最多丟幾個孤兒進佇列（每個都是一次 D1 寫入，別一次灌爆） */
const DRIVE_AUDIT_MAX_ORPHANS = 50;

/**
 * 一輪最多把幾份「檔名對得上、D1 卻沒記著」的備份接回來。
 * 每一筆都是 D1 寫入，剩下的下一輪再接，不必一次追平。
 */
const DRIVE_AUDIT_MAX_LINKS = 200;

/** 一次最多向 Drive 追問幾個「對不上」的檔。一次一個 subrequest */
const DRIVE_AUDIT_MAX_PROBES = 8;

/** 報告裡最多留幾本相簿的細節（只留有問題的），AppSetting 那一列不該長成幾百 KB */
const DRIVE_AUDIT_MAX_REPORTS = 40;

/**
 * 「單獨對一本」時，逐張明細最多列幾筆（items／extras／dups 各自一份）。
 *
 * ⚠️ 明細**只在單獨對一本時產生，而且不進 AppSetting** —— 它是直接回給呼叫者的。
 * cron 那條走的是同一支 auditDriveAlbum 但 detail=false，存回去的仍然只有數字，
 * 那一列 JSON 不會因為這次的改動長大。
 */
const DRIVE_AUDIT_MAX_DETAIL = 300;

/**
 * 逐張明細的一筆＝「某一張照片的某一份備份怎麼了」。
 *
 * 只列**有事情發生**的那幾格；兩份都好端端在的不列（一本幾千張全列出來沒有人看得完），
 * 那些算進 `ok`。「哪些要補」＝ missing / cleared / gone，「哪些不用」＝ ok 那個數字。
 */
interface DriveAuditItem {
  photo_id: number;
  title: string;
  media_type: string;
  /** 這一格是哪一份：4K 衍生版，還是原始檔（影片只有 original） */
  slot: "4k" | "original";
  /**
   * missing ＝ D1 就是空的，從來沒傳成功過 —— 補傳 Drive 補得回來
   * linked  ＝ 檔案照命名規則在資料夾裡、只是記錄漏掉，**這一趟已經接回來了**
   * linking ＝ 同上，但這一輪的寫回額度用完了，下一輪才寫得回去。
   *            **備份本身是好的**（檔案就在資料夾裡），所以這一格不算要補
   * cleared ＝ 追問過 Drive 確認真的沒了，記錄已清成 NULL，它會出現在補傳清單上
   * gone    ＝ D1 有 id、清單裡沒有，但這一輪的追問額度用完了，還沒確認
   * moved   ＝ 檔案被搬到別的資料夾，**備份是好的**，沒有動它
   */
  state: "missing" | "linked" | "linking" | "cleared" | "gone" | "moved";
}

/** Drive 上多出來的檔（沒有任何一列指著它，或是根本不照我們的命名規則） */
interface DriveAuditExtra {
  name: string;
  drive_id: string;
  /** queued ＝ 已排進待搬佇列（搬進 trash/，不是刪除）；kept ＝ 三道閘沒過，不碰 */
  action: "queued" | "kept";
  /**
   * kept 的理由：
   *   foreign  ＝ 檔名不符 `<編號>_…`，別人放進去的，一律不碰
   *   too_new  ＝ 建立不到 24 小時，可能是剛傳完還沒回報 id 的檔
   *   in_use   ＝ 那個編號的照片還指著它（照片搬去別本相簿了）
   *   queued_before ＝ 早就在待搬佇列裡了
   *   over_limit ＝ 這一輪的額度用完，下一輪再處理
   */
  reason?: string;
}

/**
 * 站上（D1）自己重複的那幾列。
 *
 * ⚠️ **只列出來，絕不自動刪。** 刪一列 Photo ＝ 那一格從相簿消失，連同它的標籤、
 * 留言、Story、手動修過的座標與時間，而且它的 Drive 檔會被排進 trash/。
 * 哪一列該留是人才判斷得了的事（舊的那列往往帶著標籤與留言），程式猜錯沒有退路。
 */
interface DriveAuditDupGroup {
  /**
   * same_hash ＝ 位元組層級同一個檔，幾乎確定是重複的
   * same_name ＝ 只有檔名一樣。Google 相簿匯入拿到的是 Google 轉檔後的位元組，
   *              hash 對不上，只認得出檔名 —— 但**不同相機的 IMG_0001 也會撞名**，
   *              所以這一類是「請你自己看一眼」，不是斷定。
   */
  kind: "same_hash" | "same_name";
  key: string;
  photos: {
    id: number; title: string; media_type: string;
    has_4k: boolean; has_original: boolean; created_at: string;
  }[];
}

interface DriveAuditAlbumReport {
  album_id: number;
  name: string;
  photos: number;
  /** 這本沒有 drive_folder_id —— 整本從來沒備份過，或是分資料夾之前的老相簿 */
  no_folder?: boolean;
  /** 檔案太多，這次沒看完。孤兒與「不見了」的判定**整個跳過**（半份清單會誤判） */
  truncated?: boolean;
  /** D1 就是 NULL：從來沒傳成功過。補傳 Drive 補得回來 */
  missing_4k: number;
  missing_original: number;
  /**
   * 檔案照命名規則好端端躺在資料夾裡，只是 D1 沒記著（或記著的是個過期的 id）——
   * 已經把 file id 寫回去了。這是「上傳成功、recordDriveIds 那一趟沒回來」的下場，
   * 以前會同時變成一筆假的「缺 4K」**和**一個假孤兒（然後被搬進 trash/）。
   */
  linked: number;
  /** D1 有 id，Drive 的清單裡卻沒有 */
  gone: number;
  /** 追問過 Drive、確認真的沒了，D1 那一欄已清成 NULL（於是補傳清單看得到它） */
  cleared: number;
  /** 檔還在，只是被搬去別的資料夾了 —— 不動它，備份是好的 */
  moved: number;
  /** Drive 上多出來、已丟進待搬佇列 */
  orphans_queued: number;
  /** 多出來但名字不符我們的命名規則，不敢動，列出來給人看 */
  foreign: number;
  /**
   * 該有的幾份備份**全都在**的照片數 —— 也就是「不用補的有幾張」。
   * 一本相簿的照片數扣掉這個就是還要處理的張數。
   */
  ok: number;
  error?: string;

  /* ── 以下只有「單獨對一本」才有（detail=true），不會存進 AppSetting ── */

  /** 逐張明細：有事情發生的那幾格 */
  items?: DriveAuditItem[];
  /** 明細超過上限，還有幾筆沒列 */
  items_more?: number;
  /** Drive 上多出來的檔 */
  extras?: DriveAuditExtra[];
  extras_more?: number;
  /** 站上重複的那幾組（只列，不刪） */
  dups?: DriveAuditDupGroup[];
  dups_more?: number;
}

interface DriveAuditState {
  /** 掃到哪一本了（Album.id），0 ＝ 從頭開始 */
  cursor: number;
  started_at: string | null;
  finished_at: string | null;
  /** 上一次真的跑過的時間，給前端顯示 */
  last_run_at: string | null;
  albums_done: number;
  totals: {
    albums: number; photos: number;
    missing_4k: number; missing_original: number; linked: number;
    gone: number; cleared: number; moved: number;
    orphans_queued: number; foreign: number; ok: number;
  };
  /** 只留有問題的那幾本 */
  reports: DriveAuditAlbumReport[];
  last_error: string | null;
}

const emptyDriveAuditState = (): DriveAuditState => ({
  cursor: 0, started_at: null, finished_at: null, last_run_at: null, albums_done: 0,
  totals: {
    albums: 0, photos: 0, missing_4k: 0, missing_original: 0, linked: 0,
    gone: 0, cleared: 0, moved: 0, orphans_queued: 0, foreign: 0, ok: 0,
  },
  reports: [], last_error: null,
});

async function loadDriveAuditState(env: Env): Promise<DriveAuditState> {
  const raw = await getSetting(env, SETTING_DRIVE_AUDIT);
  if (!raw) return emptyDriveAuditState();
  try {
    /*
     * 壞掉的 JSON 不該讓 cron 每十分鐘噴一次 —— 當成沒跑過，重新開一輪。
     *
     * ⚠️ `totals` **要自己再攤一層**。外層那個 spread 是淺的，存起來的那份直接把
     * 整個 totals 換掉 —— 加了新計數欄位（例如 linked）之後，舊的那列 JSON 裡沒有它，
     * `state.totals.linked += n` 當場變成 NaN，而且會一路存回 AppSetting。
     */
    const saved = JSON.parse(raw) as DriveAuditState;
    const base = emptyDriveAuditState();
    return { ...base, ...saved, totals: { ...base.totals, ...(saved.totals ?? {}) } };
  } catch {
    return emptyDriveAuditState();
  }
}

/**
 * 那幾個 Drive 檔還有沒有人在用。
 *
 * ⚠️ **用照片 id 反查，不要用 drive id。** 我們的檔名開頭就是照片 id
 * （`<photoId>_<檔名>`、`<photoId>_<檔名>_4k.webp`，見 frontend/src/lib/drive.ts），
 * 所以這裡查得到主鍵；改成 `WHERE drive_file_id IN (...)` 那兩欄沒有索引，
 * 每問一次就是整張 Photo 掃一遍。
 *
 * 這一道閘擋的是「照片搬到別本相簿了，檔案還留在原資料夾」—— 那不是孤兒，
 * 是好備份，搬走就等於使用者哪天想找原圖時找不到。
 */
async function driveIdsStillUsed(env: Env, items: { photoId: number; driveId: string }[]): Promise<Set<string>> {
  const used = new Set<string>();
  const ids = [...new Set(items.map((i) => i.photoId))];
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    const { results } = await env.DB.prepare(
      `SELECT drive_file_id AS a, drive_original_id AS b FROM Photo WHERE id IN (${chunk.map(() => "?").join(",")})`
    ).bind(...chunk).all<any>();
    for (const r of results) {
      if (typeof r?.a === "string" && r.a) used.add(r.a);
      if (typeof r?.b === "string" && r.b) used.add(r.b);
    }
  }
  return used;
}

/** 已經排在待搬佇列裡的，不要再排一次（佇列沒有 drive_id 的唯一索引） */
async function driveIdsAlreadyQueued(env: Env, driveIds: string[]): Promise<Set<string>> {
  const queued = new Set<string>();
  for (let i = 0; i < driveIds.length; i += 100) {
    const chunk = driveIds.slice(i, i + 100);
    const { results } = await env.DB.prepare(
      `SELECT drive_id FROM DriveTrash WHERE drive_id IN (${chunk.map(() => "?").join(",")})`
    ).bind(...chunk).all<any>();
    for (const r of results) if (typeof r?.drive_id === "string") queued.add(r.drive_id);
  }
  return queued;
}

/**
 * 站上（D1）自己重複的那幾列 —— **只挑出來，不刪任何東西。**
 *
 * 「多餘的」在這個站有兩種，處理方式**刻意不同**：
 *   - **Drive 上多出來的檔**：沒有任何一列指著它，過三道閘之後自動排進 `trash/`
 *     （見下面孤兒那一段）。搬進垃圾桶是可逆的，反悔去 Drive 搬回來就好。
 *   - **站上多出來的列**（這一支）：`Photo` 少一列＝相簿裡少一格，連同它的標籤、
 *     留言、Story、手動修過的座標與時間，而且它的 Drive 檔會被排進 trash/。
 *     哪一列該留是人才判斷得了的（舊的那一列往往帶著標籤與留言），**所以只列出來**。
 *
 * 兩種訊號，強度不一樣：
 *   - `same_hash`：`file_hash` 一樣＝位元組層級同一個檔。幾乎確定是重複的。
 *     ⚠️ hash 算的是**上傳進來的那份位元組**（縮到 2000px 的照片／canvas 畫出來的
 *     影片封面），不是相機原始檔 —— 所以同一張照片換一台機器、換一個瀏覽器重傳，
 *     hash 不見得一樣。這一類**抓得到的都是真的，抓不到的不代表沒有**。
 *   - `same_name`：只有檔名一樣。Google 相簿匯入拿到的是 Google 轉檔後的位元組，
 *     hash 一定對不上，只認得出檔名 —— 但**不同相機的 `IMG_0001.jpg` 也會撞名**，
 *     所以這一類是「請你自己看一眼」，不是斷定。同一組已經被 hash 抓到的不重複列。
 *
 * 純記憶體運算，用的是對帳本來就撈出來的那些列，**不多打任何一次 D1**。
 */
function findDuplicateRows(photos: any[]): DriveAuditDupGroup[] {
  const shape = (p: any) => ({
    id: Number(p.id),
    title: String(p?.title || p?.file_name || `#${p?.id}`),
    media_type: String(p.media_type ?? "photo"),
    has_4k: typeof p.drive_file_id === "string" && !!p.drive_file_id,
    has_original: typeof p.drive_original_id === "string" && !!p.drive_original_id,
    created_at: String(p.created_at ?? ""),
  });

  const out: DriveAuditDupGroup[] = [];

  const byHash = new Map<string, any[]>();
  for (const p of photos) {
    const h = typeof p.file_hash === "string" ? p.file_hash.trim() : "";
    if (!h) continue;
    const g = byHash.get(h);
    if (g) g.push(p); else byHash.set(h, [p]);
  }
  /** 已經被 same_hash 那一組認領走的照片，別再用檔名報一次 */
  const claimed = new Map<number, string>();
  for (const [h, g] of byHash) {
    if (g.length < 2) continue;
    for (const p of g) claimed.set(Number(p.id), h);
    out.push({ kind: "same_hash", key: h, photos: g.map(shape) });
  }

  const byName = new Map<string, any[]>();
  for (const p of photos) {
    const n = String(p?.title || p?.file_name || "").trim().toLowerCase();
    if (!n) continue;
    // 影片封面跟某張照片同名時，那不是同一件東西
    const key = `${String(p.media_type ?? "photo")}::${n}`;
    const g = byName.get(key);
    if (g) g.push(p); else byName.set(key, [p]);
  }
  for (const [key, g] of byName) {
    if (g.length < 2) continue;
    /*
     * 整組都已經被同一個 hash 認領走了＝上面那一組講的就是這件事，不重複列。
     * 只要有一張不在那一組裡（例如 Google 匯入那份轉檔過的），這一組就有話要說。
     */
    const hashes = new Set(g.map((p) => claimed.get(Number(p.id)) ?? ""));
    if (hashes.size === 1 && !hashes.has("")) continue;
    out.push({ kind: "same_name", key: key.split("::").slice(1).join("::"), photos: g.map(shape) });
  }

  return out;
}

/**
 * 對一本相簿。
 *
 * `detail=true` 是「單獨對這一本」用的：除了數字，還會把**逐張明細**、Drive 上
 * 多出來的檔、以及站上重複的那幾組一起帶回去。⚠️ 那幾份**不會存進 AppSetting**
 * ——cron 那條走的是同一支但 detail=false，存回去的仍然只有數字。
 *
 * 影片與照片的期望值不一樣：照片要 4K ＋ 原始檔兩份，**影片只有原始檔一份**
 * （沒有衍生版，id 記在 drive_original_id，drive_file_id 永遠是 NULL —— 見 0019）。
 * 把影片當照片對，每一支都會被算成「缺 4K」，那個數字永遠歸不了零。
 */
async function auditDriveAlbum(
  env: Env,
  album: { id: number; name: string; drive_folder_id: string | null },
  detail = false,
): Promise<DriveAuditAlbumReport> {
  const rep: DriveAuditAlbumReport = {
    album_id: album.id, name: album.name, photos: 0,
    missing_4k: 0, missing_original: 0, linked: 0, gone: 0, cleared: 0, moved: 0,
    orphans_queued: 0, foreign: 0, ok: 0,
  };

  const { results: photos } = await env.DB.prepare(
    `SELECT id, title, file_name, media_type, file_hash, created_at,
            drive_file_id, drive_original_id
       FROM Photo WHERE album_id = ?`
  ).bind(album.id).all<any>();
  rep.photos = photos.length;

  const titleOf = (p: any): string => String(p?.title || p?.file_name || `#${p?.id}`);

  /*
   * 「這一張還有沒有沒處理完的格子」。**先記帳，最後才換算成 ok** ——
   * 追問 Drive 那一段會把「不見了」翻案成「只是被搬走」（備份是好的），
   * 在逐格的迴圈裡就下結論會少算幾張。
   */
  const bad = new Map<number, number>();
  const markBad = (pid: number) => bad.set(pid, (bad.get(pid) ?? 0) + 1);
  const unmarkBad = (pid: number) => {
    const n = (bad.get(pid) ?? 0) - 1;
    if (n > 0) bad.set(pid, n); else bad.delete(pid);
  };

  /** 逐張明細。只有 detail 才收，而且**只收有事情發生的那幾格** */
  const items: DriveAuditItem[] = [];
  /** 追問那一段要回頭改狀態，所以留一份 `<照片 id>:<欄位>` 的索引 */
  const itemAt = new Map<string, DriveAuditItem>();
  const note = (p: any, col: string, state: DriveAuditItem["state"]) => {
    if (!detail) return;
    const it: DriveAuditItem = {
      photo_id: Number(p.id), title: titleOf(p),
      media_type: String(p.media_type ?? "photo"),
      slot: col === "drive_file_id" ? "4k" : "original",
      state,
    };
    items.push(it);
    itemAt.set(`${p.id}:${col}`, it);
  };

  const extras: DriveAuditExtra[] = [];
  const noteExtra = (
    name: string, driveId: string, action: DriveAuditExtra["action"], reason?: string,
  ) => { if (detail) extras.push({ name, drive_id: driveId, action, reason }); };

  /**
   * 收工：算出 ok，把明細夾到上限再掛回報告上。
   * ⚠️ 一定要走這一支 —— 直接把陣列塞進 rep，幾千張的相簿會回一份幾 MB 的 JSON。
   */
  const finish = (): DriveAuditAlbumReport => {
    let okCount = 0;
    for (const p of photos) if (!bad.has(Number(p.id))) okCount++;
    rep.ok = okCount;
    if (detail) {
      rep.items = items.slice(0, DRIVE_AUDIT_MAX_DETAIL);
      if (items.length > DRIVE_AUDIT_MAX_DETAIL) rep.items_more = items.length - DRIVE_AUDIT_MAX_DETAIL;
      rep.extras = extras.slice(0, DRIVE_AUDIT_MAX_DETAIL);
      if (extras.length > DRIVE_AUDIT_MAX_DETAIL) rep.extras_more = extras.length - DRIVE_AUDIT_MAX_DETAIL;
      const dups = findDuplicateRows(photos);
      rep.dups = dups.slice(0, DRIVE_AUDIT_MAX_DETAIL);
      if (dups.length > DRIVE_AUDIT_MAX_DETAIL) rep.dups_more = dups.length - DRIVE_AUDIT_MAX_DETAIL;
    }
    return rep;
  };

  /** 這一列該有哪幾份備份。回的是 [欄位名, 目前的值] */
  const slotsOf = (p: any): ["drive_file_id" | "drive_original_id", any][] =>
    String(p?.media_type) === "video"
      ? [["drive_original_id", p.drive_original_id]]
      : [["drive_file_id", p.drive_file_id], ["drive_original_id", p.drive_original_id]];

  // 沒有資料夾 id：不必去 Drive，D1 自己就答得出「誰沒有備份」
  if (!album.drive_folder_id) {
    rep.no_folder = true;
    for (const p of photos) {
      for (const [col, val] of slotsOf(p)) {
        if (typeof val === "string" && val) continue;
        if (col === "drive_file_id") rep.missing_4k++; else rep.missing_original++;
        markBad(Number(p.id));
        note(p, col, "missing");
      }
    }
    return finish();
  }

  const { files, truncated } = await listFolderFiles(env.GOOGLE_DRIVE_SA_KEY!, album.drive_folder_id);
  if (truncated) rep.truncated = true;
  type FolderFile = (typeof files)[number];

  /*
   * ⚠️ **對帳比的是檔名，不是只有 Drive id。**
   *
   * 只比 id 的話，「檔案好端端在資料夾裡、但 D1 沒記著它」這個狀態會被判成兩件
   * 互相矛盾的事：那一列算「缺 4K／缺原始檔」（於是出現在補傳清單上，使用者再傳
   * 一份），**而且**那個檔沒有人指著、變成孤兒被搬進 trash/ —— 好好的備份被丟掉。
   * 這不是假想：recordDriveIds 是上傳的最後一趟，它失敗的時候檔案早就在 Drive 上了
   * （見 frontend pushPhotoToDrive 那段註解）。
   *
   * 命名規則就是對應關係：`<photoId>_<檔名>_4k.webp` 與 `<photoId>_<原始檔名>`
   * （影片只有後者）。所以照檔名開頭那個 id 分組，再看結尾分成兩格。
   */
  const recorded = new Set<string>();
  for (const p of photos) {
    for (const [, val] of slotsOf(p)) if (typeof val === "string" && val) recorded.add(val);
  }
  /** 資料夾裡有哪些 id。命名規則之前傳的舊檔認不出檔名，只認得出 id */
  const onDrive = new Set(files.map((f) => f.id));

  const byPhoto = new Map<number, { drive_file_id: FolderFile[]; drive_original_id: FolderFile[] }>();
  for (const f of files) {
    const m = /^(\d+)_/.exec(f.name);
    if (!m) {
      // 名字不符我們的規則。**已經有人指著的不算外來檔** —— 命名規則之前傳的舊檔
      if (!recorded.has(f.id)) { rep.foreign++; noteExtra(f.name, f.id, "kept", "foreign"); }
      continue;
    }
    const pid = Number(m[1]);
    let g = byPhoto.get(pid);
    if (!g) { g = { drive_file_id: [], drive_original_id: [] }; byPhoto.set(pid, g); }
    (/_4k\.webp$/i.test(f.name) ? g.drive_file_id : g.drive_original_id).push(f);
  }

  /** 這一輪確認有人在用的 Drive id（含這次剛接回來的）。孤兒＝資料夾裡不在這份裡的 */
  const referenced = new Set<string>();
  const suspects: { photoId: number; column: string; driveId: string }[] = [];
  /** 檔名對得上、D1 卻沒記著（或記著過期的 id）—— 把 id 寫回去 */
  const relinks: { photoId: number; column: string; driveId: string; had: string | null }[] = [];

  for (const p of photos) {
    const pid = Number(p.id);
    const group = byPhoto.get(pid);
    for (const [col, val] of slotsOf(p)) {
      const id = typeof val === "string" && val ? val : null;
      const named = group ? group[col] : [];

      /*
       * 記著的那個就在這個資料夾裡 —— 這一格沒事。
       * ⚠️ 這裡比的是 **id 在不在資料夾裡**，不是「檔名對不對得上」。
       * 命名規則（`<photoId>_…`）之前傳上去的舊檔認不出檔名，硬要檔名也對得上的話
       * 每一張老照片都會被判成對不上，然後白花一次 probe 再回報成「被搬走了」。
       */
      if (id && onDrive.has(id)) { referenced.add(id); continue; }
      markBad(pid);

      /*
       * 檔名對得上但 id 不對。**這是正面證據，清單有沒有看完都算數**
       * （truncated 只讓我們不敢說「沒有」，不會讓看到的東西變假）。
       * 同名有好幾份時取第一個，多出來的留給下面孤兒那段收掉。
       */
      if (named.length > 0) {
        relinks.push({ photoId: pid, column: col, driveId: named[0].id, had: id });
        referenced.add(named[0].id);
        // 檔案在 Drive 上 —— 這一格是好的，不算要補
        unmarkBad(pid);
        /*
         * ⚠️ 一輪最多寫回 `DRIVE_AUDIT_MAX_LINKS` 筆，超出的**這一輪還沒真的寫回去**。
         * 明細上不能一律寫成「已經接回來了」—— 那是下一輪的事，使用者照著這份報告
         * 去看 D1 會發現對不上。
         */
        note(p, col, relinks.length <= DRIVE_AUDIT_MAX_LINKS ? "linked" : "linking");
        continue;
      }

      if (!id) {
        if (col === "drive_file_id") rep.missing_4k++; else rep.missing_original++;
        note(p, col, "missing");
        continue;
      }
      referenced.add(id);
      // 清單沒看完的時候，「不在清單裡」什麼都證明不了
      if (truncated) {
        // 這一本的判定不算數，不要留下一筆會誤導人的「不見了」
        unmarkBad(pid);
      } else {
        rep.gone++;
        note(p, col, "gone");
        suspects.push({ photoId: pid, column: col, driveId: id });
      }
    }
  }

  /*
   * 把接回來的 id 寫回 D1。條件帶上「原本是什麼」是為了不覆蓋掉這中間別人寫進去的值
   * （上傳跟對帳是同時在跑的）。一輪最多寫 DRIVE_AUDIT_MAX_LINKS 筆，剩下的下一輪
   * 再說 —— 這是 D1 寫入，不是讀取。
   */
  for (let i = 0; i < relinks.length && i < DRIVE_AUDIT_MAX_LINKS; i += 50) {
    const chunk = relinks.slice(i, Math.min(i + 50, DRIVE_AUDIT_MAX_LINKS));
    await env.DB.batch(chunk.map((r) => (
      r.had === null
        ? env.DB.prepare(`UPDATE Photo SET ${r.column} = ? WHERE id = ? AND ${r.column} IS NULL`)
            .bind(r.driveId, r.photoId)
        : env.DB.prepare(`UPDATE Photo SET ${r.column} = ? WHERE id = ? AND ${r.column} = ?`)
            .bind(r.driveId, r.photoId, r.had)
    )));
    rep.linked += chunk.length;
  }

  /*
   * 對不上的**要再問一次本人**才敢清 D1。
   *
   * 「不在這個資料夾的清單裡」有兩種可能：真的沒了，或是被搬到別的資料夾
   * （相簿改名、有人手動整理）。後者那份備份是好的，把 D1 清成 NULL 等於
   * 叫使用者重傳一份，Drive 上再多一個垃圾。一次只追問幾個，剩下的下一輪再說。
   */
  for (const s of suspects.slice(0, DRIVE_AUDIT_MAX_PROBES)) {
    try {
      const probe = await probeDriveFile(env.GOOGLE_DRIVE_SA_KEY!, s.driveId);
      if (probe && !probe.trashed) {
        // 只是被搬去別的資料夾 —— 備份是好的，這一格翻案成沒事
        rep.moved++; rep.gone--;
        unmarkBad(s.photoId);
        const mv = itemAt.get(`${s.photoId}:${s.column}`);
        if (mv) mv.state = "moved";
        continue;
      }
      // 真的沒了（404 或已在垃圾桶）：清掉那一欄，補傳清單才看得到這張
      await env.DB.prepare(
        `UPDATE Photo SET ${s.column} = NULL WHERE id = ? AND ${s.column} = ?`
      ).bind(s.photoId, s.driveId).run();
      rep.cleared++;
      if (s.column === "drive_file_id") rep.missing_4k++; else rep.missing_original++;
      const cl = itemAt.get(`${s.photoId}:${s.column}`);
      if (cl) cl.state = "cleared";
    } catch (e) {
      // 追問失敗就維持原狀 —— 寧可下一輪再看，也不要憑一次網路錯誤清掉備份
      rep.error = e instanceof Error ? e.message : String(e);
    }
  }

  /*
   * 孤兒：資料夾裡有、沒有任何一列指著它。三道閘全過才敢動，順序也是刻意的
   * （便宜的先擋，最貴的那次 D1 查詢留到最後）：
   *   ① 名字要符合我們自己的命名規則 `<photoId>_…` —— 使用者自己丟進去的東西不歸我們管
   *   ② 至少 24 小時前建的 —— 剛傳完還沒回報 id 的檔長得跟孤兒一模一樣
   *   ③ 問 D1「這個照片 id 現在指到哪」—— 照片搬去別本相簿時檔案會留在原資料夾
   * 清單沒看完就整段跳過：半份清單去清孤兒會清掉好檔。
   */
  if (!truncated) {
    const now = Date.now();
    const candidates: { photoId: number; driveId: string; name: string }[] = [];
    for (const f of files) {
      if (referenced.has(f.id)) continue;
      // 外來檔在上面編檔名索引的時候就算過了，這裡只是跳過
      const m = /^(\d+)_/.exec(f.name);
      if (!m) continue;
      const created = f.createdTime ? Date.parse(f.createdTime) : NaN;
      if (!Number.isFinite(created) || now - created < DRIVE_AUDIT_ORPHAN_MIN_AGE_MS) {
        noteExtra(f.name, f.id, "kept", "too_new");
        continue;
      }
      if (candidates.length >= DRIVE_AUDIT_MAX_ORPHANS) {
        // 這一輪的額度用完了，下一輪再處理 —— 但要講出來，不然數字對不起來
        noteExtra(f.name, f.id, "kept", "over_limit");
        continue;
      }
      candidates.push({ photoId: Number(m[1]), driveId: f.id, name: f.name });
    }

    if (candidates.length > 0) {
      const used = await driveIdsStillUsed(env, candidates);
      const fresh = candidates.filter((c) => {
        if (!used.has(c.driveId)) return true;
        noteExtra(c.name, c.driveId, "kept", "in_use");
        return false;
      });
      const queued = fresh.length > 0
        ? await driveIdsAlreadyQueued(env, fresh.map((c) => c.driveId))
        : new Set<string>();
      const orphans = fresh.filter((c) => {
        if (!queued.has(c.driveId)) return true;
        noteExtra(c.name, c.driveId, "kept", "queued_before");
        return false;
      });
      if (orphans.length > 0) {
        for (const o of orphans) noteExtra(o.name, o.driveId, "queued");
        const stmt = env.DB.prepare("INSERT INTO DriveTrash (drive_id, photo_id) VALUES (?, NULL)");
        for (let i = 0; i < orphans.length; i += 100) {
          await env.DB.batch(orphans.slice(i, i + 100).map((o) => stmt.bind(o.driveId)));
        }
        rep.orphans_queued = orphans.length;
      }
    }
  }

  return finish();
}

/** 這份報告值不值得留下來給人看（沒問題的相簿不佔位子） */
const driveAuditWorthReporting = (r: DriveAuditAlbumReport): boolean =>
  r.missing_4k > 0 || r.missing_original > 0 || r.linked > 0 || r.gone > 0 || r.cleared > 0
  || r.orphans_queued > 0 || r.foreign > 0 || Boolean(r.truncated) || Boolean(r.error);

/**
 * 跑一次對帳：從 cursor 往後挑幾本相簿對完，把進度寫回 AppSetting。
 *
 * `force` 是手動按下去用的（跳過 24 小時的閒置檢查）。cron 那條一定要留著
 * 閒置檢查，不然一天 144 次、每次都整輪掃過去，讀取額度會被吃掉。
 */
async function runDriveAudit(env: Env, albums: number, force: boolean): Promise<DriveAuditState> {
  const state = await loadDriveAuditState(env);
  if (!env.GOOGLE_DRIVE_SA_KEY) {
    state.last_error = "沒有設定 GOOGLE_DRIVE_SA_KEY，無法對帳";
    return state;
  }

  // 上一輪掃完了而且還沒到下一輪的時間 —— 這個 tick 只花了一次 AppSetting 讀取
  if (!force && state.cursor === 0 && state.finished_at
      && Date.now() - Date.parse(state.finished_at) < DRIVE_AUDIT_IDLE_MS) {
    return state;
  }

  if (state.cursor === 0) {
    // 新的一輪：計數與報告全部歸零，不然數字會一輪疊一輪
    const fresh = emptyDriveAuditState();
    fresh.started_at = new Date().toISOString();
    fresh.last_run_at = state.last_run_at;
    Object.assign(state, fresh);
  }

  for (let n = 0; n < albums; n++) {
    const album = await env.DB.prepare(
      "SELECT id, name, drive_folder_id FROM Album WHERE id > ? ORDER BY id LIMIT 1"
    ).bind(state.cursor).first<any>();

    if (!album) {
      // 掃完一輪
      state.cursor = 0;
      state.finished_at = new Date().toISOString();
      break;
    }

    try {
      const rep = await auditDriveAlbum(env, {
        id: Number(album.id),
        name: String(album.name ?? ""),
        drive_folder_id: typeof album.drive_folder_id === "string" && album.drive_folder_id
          ? album.drive_folder_id : null,
      });
      state.totals.albums++;
      state.totals.photos += rep.photos;
      state.totals.missing_4k += rep.missing_4k;
      state.totals.missing_original += rep.missing_original;
      state.totals.linked += rep.linked;
      state.totals.gone += rep.gone;
      state.totals.cleared += rep.cleared;
      state.totals.moved += rep.moved;
      state.totals.orphans_queued += rep.orphans_queued;
      state.totals.foreign += rep.foreign;
      state.totals.ok += rep.ok;
      if (driveAuditWorthReporting(rep) && state.reports.length < DRIVE_AUDIT_MAX_REPORTS) {
        state.reports.push(rep);
      }
    } catch (e) {
      // 一本壞掉不該讓整輪停在那裡 —— 記下來，cursor 照樣往前走
      state.last_error = `相簿 ${album.id}：${e instanceof Error ? e.message : String(e)}`;
    }

    state.cursor = Number(album.id);
    state.albums_done++;
  }

  state.last_run_at = new Date().toISOString();
  await setSetting(env, SETTING_DRIVE_AUDIT, JSON.stringify(state));
  return state;
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
): Promise<{ ok: true; user: { id: number; email: string; name: string; role: string } } | { ok: false; reason: string }> {
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
  // role 要一起撈：回呼那邊靠它決定「這次登入要不要順手收下 Drive 寫入授權」
  const row = await env.DB.prepare(
    "SELECT id, name, email, role, active FROM User WHERE lower(email) = ?"
  ).bind(email).first<any>();

  // 名單上沒有這個人 —— 到此為止，不建列、不放行
  if (!row) return { ok: false, reason: "not_admin" };

  // 在名單上但被停權。跟「從來不在名單上」分開回報，前端才講得出人話
  if (Number(row.active) !== 1) return { ok: false, reason: "revoked" };

  await env.DB.prepare("UPDATE User SET last_login_at = datetime('now') WHERE id = ?").bind(row.id).run();
  return { ok: true, user: { id: row.id, email: row.email, name: row.name, role: String(row.role || "member") } };
}

/**
 * 登入要的三樣權限：`openid email`（認人）、`drive.file`（照片備份）、
 * `photospicker`（相簿匯入）。**合成一次要齊**，不然每一樣都要各自跳一次授權。
 */
const GOOGLE_LOGIN_SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/drive.file",
  "https://www.googleapis.com/auth/photospicker.mediaitems.readonly",
].join(" ");

/**
 * 組一條 Google 授權網址。登入的正門與回呼裡「補一次同意畫面」共用同一個組法。
 *
 * `consent` 為真才拿得到 refresh token —— Google 只在使用者親手按下同意那一次給。
 * `retried` 一路帶進 state、再跟著回呼回來，是**避免無限迴圈**的閂：補跳過一次
 * 還是沒拿到就算了，那次登入照樣成立，只是匯入會請他再登一次。
 */
function googleAuthUrl(
  env: Env, origin: string,
  opts: { albumId: string; redirectHost: string; consent: boolean; retried: boolean },
): string {
  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID || "",
    redirect_uri: `${origin}/api/auth/google/callback`,
    response_type: "code",
    scope: GOOGLE_LOGIN_SCOPES,
    access_type: "offline",
    prompt: opts.consent ? "consent select_account" : "select_account",
    state: JSON.stringify({
      albumId: opts.albumId, redirectHost: opts.redirectHost, retried: opts.retried,
    }),
  });
  if (opts.consent) params.set("include_granted_scopes", "true");
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
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
  // localhost 與 127.0.0.1 在瀏覽器眼裡是**兩個不同的 origin**，next dev 兩種開法都有人用
  "http://127.0.0.1:3000",
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
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
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
     *      **頭像也在這一類**（0015）：一樣是 <img src>，護欄一樣是猜不到的檔名
     *      （`<uid>-<亂數>.webp`）。所以那條路由絕對不可以改成吃 user id。
     *
     * ⚠️ `/api/photos/:id/full` **曾經在這張白名單上，已經移走了**（見 isSignedMediaPath）。
     *    它吃的是流水號，「網址猜不到」那個護欄對它從來沒成立過 —— 任何台灣 IP 不帶
     *    token 從 1 數上去就能抓完整站的 Drive 4K。它現在走簽章網址（`?mt=`），
     *    由下面那一段驗。**不要為了「圖片要放行」把它加回白名單。**
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
      // 只開 GET。上傳／刪除頭像照樣要 token，不能因為圖片要放行就整條路徑打開
      || (method === "GET" && pathname.startsWith("/api/users/avatar/"));

    /*
     * 閘門認兩種東西：Authorization 裡那張 token，或**媒體路徑上的簽章網址**。
     * 後者只對 isSignedMediaPath 那張表上的 GET 成立，而且只是「進得了站」的證明，
     * 不帶身分 —— 需要知道「是誰」的路由照樣得自己去 currentActor()。
     */
    if (!isOpenPath) {
      const gateOk = (await tokenIdentity(request, env)) !== null
        || (method === "GET" && isSignedMediaPath(pathname)
            && (await requestMediaScope(request, url, env)) !== 'none');
      if (!gateOk) {
        return new Response(JSON.stringify({ error: "locked" }), { status: 401, headers });
      }
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
        // 足跡地圖看不看得到：成員照自己那一欄（0014），訪客看站長的全站開關
        const canViewMap = actor !== null ? actor.canViewMap : await guestCanViewMap(env);
        /*
         * 留言看不看得到：成員照自己那一欄，訪客看站長的全站開關。
         *
         * 未讀數也在這裡一起回。**刻意不另開一支端點** —— 這一條前端每次進站
         * 都會打，右上角的紅點跟著它回來就是零額外請求。看不到留言的人直接給 0，
         * 連查都不必查（他點不開通知清單，那個數字沒有意義）。
         */
        const canViewComments = actor !== null ? actor.canViewComments : await guestCanViewComments(env);
        let unread = 0;
        if (actor?.uid != null && actor.canViewComments) {
          /*
           * ⚠️ 未讀數要跟 /api/notifications 那支**用同一套條件**，不然紅點會停在
           *    一個點進去什麼都沒有的數字上（跟 drive-pending 的清單與 COUNT 是
           *    同一個道理）。
           */
          const unreadRestricted = canSeeRestricted(actor) ? "" : `
               AND EXISTS (SELECT 1 FROM Comment c JOIN Photo p ON p.id = c.photo_id
                            WHERE c.id = CommentNotify.comment_id AND p.restricted = 0)`;
          const row = await env.DB.prepare(`
            SELECT COUNT(*) AS n FROM CommentNotify
             WHERE user_id = ?
               AND created_at > COALESCE((SELECT notif_seen_at FROM User WHERE id = ?), '')${unreadRestricted}
          `).bind(actor.uid, actor.uid).first<any>();
          unread = Number(row?.n ?? 0);
        }
        return new Response(JSON.stringify({
          // 白名單被撤掉的人 token 還沒過期 —— 這裡就要說 admin:false，
          // 不然前端會端出一整套按下去全是 403 的編輯介面
          admin: actor !== null,
          guest: identity.role === 'guest' || (identity.role === 'admin' && actor === null),
          can_view_map: canViewMap ? 1 : 0,
          can_view_comments: canViewComments ? 1 : 0,
          // 訪客永遠是 0：不是設定，是資料模型上就沒有訪客這個作者
          can_comment: actor?.canComment ? 1 : 0,
          // 訪客也永遠是 0：工具區整塊只給成員（見 migrations/0016）
          can_use_tools: actor?.canUseTools ? 1 : 0,
          unread_notifications: unread,
          /*
           * 同遊判定的門檻。**刻意跟著這一條回來**，理由跟未讀數一樣：
           * 這是每次進站都會打的路由，而且值走 getSettingCached（60 秒 memo），
           * 幾乎不會真的去讀 D1。為它另開一支端點等於每個人開地圖多一次請求。
           */
          convoy_overlap_pct: await convoyOverlapPct(env),
          /*
           * 不開放的照片要不要連我自己看都先糊著。
           *
           * **只有看得到不開放照片的人才問這個設定** —— 其他人的清單裡根本沒有
           * 那幾張，這個值對他們沒有意義，而且這樣省掉一次設定讀取（乘上每個人
           * 的每次進站）。遮罩是瀏覽器端的 CSS，位元組照樣是完整的。
           */
          restricted_blur: actor?.canManageOthers && await restrictedBlurOn(env) ? 1 : 0,
          /*
           * 圖片／影片的簽章網址要用的那張。**訪客也有** —— 燈箱大圖本來就給訪客看，
           * 這張 token 擋的是「完全沒進站的人」，不是訪客。
           * 同樣跟著這一條回來（零額外請求），效期與手上那張進站 token 一致。
           */
          media_token: await mintMediaToken(env, actor?.canManageOthers ? 'admin' : 'basic'),
          user: actor ? {
            id: actor.uid, name: actor.name, email: actor.email,
            role: actor.isOwner ? 'owner' : 'member',
            can_manage_others: actor.canManageOthers ? 1 : 0,
            can_add_to_others: actor.canAddToOthers ? 1 : 0,
            can_reorder_others: actor.canReorderOthers ? 1 : 0,
            can_comment: actor.canComment ? 1 : 0,
            can_view_comments: actor.canViewComments ? 1 : 0,
            can_view_map: actor.canViewMap ? 1 : 0,
            can_use_tools: actor.canUseTools ? 1 : 0,
            track_color: actor.trackColor,
            avatar: avatarUrl(url.origin, actor.avatarKey),
          } : null,
        }), { headers });
      }

      /*
       * 路由：改自己的個人設定。就兩個欄位 ——
       * 信箱是身分（改了等於換人），權限不能自己給自己加。
       *
       *   name         顯示名稱
       *   track_color  他的軌跡在地圖上的顏色。**每個人自己挑自己的**（使用者定調），
       *                所以是這裡而不是站長後台。送 null 就是清掉，退回依 uid 的預設色。
       *
       * 兩個都是選填、各自獨立更新 —— 只送顏色不會把名字洗掉。
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
        const body = await request.json().catch(() => ({})) as { name?: string; track_color?: unknown };

        const sets: string[] = [];
        const binds: any[] = [];

        let name = actor.name;
        if (body.name !== undefined) {
          name = String(body.name ?? "").trim();
          if (!name) {
            return new Response(JSON.stringify({ error: "顯示名稱不能空白" }), { status: 400, headers });
          }
          if (name.length > 40) {
            return new Response(JSON.stringify({ error: "顯示名稱最多 40 個字" }), { status: 400, headers });
          }
          sets.push("name = ?");
          binds.push(name);
        }

        let trackColor = actor.trackColor;
        if (body.track_color !== undefined) {
          const color = normalizeTrackColor(body.track_color);
          if (color === undefined) {
            return new Response(JSON.stringify({ error: "不是調色盤裡的顏色" }), { status: 400, headers });
          }
          sets.push("track_color = ?");
          binds.push(color);
          trackColor = trackColorFor(actor.uid, color);
        }

        if (sets.length === 0) {
          return new Response(JSON.stringify({ error: "沒有要變更的內容" }), { status: 400, headers });
        }
        await env.DB.prepare(`UPDATE User SET ${sets.join(", ")} WHERE id = ?`)
          .bind(...binds, actor.uid).run();

        return new Response(JSON.stringify({
          success: true,
          user: {
            id: actor.uid, name, email: actor.email,
            role: actor.isOwner ? 'owner' : 'member',
            can_manage_others: actor.canManageOthers ? 1 : 0,
            can_add_to_others: actor.canAddToOthers ? 1 : 0,
            can_reorder_others: actor.canReorderOthers ? 1 : 0,
            track_color: trackColor,
            avatar: avatarUrl(url.origin, actor.avatarKey),
          },
        }), { headers });
      }

      /* ── 頭像 ────────────────────────────────────────────────────────────
       *
       * 一張圖兩用：留言區的圓形頭像 ＋ 地圖上坐在小車上的大頭（飛碟已退休）。
       * 縮圖、去背判斷、圓形遮罩全在前端做完才上傳（見 frontend/lib/avatar.ts）——
       * Worker 不碰像素，跟照片縮圖同一套分工。
       */

      /*
       * 路由：看頭像。**在進站閘門的白名單裡**（<img src> 帶不了 Authorization）。
       *
       * 護欄是猜不到的檔名，所以這裡只認 AVATAR_NAME_RE ——
       * 那個值會被接到 R2 鍵上，不擋等於把整個桶子開放給人翻。
       *
       * 換頭像一定是換一個新檔名（不就地覆寫），所以可以給 immutable 的一年。
       */
      if (method === "GET" && pathname.startsWith("/api/users/avatar/")) {
        const name = decodeURIComponent(pathname.split("/")[4] ?? "");
        if (!AVATAR_NAME_RE.test(name)) {
          return new Response(JSON.stringify({ error: "Not Found" }), { status: 404, headers });
        }
        return withEdgeCache(request, ctx,
          { browserMaxAge: 31536000, edgeMaxAge: 31536000, skip: false },
          async () => {
            const object = await env.BUCKET.get(avatarR2Key(name));
            if (object === null) {
              return new Response(JSON.stringify({ error: "Avatar not found" }), { status: 404, headers });
            }
            const h = new Headers();
            object.writeHttpMetadata(h);
            h.set("etag", object.httpEtag);
            h.set("Access-Control-Allow-Origin", "*");
            return new Response(object.body, { headers: h });
          });
      }

      /*
       * 路由：換掉／移除某個人的頭像。**本人或站長**，沒有第三種。
       *
       * 刻意不吃 canManageOthers —— 那一欄講的是「動得了別人的相簿與照片」，
       * 頭像是那個人自己的臉，能改它的只有他本人跟站長（站長那條是為了幫
       * 不會用的家人代設，也是為了能把不合適的圖拿掉）。
       *
       * body 是原始的圖檔位元組，不是 multipart —— 只有一個檔案，包一層 FormData
       * 兩邊都變麻煩。舊檔在更新完 D1 之後才刪，而且是 best-effort：
       * 刪失敗只是留一顆孤兒物件，讓整個請求失敗才是真的壞事。
       */
      if ((method === "POST" || method === "DELETE") && pathname.startsWith("/api/users/")
          && pathname.endsWith("/avatar") && pathname.split("/").length === 5) {
        const targetId = Number(pathname.split("/")[3]);
        const actor = await currentActor(request, env);
        if (!actor) {
          return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers });
        }
        if (!Number.isInteger(targetId) || targetId <= 0) {
          return new Response(JSON.stringify({ error: "Not Found" }), { status: 404, headers });
        }
        if (!actor.isOwner && actor.uid !== targetId) {
          return forbidden(headers, "只能換自己的頭像");
        }
        const target = await env.DB.prepare("SELECT id, avatar_key FROM User WHERE id = ?")
          .bind(targetId).first<any>();
        if (!target) {
          return new Response(JSON.stringify({ error: "找不到這個帳號" }), { status: 404, headers });
        }
        const oldKey: string | null = target.avatar_key ?? null;

        if (method === "DELETE") {
          await env.DB.prepare("UPDATE User SET avatar_key = NULL WHERE id = ?").bind(targetId).run();
          if (oldKey) ctx.waitUntil(env.BUCKET.delete(avatarR2Key(oldKey)).catch(() => {}));
          return new Response(JSON.stringify({ success: true, avatar: null }), { headers });
        }

        const contentType = (request.headers.get("Content-Type") || "").split(";")[0].trim().toLowerCase();
        // WebP 是常態，PNG 是「這個瀏覽器編不出 WebP」的退路（見前端 canEncodeWebp）。
        // JPEG 沒有 alpha，去背圖進不來，所以刻意不收
        const ext = contentType === "image/webp" ? "webp" : contentType === "image/png" ? "png" : null;
        if (!ext) {
          return new Response(JSON.stringify({ error: "頭像只收 WebP 或 PNG（要留得住去背的透明背景）" }), { status: 400, headers });
        }
        const buffer = await request.arrayBuffer();
        if (buffer.byteLength === 0) {
          return new Response(JSON.stringify({ error: "沒有收到圖片" }), { status: 400, headers });
        }
        if (buffer.byteLength > AVATAR_MAX_BYTES) {
          return new Response(JSON.stringify({ error: "頭像檔案太大" }), { status: 413, headers });
        }

        // 亂數尾碼就是這條白名單路由的護欄，不能拿 uid 或時間戳充數
        const rand = Array.from(crypto.getRandomValues(new Uint8Array(6)))
          .map((b) => b.toString(16).padStart(2, "0")).join("");
        const name = `${targetId}-${rand}.${ext}`;
        await env.BUCKET.put(avatarR2Key(name), buffer, { httpMetadata: { contentType } });
        await env.DB.prepare("UPDATE User SET avatar_key = ? WHERE id = ?").bind(name, targetId).run();
        if (oldKey && oldKey !== name) {
          ctx.waitUntil(env.BUCKET.delete(avatarR2Key(oldKey)).catch(() => {}));
        }
        return new Response(JSON.stringify({
          success: true, avatar: avatarUrl(url.origin, name),
        }), { headers });
      }

      /*
       * 路由：站上的家人清單（id / 名字 / 顏色）。**任何管理員都讀得到**，
       * 不是站長專屬 —— 它不是白名單管理，是地圖圖例與色票列的資料來源：
       *
       *   - 地圖頁要把 user_id 換成人名與顏色（軌跡點只帶 id）
       *   - 帳號牌的色票列要標出「這個顏色 OO 已經在用了」
       *
       * 刻意不含信箱、權限、最後登入時間 —— 那些是 /api/admin/users 的事。
       * 訪客不給：軌跡本來就要登入才看得到（/api/tracks 是 401），
       * 給了只是白白洩漏站上有誰。
       */
      if (method === "GET" && pathname === "/api/track-members") {
        if (!(await isAuthorized(request, env))) {
          return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers });
        }
        // 沒有工具權限的人不列（見 TRACK_MEMBER_COND）。這一支同時餵地圖的
        // 圖例、成員篩選列、軌跡顏色與車上的大頭 —— 從源頭拿掉，四個地方一起乾淨
        const { results } = await env.DB.prepare(
          `SELECT u.id, u.name, u.track_color, u.avatar_key FROM User u
           WHERE u.active = 1 AND ${TRACK_MEMBER_COND} ORDER BY u.id`
        ).all();
        return new Response(JSON.stringify((results as any[]).map((u) => ({
          id: Number(u.id),
          name: u.name,
          // 算好的顏色，理由同 Actor.trackColor：退讓規則只寫在後端一處
          track_color: trackColorFor(Number(u.id), u.track_color),
          // 地圖要拿它畫車上的大頭 —— 沒設就是 null，那個人坐上去的是小外星人
          avatar: avatarUrl(url.origin, u.avatar_key),
        }))), { headers });
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
            guest_can_view_comments: (await getSetting(env, SETTING_GUEST_COMMENTS)) === "1" ? 1 : 0,
            convoy_overlap_pct: await convoyOverlapPct(env),
            restricted_blur: (await getSetting(env, SETTING_RESTRICTED_BLUR)) === "1" ? 1 : 0,
          }), { headers });
        }

        if (method === "PUT") {
          const body: {
            guest_can_view_map?: any; guest_can_view_comments?: any; convoy_overlap_pct?: any;
            restricted_blur?: any;
          } = await request.json();
          if (body.guest_can_view_map !== undefined) {
            await setSetting(env, SETTING_GUEST_MAP, body.guest_can_view_map ? "1" : "0");
          }
          if (body.guest_can_view_comments !== undefined) {
            await setSetting(env, SETTING_GUEST_COMMENTS, body.guest_can_view_comments ? "1" : "0");
          }
          if (body.convoy_overlap_pct !== undefined) {
            // 這一格是數字不是開關，壞值要當場報錯而不是靜靜地存進去 ——
            // 讀取端會把壞值當成預設，站長會以為拉桿沒有作用
            const pct = Math.round(Number(body.convoy_overlap_pct));
            if (!Number.isFinite(pct) || pct < CONVOY_PCT_MIN || pct > CONVOY_PCT_MAX) {
              return new Response(JSON.stringify({
                error: `同遊門檻要在 ${CONVOY_PCT_MIN}–${CONVOY_PCT_MAX} 之間`,
              }), { status: 400, headers });
            }
            await setSetting(env, SETTING_CONVOY_PCT, String(pct));
          }
          if (body.restricted_blur !== undefined) {
            await setSetting(env, SETTING_RESTRICTED_BLUR, body.restricted_blur ? "1" : "0");
          }
          return new Response(JSON.stringify({
            success: true,
            guest_can_view_map: (await getSetting(env, SETTING_GUEST_MAP)) === "1" ? 1 : 0,
            guest_can_view_comments: (await getSetting(env, SETTING_GUEST_COMMENTS)) === "1" ? 1 : 0,
            convoy_overlap_pct: await convoyOverlapPct(env),
            restricted_blur: (await getSetting(env, SETTING_RESTRICTED_BLUR)) === "1" ? 1 : 0,
          }), { headers });
        }
      }


      /* ── 站長專用：Drive 備份對帳 ──────────────────────────────────────────
       *
       * 「站上一張照片，Drive 上就該有一份 4K ＋ 一份原始檔」的自動巡邏。
       * 引擎在 runDriveAudit（見上面那一大段），這裡只是看報告與手動催。
       *
       * 歸 canManageOthers 而不是 isOwner：它看的是全站內容的備份狀態，
       * 跟「誰進得來」無關，跟待搬佇列那支（drain-drive-trash）同一個層級。
       */
      if (pathname === "/api/admin/drive-audit") {
        const auditActor = await currentActor(request, env);
        if (!auditActor) {
          return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers });
        }
        if (!auditActor.canManageOthers) {
          return forbidden(headers, "這是全站共用的資料，只有可以管理別人內容的帳號能看");
        }

        if (method === "GET") {
          const state = await loadDriveAuditState(env);
          /*
           * 待搬佇列的現況一起回。放棄的那幾筆（attempts >= 3）是這次要修的重點
           * 之一 —— 以前它們只是靜靜留在表裡，站上任何一個畫面都看不到，
           * 於是「Drive 刪除失敗」那句話跳完就再也沒有下文。
           */
          const trash = await env.DB.prepare(`
            SELECT SUM(CASE WHEN attempts < 3 THEN 1 ELSE 0 END) AS remaining,
                   SUM(CASE WHEN attempts >= 3 THEN 1 ELSE 0 END) AS gave_up
              FROM DriveTrash
          `).first<any>();
          const { results: stuck } = await env.DB.prepare(
            "SELECT id, drive_id, photo_id, attempts, last_error, created_at FROM DriveTrash WHERE attempts >= 3 ORDER BY id LIMIT 20"
          ).all<any>();

          /*
           * 相簿清單，給後台那個「單獨對一本」的下拉選單用。
           *
           * 刻意不叫前端去打 `/api/albums` —— 那一支每一本都要撈封面與預覽圖，
           * 而這裡只需要 id 跟名字。一句沒有 JOIN 的查詢，比那邊便宜得多。
           */
          const { results: albumList } = await env.DB.prepare(
            "SELECT id, name FROM Album ORDER BY name"
          ).all<any>();

          return new Response(JSON.stringify({
            ...state,
            trash: {
              remaining: Number(trash?.remaining ?? 0),
              gave_up: Number(trash?.gave_up ?? 0),
              stuck,
            },
            albums: albumList.map((a: any) => ({ id: Number(a.id), name: String(a.name ?? "") })),
          }), { headers });
        }

        if (method === "POST") {
          const body = await request.json().catch(() => ({})) as {
            reset?: unknown; albums?: unknown; retry_trash?: unknown; album_id?: unknown;
          };

          /*
           * 「單獨對這一本，而且要看逐張明細」。
           *
           * 跟 cron 那條走**同一支 auditDriveAlbum**（三段判定只能有一份實作，
           * 分兩份寫遲早會走鐘），差別只在 detail=true 會多帶明細回來。
           *
           * ⚠️ **這一趟不碰 AppSetting**：不推游標、不累加 totals、不塞進 reports。
           * 它是使用者站在某一本相簿前面問的一次性問題，把它算進「整輪掃描」的
           * 進度裡只會讓那份報告的數字對不起來（同一本被算兩次）。
           * 副作用照舊會發生（接回漏記的 id、清掉真的沒了的、排孤兒進待搬佇列）
           * —— 那些是修資料，本來就該做。
           */
          if (body.album_id !== undefined && body.album_id !== null) {
            const aid = Number(body.album_id);
            if (!Number.isFinite(aid) || aid <= 0) {
              return new Response(JSON.stringify({ error: "album_id 不正確" }), { status: 400, headers });
            }
            if (!env.GOOGLE_DRIVE_SA_KEY) {
              return new Response(JSON.stringify({ error: "沒有設定 GOOGLE_DRIVE_SA_KEY，無法對帳" }), { status: 503, headers });
            }
            const album = await env.DB.prepare(
              "SELECT id, name, drive_folder_id FROM Album WHERE id = ?"
            ).bind(aid).first<any>();
            if (!album) {
              return new Response(JSON.stringify({ error: "找不到這本相簿" }), { status: 404, headers });
            }
            const report = await auditDriveAlbum(env, {
              id: Number(album.id),
              name: String(album.name ?? ""),
              drive_folder_id: typeof album.drive_folder_id === "string" && album.drive_folder_id
                ? album.drive_folder_id : null,
            }, true);
            return new Response(JSON.stringify({ success: true, report }), { headers });
          }

          /*
           * 「重試放棄的搬移」：把 attempts 歸零讓它們回到佇列。
           *
           * 這是使用者真的踩到的那一個 —— 刪照片時 Drive 那一下失敗，
           * 試三次之後就永遠躺在表裡。失敗常常是暫時的（Drive 5xx、網路），
           * 但沒有任何地方按得到重試。
           */
          if (body.retry_trash) {
            const reset = await env.DB.prepare(
              "UPDATE DriveTrash SET attempts = 0, last_error = NULL WHERE attempts >= 3"
            ).run();
            const drained = await drainDriveTrash(env, 10);
            return new Response(JSON.stringify({
              success: true,
              revived: Number((reset as any)?.meta?.changes ?? 0),
              drained,
            }), { headers });
          }

          // reset：把游標歸零，下一次（含這一次）從第一本重新對
          if (body.reset) await setSetting(env, SETTING_DRIVE_AUDIT, JSON.stringify(emptyDriveAuditState()));

          /*
           * 手動跑幾本。上限 5 —— 一本要列一次（可能好幾次）Drive，
           * 而單次呼叫的 subrequest 免費版只有 50 個。想整輪掃完就多按幾次，
           * 進度存在 AppSetting 裡不會掉。
           */
          const want = Math.min(Math.max(Number(body.albums ?? 3) || 3, 1), 5);
          const state = await runDriveAudit(env, want, true);
          return new Response(JSON.stringify(state), { headers });
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

        /*
         * 路由：白名單清單。
         *
         * 這裡有**兩個意思完全不同的照片數**，別再把它們混為一談：
         *
         *   photo_count     他建的相簿裡總共幾張，**含別人傳進去的**。
         *                   這是「刪掉他的相簿會連帶消失多少」，停權／刪帳號
         *                   的對話框靠它講話，跟他本人的貢獻無關。
         *   uploaded_count  他自己傳了幾張，**含傳進別人相簿的那些**。
         *                   這才是畫面上該當成「這個人傳了多少」的數字。
         *
         * 之前列表印的是 photo_count，於是「站長建 1 本傳 1 張、家人往那本
         * 傳 1 張」會顯示成站長 2 張、家人 1 張 —— 兩個人都不對（2026-08-14）。
         *
         * uploaded_count 拆成兩段而不是寫 COALESCE(p.uploaded_by, a.user_id)：
         * 包在函式裡的欄位用不到索引，那會變成每列掃一遍整張 Photo。
         * 拆開之後前段走 idx_photo_uploaded_by、後段走 album_id，語意一模一樣
         * （NULL ＝ 回頭看相簿主人，見 migration 0008）。
         */
        if (method === "GET" && pathname === "/api/admin/users") {
          const { results } = await env.DB.prepare(`
            SELECT u.id, u.name, u.email, u.role,
                   u.can_manage_others, u.can_add_to_others, u.can_reorder_others,
                   u.can_comment, u.can_view_comments, u.can_view_map, u.can_use_tools, u.active,
                   u.last_login_at, u.created_at,
                   u.track_color, u.avatar_key, u.track_drive_folder_id,
                   (SELECT COUNT(*) FROM Album a WHERE a.user_id = u.id) AS album_count,
                   (SELECT COUNT(*) FROM Photo p JOIN Album a ON a.id = p.album_id WHERE a.user_id = u.id) AS photo_count,
                   (SELECT COUNT(*) FROM Photo p WHERE p.uploaded_by = u.id)
                   + (SELECT COUNT(*) FROM Photo p JOIN Album a ON a.id = p.album_id
                       WHERE p.uploaded_by IS NULL AND a.user_id = u.id) AS uploaded_count
              FROM User u
             ORDER BY (u.role = 'owner') DESC, u.active DESC, u.id
          `).all();
          // avatar_key 是 R2 檔名，前端要的是網址（見 avatarUrl）。整列照樣往外送，
          // 站長後台本來就看得到這些欄位
          return new Response(JSON.stringify((results as any[]).map((u) => ({
            ...u, avatar: avatarUrl(url.origin, u.avatar_key),
          }))), { headers });
        }

        // 路由：加一個人進白名單。只需要信箱 —— 他第一次 Google 登入就自動對上
        if (method === "POST" && pathname === "/api/admin/users") {
          const body: { email?: string; name?: string; can_manage_others?: any; can_use_tools?: any } = await request.json();
          const email = String(body.email ?? "").trim().toLowerCase();
          if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
            return new Response(JSON.stringify({ error: "請填一個看起來像信箱的東西" }), { status: 400, headers });
          }
          const name = String(body.name ?? "").trim() || email.split("@")[0];
          const canManage = body.can_manage_others ? 1 : 0;
          /*
           * 管理工具**預設不給**（見 migrations/0016）。欄位本身是 DEFAULT 1
           * ——那是為了不動到現有成員——所以這裡一定要明寫，不能靠預設值。
           * 使用者要的正是「新增白名單時決定給不給」。
           */
          const canUseTools = body.can_use_tools ? 1 : 0;

          /*
           * 配一個還沒被用到的顏色。
           *
           * 依 uid 的預設色（trackColorFor）已經保證「不會全部同色」，但它不知道
           * 別人手動挑過什麼 —— 站長把自己改成藍色之後，第二個人的預設剛好也是藍色。
           * 所以這裡看一遍**現在實際生效的顏色**（含預設），挑第一個沒人用的存進去。
           *
           * 存進去而不是繼續走預設：新成員一加進來，顏色就定了，不會因為別人改色
           * 而跟著飄。全部十色都用完（家庭不會發生）就交給 trackColorFor 去輪。
           */
          const { results: taken } = await env.DB.prepare(
            "SELECT id, track_color FROM User WHERE active = 1"
          ).all();
          const used = new Set((taken as any[]).map((u) => trackColorFor(Number(u.id), u.track_color)));
          const freeColor = TRACK_PALETTE.find((c) => !used.has(c)) ?? null;

          const existing = await env.DB.prepare(
            "SELECT id, active, track_color FROM User WHERE lower(email) = ?"
          ).bind(email).first<any>();
          if (existing) {
            // 曾經被移出白名單的人再加回來 —— 就是把 active 打開，他的相簿都還在。
            // 顏色只在他從來沒有過的時候才補（COALESCE）：以前挑過什麼就還他什麼
            await env.DB.prepare(
              "UPDATE User SET active = 1, can_manage_others = ?, can_use_tools = ?, name = ?, track_color = COALESCE(track_color, ?) WHERE id = ?"
            ).bind(canManage, canUseTools, name, freeColor, existing.id).run();
            const row = await env.DB.prepare("SELECT id, name, email, role, can_manage_others, can_add_to_others, can_reorder_others, can_use_tools, active, track_color FROM User WHERE id = ?")
              .bind(existing.id).first();
            return new Response(JSON.stringify({ success: true, restored: Number(existing.active) !== 1, user: row }), { headers });
          }

          const res = await env.DB.prepare(
            "INSERT INTO User (name, email, role, can_manage_others, can_use_tools, active, track_color) VALUES (?, ?, 'member', ?, ?, 1, ?)"
          ).bind(name, email, canManage, canUseTools, freeColor).run();
          const id = res.meta.last_row_id;
          const row = await env.DB.prepare("SELECT id, name, email, role, can_manage_others, can_add_to_others, can_reorder_others, can_use_tools, active, track_color FROM User WHERE id = ?")
            .bind(id).first();
          return new Response(JSON.stringify({ success: true, user: row }), { headers });
        }

        /* ── 綁定某個人的 GPSLogger Drive 資料夾 ──────────────────────────────
         *
         * 為什麼是**獨立一條**而不是塞進 PUT /api/admin/users/:id：那一條為了
         * 防呆，站長自己那一列一律 400（權限不能自己改掉）。但資料夾是要綁的，
         * 站長自己也得綁得了，所以拆開來。
         *
         * folder_id 送 null／空字串＝解除綁定。這裡不驗證資料夾在 Drive 上存不存在。
         *
         * ⚠️ 後台已經**沒有畫面在打這一條**了 —— 綁定改成
         * `POST /api/tracks/drive/sync-folders` 照信箱自動配對。留著它是唯一的
         * 人工覆寫路徑：家人手機上的 Google 帳號跟他登入本站的帳號不同時，
         * 自動配對永遠對不到，只能直接打這一條（或改 D1）把他綁上去。
         */
        const folderMatch = pathname.match(/^\/api\/admin\/users\/(\d+)\/track-folder$/);
        if (folderMatch && method === "PUT") {
          const targetId = Number(folderMatch[1]);
          const target = await env.DB.prepare("SELECT id FROM User WHERE id = ?").bind(targetId).first<any>();
          if (!target) {
            return new Response(JSON.stringify({ error: "找不到這個帳號" }), { status: 404, headers });
          }
          const body = await request.json().catch(() => ({})) as { folder_id?: any };
          const raw = body.folder_id == null ? "" : String(body.folder_id).trim();
          const folderId = raw || null;

          /*
           * 一個資料夾只能綁一個人。綁重了兩個人會同步到同一批 GPX，
           * 而 day_key 帶各自的前綴 —— 同一天的軌跡會憑空多出一份「別人的」。
           */
          if (folderId) {
            const dup = await env.DB.prepare(
              "SELECT id, name FROM User WHERE track_drive_folder_id = ? AND id != ?"
            ).bind(folderId, targetId).first<any>();
            if (dup) {
              return new Response(JSON.stringify({
                error: `這個資料夾已經綁在「${dup.name}」身上了`,
              }), { status: 409, headers });
            }
          }

          await env.DB.prepare("UPDATE User SET track_drive_folder_id = ? WHERE id = ?")
            .bind(folderId, targetId).run();
          return new Response(JSON.stringify({ success: true, folder_id: folderId }), { headers });
        }

        /* ── 路由：某個人的貢獻明細（他在每本相簿各傳了幾張）───────────────────
         *
         * 清單上的兩個總數回答不了「這 5 張散在哪」，尤其家人本來就會互相往
         * 對方的相簿裡傳。這一支把它攤開，分成兩疊：
         *
         *   own_albums  他建的相簿。每本印「他傳的 / 總共」兩個數字 ——
         *               差額就是別人傳進來的，順便解釋了舊版那個數字是怎麼來的。
         *               **傳 0 張的相簿也要列**（他建了但都是別人在傳，
         *               或空相簿），所以是從 Album 出發而不是從 Photo 出發。
         *   elsewhere   他傳進別人相簿的。uploaded_by IS NULL 的照片不可能
         *               落在這一疊 —— NULL 的意思就是「算相簿主人的」。
         *
         * 站長按下「明細」才會打這一支，不跟著白名單清單一起回：
         * 清單是每次進 /admin 都要付的錢，明細是想看才付。
         */
        const contribMatch = pathname.match(/^\/api\/admin\/users\/(\d+)\/contributions$/);
        if (contribMatch && method === "GET") {
          const targetId = Number(contribMatch[1]);
          const target = await env.DB.prepare(
            "SELECT id FROM User WHERE id = ?"
          ).bind(targetId).first<any>();
          if (!target) {
            return new Response(JSON.stringify({ error: "找不到這個帳號" }), { status: 404, headers });
          }

          const [own, elsewhere] = await env.DB.batch<any>([
            env.DB.prepare(`
              SELECT a.id AS album_id, a.name AS album_name,
                     (SELECT COUNT(*) FROM Photo p WHERE p.album_id = a.id) AS total,
                     (SELECT COUNT(*) FROM Photo p WHERE p.album_id = a.id
                        AND (p.uploaded_by = ? OR p.uploaded_by IS NULL)) AS uploaded
                FROM Album a
               WHERE a.user_id = ?
               ORDER BY a.id DESC
            `).bind(targetId, targetId),
            env.DB.prepare(`
              SELECT a.id AS album_id, a.name AS album_name,
                     a.user_id AS owner_id, ou.name AS owner_name,
                     COUNT(*) AS uploaded
                FROM Photo p
                JOIN Album a ON a.id = p.album_id
                LEFT JOIN User ou ON ou.id = a.user_id
               WHERE p.uploaded_by = ? AND a.user_id <> ?
               GROUP BY a.id
               ORDER BY uploaded DESC, a.id DESC
            `).bind(targetId, targetId),
          ]);

          const ownAlbums = (own.results ?? []).map((r: any) => ({
            album_id: Number(r.album_id),
            album_name: r.album_name,
            total: Number(r.total ?? 0),
            uploaded: Number(r.uploaded ?? 0),
          }));
          const elsewhereAlbums = (elsewhere.results ?? []).map((r: any) => ({
            album_id: Number(r.album_id),
            album_name: r.album_name,
            owner_id: Number(r.owner_id),
            owner_name: r.owner_name ?? null,
            uploaded: Number(r.uploaded ?? 0),
          }));

          return new Response(JSON.stringify({
            id: targetId,
            own_albums: ownAlbums,
            elsewhere: elsewhereAlbums,
            // 前端不必自己加總；這兩個數字要跟清單上那兩欄對得起來
            album_count: ownAlbums.length,
            uploaded_count:
              ownAlbums.reduce((n: number, a: any) => n + a.uploaded, 0)
              + elsewhereAlbums.reduce((n: number, a: any) => n + a.uploaded, 0),
          }), { headers });
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
             * uploaded_by 從 0011 起有索引（idx_photo_uploaded_by），所以這幾個
             * COUNT 不再是全表掃描。仍然只在站長真的打開刪除視窗時才算 ——
             * 這幾個數字只有這個視窗用得到，沒理由讓每次進 /admin 都付這筆錢。
             */
            const counts = await env.DB.prepare(`
              SELECT
                (SELECT COUNT(*) FROM Album WHERE user_id = ?) AS albums,
                (SELECT COUNT(*) FROM Photo p JOIN Album a ON a.id = p.album_id
                  WHERE a.user_id = ?) AS photos_in_albums,
                (SELECT COUNT(*) FROM Photo WHERE uploaded_by = ?) AS photos_uploaded,
                (SELECT COUNT(*) FROM Photo p JOIN Album a ON a.id = p.album_id
                  WHERE p.uploaded_by = ? AND a.user_id <> ?) AS photos_elsewhere,
                (SELECT COUNT(*) FROM TrackDay WHERE user_id = ?) AS track_days
            `).bind(targetId, targetId, targetId, targetId, targetId, targetId).first<any>();
            return new Response(JSON.stringify({
              id: targetId,
              email: target.email,
              albums: Number(counts?.albums ?? 0),
              photos_in_albums: Number(counts?.photos_in_albums ?? 0),
              photos_uploaded: Number(counts?.photos_uploaded ?? 0),
              photos_elsewhere: Number(counts?.photos_elsewhere ?? 0),
              track_days: Number(counts?.track_days ?? 0),
            }), { headers });
          }

          // 保留下來的相簿要有人接手，而接手的人是站長本人。極端情況下站上
          // 一個 owner 列都沒有（舊 token 密碼登入 + User 表被清過），那就別動
          if (actor.uid == null) {
            return new Response(JSON.stringify({ error: "站上找不到站長的帳號列，無法接手保留下來的內容" }), { status: 400, headers });
          }

          const dropAlbums = url.searchParams.get("albums") === "1";
          const dropPhotos = url.searchParams.get("photos") === "1";
          const dropTracks = url.searchParams.get("tracks") === "1";

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

          // 3. Drive：整本刪掉的相簿搬資料夾，其餘（別人相簿裡的照片、
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

            /*
             * 4. **D1 收乾淨之後才刪 R2**（主檔 + 800px + 400px），一次最多 1000 個鍵。
             *
             * 跟刪照片、刪相簿同一個順序。R2 排在前面的話，它丟一次暫時性的錯誤
             * 就會讓整支路由 500，而照片那些列還在 —— 帳號刪了一半，畫面上留下
             * 一堆點開是破圖的照片。反過來最壞只是 R2 留下幾顆沒人指著的縮圖。
             */
            try {
              const keys = photos.flatMap((p) => r2KeysForPhoto(p));
              for (let i = 0; i < keys.length; i += 1000) {
                await env.BUCKET.delete(keys.slice(i, i + 1000));
              }
            } catch (e) {
              console.error(`清除帳號 ${targetId} 的內容時，R2 物件沒刪乾淨（列已經刪了）`, e);
            }
          }

          // 5. 相簿本身。一條 statement 就掃完，不必按 id 切塊
          if (dropAlbums) {
            await env.DB.prepare("DELETE FROM Album WHERE user_id = ?").bind(targetId).run();
          }

          /*
           * 5b. GPS 軌跡。跟相簿同一套語意：勾了就連 R2 上的原始 GPX
           *     與貼路結果一起清，沒勾就在下一步改掛站長。
           *
           *     TrackPoint 有 ON DELETE CASCADE，刪 TrackDay 會一起帶走；
           *     但 **R2 的物件沒有外鍵**，不在這裡清就永遠是孤兒
           *     （key 由 day_key 推得，列一刪就再也算不出來）。
           */
          let deletedTrackDays = 0;
          if (dropTracks) {
            const { results: dayRows } = await env.DB.prepare(
              "SELECT day_key, raw_key FROM TrackDay WHERE user_id = ?"
            ).bind(targetId).all<any>();
            deletedTrackDays = dayRows.length;
            if (dayRows.length > 0) {
              await env.DB.prepare("DELETE FROM TrackDay WHERE user_id = ?").bind(targetId).run();
              // 列先收掉再刪 R2，理由同上（R2 失敗不該讓整個清除半路 500）
              try {
                const keys = dayRows.flatMap((d) => [
                  typeof d.raw_key === "string" && d.raw_key ? d.raw_key : rawTrackKey(d.day_key),
                  matchedKey(d.day_key),
                ]);
                for (let i = 0; i < keys.length; i += 1000) {
                  await env.BUCKET.delete(keys.slice(i, i + 1000));
                }
              } catch (e) {
                console.error(`清除帳號 ${targetId} 的軌跡時，R2 物件沒刪乾淨（列已經刪了）`, e);
              }
            }
          }

          /*
           * 6. 沒被刪掉的東西改掛站長名下。**一定要排在刪 User 之前** ——
           *    Album.user_id 是 ON DELETE CASCADE，順序反過來就會把留下來的
           *    相簿連同照片一起被外鍵帶走，而且 R2 與 Drive 上的檔案不會跟著清。
           *
           *    TrackDay.user_id 沒有 CASCADE（0009 刻意的），但同樣要在這裡改掛：
           *    留著指向已刪帳號的 user_id，那些軌跡在地圖上會變成沒有主人、
           *    也沒有顏色的一條線。
           */
          const moved = await env.DB.prepare(
            "UPDATE Album SET user_id = ? WHERE user_id = ?"
          ).bind(actor.uid, targetId).run();
          // uploaded_by 沒有外鍵，不清會留下指向不存在帳號的 id
          //（前端的 canEdit 拿它跟自己的 uid 比對，id 被重用時會誤判）
          const orphaned = await env.DB.prepare(
            "UPDATE Photo SET uploaded_by = NULL WHERE uploaded_by = ?"
          ).bind(targetId).run();
          const movedTracks = await env.DB.prepare(
            "UPDATE TrackDay SET user_id = ? WHERE user_id = ?"
          ).bind(actor.uid, targetId).run();

          // 7. 人本身。他的頭像跟軌跡檔一樣沒有外鍵，列一刪就再也算不出鍵，
          //    所以要在這裡順手清掉（best-effort，失敗頂多留一顆孤兒物件）
          const avatarRow = await env.DB.prepare("SELECT avatar_key FROM User WHERE id = ?")
            .bind(targetId).first<any>();
          if (avatarRow?.avatar_key) {
            ctx.waitUntil(env.BUCKET.delete(avatarR2Key(avatarRow.avatar_key)).catch(() => {}));
          }
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
            deleted_track_days: deletedTrackDays,
            kept_albums: Number(moved.meta?.changes ?? 0),
            kept_photos: Number(orphaned.meta?.changes ?? 0),
            kept_track_days: Number(movedTracks.meta?.changes ?? 0),
          }), { headers });
        }

        const idMatch = pathname.match(/^\/api\/admin\/users\/(\d+)$/);
        if (idMatch && (method === "PUT" || method === "DELETE")) {
          const targetId = Number(idMatch[1]);
          const target = await env.DB.prepare(
            "SELECT id, name, email, role, can_manage_others, can_add_to_others, can_reorder_others, active FROM User WHERE id = ?"
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
            const body: {
              name?: string; can_manage_others?: any; active?: any;
              can_add_to_others?: any; can_reorder_others?: any;
              can_comment?: any; can_view_comments?: any; can_view_map?: any;
              can_use_tools?: any;
            } = await request.json();
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
            /*
             * 這兩欄是 can_manage_others 底下的細項（見 migrations/0010）。
             * **關掉時照存不覆蓋** —— 勾了「可管理全站」的人這兩欄的值不會被讀到
             * （currentActor 直接短路成全開），所以站長把全站權限收回來的時候，
             * 這裡留著的還是他當初勾的那份設定，不會突然多給或少給。
             */
            if (body.can_add_to_others !== undefined) {
              sets.push("can_add_to_others = ?"); binds.push(body.can_add_to_others ? 1 : 0);
            }
            if (body.can_reorder_others !== undefined) {
              sets.push("can_reorder_others = ?"); binds.push(body.can_reorder_others ? 1 : 0);
            }
            /*
             * 留言那兩欄與足跡那一欄跟上面兩欄不同：**「可管理全站」不會蓋過它們**
             * （見 Actor 的註解）。所以這裡沒有「勾了全站就別管細項」那種關係，
             * 站長勾什麼就是什麼。
             */
            if (body.can_comment !== undefined) {
              sets.push("can_comment = ?"); binds.push(body.can_comment ? 1 : 0);
            }
            if (body.can_view_comments !== undefined) {
              sets.push("can_view_comments = ?"); binds.push(body.can_view_comments ? 1 : 0);
            }
            if (body.can_view_map !== undefined) {
              sets.push("can_view_map = ?"); binds.push(body.can_view_map ? 1 : 0);
            }
            if (body.can_use_tools !== undefined) {
              sets.push("can_use_tools = ?"); binds.push(body.can_use_tools ? 1 : 0);
            }
            if (body.active !== undefined) {
              sets.push("active = ?"); binds.push(body.active ? 1 : 0);
            }
            if (sets.length === 0) {
              return new Response(JSON.stringify({ error: "沒有要改的東西" }), { status: 400, headers });
            }
            await env.DB.prepare(`UPDATE User SET ${sets.join(", ")} WHERE id = ?`).bind(...binds, targetId).run();
            const row = await env.DB.prepare("SELECT id, name, email, role, can_manage_others, can_add_to_others, can_reorder_others, can_comment, can_view_comments, can_view_map, can_use_tools, active FROM User WHERE id = ?")
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
       /*
        * 預覽圖要不要含不開放的那幾張，取決於是誰在看 —— 所以這裡要的是 actor
        * 而不只是「有沒有登入」。currentActor 對同一個 request 只查一次 D1，
        * 這行不會比原本的 isAuthorized 多花任何讀取。
        */
       const albumsActor = await currentActor(request, env);
       // 快取 60 秒，剛好對齊下面預覽圖的分鐘種子 —— 種子換人時快取也正好過期，
       // 不會出現「快取裡的舊種子」與「新算出來的種子」互相打架的空窗
       // 預覽圖會濾掉不開放的照片，所以這份清單要跟著版本號走（見 bumpContentEpoch）
       const albumsEpoch = albumsActor !== null ? null : await contentEpoch(env);
       return withEdgeCache(request, ctx,
         { browserMaxAge: 10, edgeMaxAge: 60, skip: albumsActor !== null, epoch: albumsEpoch },
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
        // 不開放的那幾張不可以被抽成預覽圖 —— 首頁那排小圖是整個站最公開的地方
        const previewRestricted = canSeeRestricted(albumsActor) ? "" : " AND restricted = 0";
        const previewSelect = (op: string) =>
          `SELECT COALESCE(thumb_sm_url, thumb_url, url) AS url
             FROM Photo WHERE album_id = ? AND shuffle_key ${op} ?${previewRestricted}
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
       * **任何一步失敗都退回 R2 的 800px 縮圖**，包含 drive_file_id 還是 NULL 的照片、
       * SA 沒設定、Drive 當掉。燈箱永遠打得開，只是會小一點 —— 前端在角落標示原因
       * （看 drive_file_id 有沒有值，不看這條路由實際走了哪一邊）。
       *
       * 2026-08-14 起 R2 不再存 2000px 的中間版本，所以這裡的退路就是相簿格線那張。
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

        /*
         * ⚠️ **D1 一定要查在 cache.match 之前，順序不能倒回去。**
         *
         * 曾經是反過來的（先撈邊緣快取、撈不到才查 D1），那是「不開放」的一個破口：
         * 一張照片在還沒被標成不開放之前只要有人開過燈箱，那份 4K 就以 immutable
         * 一年躺在共用的邊緣快取裡；之後才標成不開放的話，後面的請求在快取那一行
         * 就回去了，底下的檢查根本沒機會跑。**邊緣快取沒辦法從這裡精準清掉**
         * （cache.delete 只作用在當下這一個機房），所以只能把順序倒過來。
         *
         * 代價是每看一次大圖多一次 D1 讀取（主鍵單列，不是掃描）。換來的除了
         * 正確性還有一件好事：**沒有不開放的照片現在全站共用同一份快取** ——
         * 舊版把 adm 掛進 key，等於管理員自己一份、其他人一份，同一張照片的
         * Drive 取檔次數直接翻倍。
         */
        const photo = await env.DB.prepare(
          // url 現在跟 thumb_url 是同一顆物件，但舊照片（Google 同步進來的那批）
          // 只有 url，所以還是照 COALESCE 的順序逐級退
          "SELECT COALESCE(thumb_url, thumb_sm_url, url) AS fallback_url, drive_file_id, restricted FROM Photo WHERE id = ?"
        ).bind(photoId).first<any>();
        if (!photo) {
          return new Response(JSON.stringify({ error: "Photo not found" }), { status: 404, headers });
        }

        /*
         * 不開放的照片對其他人來說**不存在**，所以回 404 而不是 403 ——
         * 403 等於告訴對方「這個編號上有東西，只是你不能看」。
         *
         * <img src> 帶不了 Authorization，所以這裡認的是票的粒度（見 mintMediaToken）；
         * 真的用 fetch 帶 token 進來的也認。**只有不開放的那幾張需要問這件事**，
         * 一般照片一次都不問 —— currentActor 因此完全不會被叫去查 D1。
         */
        const isRestricted = Number(photo.restricted) === 1;
        if (isRestricted) {
          const elevated = (await requestMediaScope(request, url, env)) === 'admin'
            || canSeeRestricted(await currentActor(request, env));
          if (!elevated) {
            return new Response(JSON.stringify({ error: "Photo not found" }), { status: 404, headers });
          }
        }

        /*
         * cache key 把 mt 拿掉。閘門已經驗過了，留在 key 裡只會讓每個人、每次登入
         * 都是一份獨立的邊緣快取 —— 同一張照片的 Drive 取檔次數直接乘上人數。
         * 圖片位元組不隨身分變化，所以共用一份是對的。
         *
         * 不開放的那幾張另外掛 adm=1，把它們的位元組跟公開照片分開存（上面已經
         * 擋掉了，這純粹是多一層保險）。⚠️ adm 一定要**先 delete 再由伺服器自己
         * set** —— 照抄請求裡的 `?adm=1` 等於讓任何人自己指定要讀哪一份快取。
         */
        const keyUrl = new URL(request.url);
        keyUrl.searchParams.delete("mt");
        keyUrl.searchParams.delete("adm");
        if (isRestricted) keyUrl.searchParams.set("adm", "1");
        const cacheKey = new Request(keyUrl.toString(), { method: "GET" });
        const hit = await cache.match(cacheKey);
        if (hit) return hit;

        const fallback = () => new Response(null, {
          status: 302,
          headers: {
            Location: photo.fallback_url,
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
       * 路由：影片位元組。
       *
       * 跟上面的 /full 是同一個模式（Drive 上的檔沒有分享給任何人，只有 service
       * account 讀得到，所以一定要經過 Worker 代理），但有三處刻意不一樣：
       *
       * 1. **Range 原封轉發，回應照樣 206。** <video> 拖時間軸、手機分段下載全靠
       *    這個；一律回整份的話，每拖一次就是重下一支完整的影片。
       * 2. **不進 caches.default。** Cache API 存的是「這個網址的一整份回應」，
       *    而這裡每個請求要的範圍都不同 —— 把某一段 206 存成那個網址的答案，
       *    下一個要別段的人就會拿到錯的位元組。瀏覽器自己的媒體快取已經夠用，
       *    而且 Drive 那個 file id 的內容永遠不變，下面給的是一年 immutable。
       * 3. **沒有退路。** 照片拿不到 Drive 還能退回 R2 的 800px；影片在 R2 只有
       *    一張封面圖，退回去就是一張不會動的圖 —— 比明確報錯更難懂。
       *
       * 位元組是串流轉發的，不落 Worker 的記憶體（見 fetchDriveMediaRange），
       * 所以 2GB 的影片跟 128MB 的記憶體上限沒有關係。
       *
       * ⚠️ 影片的 Drive id 存在 **drive_original_id**，不是 drive_file_id（見 0019）。
       */
      if (method === "GET" && pathname.startsWith("/api/photos/")
          && pathname.endsWith("/video") && pathname.split("/").length === 5) {
        const photoId = pathname.split("/")[3];
        const photo = await env.DB.prepare(
          "SELECT drive_original_id, media_type, restricted FROM Photo WHERE id = ?"
        ).bind(photoId).first<any>();

        // 對著一張照片要影片是前端弄錯了，不要真的去代理一張圖片的位元組
        if (!photo || photo.media_type !== "video") {
          return new Response(JSON.stringify({ error: "Video not found" }), { status: 404, headers });
        }
        /*
         * 不開放的影片：跟 /full 同一套判斷，一樣回 404 不是 403。
         * 這條路由本來就不進 caches.default（回應是某一段 Range），所以沒有
         * 上面那個 cache key 的問題。
         */
        if (Number(photo.restricted) === 1
            && (await requestMediaScope(request, url, env)) !== 'admin'
            && !canSeeRestricted(await currentActor(request, env))) {
          return new Response(JSON.stringify({ error: "Video not found" }), { status: 404, headers });
        }
        // 上傳到一半斷掉會留下這種列：封面已經在 R2，影片還沒送上 Drive
        if (!photo.drive_original_id) {
          return new Response(JSON.stringify({ error: "這支影片還沒上傳到 Drive" }), { status: 404, headers });
        }
        if (!env.GOOGLE_DRIVE_SA_KEY) {
          return new Response(JSON.stringify({ error: "Drive 未設定" }), { status: 503, headers });
        }

        try {
          const upstream = await fetchDriveMediaRange(
            env.GOOGLE_DRIVE_SA_KEY, photo.drive_original_id, request.headers.get("Range"),
          );
          /*
           * 這幾個標頭少一個 <video> 就不肯讓人拖時間軸：Accept-Ranges 是「可以拖」，
           * Content-Range／Content-Length 是這一段在哪、有多長。**照抄上游的**，
           * 不要自己算 —— 算錯的話瀏覽器會在影片中間卡住不動。
           */
          const videoHeaders = new Headers();
          for (const h of ["Content-Type", "Content-Length", "Content-Range", "Accept-Ranges", "ETag"]) {
            const v = upstream.headers.get(h);
            if (v) videoHeaders.set(h, v);
          }
          // Drive 偶爾回 application/octet-stream，那樣 <video> 直接不收
          const upType = videoHeaders.get("Content-Type") || "";
          if (!upType.startsWith("video/")) videoHeaders.set("Content-Type", "video/mp4");
          if (!videoHeaders.has("Accept-Ranges")) videoHeaders.set("Accept-Ranges", "bytes");
          videoHeaders.set("Access-Control-Allow-Origin", "*");
          /*
           * private ＝ 只准瀏覽器自己留，不准任何共用快取（含 Cloudflare 邊緣）碰。
           * 這裡的回應是「某個範圍」，共用快取存下來一定會餵錯給別人。
           */
          videoHeaders.set("Cache-Control", "private, max-age=31536000, immutable");
          return new Response(upstream.body, { status: upstream.status, headers: videoHeaders });
        } catch (e) {
          console.error("Drive 影片取檔失敗", e);
          return new Response(JSON.stringify({ error: "影片取檔失敗" }), { status: 502, headers });
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
        const albumActor = await currentActor(request, env);
        const albumIsAdmin = albumActor !== null;
        const albumEpoch = albumIsAdmin ? null : await contentEpoch(env);
        return withEdgeCache(request, ctx,
          { browserMaxAge: 10, edgeMaxAge: 300, skip: albumIsAdmin, epoch: albumEpoch },
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
          WHERE p.album_id = ?${canSeeRestricted(albumActor) ? "" : ` AND ${RESTRICTED_VISIBLE_COND}`}
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
       const searchActor = await currentActor(request, env);
       const searchIsAdmin = searchActor !== null;
       const searchEpoch = searchIsAdmin ? null : await contentEpoch(env);
       return withEdgeCache(request, ctx,
         { browserMaxAge: 10, edgeMaxAge: 300, skip: searchIsAdmin, epoch: searchEpoch },
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
        // 不開放的那幾張連搜尋都搜不到（FTS 索引照樣建著，過濾在外層）
        if (!canSeeRestricted(searchActor)) where.push(RESTRICTED_VISIBLE_COND);
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
        const geoPendingActor = await currentActor(request, env);
        if (!geoPendingActor) {
          return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers });
        }
        const cursor = Number(url.searchParams.get("cursor") ?? 0) || 0;
        const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 1000) || 1000, 1), 2000);
        const onlyMissing = url.searchParams.get("only_missing") === "1";
        // 不開放的那幾張對其他人來說不存在，時間軸比對也不該把它們列出來
        const geoPendingRestricted = canSeeRestricted(geoPendingActor) ? "" : "AND restricted = 0";

        const { results: photos } = await env.DB.prepare(`
          SELECT id, lat, taken_at, taken_at_local
            FROM Photo
           WHERE id > ? ${onlyMissing ? "AND lat IS NULL" : ""} ${geoPendingRestricted}
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
        // Drive 上唯一的寫入身分＝站長本人的 Google 授權（見 driveWriterOwner）
        const writer = await driveWriterOwner(env);
        return new Response(JSON.stringify({
          client_id: env.GOOGLE_CLIENT_ID || null,
          sa_email: saEmail,
          photos_folder_id: folders.photos,
          trash_folder_id: folders.trash,
          // 這個環境的根資料夾要叫什麼（見 driveRootFolderName）。網頁第一次
          // 上傳時照這個名字去找／去建，不能寫死在前端 —— 三個環境不同名
          root_folder_name: driveRootFolderName(env, url),
          // 所有人的上傳都用這個帳號的身分寫進 Drive（不是「現在登入的人」）。
          // null＝站長還沒用 Google 登入過這個環境，那就是真的傳不了
          writer_email: writer?.email ?? null,
          // 少任何一項都上傳不了，讓前端一眼看出是哪裡沒設好
          ready: Boolean(env.GOOGLE_CLIENT_ID && saEmail && writer),
        }), { headers });
      }

      /*
       * 路由：還沒搬上 Drive 的照片與影片（「補傳 Drive」批次動作的來源）。
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
        const drivePendingActor = await currentActor(request, env);
        if (!drivePendingActor) {
          return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers });
        }
        const cursor = Number(url.searchParams.get("cursor") ?? 0) || 0;
        const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 200) || 200, 1), 500);
        const albumId = Number(url.searchParams.get("album_id") ?? 0) || 0;
        /*
         * 不開放的那幾張對其他人來說不存在，這張清單會端出縮圖網址 —— 一樣要濾掉。
         * ⚠️ 底下的列表與 COUNT **必須用同一個條件**，不然「剩幾張」永遠歸不了零，
         *    補傳的進度條會卡在一個補不完的數字上。
         */
        const drivePendingRestricted = canSeeRestricted(drivePendingActor) ? "" : " AND restricted = 0";
        const albumClause = (albumId ? " AND album_id = ?" : "") + drivePendingRestricted;

        /*
         * ⚠️ **影片與照片的「有沒有備份」是兩個不同的問題，不能寫成同一句。**
         *
         *   照片：4K（drive_file_id）＋ 原始檔（drive_original_id）**兩份都要**。
         *   影片：只有原始檔一份，drive_file_id 對它永遠是 NULL（見 0019）。
         *
         * 以前這裡是 `drive_file_id IS NULL AND media_type = 'photo'`，兩邊都漏：
         *   ① 影片整類被排除掉 —— 上傳時 Drive 失敗的影片**永遠不會出現在補傳清單上**，
         *      使用者手上只剩一張封面圖，而站上沒有任何地方講得出這件事。
         *      （當初排除是對的，因為不排除的話每支影片都會賴著補不完，
         *        而且補傳會拿影片去跑 encode4kWebp —— 正解是分開判斷，不是整類丟掉。）
         *   ② 照片只看 4K —— 「4K 上去了、原始檔失敗」的那些一輩子看不到。
         *      pushPhotoToDrive 兩份是分開 try 的，這種半套結果本來就會發生。
         *
         * ⚠️ 列表與 COUNT **必須用同一個條件**，不然「剩幾張」永遠歸不了零。
         *    共用底下這個字串就是為了讓它們沒辦法不一致。
         */
        const drivePendingCond = `(
             (media_type = 'video' AND drive_original_id IS NULL)
          OR (media_type != 'video' AND (drive_file_id IS NULL OR drive_original_id IS NULL))
        )`;

        const { results: photos } = await env.DB.prepare(`
          SELECT id, url, file_name, title, media_type, thumb_url,
                 drive_file_id IS NOT NULL AS has_4k,
                 drive_original_id IS NOT NULL AS has_original
            FROM Photo
           WHERE id > ? AND ${drivePendingCond}${albumClause}
           ORDER BY id LIMIT ?
        `).bind(...(albumId ? [cursor, albumId, limit] : [cursor, limit])).all();

        // 剩幾張要另外算：photos 只是這一批，進度條需要總數
        const remaining = await env.DB.prepare(
          `SELECT COUNT(*) AS n FROM Photo WHERE ${drivePendingCond}${albumClause}`
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

      /**
       * 可不可以把**新的照片放進**這本相簿。
       *
       * 跟 canTouchAlbum 分開：往別人的相簿裡加一張照片，最壞的情況是主人自己
       * 刪掉它（那張照片的 uploaded_by 記著是誰放的）；改名、刪相簿則是別人的
       * 東西直接消失。前者預設放行，後者維持原樣。開關在 User.can_add_to_others，
       * 站長可以單獨對某個人關掉（見 migrations/0010）。
       *
       * 有 can_add_to_others 就一路放行、連相簿存不存在都不查 —— 跟
       * canManageOthers 的短路同一個理由：上傳是逐張呼叫的，多一次讀取會乘上
       * 一整批照片的張數。相簿不存在的話下面的 INSERT 自己會撞外鍵。
       */
      const canAddToAlbum = async (albumId: string | number): Promise<boolean> => {
        if (me.canAddToOthers) return true;
        return canTouchAlbum(albumId);
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

      /**
       * 這一天的軌跡在不在我的管轄範圍。找不到那一列也回 false ——
       * 呼叫端要嘛回 404，要嘛（ingest）自己決定要開在誰的名下。
       *
       * 軌跡從 0009 起是「每個人各自一份」，不再是全站共用資產，
       * 所以規則跟相簿、照片完全一樣：canManageOthers 全開，其餘只動自己的。
       */
      const canTouchTrackDay = async (dayKey: string): Promise<boolean> => {
        if (me.canManageOthers) return true;
        const row = await trackDayOwnership(env, dayKey);
        return row ? actorOwns(me, row) : false;
      };

      /*
       * 全站共用的維護工具，只有管得動別人的帳號能碰。
       * （白名單那幾支更嚴，是站長限定，而且在上面就先回應了。）
       *
       * **GPS 軌跡與 Google 時間軸都不在這份清單裡**：每個成員各自上傳、
       * 各自擁有，擋在這裡會讓一般成員連自己的東西都寫不進來。
       * 軌跡改由各路由用 canTouchTrackDay() 逐日檢查 —— 那才問得出「這一天是誰的」；
       * 時間軸則是 R2 key 依 uid 分開（timelineIndexKey），寫入永遠只寫得到自己那一包。
       *
       * **`/api/config/drive-folders` 2026-08-14 移出這份清單**：它是第一次上傳的
       * bootstrap，資料庫一清就會有人是「第一個上傳的人」，那個人不見得是站長。
       * 擋著的話家人的第一次上傳會 403，照片進得了 R2 卻沒有 Drive 備份。
       * 它本來就是**只寫得了一次**（第二次回 409），而且資料夾一定建在站長的
       * Drive 裡（用的是寫入帳號的 token），開放給所有管理員是安全的。
       */
      const isSharedResourceWrite = pathname.startsWith("/api/admin/");
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

      /*
       * 路由：切換單張（或一批）照片／影片的「不開放」。
       *
       * ⚠️ **位置不能往後搬**：`/api/photos/restricted` 切出來是 4 段，跟底下
       *    `PUT /api/photos/:id` 那條的長度判斷一模一樣（見 CLAUDE.md「路由靠
       *    pathname.split 分辨」那條坑）。排在它後面的話，這個網址會被當成
       *    「id 叫 restricted 的照片」吃掉。隔壁的 /api/photos/reorder 也是同一個理由。
       *
       * ⚠️ **只有可管理全站內容的人動得了，不是 canTouchPhotos。** 其餘那幾支
       *    批次路由問的是「這是不是你的東西」，這一支不行 —— 標成不開放之後
       *    連標的人自己都看不到了，等於把自己的照片弄丟；而且「誰看得到」
       *    是全站層級的決定，跟「誰傳的」是兩回事。
       *
       * 一批一起改是為了沿用相簿頁那套既有的選取列，不是為了大量操作 ——
       * 使用者要的是單張，燈箱那顆開關送的就是一個 id 的陣列。
       */
      if (method === "PUT" && pathname === "/api/photos/restricted") {
        if (!me.canManageOthers) {
          return forbidden(headers, "只有可管理全站內容的人能設定不開放");
        }
        const body: any = await request.json();
        const ids = sanitizePhotoIds(body?.photoIds);
        if (ids.length === 0) {
          return new Response(JSON.stringify({ error: "photoIds is required" }), { status: 400, headers });
        }
        const value = body?.restricted === 0 || body?.restricted === false ? 0 : 1;
        const res = await env.DB.batch(
          chunkIds(ids, 1).map((c) => env.DB.prepare(
            `UPDATE Photo SET restricted = ? WHERE id IN (${placeholdersFor(c)})`
          ).bind(value, ...c)),
        );
        /*
         * 相簿封面是**存下來的網址**（Album.cover_photo_url），不是每次去查哪張照片
         * —— 不清掉的話，一張被標成不開放的照片還是會以封面的身分掛在首頁上，
         * 對所有人。刪除照片那條路由本來就有同一件事要做（見 DELETE /api/photos/:id）。
         */
        if (value === 1) {
          await env.DB.batch(
            chunkIds(ids).map((c) => env.DB.prepare(
              `UPDATE Album SET cover_photo_url = NULL
                WHERE cover_photo_url IN (SELECT url FROM Photo WHERE id IN (${placeholdersFor(c)}))`
            ).bind(...c)),
          );
        }
        /*
         * 換掉 R2 縮圖的物件鍵（見 rotateThumbKeys）。SQL 過濾只讓照片從清單上
         * 消失，**已經發出去的縮圖網址不會因此失效** —— 那條路在進站閘門的白名單上。
         *
         * 一次最多換 RESTRICT_ROTATE_MAX 張：搬一顆物件是一次 R2 讀＋一次寫＋一次刪，
         * 燈箱那顆開關送的永遠是一張，這個上限只是不讓「多選一整本」把單次請求撐爆。
         * 沒輪到的那些照樣是不開放的（擋人的是 SQL 與 /full，不是這裡），只是舊網址
         * 還活著 —— 回應把 rotated 講出來，不要讓它變成一件沒人知道的事。
         */
        let rotated = 0;
        /*
         * 換過鍵的那幾張的**新網址**。
         *
         * 前端點完那顆鎖不該整頁重抓（捲軸會跳回去，使用者要重新找那張照片），
         * 但縮圖的鍵在這一趟就換掉了 —— 不把新網址帶回去，他手上那一格會指著
         * 一顆剛被刪掉的 R2 物件，畫面上就是破圖。
         */
        const fresh: { id: number; url?: string; thumb_url?: string; thumb_sm_url?: string }[] = [];
        if (value === 1) {
          const RESTRICT_ROTATE_MAX = 8;
          const origin = new URL(request.url).origin;
          const cache = caches.default;
          const toRotate = ids.slice(0, RESTRICT_ROTATE_MAX);
          const { results: rows } = await env.DB.prepare(
            `SELECT id, file_name, url, thumb_url, thumb_sm_url FROM Photo WHERE id IN (${placeholdersFor(toRotate)})`
          ).bind(...toRotate).all();
          const rewrites: D1PreparedStatement[] = [];
          const staleKeys: string[] = [];
          const staleUrls: string[] = [];
          for (const row of rows as any[]) {
            const moved = await rotateThumbKeys(env, origin, row);
            if (!moved) continue;
            const cols = Object.keys(moved.sets);
            rewrites.push(env.DB.prepare(
              `UPDATE Photo SET ${cols.map((c) => `${c} = ?`).join(", ")} WHERE id = ?`
            ).bind(...cols.map((c) => moved.sets[c]), row.id));
            staleKeys.push(...moved.movedFrom);
            // file_name 是內部的 R2 鍵，不外流；前端只需要那三個網址
            fresh.push({
              id: Number(row.id),
              url: moved.sets.url, thumb_url: moved.sets.thumb_url, thumb_sm_url: moved.sets.thumb_sm_url,
            });
            // 舊網址可能是早年匯進來的怪值（甚至字串 "null"），new Request 會直接丟例外
            for (const u of [row.url, row.thumb_url, row.thumb_sm_url]) {
              if (typeof u === "string" && /^https?:\/\//.test(u)) staleUrls.push(u);
            }
            rotated++;
          }
          /*
           * ⚠️ **順序：先把新網址寫進 D1，再刪舊物件。** 反過來的話，D1 那一批
           *    寫失敗就等於照片指向一顆已經刪掉的物件 —— 相簿裡直接破圖，而且
           *    救不回來。照這個順序最壞只是留下幾顆孤兒物件。
           */
          if (rewrites.length > 0) await env.DB.batch(rewrites);
          for (const k of new Set(staleKeys)) await env.BUCKET.delete(k);
          // 舊網址在這個機房的邊緣快取殘影，順手清一次（只清得到當下這一個機房）
          for (const u of new Set(staleUrls)) ctx.waitUntil(cache.delete(new Request(u, { method: "GET" })));
        }

        /*
         * ⚠️ **兩個方向都要推版本號。** 標成不開放要讓訪客那份還留著它的舊清單
         *    失效；取消不開放也要 —— 不然那張照片得等快取自己過期才回得來，
         *    站長會以為開關壞了。
         */
        await bumpContentEpoch(env);

        const updated = res.reduce((n, r) => n + ((r.meta as any)?.changes ?? 0), 0);
        return new Response(JSON.stringify({ success: true, updated, rotated, restricted: value, photos: fresh }), { headers });
      }

      /*
       * 路由：重新排序照片。相簿裡面的順序是相簿主人的版面，逐張驗。
       *
       * 「可以加照片」不含這一支：加一張照片主人刪得掉，把整本重排他救不回來
       * （原本的順序沒有留底）。要給就給 can_reorder_others（見 migrations/0010）。
       */
      if (method === "PUT" && pathname === "/api/photos/reorder") {
        const body: { id: number; sort_order: number }[] = await request.json();
        if (!me.canReorderOthers && !(await canTouchPhotos(body.map((i) => i.id)))) {
          return forbidden(headers, "沒有權限調整別人相簿裡的照片順序");
        }
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
        /*
         * 看的是 canAddToAlbum 而不是 canTouchAlbum：這支是上傳流程的水電，
         * 「能往這本相簿加照片」的人一定會走到這裡（相簿還沒有 Drive 資料夾，
         * 或記著的那個是舊帳號建的）。用「能不能動這本相簿」擋的話，家人往
         * 別人的相簿上傳會拿到 403 —— 照片進得了 R2 但永遠沒有 Drive 備份。
         * 這裡寫的只是一個資料夾 id，不是相簿內容，權限對齊上傳才合理。
         */
        if (!(await canAddToAlbum(albumId))) return forbidden(headers);
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
          // 2. 刪除所有這些照片的 Tag 關聯
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


        // 4. 刪除這些照片紀錄
        await env.DB.prepare("DELETE FROM Photo WHERE album_id = ?").bind(albumId).run();

        // 5. 刪除相簿本身
        await env.DB.prepare("DELETE FROM Album WHERE id = ?").bind(albumId).run();

        // 6. PhotoFts 是虛擬表，沒有 FK，不會跟著 Photo 一起被刪掉
        await deleteFtsForPhotos(env.DB, photos.map((p: any) => Number(p.id)));

        /*
         * 7. **最後才刪 R2**（主檔 + 800px + 400px），而且失敗不算整件事失敗。
         *
         * 跟單張刪除同一個理由：R2 排在前面的話，它丟一次暫時性的錯誤就會讓整支
         * 路由 500，而 Album 與 Photo 那些列還在 —— 使用者眼中是「刪不掉」，
         * 重新整理卻看到一本整本都是破圖的相簿。反過來最壞只是 R2 留下一批
         * 沒人指著的物件（縮圖幾十 KB），而且這裡會記進 log。
         *
         * R2 的 delete 一次最多吃 1000 個鍵，一本相簿可能上千張，得分批。
         */
        try {
          const keys = photos.flatMap((p) => r2KeysForPhoto(p));
          for (let i = 0; i < keys.length; i += 1000) {
            await env.BUCKET.delete(keys.slice(i, i + 1000));
          }
        } catch (e) {
          console.error(`相簿 ${albumId} 的 R2 物件沒刪乾淨（列已經刪了）`, e);
        }

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
 * 把一張照片在 R2 上的縮圖搬到**新的物件鍵**，回傳要寫回 D1 的欄位與搬過的舊鍵。
 *
 * 為什麼需要這件事：`/api/photos/view/<key>` **在進站閘門的白名單上**，它唯一的
 * 護欄是「網址猜不到」（見 CLAUDE.md「後端的請求流程」）。可是一張照片在被標成
 * 不開放**之前**，縮圖網址早就隨相簿 JSON 發給每一個進得了站的人了 —— 標成不開放
 * 之後 SQL 過濾讓它從清單上消失，那些**已經發出去的網址卻還是活的**。換一把鍵
 * 就是把發出去的那些全部作廢。
 *
 * ⚠️ 這收不回「已經下載到對方瀏覽器裡的那幾個位元組」，也清不掉舊網址殘留在邊緣
 *    快取裡的影子（cache.delete 只作用在當下這一個機房，呼叫端會順手試一次）。
 *    能保證的是：**新網址沒有任何人拿過，而舊物件已經不存在**。
 *
 * 順序是 get → put →（呼叫端寫 D1）→ delete 舊的。中途失敗最壞留下一顆孤兒物件，
 * 佔一點額度但不會讓照片壞掉；反過來先刪再複製就會把照片弄丟。
 */
async function rotateThumbKeys(
  env: Env, origin: string, photo: any,
): Promise<{ sets: Record<string, string>; movedFrom: string[] } | null> {
  const cols = ["url", "thumb_url", "thumb_sm_url"] as const;
  const keyByCol = new Map<string, string>();
  for (const c of cols) {
    const k = r2KeyFromViewUrl(photo?.[c]);
    if (k) keyByCol.set(c, k);
  }
  // file_name 跟 url 指的是同一顆物件（見上傳那條路由），一起換掉才不會對不上
  const fileName = typeof photo?.file_name === "string" ? photo.file_name : null;

  const moved = new Map<string, string>();   // 舊鍵 -> 新鍵，同一顆只搬一次
  for (const oldKey of new Set([...keyByCol.values(), ...(fileName ? [fileName] : [])])) {
    const obj = await env.BUCKET.get(oldKey);
    if (!obj) continue;                      // 早就不在了，沒什麼好搬的
    const dot = oldKey.lastIndexOf(".");
    const ext = dot > 0 ? oldKey.slice(dot) : "";
    // 前綴只認我們自己產的那兩種，其餘（早年匯進來的）一律歸到 thumb，
    // 不能拿整個舊檔名當前綴 —— 那等於把要作廢的名字又抄一次進新鍵裡
    const head = oldKey.split("_")[0];
    const prefix = head === "thumb" || head === "thumbsm" ? head : "thumb";
    const newKey = `${prefix}_${Date.now()}_${crypto.randomUUID().replace(/-/g, "")}${ext}`;
    await env.BUCKET.put(newKey, obj.body, { httpMetadata: obj.httpMetadata });
    moved.set(oldKey, newKey);
  }
  if (moved.size === 0) return null;

  const sets: Record<string, string> = {};
  for (const [col, oldKey] of keyByCol) {
    const nk = moved.get(oldKey);
    if (nk) sets[col] = `${origin}/api/photos/view/${encodeURIComponent(nk)}`;
  }
  if (fileName && moved.has(fileName)) sets.file_name = moved.get(fileName)!;
  return Object.keys(sets).length > 0 ? { sets, movedFrom: [...moved.keys()] } : null;
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

      // 路由：處理 R2 照片上傳
      if (method === "POST" && pathname === "/api/upload") {
        const formData = await request.formData();
        /*
         * **R2 只收兩張縮圖**（2026-08-14 起）。以前還會收一張 2000px 當「燈箱退路」，
         * 那是 R2 佔用最大的一份，而全尺寸的版本 Drive 上本來就有兩份（4K + 原始檔）。
         * 現在燈箱沒有 Drive 可用時直接退回 800px，並在角落標示原因。
         *
         * 走 unknown：這個專案同時吃 workers-types 與 @types/node，FormData.get 的
         * 回傳型別會解析到不含 File 的那一份，直接 as File 會被 TS 擋下來。
         * 實際 runtime 是 Workers，取到的就是 File；下面仍有 !thumb 的檢查。
         */
        const thumb = formData.get('thumb') as unknown as File | null;      // 800px，兼任主檔
        const thumbSm = formData.get('thumb_sm') as unknown as File | null; // 400px
        // 原始檔名（Photo.title 與物件鍵都用它）。以前是從 file 欄位的 File.name 拿的
        const originalName = (formData.get('filename') as string) || (thumb?.name ?? 'photo');
        const albumId = formData.get('album_id') as string;
        const exifData = formData.get('exif') as string || null;
        const takenAt = formData.get('taken_at') as string || null;
        const clientPhash = formData.get('phash') as string || null;
        // 使用者在重複清單裡按了「照樣上傳」才會帶這個旗標
        const allowDuplicate = formData.get('allow_duplicate') === '1';

        /*
         * 影片跟照片走**同一條上傳路**（0019）。從這支路由的角度看只有兩點不同：
         *   - 送上來的 thumb／thumb_sm 是瀏覽器擷的**封面圖**，不是縮小的原圖；
         *   - 原始影片檔由前端直接送 Drive，之後用 /api/photos/:id/drive 記進
         *     drive_original_id，不經過這裡。
         * 其餘每一步 —— R2 兩顆物件、重複偵測、FTS、uploaded_by —— 完全一樣，
         * 所以底下不需要任何 if。
         *
         * 白名單比對而不是照收：這個欄位會進 SQL，也會決定 /video 肯不肯代理，
         * 收一個沒見過的值只會讓後面每一處判斷都變成第三種狀態。
         */
        const mediaType = formData.get('media_type') === 'video' ? 'video' : 'photo';
        const durationRaw = Number(formData.get('duration_ms'));
        const durationMs = mediaType === 'video' && Number.isFinite(durationRaw) && durationRaw > 0
          ? Math.round(durationRaw)
          : null;

        if (!thumb || !albumId) {
          // 縮圖產不出來就整張不收：沒有它 R2 這邊一個位元組都沒有，
          // 存進 D1 只會得到一列點不開的照片
          return new Response(JSON.stringify({ error: "thumb and album_id are required" }), { status: 400, headers });
        }
        // 往別人的相簿裡加照片是「貢獻」，不是「動別人的相簿」（見 canAddToAlbum）
        if (!(await canAddToAlbum(albumId))) return forbidden(headers, "沒有權限上傳到別人的相簿");

        // 縮圖是前端 canvas 編出來的，只會是這兩種；不支援 WebP 編碼的瀏覽器退回 JPEG
        const allowedTypes = ['image/jpeg', 'image/webp'];
        const thumbType = (thumb.type || 'image/jpeg').toLowerCase();
        if (!allowedTypes.includes(thumbType)) {
          return new Response(JSON.stringify({ error: "Invalid file type. Only images are allowed." }), { status: 400, headers });
        }

        /*
         * 雜湊改算 800px 那張的位元組（以前算的是 2000px 那張）。
         * 重複偵測的前提沒變 —— 同一台電腦重傳同一個檔，縮圖參數固定，位元組就一模一樣。
         */
        const buffer = await thumb.arrayBuffer();
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
            `SELECT id, title, thumb_sm_url, thumb_url, url, taken_at, file_hash,
                    media_type, drive_file_id, drive_original_id
               FROM Photo
              WHERE album_id = ?
                AND (file_hash = ? OR (? IS NOT NULL AND taken_at = ?))
              LIMIT 5`
          ).bind(albumId, fileHash, dupTakenAt, dupTakenAt).all<any>();

          if (dupes.length > 0) {
            /*
             * ⚠️ 每一筆都要講出**它的備份到底缺不缺**（`has_4k`／`has_original`，
             * 欄位名跟 /api/photos/drive-pending 那支一致）。
             *
             * 「網站有這張、Drive 上卻缺一半」是很常見的半套狀態：上傳當下 Drive
             * 斷線、或是檔案傳上去了但 recordDriveIds 那一趟沒回來。使用者重傳同一個檔
             * 想補救時，以前跳的是重複視窗 —— 而視窗給的兩條路都不對：「全部保留」多一列
             * ＋多兩顆 R2 物件、缺的那半還是缺；「取代」雖然補得起來，但會換一個新的
             * 照片 id，標籤、留言、Story、手動修過的座標與時間全部跟著沒了。
             *
             * 所以前端拿到這幾個旗標之後，**只有整份都齊的才跳視窗**，缺的直接補上去
             * （見 frontend ingestSources 的自動補那段）。影片沒有 4K 這一份，
             * `has_4k` 一律回 true，不然它永遠看起來像缺一半。
             */
            const isVideoRow = (d: any) => String(d.media_type) === 'video';
            return new Response(JSON.stringify({
              duplicate: true,
              // 讓前端講得出「哪裡像」：hash 一樣是同一個檔，只有時間一樣就是疑似
              reason: dupes.some((d: any) => d.file_hash === fileHash) ? 'same_file' : 'same_time',
              existing: dupes.map((d: any) => ({
                id: d.id,
                title: d.title,
                thumb_url: d.thumb_sm_url || d.thumb_url || d.url,
                taken_at: d.taken_at,
                media_type: isVideoRow(d) ? 'video' : 'photo',
                // 這一筆是不是**位元組層級**的同一個檔（hash 一樣）。只有它才敢自動補
                same_file: d.file_hash === fileHash,
                has_4k: isVideoRow(d) ? true : Boolean(d.drive_file_id),
                has_original: Boolean(d.drive_original_id),
              })),
            }), { headers });
          }
        }

        const host = new URL(request.url).origin;

        /*
         * 一張照片在 R2 只有兩顆物件：800px 與 400px 的 WebP q80（41.3 + 10.9 KB）。
         *
         * 舊版還有第三顆 2000px JPEG（`file_name` 指的那個），是三顆裡最大的一顆；
         * 拿掉之後每張的 R2 佔用少掉九成以上。**`file_name` / `url` 現在指的就是 800px 那顆** ——
         * 讀取端的 COALESCE(thumb_url, thumb_sm_url, url) 因此都還是對的，不必改。
         *
         * 物件鍵的副檔名跟著實際 content type 走：前端在不支援 WebP 編碼的瀏覽器上
         * 會退回 JPEG，寫死副檔名會讓 R2 上的鍵與內容不一致。
         */
        const baseName = `${Date.now()}_${originalName.replace(/[^a-zA-Z0-9.-]/g, '_')}`
          .replace(/\.[^/.]+$/, '');
        const putThumb = async (
          body: ArrayBuffer | ReadableStream, contentType: string, prefix: string,
        ): Promise<{ key: string; url: string }> => {
          const key = `${prefix}_${baseName}.${thumbExtFor(contentType)}`;
          await env.BUCKET.put(key, body, { httpMetadata: { contentType } });
          return { key, url: `${host}/api/photos/view/${encodeURIComponent(key)}` };
        };
        // 兩顆物件互不相干，併發送出省掉一趟 R2 往返。800px 那顆一定有（上面擋過了），
        // 400px 缺席時讀取端會自己退回 800px
        const [md, sm] = await Promise.all([
          putThumb(buffer, thumbType, 'thumb'),
          thumbSm
            ? putThumb(thumbSm.stream(), (thumbSm.type || 'image/jpeg').toLowerCase(), 'thumbsm')
            : Promise.resolve(null),
        ]);

        const fileName = md.key;
        const thumbUrl = md.url;
        const thumbSmUrl = sm?.url ?? null;
        const fileUrl = md.url;

        const inserted = await env.DB.prepare(
          // shuffle_key 由 SQL 直接產生：ALTER TABLE 不接受非常數的 DEFAULT，
          // 而漏填的照片 shuffle_key 是 NULL，會被 /api/albums 的預覽查詢整個跳過。
          // random() & 0x7FFFFFFF 保證落在 JS 安全整數內，後端才算得出同樣的種子。
          `INSERT INTO Photo
             (title, file_name, album_id, url, thumb_url, thumb_sm_url, exif, taken_at, file_hash, phash,
              lat, lng, geo_source, taken_at_local, tz_offset_minutes, time_source, uploaded_by,
              media_type, duration_ms, shuffle_key)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, (random() & 2147483647))`
        ).bind(
          originalName, fileName, albumId, fileUrl, thumbUrl, thumbSmUrl, exifData,
          uploadTakenAt, fileHash, clientPhash,
          geo.lat, geo.lng, geo.geoSource, geo.takenAtLocal, geo.tzOffsetMinutes,
          uploadTimeSource, me.uid, mediaType, durationMs,
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
          media_type: mediaType,
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

        /*
         * ⚠️ **順序：Drive 登記 → 收掉 D1 → 最後才刪 R2。**
         *
         * 以前 R2 是第一步。R2 那一下丟出錯誤的話（暫時的 5xx 就夠了）整支路由
         * 500，Photo 那一列還在 —— 使用者眼中是「刪不掉」，而下一次重新整理
         * 會看到一格**點開是破圖**的照片：位元組已經沒了，列還在。
         *
         * 反過來就沒有這個問題。最壞情況是 R2 留下三顆沒人指著的物件（縮圖幾十 KB，
         * 而且會被下面的 catch 記下來），比起「相簿裡多一格壞掉的東西」便宜太多。
         * Drive 那份永遠是最後一道後悔藥，先登記進待搬佇列（務必在 DELETE 之前 ——
         * 列一刪，那兩個 drive id 就沒有任何地方記得了）。
         */
        await queueDriveTrash(env, [photo]);
        await env.DB.prepare("DELETE FROM PhotoTag WHERE photo_id = ?").bind(photoId).run();
        // 如果該照片是某個相簿的封面，則清除該相簿的封面
        await env.DB.prepare("UPDATE Album SET cover_photo_url = NULL WHERE cover_photo_url = ?").bind(photo.url).run();
        await env.DB.prepare("DELETE FROM Photo WHERE id = ?").bind(photoId).run();
        await deleteFtsForPhotos(env.DB, [Number(photoId)]);

        // 主檔 + 兩張縮圖一起刪，只刪 file_name 會留下孤兒縮圖佔 R2 額度。
        // 這一步失敗不該讓整個刪除變成失敗 —— 列已經沒了，照片在站上就是消失了
        try {
          await env.BUCKET.delete(r2KeysForPhoto(photo));
        } catch (e) {
          console.error(`照片 ${photoId} 的 R2 物件沒刪掉（列已經刪了）`, e);
        }

        // Drive 當場搬進 trash/ —— 回應照樣先送出去，搬移在背景做
        ctx.waitUntil(drainDriveTrash(env, 10).catch((e) => console.error("Drive 待搬佇列", e)));
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

      /* ══ 照片留言 ══════════════════════════════════════════════════════════
       *
       * 三層身分在這裡的差別：
       *
       *   站長／成員  照自己的 can_view_comments、can_comment 兩欄
       *   訪客        看：站長的全站開關 guest_can_view_comments（預設關）
       *               寫：**永遠不行**。不是開關，是 Comment.user_id 指向 User
       *               而訪客沒有那一列（見 migrations/0013）
       *
       * ⚠️ 這幾條**都不可以包 withEdgeCache**。留言是即時的，而且回應裡帶著
       *    家人的顯示名稱 —— 進了共用邊緣快取就等於外流給下一個匿名請求。
       */

      // 路由：讀一張照片的留言。回傳攤平的清單（回覆只有一層，前端自己收攏），
      // 順序照 id 遞增 —— created_at 只有到秒，同一秒內的兩則會排不穩
      if (method === "GET" && pathname.startsWith("/api/photos/")
          && pathname.endsWith("/comments") && pathname.split("/").length === 5) {
        const photoId = Number(pathname.split("/")[3]);
        const actor = await currentActor(request, env);
        const canView = actor ? actor.canViewComments : await guestCanViewComments(env);
        if (!canView) {
          return new Response(JSON.stringify({ error: "沒有權限看留言", reason: "forbidden" }), { status: 403, headers });
        }
        /*
         * **不開放的照片連留言都不給看。** 相簿清單裡本來就找不到那個 id，
         * 但直接打這一支還是問得到 —— 而留言帶著家人的名字與內容，等於把
         * 「這張照片存在、還有人在上面聊天」整個講出來。
         *
         * 條件折進同一句 SQL 的 EXISTS 裡，**不另外查一次 Photo** —— 每開一次
         * 燈箱多一趟 D1 是這個站最不該花的額度。回的是空清單不是 403，
         * 理由同 /full：403 等於承認那個編號上有東西。
         */
        const commentsRestricted = canSeeRestricted(actor)
          ? ""
          : " AND EXISTS (SELECT 1 FROM Photo p WHERE p.id = c.photo_id AND p.restricted = 0)";
        const { results } = await env.DB.prepare(`
          SELECT c.id, c.parent_id, c.user_id, c.body, c.created_at,
                 u.name AS user_name, u.track_color, u.avatar_key
            FROM Comment c
            JOIN User u ON u.id = c.user_id
           WHERE c.photo_id = ?${commentsRestricted}
           ORDER BY c.id ASC
        `).bind(photoId).all();
        const comments = (results as any[]).map((r) => ({
          id: Number(r.id),
          parent_id: r.parent_id == null ? null : Number(r.parent_id),
          user_id: Number(r.user_id),
          user_name: r.user_name,
          // 頭像圓圈的顏色沿用他的軌跡色 —— 已經是「這個人的顏色」了，
          // 再挑一套只會讓同一個人在地圖上與留言區長得不一樣
          color: trackColorFor(Number(r.user_id), r.track_color),
          // 沒設頭像就是 null，前端畫回名字首字的色圓
          avatar: avatarUrl(url.origin, r.avatar_key),
          body: r.body,
          created_at: r.created_at,
          // 前端據此決定要不要端出刪除鈕。規則跟底下的 DELETE 一致：作者本人或站長
          can_delete: !!actor && (actor.isOwner || actor.uid === Number(r.user_id)),
        }));
        /*
         * 這串留言裡被 @ 到的人。內文存的是 `@[uid]`，要有名字才顯示得出來。
         *
         * 為什麼不叫前端去打 /users/mentionable：**訪客打不到那一支**（那是全家人的
         * 名單，沒理由給訪客），可是訪客看得到留言 —— 少了這一份，他看到的每個
         * @ 都會變成「@?」。而且被 @ 的人可能已經停權，本來就不在那份名單裡。
         */
        const mentioned = new Set<number>();
        for (const c of comments) for (const uid of parseMentions(c.body)) mentioned.add(uid);
        const people: Array<{ id: number; name: string | null; color: string; avatar: string | null }> = [];
        // D1 綁定參數上限 100，照慣例先切塊再查
        for (const chunk of chunkIds(Array.from(mentioned))) {
          const { results: us } = await env.DB.prepare(
            `SELECT id, name, track_color, avatar_key FROM User WHERE id IN (${chunk.map(() => "?").join(",")})`
          ).bind(...chunk).all();
          for (const u of us as any[]) {
            people.push({
              id: Number(u.id),
              name: u.name,
              color: trackColorFor(Number(u.id), u.track_color),
              avatar: avatarUrl(url.origin, u.avatar_key),
            });
          }
        }

        return new Response(JSON.stringify({
          comments,
          people,
          can_comment: actor?.canComment ? 1 : 0,
          me: actor?.uid ?? null,
        }), { headers });
      }

      // 路由：留言／回覆
      if (method === "POST" && pathname.startsWith("/api/photos/")
          && pathname.endsWith("/comments") && pathname.split("/").length === 5) {
        const photoId = Number(pathname.split("/")[3]);
        const actor = await currentActor(request, env);
        if (!actor || actor.uid == null) {
          return new Response(JSON.stringify({ error: "訪客不能留言，請用 Google 登入", reason: "guest" }), { status: 403, headers });
        }
        if (!actor.canComment) {
          return new Response(JSON.stringify({ error: "站長關掉了你的留言權限", reason: "forbidden" }), { status: 403, headers });
        }

        const payload: { body?: string; parent_id?: any } = await request.json();
        const text = String(payload.body ?? "").trim();
        if (!text) {
          return new Response(JSON.stringify({ error: "留言不能空白" }), { status: 400, headers });
        }
        if (text.length > COMMENT_MAX_LEN) {
          return new Response(JSON.stringify({ error: `留言最多 ${COMMENT_MAX_LEN} 字` }), { status: 400, headers });
        }

        const photo = await env.DB.prepare(`
          SELECT p.id, p.uploaded_by, p.album_id, p.restricted, a.user_id AS album_owner
            FROM Photo p LEFT JOIN Album a ON a.id = p.album_id
           WHERE p.id = ?
        `).bind(photoId).first<any>();
        // 不開放的照片對其他人不存在，所以留不了言也問不出它存不存在（404 不是 403）
        if (!photo || (Number(photo.restricted) === 1 && !canSeeRestricted(actor))) {
          return new Response(JSON.stringify({ error: "找不到這張照片" }), { status: 404, headers });
        }

        /*
         * 回覆只有一層：parent 必須是同一張照片上的**主留言**。
         * 擋在這裡而不是靠前端不端出按鈕 —— 巢狀一旦寫進資料就回不去了。
         */
        let parentId: number | null = null;
        let parentAuthor: number | null = null;
        if (payload.parent_id != null) {
          const parent = await env.DB.prepare(
            "SELECT id, user_id, parent_id, photo_id FROM Comment WHERE id = ?"
          ).bind(Number(payload.parent_id)).first<any>();
          if (!parent || Number(parent.photo_id) !== photoId) {
            return new Response(JSON.stringify({ error: "找不到要回覆的留言" }), { status: 404, headers });
          }
          if (parent.parent_id != null) {
            return new Response(JSON.stringify({ error: "回覆只有一層，請回覆最上層那一則" }), { status: 400, headers });
          }
          parentId = Number(parent.id);
          parentAuthor = Number(parent.user_id);
        }

        const res = await env.DB.prepare(
          "INSERT INTO Comment (photo_id, user_id, parent_id, body) VALUES (?, ?, ?, ?)"
        ).bind(photoId, actor.uid, parentId, text).run();
        const commentId = Number(res.meta.last_row_id);

        /*
         * 通知 fan-out。四個理由由高而低排，**INSERT OR IGNORE 讓先寫的贏** ——
         * PK 是 (comment_id, user_id)，所以同一個人只會拿到一則，而且是最貼切的
         * 那個理由（你同時是相簿主人、上傳者又被 @ 的時候，說的是「提到了你」）。
         *
         * SELECT … FROM User WHERE id = ? AND active = 1 一句同時做掉三件事：
         * 帳號存不存在、有沒有被停權、以及不必為此多跑一趟查詢。
         * 自己講的話不通知自己，這在 notify() 裡擋掉。
         */
        const stmts: D1PreparedStatement[] = [];
        const notify = (uid: any, reason: string) => {
          const n = Number(uid);
          if (!Number.isFinite(n) || n <= 0 || n === actor.uid) return;
          stmts.push(env.DB.prepare(
            `INSERT OR IGNORE INTO CommentNotify (comment_id, user_id, reason)
             SELECT ?, id, ? FROM User WHERE id = ? AND active = 1`
          ).bind(commentId, reason, n));
        };
        for (const uid of parseMentions(text)) notify(uid, "mention");
        if (parentAuthor != null) notify(parentAuthor, "reply");
        // uploaded_by 是 NULL 的舊照片算相簿主人的，剛好就是下一行那個人
        notify(photo.uploaded_by, "photo");
        notify(photo.album_owner, "album");
        if (stmts.length) await env.DB.batch(stmts);

        return new Response(JSON.stringify({
          success: true,
          comment: {
            id: commentId,
            parent_id: parentId,
            user_id: actor.uid,
            user_name: actor.name,
            color: trackColorFor(actor.uid, actor.trackColor),
            body: text,
            created_at: new Date().toISOString().slice(0, 19).replace("T", " "),
            can_delete: true,
          },
        }), { headers });
      }

      /*
       * 路由：刪留言。**作者本人或站長**，沒有第三種人（使用者拍板）。
       *
       * 硬刪，回覆跟著 FK CASCADE 一起消失，不留「此留言已刪除」的墓碑 ——
       * 那需要多一個狀態欄位與一套顯示規則，而這個站不需要保留刪除痕跡。
       */
      if (method === "DELETE" && pathname.startsWith("/api/comments/")
          && pathname.split("/").length === 4) {
        const commentId = Number(pathname.split("/")[3]);
        const actor = await currentActor(request, env);
        if (!actor) {
          return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers });
        }
        const row = await env.DB.prepare("SELECT id, user_id FROM Comment WHERE id = ?")
          .bind(commentId).first<any>();
        if (!row) {
          return new Response(JSON.stringify({ error: "找不到這則留言" }), { status: 404, headers });
        }
        if (!actor.isOwner && actor.uid !== Number(row.user_id)) {
          return forbidden(headers, "只能刪自己的留言");
        }
        await env.DB.prepare("DELETE FROM Comment WHERE id = ?").bind(commentId).run();
        return new Response(JSON.stringify({ success: true }), { headers });
      }

      /*
       * 路由：可以 @ 誰。只有成員打得到 —— 訪客留不了言，自然也不需要這份名單，
       * 而這份名單就是全家人的顯示名稱，沒理由多給。
       */
      if (method === "GET" && pathname === "/api/users/mentionable") {
        const actor = await currentActor(request, env);
        if (!actor) {
          return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers });
        }
        const { results } = await env.DB.prepare(
          "SELECT id, name, track_color, avatar_key FROM User WHERE active = 1 ORDER BY (role = 'owner') DESC, name"
        ).all();
        return new Response(JSON.stringify((results as any[]).map((u) => ({
          id: Number(u.id),
          name: u.name,
          color: trackColorFor(Number(u.id), u.track_color),
          avatar: avatarUrl(url.origin, u.avatar_key),
        }))), { headers });
      }

      /* ── 通知 ──────────────────────────────────────────────────────────────
       *
       * 未讀**數**不在這裡，在 /api/auth/me（那一條每次進站都會打，紅點跟著它
       * 回來就是零額外請求）。這一條是點開清單才打的。
       */
      if (method === "GET" && pathname === "/api/notifications") {
        const actor = await currentActor(request, env);
        if (!actor || actor.uid == null) {
          return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers });
        }
        if (!actor.canViewComments) {
          return new Response(JSON.stringify({ items: [], seen_at: null }), { headers });
        }
        const me = await env.DB.prepare("SELECT notif_seen_at FROM User WHERE id = ?")
          .bind(actor.uid).first<any>();
        const seenAt: string | null = me?.notif_seen_at ?? null;
        /*
         * 每一則通知都帶著縮圖、相簿名與留言內文 —— 照片被標成不開放之後，
         * 那幾則就不該再出現在別人的清單上。查詢本來就 JOIN 了 Photo p，
         * 多這一段條件不多花任何一次讀取。
         */
        const notifRestricted = canSeeRestricted(actor) ? "" : " AND p.restricted = 0";
        const { results } = await env.DB.prepare(`
          SELECT n.comment_id, n.reason, n.created_at,
                 c.photo_id, c.body, c.parent_id,
                 au.id AS actor_id, au.name AS actor_name, au.track_color,
                 p.album_id, p.title,
                 COALESCE(p.thumb_sm_url, p.thumb_url, p.url) AS thumb,
                 al.name AS album_name
            FROM CommentNotify n
            JOIN Comment c  ON c.id  = n.comment_id
            JOIN User au    ON au.id = c.user_id
            JOIN Photo p    ON p.id  = c.photo_id
            LEFT JOIN Album al ON al.id = p.album_id
           WHERE n.user_id = ?${notifRestricted}
           ORDER BY n.created_at DESC, n.comment_id DESC
           LIMIT 30
        `).bind(actor.uid).all();
        return new Response(JSON.stringify({
          seen_at: seenAt,
          items: (results as any[]).map((r) => ({
            comment_id: Number(r.comment_id),
            reason: r.reason,
            created_at: r.created_at,
            unread: seenAt == null || String(r.created_at) > seenAt,
            photo_id: Number(r.photo_id),
            album_id: r.album_id == null ? null : Number(r.album_id),
            album_name: r.album_name ?? null,
            photo_title: r.title ?? null,
            thumb: r.thumb ?? null,
            body: r.body,
            actor_id: Number(r.actor_id),
            actor_name: r.actor_name,
            color: trackColorFor(Number(r.actor_id), r.track_color),
          })),
        }), { headers });
      }

      /*
       * 路由：把通知全部標成已讀。**一個時間戳，沒有逐則已讀**（見 migrations/0013）。
       *
       * 已知的邊界：跟按下這一鍵**同一秒**內產生的留言會被算成已讀
       * （created_at 只到秒）。家族站規模下不值得為此加毫秒欄位。
       */
      if (method === "POST" && pathname === "/api/notifications/seen") {
        const actor = await currentActor(request, env);
        if (!actor || actor.uid == null) {
          return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers });
        }
        await env.DB.prepare("UPDATE User SET notif_seen_at = datetime('now') WHERE id = ?")
          .bind(actor.uid).run();
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
       * `access_type=offline` 一律帶著，而且**每個人的 refresh token 都會被收下**
       * （2026-08-21）：那是「從 Google 相簿匯入」唯一的憑據，不然匯入就得再授權
       * 一次（見 mintUserGoogleToken 與 migrations/0017）。站長那份還會多一個用途
       * —— 當這個環境的 Drive 寫入身分。
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
         * **這裡不強制跳同意畫面。** 以前的規則是「這個環境還沒有 Drive 寫入
         * 憑證時，所有人登入都多看一次同意畫面」—— 那個判斷只看「有沒有值」，
         * 值早就失效也算數，於是真的壞掉時反而永遠跳不出來（2026-08-21 卡死過）。
         *
         * 現在補同意這件事整個交給回呼：它認得出人，發現「這個人一份 refresh
         * token 都沒有」才補跳一次（見下面「收下這個人自己的授權」）。
         * 精準到人，也不必為了站長的 Drive 讓全家人多按一次同意。
         */
        return Response.redirect(googleAuthUrl(env, new URL(request.url).origin, {
          albumId, redirectHost, consent: false, retried: false,
        }), 302);
      }

      // 路由：Google OAuth 回呼
      if (method === "GET" && pathname === "/api/auth/google/callback") {
        const urlObj = new URL(request.url);
        const code = urlObj.searchParams.get("code");
        const rawState = urlObj.searchParams.get("state") || "";
        let albumId = rawState;
        let redirectHost = "";
        // 補跳同意畫面那一次會把 retried 帶進來。見下面「收下這個人自己的授權」
        let retried = false;
        try {
          const parsed = JSON.parse(decodeURIComponent(rawState));
          if (parsed && typeof parsed === "object") {
            albumId = parsed.albumId || "";
            /*
             * state 是我們自己包的，但它繞過 Google 才回來，**中間誰都能換掉** ——
             * 拿我們的 client_id 自己組一個授權網址、把 redirectHost 寫成自家網站，
             * 騙人點下去就收得到回程 fragment 裡的管理員 JWT。所以這裡要再驗一次。
             */
            const candidate = String(parsed.redirectHost || "");
            if (ALLOWED_ORIGINS.includes(candidate)) redirectHost = candidate;
            retried = parsed.retried === true;
          }
        } catch (e) {}

        if (!code) return new Response("Missing code", { status: 400 });

        /*
         * 優先使用傳過來的 redirectHost（往上提到換 token 之前，失敗時也才有地方可回）。
         *
         * 認不得來源時的**退路照這個 worker 自己的網域決定，不是一律回 prod** ——
         * 以前兩個環境共用一行寫死的 prod 網址，於是瀏覽器一旦沒帶 Referer
         * （隱私設定、某些 App 內建瀏覽器），在 dev 站登入會被丟到 prod 站，
         * 手上還捏著一張 dev 簽的 token：看起來像 prod 壞了，其實是走錯環境。
         */
        const selfHost = urlObj.hostname;
        const isLocalWorker = selfHost.includes("localhost") || selfHost.includes("127.0.0.1");
        const fallbackFrontEnd = isLocalWorker
          ? "http://localhost:3000"
          : selfHost.startsWith("didadida-api-dev")
            ? "https://dev.didadida-frontend.pages.dev"
            : "https://didadida-frontend.pages.dev";
        const baseFrontEndUrl = redirectHost || fallbackFrontEnd;
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
        /*
         * **收下這個人自己的 refresh token。** 這是「從 Google 相簿匯入」唯一的
         * 憑據（見 mintUserGoogleToken 與 migrations/0017）—— 以前是把短效的
         * access token 塞進網址 fragment 讓瀏覽器存著，一小時就死，死了之後
         * 匯入就變成再授權一次。現在 fragment 裡只剩站上自己的 JWT。
         *
         * Google 只在**走過同意畫面那一次**給 refresh token。這次沒給、而且這個人
         * 也還沒存過的話，就地補跳一次 `prompt=consent`（state 帶 retried，只補
         * 一次，不會變成迴圈）。也就是現有成員下次登入會多看到一次同意畫面，
         * 之後再也不會。
         */
        const freshRefresh = typeof tokenData.refresh_token === "string"
          ? tokenData.refresh_token.trim() : "";
        if (freshRefresh) {
          await env.DB.prepare("UPDATE User SET google_refresh_token = ? WHERE id = ?")
            .bind(freshRefresh, admitted.user.id).run();
          userGoogleTokens.delete(admitted.user.id);
        } else if (!retried) {
          const stored = await env.DB.prepare(
            "SELECT google_refresh_token AS t FROM User WHERE id = ?"
          ).bind(admitted.user.id).first<any>();
          if (!String(stored?.t || "").trim()) {
            return Response.redirect(googleAuthUrl(env, new URL(request.url).origin, {
              albumId, redirectHost, consent: true, retried: true,
            }), 302);
          }
        }

        const frag = new URLSearchParams({
          token: await generateJWT(env, 'admin', admitted.user),
        });

        /*
         * 這裡以前還有一段「站長登入時自動把 refresh token 收進 AppSetting 當
         * Drive 寫入身分」。**2026-08-21 拿掉**：上面那一行已經把它存進
         * `User.google_refresh_token` 了，Drive 直接讀站長那一列就好
         * （見 driveWriterOwner）。同一份憑證不必再抄一份到別的地方 ——
         * 抄出來的那份沒人刷新，壞掉還會擋住自癒。
         */
        return Response.redirect(`${target}#${frag.toString()}`, 302);
      }

      /* ── Google 相簿匯入 ──────────────────────────────────────────────────
       *
       * **匯入用的是「登入的這個人自己的」Google 身分，站上不再有第二次授權。**
       * 這幾支以前吃 `X-Google-Token`（登入時塞進 localStorage 的那張短效 token），
       * 一小時就過期 —— 過期之後按「匯入」等於整頁跳去 Google 重登一次。
       * 現在一律由後端拿他自己的 refresh token 當場換（見 googleUserAuth）。
       *
       * 三支就是一趟匯入的全部：開 Picker → 輪詢使用者選完沒 → 把選到的位元組
       * 交給瀏覽器。**照片的處理（縮圖、EXIF、重複偵測、Drive 備份）全部走
       * 本機上傳那一條**（/api/upload ＋ 前端的 pushPhotoToDrive）——
       * 以前這裡另有一條 sync-photo/resolve-conflict，那條把 Google 給的原始檔
       * 整份塞進 R2、不產縮圖、也不上 Drive，跟儲存模型完全相反（見 CLAUDE.md
       * 「儲存模型」）。同一件事不要有兩套實作。
       */

      // 路由：建立 Picker Session
      if (method === "POST" && pathname === "/api/google/picker/sessions") {
        const auth = await googleUserAuth(request, env, headers);
        if (!auth.ok) return auth.res;
        const res = await fetch("https://photospicker.googleapis.com/v1/sessions", {
          method: "POST",
          headers: { Authorization: `Bearer ${auth.token}`, "Content-Type": "application/json" }
        });
        const data = await res.json();
        return new Response(JSON.stringify(data), { headers });
      }

      // 路由：檢查 Picker Session 狀態並取得照片
      if (method === "GET" && pathname.startsWith("/api/google/picker/sessions/") && pathname.endsWith("/photos")) {
        const sessionId = pathname.split("/")[5];
        const auth = await googleUserAuth(request, env, headers);
        if (!auth.ok) return auth.res;

        // 1. 檢查狀態
        const statusRes = await fetch(`https://photospicker.googleapis.com/v1/sessions/${sessionId}`, {
          headers: { Authorization: `Bearer ${auth.token}` }
        });
        const statusData = await statusRes.json() as any;
        /*
         * ⚠️ **失敗不可以長得像「還沒選完」。** 以前這裡不看狀態碼，statusRes 掛掉時
         *    statusData.mediaItemsSet 是 undefined ＝ ready:false，前端就這樣空轉輪詢
         *    到十分鐘逾時，畫面上完全沒有線索。
         */
        if (!statusRes.ok) {
          console.error("Picker session 狀態查詢失敗", statusRes.status, JSON.stringify(statusData).slice(0, 300));
          return new Response(JSON.stringify({
            error: "picker_status_failed", status: statusRes.status, detail: statusData,
          }), { status: 502, headers });
        }

        // Google Photospicker API: 當使用者點擊「完成/選擇」後，mediaItemsSet 會變為 true
        const isReady = statusData.mediaItemsSet === true || statusData.mediaItemsSet === "true";

        if (!isReady) {
          return new Response(JSON.stringify({ ready: false, statusData }), { headers });
        }

        /*
         * 2. 使用者選完了，去抓清單。**要翻頁** —— 一次預設只給 100 筆，
         *    以前只讀第一頁，選超過 100 張時後面的會安靜地不見。
         */
        const mediaItems: any[] = [];
        let pageToken = "";
        for (let page = 0; page < 20; page++) {
          const qs = new URLSearchParams({ sessionId, pageSize: "100" });
          if (pageToken) qs.set("pageToken", pageToken);
          const itemsRes = await fetch(`https://photospicker.googleapis.com/v1/mediaItems?${qs}`, {
            headers: { Authorization: `Bearer ${auth.token}` }
          });
          const itemsData = await itemsRes.json() as any;
          /*
           * ⚠️ 同上：以前是 `itemsData.mediaItems || []`，於是**任何失敗都變成
           *    「選完了，但一張都沒有」** —— 前端拿到空陣列什麼都不做，使用者按了
           *    半天沒有任何反應也沒有任何錯誤。失敗要照實往外講。
           */
          if (!itemsRes.ok) {
            console.error("Picker mediaItems 取回失敗", itemsRes.status, JSON.stringify(itemsData).slice(0, 300));
            return new Response(JSON.stringify({
              error: "picker_items_failed", status: itemsRes.status, detail: itemsData,
            }), { status: 502, headers });
          }
          if (Array.isArray(itemsData.mediaItems)) mediaItems.push(...itemsData.mediaItems);
          pageToken = typeof itemsData.nextPageToken === "string" ? itemsData.nextPageToken : "";
          if (!pageToken) break;
        }

        return new Response(JSON.stringify({ ready: true, mediaItems, statusData }), { headers });
      }

      /*
       * 路由：把 Picker 選到的那張照片的位元組轉給瀏覽器。
       *
       * 為什麼非得經過後端：Picker 的 `baseUrl` 要帶 `Authorization` 才拿得到原始
       * 解析度，而自訂標頭會觸發 CORS 預檢，Google 那邊不收 —— 瀏覽器自己抓不到。
       * 後端只是把位元組**串流**轉手，不落地、不進 R2、不解 EXIF；拿到檔案之後
       * 前端就當成一般的本機檔案走同一條上傳路（縮圖進 R2、4K＋原始檔進 Drive）。
       *
       * `baseUrl` 是前端送回來的，**一定要驗主機名** —— 不驗的話這支就是一台
       * 任人指定目標的代理（SSRF）。只放行 Google 自己的圖片主機。
       */
      if (method === "POST" && pathname === "/api/google/media") {
        const auth = await googleUserAuth(request, env, headers);
        if (!auth.ok) return auth.res;

        const body = await request.json().catch(() => ({})) as { baseUrl?: unknown; video?: unknown };
        const raw = typeof body.baseUrl === "string" ? body.baseUrl : "";
        const isVideo = body.video === true;
        let target: URL;
        try {
          target = new URL(raw);
        } catch (e) {
          return new Response(JSON.stringify({ error: "baseUrl 不是合法網址" }), { status: 400, headers });
        }
        if (target.protocol !== "https:" || !/(^|\.)googleusercontent\.com$/.test(target.hostname)) {
          return new Response(JSON.stringify({ error: "baseUrl 不是 Google 的圖片位址" }), { status: 400, headers });
        }

        /*
         * Picker 的 baseUrl 要自己加下載參數（沒有 `=` 才代表還沒帶過）。
         *
         * ⚠️ **照片是 `=d`、影片是 `=dv`，不能通用。** 影片給 `=d` 拿回來的是一張
         *    封面圖 —— 位元組是 JPEG，Content-Type 也是 image/*，前端於是把它當照片
         *    收下，相簿裡多一張靜止的圖、而且完全沒有錯誤。這是「Google 相簿匯入
         *    影片沒反應」的其中一半原因（另一半是前端只放行 image/*）。
         * ⚠️ `=dv` 給的是 **Google 轉檔後的版本**，不是相機原始檔 —— Picker API 沒有
         *    拿原始影片的路。要原始檔只能從本機選檔上傳。
         *    而且影片要 Google 那邊處理完（processingStatus READY）才抓得到。
         */
        const downloadUrl = raw.includes("=") ? raw : `${raw}=${isVideo ? "dv" : "d"}`;
        let upstream = await fetch(downloadUrl, { headers: { Authorization: `Bearer ${auth.token}` } });
        // 有些 baseUrl 不吃 Bearer（帶了反而 403），再試一次不帶的
        if (!upstream.ok) upstream = await fetch(downloadUrl);
        if (!upstream.ok) {
          const detail = await upstream.text().catch(() => "");
          console.error("Google 照片下載失敗", upstream.status, detail.slice(0, 200));
          return new Response(JSON.stringify({ error: "download_failed", status: upstream.status }), { status: 502, headers });
        }

        return new Response(upstream.body, {
          headers: {
            "Access-Control-Allow-Origin": allowOrigin,
            "Content-Type": upstream.headers.get("content-type") || "application/octet-stream",
            // 這是別人相簿裡的私密照片，一個位元組都不該進共用快取
            "Cache-Control": "no-store",
          },
        });
      }

      // ===== 足跡地圖 =====

      // 路由：取得足跡點位
      // 時間篩選一律用當地牆上時間 —— 使用者說「3/1 我在京都」指的是當地時間。
      // 舊資料若無 taken_at_local，由 LOCAL_TIME_EXPR 從 taken_at 加時區推回來再比對。
      if (method === "GET" && pathname === "/api/footprint") {
        const actor = await currentActor(request, env);
        const isAdmin = actor !== null;
        /*
         * 誰看得到：成員照自己的 can_view_map（0014），訪客看站長的全站開關。
         *
         * **這一關必須擋在 withEdgeCache 前面** —— 進到裡面就可能直接命中
         * 先前存下的 200，開關關掉也照樣把座標端出去。
         */
        if (actor ? !actor.canViewMap : !(await guestCanViewMap(env))) {
          return forbidden(headers, actor
            ? "站長沒有開放你瀏覽足跡地圖"
            : "站長沒有開放訪客瀏覽足跡地圖");
        }
        // 這條的隱私過濾是寫在 SQL 的 WHERE 裡（不是 applyGeoPrivacy），但結果同樣
        // 依身分而異，一樣不能讓管理員的版本落進共用的邊緣快取
        const footprintEpoch = isAdmin ? null : await contentEpoch(env);
        return withEdgeCache(request, ctx,
          { browserMaxAge: 10, edgeMaxAge: 300, skip: isAdmin, epoch: footprintEpoch },
          async () => {
        const conds = ["p.lat IS NOT NULL", "p.lng IS NOT NULL"];
        const binds: any[] = [];

        // 非管理者只看得到雙層隱私都放行的照片
        if (!isAdmin) conds.push("a.map_private = 0", "p.geo_private = 0");
        // 不開放的那幾張連點都不該出現（跟座標隱私是兩件事，見 canSeeRestricted）
        if (!canSeeRestricted(actor)) conds.push(RESTRICTED_VISIBLE_COND);

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

      /*
       * 路由：批次**指定**拍攝時間（不是修正）。
       *
       * 跟上面兩支的差別是它**不要求原本有時間** —— 這支就是為了
       * `taken_at IS NULL` 的東西存在的：影片（封面圖是 canvas 畫的，不帶 EXIF）、
       * 掃描的老照片、被 App 洗掉 EXIF 的圖。平移與改時區都需要一個基準，
       * 對 NULL 一律跳過，所以它們補不了這個洞。
       *
       * 語意與單張的 `PUT /api/photos/:id/geo` 送 takenAtLocal 完全一致：
       * 牆上時間與時區都由使用者指定，taken_at = local − tz，time_source = manual。
       * 解析與換算刻意共用 parseExifDateTime／formatWallClock／utcFromLocal 三支，
       * 不在這裡自己拼字串 —— 不變式只能有一個實作。
       */
      if (method === "POST" && pathname === "/api/photos/geo/set-time") {
        const body: any = await request.json().catch(() => ({}));
        const ids = sanitizePhotoIds(body?.photoIds);
        if (ids.length === 0) {
          return new Response(JSON.stringify({ error: "photoIds is required" }), { status: 400, headers });
        }
        if (!isValidTzOffset(body?.tzOffsetMinutes)) {
          return new Response(JSON.stringify({ error: "Invalid tzOffsetMinutes" }), { status: 400, headers });
        }
        const wc = parseExifDateTime(body?.takenAtLocal);
        if (!wc) {
          return new Response(JSON.stringify({ error: "Invalid takenAtLocal" }), { status: 400, headers });
        }
        if (!(await canTouchPhotos(ids))) return forbidden(headers);

        const tz = body.tzOffsetMinutes;
        const localStr = formatWallClock(wc);
        const utcStr = utcFromLocal(localStr, tz);
        // 三個固定綁定（local、utc、tz）先扣掉，剩下的才是 id 能用的位置
        const res = await env.DB.batch(
          chunkIds(ids, 3).map((c) => env.DB.prepare(`
            UPDATE Photo SET
              taken_at_local = ?,
              taken_at = ?,
              tz_offset_minutes = ?,
              time_source = 'manual'
            WHERE id IN (${placeholdersFor(c)})
          `).bind(localStr, utcStr, tz, ...c)),
        );

        const updated = res.reduce((n, r) => n + ((r.meta as any)?.changes ?? 0), 0);
        // 這支沒有「因為沒時間而跳過」這回事，skippedNoTime 恆為 0；
        // 欄位照樣回，前端那個結果提示三個模式共用一份
        return new Response(JSON.stringify({
          success: true,
          updated,
          skippedNoTime: 0,
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
        const denied = await guardTrackAccess(request, env, headers);
        if (denied) return denied;
        const noTools = await guardTrackTools(request, env, headers);
        if (noTools) return noTools;
        // guardTrackAccess 已經擋掉 null，這裡是 WeakMap 快取命中，不會再查一次 D1
        const viewer = (await currentActor(request, env)) as Actor;
        if (!env.GOOGLE_DRIVE_SA_KEY) {
          return new Response(JSON.stringify({
            error: "尚未設定 GOOGLE_DRIVE_SA_KEY",
          }), { status: 503, headers });
        }
        /*
         * 每個人各看各的資料夾（P1）。GPSLogger 只拿得到 `drive.file` scope，
         * 只碰得到自己建的檔，所以「大家都傳進站長的 Drive」在技術上不可能 ——
         * 每個人傳進自己的 Drive，再把那個資料夾分享給 Service Account，
         * 由站長在 /admin 綁上去。沒綁的人這裡就直接說清楚，不要回空陣列
         * 讓人以為是「Drive 上沒檔案」。
         */
        const folderId = trackFolderFor(env, viewer);
        if (!folderId) {
          // code 給前端判斷用：這不是故障，是「還沒設定」。開頁自動同步碰到它
          // 要安靜地跳過，不能每次進地圖都跳一次紅字
          return new Response(JSON.stringify({
            code: "track_folder_unbound",
            error: "你還沒有綁定 Drive 軌跡資料夾。請把 GPSLogger 上傳的資料夾分享給站上的服務帳號，再請站長到後台綁定。",
          }), { status: 503, headers });
        }

        const files = await listGpxFiles(env.GOOGLE_DRIVE_SA_KEY, folderId);
        const { results: days } = await env.DB.prepare(
          "SELECT day_key, md5, point_count, synced_at, ingest_source FROM TrackDay"
        ).all();
        const byKey = new Map((days as any[]).map(d => [d.day_key, d]));

        // md5 相同就代表內容一個點都沒變 —— 每次 auto-send 都會動 modifiedTime，
        // 只看時間會把整天的檔案白抓白解析一遍
        const list = files.map(f => {
          /*
           * 檔名 → day_key 的轉換**在這裡就做掉**，前端從頭到尾只看得到
           * 完整的 day_key。ingest、saveTrackRaw、貼路結果三者共用同一個 key，
           * 任何一處拿到裸檔名都會寫到別人（或不存在）的那一列去。
           */
          const dayKey = trackDayKeyFor(viewer.uid, f.name);
          const known = byKey.get(dayKey);
          return {
            dayKey,
            // 給畫面顯示用：day_key 帶著前綴，人看的是檔名
            fileName: f.name,
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

      /*
       * 路由：掃一遍分享給服務帳號的 Drive 資料夾，**自動**綁到人身上。
       *
       * 規矩只有一條：登入本站用哪個 Google 帳號，就得用那個帳號的 Drive
       * 分享資料夾。所以「資料夾的擁有者信箱 == User.email」是唯一的對應依據，
       * 站長不必也不能人工指定 —— 對不上就是那個人還沒設定好，訊息會叫他去設。
       * （`User.email` 是 UNIQUE NOT NULL，所以一個信箱不可能對出兩個人。）
       *
       * 是 POST 不是 GET，因為它會寫 D1。舊的 `GET /shared-folders` 只是把清單
       * 吐出來讓站長從下拉挑，整個拿掉了。
       *
       * 三個「寧可不動也不要亂綁」的地方：
       *   - 對到兩個以上 → 不綁，回 ambiguous 請對方只留一個。要自動選就得再
       *     打 Drive 看哪個資料夾裡面有 .gpx，為了這種罕見狀況不值得那趟往返。
       *   - 一個都對不到 → **不動他現有的綁定**。Drive 允許不揭露擁有者，
       *     信箱可能只是這一次沒拿到，把還在運作的綁定清掉才是災難。
       *   - 站長不綁。他走 GOOGLE_DRIVE_FOLDER_ID 那條，見 trackFolderFor()。
       */
      if (method === "POST" && pathname === "/api/tracks/drive/sync-folders") {
        const actor = await currentActor(request, env);
        if (!actor) {
          return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers });
        }
        if (!actor.isOwner) {
          return new Response(JSON.stringify({ error: "只有站長可以綁定軌跡資料夾" }), { status: 403, headers });
        }
        if (!env.GOOGLE_DRIVE_SA_KEY) {
          return new Response(JSON.stringify({ error: "尚未設定 GOOGLE_DRIVE_SA_KEY" }), { status: 503, headers });
        }

        const folders = await listSharedFolders(env.GOOGLE_DRIVE_SA_KEY);
        /*
         * 比對要用**全部**帳號（含站長與已停權的），綁定只做 active 的一般成員。
         * 差別在 unmatched：站長那顆照片備份資料夾（`didadida/`，上傳時會把 SA
         * 加成 writer，所以它也算 sharedWithMe）跟停權者的資料夾都對得到人，
         * 就不會被當成「對不到任何帳號」報給站長看，省掉每次都要解釋一次。
         */
        const { results: users } = await env.DB.prepare(
          "SELECT id, name, email, role, active, track_drive_folder_id FROM User"
        ).all<any>();

        const byUser = new Map<number, typeof folders>();
        const matched = new Set<string>();
        for (const f of folders) {
          if (!f.ownerEmail) continue;
          const email = f.ownerEmail.toLowerCase();
          const u = users.find((x: any) => String(x.email ?? "").toLowerCase() === email);
          if (!u) continue;
          matched.add(f.id);
          byUser.set(Number(u.id), [...(byUser.get(Number(u.id)) ?? []), f]);
        }

        const writes: D1PreparedStatement[] = [];
        const results: any[] = [];
        for (const u of users) {
          if (u.role === "owner" || u.active !== 1) continue;
          const mine = byUser.get(Number(u.id)) ?? [];
          const current: string | null = u.track_drive_folder_id ?? null;
          const base = { user_id: Number(u.id), name: u.name, email: u.email };

          if (mine.length === 1) {
            const f = mine[0];
            if (current !== f.id) {
              /*
               * 這個資料夾如果還掛在別人身上（以前人工綁的殘留），先拆掉再綁。
               * 一個資料夾綁兩個人 → 兩人同步到同一批 GPX，而 day_key 帶各自的
               * 前綴，同一天會憑空多出一份「不是他的」軌跡。
               */
              writes.push(env.DB.prepare(
                "UPDATE User SET track_drive_folder_id = NULL WHERE track_drive_folder_id = ? AND id != ?"
              ).bind(f.id, u.id));
              writes.push(env.DB.prepare(
                "UPDATE User SET track_drive_folder_id = ? WHERE id = ?"
              ).bind(f.id, u.id));
            }
            results.push({ ...base, status: current === f.id ? "bound" : "updated", folder_name: f.name });
          } else if (mine.length === 0) {
            results.push({ ...base, status: "missing", still_bound: current != null });
          } else {
            results.push({ ...base, status: "ambiguous", folder_names: mine.map(f => f.name) });
          }
        }
        if (writes.length) await env.DB.batch(writes);

        return new Response(JSON.stringify({
          // 站長要把資料夾分享給誰，畫面上得看得到這個信箱
          serviceAccount: serviceAccountEmail(env.GOOGLE_DRIVE_SA_KEY),
          folderCount: folders.length,
          results,
          // 分享過來卻對不到任何帳號的。「我明明分享了怎麼沒反應」只能靠這個查
          unmatched: folders.filter(f => !matched.has(f.id))
            .map(f => ({ name: f.name, ownerEmail: f.ownerEmail })),
        }), { headers });
      }

      // 路由：代理單一 GPX 檔的原始 bytes 給前端解析
      if (method === "GET" && pathname.startsWith("/api/tracks/drive/file/")) {
        const denied = await guardTrackAccess(request, env, headers);
        if (denied) return denied;
        const noTools = await guardTrackTools(request, env, headers);
        if (noTools) return noTools;
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
        const denied = await guardTrackAccess(request, env, headers);
        if (denied) return denied;
        // drive_file_id / md5 也一起給：還原是走 ingest，而 ingest 會把這兩欄
        // 整個覆蓋掉，前端得原封不動送回來，否則下次同步會誤判成「檔案有變」
        // first_local_day / last_local_day：這批軌跡點實際落在哪一天（當地）。
        // day_key 是 Drive 檔名，不保證是日期（見上面的註解），前端的月曆要標
        // 「這天有沒有足跡」只能靠這兩欄，不能去解析檔名。
        //
        // 用相關子查詢而不是 GROUP BY 掃全表：idx_trackpoint_day 是
        // (day_key, t_utc)，day_key 給定之後 MIN/MAX 就是索引的頭尾兩次 seek，
        // 每天各兩筆。GROUP BY 會把整個 TrackPoint 掃過一遍，天數一多就是白花讀取額度。
        // user_id / user_name：這一天是誰的。家人之間互相看得到彼此的足跡
        // （使用者定調），所以這裡回全部，由前端決定要不要篩選與能不能編輯。
        const { results } = await env.DB.prepare(`
          SELECT d.day_key, d.ingest_source, d.drive_file_id, d.md5, d.point_count,
                 d.tz_offset_minutes, d.synced_at, d.is_private,
                 d.user_id, u.name AS user_name,
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
          LEFT JOIN User u ON u.id = d.user_id
          WHERE d.user_id IS NULL OR ${TRACK_MEMBER_COND}
          ORDER BY d.day_key DESC
        `).all();
        return new Response(JSON.stringify(results), { headers });
      }

      // 路由：讀回某一天的原始 GPX（給「恢復原始軌跡」用）
      // 原文就是完整的一日行蹤，比軌跡點更敏感，只給管理者
      if (method === "GET" && pathname.startsWith("/api/tracks/raw/")) {
        const denied = await guardTrackAccess(request, env, headers);
        if (denied) return denied;
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
        /*
         * 一般成員要有那一列才存得了原文（canTouchTrackDay 對不存在的列回 false）。
         * 這正好符合真實流程 —— 前端一律是 ingest 成功之後才呼叫這支。
         * 反過來讓它先建檔的話，等於任何成員都能往別人未來的 day_key 塞內容。
         */
        const denied = await guardTrackAccess(request, env, headers);
        if (denied) return denied;
        const noTools = await guardTrackTools(request, env, headers);
        if (noTools) return noTools;
        if (!(await canTouchTrackDay(dayKey))) {
          return forbidden(headers, "這一天的軌跡不是你的，或還沒有同步過");
        }
        const xml = await request.text();
        if (!xml.trim()) {
          return new Response(JSON.stringify({ error: "內容是空的" }), { status: 400, headers });
        }
        const rawKey = rawTrackKey(dayKey);
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
        const denied = await guardTrackAccess(request, env, headers);
        if (denied) return denied;
        const noTools = await guardTrackTools(request, env, headers);
        if (noTools) return noTools;
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
        const denied = await guardTrackAccess(request, env, headers);
        if (denied) return denied;
        const object = await env.BUCKET.get(matchedKey(dayKey));
        if (!object) {
          return new Response(JSON.stringify({ error: "這一天還沒有貼路軌跡" }), { status: 404, headers });
        }
        return new Response(object.body, {
          headers: { ...headers, "Content-Type": "application/json" },
        });
      }

      if (method === "PUT" && pathname.startsWith("/api/tracks/matched/")) {
        const denied = await guardTrackAccess(request, env, headers);
        if (denied) return denied;
        const noTools = await guardTrackTools(request, env, headers);
        if (noTools) return noTools;
        const dayKey = decodeURIComponent(pathname.slice("/api/tracks/matched/".length));
        if (!dayKey) {
          return new Response(JSON.stringify({ error: "dayKey is required" }), { status: 400, headers });
        }
        // 貼路結果是從那一天的點推出來的，跟著同一份擁有權走
        if (!(await canTouchTrackDay(dayKey))) {
          return forbidden(headers, "這一天的軌跡不是你的，或還沒有同步過");
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
        const denied = await guardTrackAccess(request, env, headers);
        if (denied) return denied;
        const noTools = await guardTrackTools(request, env, headers);
        if (noTools) return noTools;
        const dayKey = decodeURIComponent(pathname.slice("/api/tracks/matched/".length));
        if (!dayKey) {
          return new Response(JSON.stringify({ error: "dayKey is required" }), { status: 400, headers });
        }
        if (!(await canTouchTrackDay(dayKey))) {
          return forbidden(headers, "這一天的軌跡不是你的，或還沒有同步過");
        }
        await env.BUCKET.delete(matchedKey(dayKey));
        return new Response(JSON.stringify({ success: true, dayKey }), { headers });
      }

      // 路由：寫入解析後的軌跡點
      // 冪等：同一個 day_key 重灌就是整批換掉，所以重複同步不會長出重複的點
      if (method === "POST" && pathname === "/api/tracks/ingest") {
        const denied = await guardTrackAccess(request, env, headers);
        if (denied) return denied;
        const noTools = await guardTrackTools(request, env, headers);
        if (noTools) return noTools;
        const body: any = await request.json().catch(() => ({}));
        const requestedKey = typeof body?.dayKey === 'string' ? body.dayKey.trim() : '';
        if (!requestedKey) {
          return new Response(JSON.stringify({ error: "dayKey is required" }), { status: 400, headers });
        }

        /*
         * 這一批點要寫進誰的名下。
         *
         * 規則只有一條：**day_key 由後端依 actor 重新組一次，不信任前端送什麼**。
         * 少了它，任何成員只要把 dayKey 打成別人的，就能整批洗掉對方那天的軌跡
         * （ingest 是 DELETE 全部再插入）。重組是冪等的：`u2:20260813.gpx`
         * 拆掉前綴再貼回去還是同一個，所以正常流程（drive/files 回好的 key）
         * 走這裡什麼都不會變。
         *
         * 刻意**不因為前綴不對就 403** —— 送進來的字串是「哪一天」而不是
         * 「誰的」，硬要報錯只會讓手動上傳 GPX（P1）那條路莫名其妙失敗。
         * 重組後它必然落在自己的命名空間裡，覆蓋不到別人。
         *
         * 管得到別人的人是例外，照原樣收：站長要修別人那天的軌跡，
         * 得指得到別人那一列。
         */
        const dayKey = me.canManageOthers
          ? requestedKey
          : trackDayKeyFor(me.uid, stripTrackKeyPrefix(requestedKey));

        // 防禦性檢查。重組過的 key 照理不可能是別人的，但 uid 1 無前綴那條規則
        // 讓「沒有前綴」同時代表舊資料與站長的資料，還是攔一道比較安全
        const existing = await trackDayOwnership(env, dayKey);
        if (existing && !actorOwns(me, existing)) {
          return forbidden(headers, "這一天的軌跡是別人的，不能覆蓋");
        }
        /*
         * 已經有那一列 → user_id 是唯一權威（換主人是刪帳號那條路才做的事）。
         * 還沒有 → 站長可以替別人開（key 上宣稱誰就是誰），其餘一律開在自己名下。
         */
        const ownerUid: number | null = existing && existing.user_id != null
          ? Number(existing.user_id)
          : (me.canManageOthers ? trackKeyClaimedUid(dayKey) : me.uid);

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
            `INSERT INTO TrackDay (day_key, user_id, ingest_source, drive_file_id, md5, point_count, tz_offset_minutes)
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(day_key) DO UPDATE SET
               ingest_source = excluded.ingest_source,
               drive_file_id = excluded.drive_file_id,
               md5 = excluded.md5,
               point_count = excluded.point_count,
               tz_offset_minutes = excluded.tz_offset_minutes,
               synced_at = CURRENT_TIMESTAMP`
            // user_id 刻意不在 DO UPDATE 裡：上面已經確認過我動得了這一列，
            // 但「可以修改」不等於「可以把別人的軌跡改成我的」。換主人是
            // 刪帳號那條路才做的事
          ).bind(
            dayKey,
            ownerUid,
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
        const denied = await guardTrackAccess(request, env, headers);
        if (denied) return denied;
        const conds: string[] = [];
        const binds: any[] = [];

        const qFrom = url.searchParams.get("from");
        if (qFrom) { conds.push("p.t_utc >= ?"); binds.push(qFrom); }
        const qTo = url.searchParams.get("to");
        if (qTo) { conds.push("p.t_utc <= ?"); binds.push(qTo); }
        const qDay = url.searchParams.get("day_key");
        if (qDay) { conds.push("p.day_key = ?"); binds.push(qDay); }

        /*
         * 只看某幾個人的足跡。`?user_id=3,7`，省略就是全部。
         *
         * 家人之間互相看得到（使用者定調），所以這是**篩選不是權限** ——
         * 但它同時省讀取額度：底下那個 LIMIT 是全域的，三個人同框等於
         * 每個人只剩三分之一的天數，只看自己時就不該把別人的點也讀出來。
         */
        const qUsers = (url.searchParams.get("user_id") ?? "")
          .split(",").map((s) => Number(s.trim()))
          .filter((n) => Number.isInteger(n) && n > 0);
        if (qUsers.length > 0) {
          // 這裡的數量是「站上有幾個家人」，遠低於 D1 的 100 個綁定參數上限
          conds.push(`d.user_id IN (${placeholdersFor(qUsers.slice(0, 50))})`);
          binds.push(...qUsers.slice(0, 50));
        }

        // 沒有工具權限的人的軌跡整條不出（見 TRACK_MEMBER_COND）。
        // 放在 conds 裡是因為它同時要吃到底下那個 LIMIT —— 先濾再取 N 點，
        // 不然「最近 20000 點」會被畫不出來的人佔掉名額
        conds.push(`(d.user_id IS NULL OR ${TRACK_MEMBER_COND})`);

        const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
        // 一定要有上限。軌跡一天就好幾百點，不設限的話「不選日期直接進地圖頁」
        // 會把好幾年份一次讀出來，D1 免費額度的每日讀取列數撐不住。
        const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 20000, 1), 50000);
        const { results } = await env.DB.prepare(`
          SELECT p.id, p.day_key, p.t_utc, p.lat, p.lng, p.src, p.seg, p.stay_sec,
                 d.user_id
          FROM TrackPoint p
          JOIN TrackDay d ON d.day_key = p.day_key
          LEFT JOIN User u ON u.id = d.user_id
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
        const denied = await guardTrackAccess(request, env, headers);
        if (denied) return denied;
        const noTools = await guardTrackTools(request, env, headers);
        if (noTools) return noTools;
        const body: any = await request.json().catch(() => ({}));
        const dayKey = typeof body?.dayKey === 'string' ? body.dayKey.trim() : '';
        if (!dayKey) {
          return new Response(JSON.stringify({ error: "dayKey is required" }), { status: 400, headers });
        }
        if (!(await canTouchTrackDay(dayKey))) {
          return forbidden(headers, "這一天的軌跡不是你的，或還沒有同步過");
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
       *
       * **多身分（P1）**：R2 的 key 依 uid 分開（見 timelineIndexKey）。
       * 寫入永遠只寫得到自己那一包 —— 沒有「幫別人匯入」這種需求，
       * 匯出檔要從他自己的 Google 帳號下載。讀取可以用 `?user_id=` 指定別人，
       * 家人之間本來就互相看得到（跟 /api/tracks 同一個定調）。
       */
      const timelineViewerUid = async (): Promise<number | null | undefined> => {
        const q = url.searchParams.get("user_id");
        if (q) {
          const n = Number(q);
          return Number.isInteger(n) && n > 0 ? n : undefined; // undefined ＝ 參數不合法
        }
        return (await currentActor(request, env))?.uid ?? null;
      };

      if (method === "GET" && pathname === "/api/timeline/index") {
        const denied = await guardTrackAccess(request, env, headers);
        if (denied) return denied;
        const uid = await timelineViewerUid();
        if (uid === undefined) {
          return new Response(JSON.stringify({ error: "user_id 必須是正整數" }), { status: 400, headers });
        }
        const object = await env.BUCKET.get(timelineIndexKey(uid));
        // 還沒匯入過不是錯誤，回空索引讓前端不用區分這兩種情況
        if (!object) {
          return new Response(JSON.stringify({ months: [] }), { headers });
        }
        return new Response(object.body, {
          headers: { ...headers, "Content-Type": "application/json" },
        });
      }

      if (method === "PUT" && pathname === "/api/timeline/index") {
        const denied = await guardTrackAccess(request, env, headers);
        if (denied) return denied;
        const noTools = await guardTrackTools(request, env, headers);
        if (noTools) return noTools;
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

        // 寫入只寫得到自己那一包：uid 取自 token，刻意不看 ?user_id=
        const meUid = (await currentActor(request, env))?.uid ?? null;
        await env.BUCKET.put(timelineIndexKey(meUid), JSON.stringify({
          months, updatedAt: new Date().toISOString(),
        }), { httpMetadata: { contentType: "application/json" } });
        return new Response(JSON.stringify({ success: true, months: months.length }), { headers });
      }

      if (method === "GET" && pathname.startsWith("/api/timeline/month/")) {
        const denied = await guardTrackAccess(request, env, headers);
        if (denied) return denied;
        const month = pathname.slice("/api/timeline/month/".length);
        if (!TIMELINE_MONTH_RE.test(month)) {
          return new Response(JSON.stringify({ error: "月份格式必須是 YYYY-MM" }), { status: 400, headers });
        }
        const uid = await timelineViewerUid();
        if (uid === undefined) {
          return new Response(JSON.stringify({ error: "user_id 必須是正整數" }), { status: 400, headers });
        }
        const object = await env.BUCKET.get(timelineMonthKey(uid, month));
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
        const denied = await guardTrackAccess(request, env, headers);
        if (denied) return denied;
        const noTools = await guardTrackTools(request, env, headers);
        if (noTools) return noTools;
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
        const meUid = (await currentActor(request, env))?.uid ?? null;
        await env.BUCKET.put(timelineMonthKey(meUid, month), json, {
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
   * Cron：清 Drive 待搬佇列的尾巴，佇列空了就順便對帳。
   *
   * 刪除當下已經會搬掉前幾個，這裡負責整本相簿刪除留下的長尾。一次仍然只搬
   * 一小批 —— 免費版單次呼叫 50 個 subrequest，一個檔要兩次 Drive 往返。
   * 佇列空的時候這支只花一個 D1 查詢，一天 288 次對免費額度沒感覺。
   *
   * ⚠️ **兩件事一定要分先後，不可以並排跑。** 搬 20 個檔就是 40 個 subrequest，
   *    對帳再去列 Drive 資料夾就會撞上單次 50 個的上限，而撞上的表現是
   *    「後面那幾個請求安靜地失敗」—— 對帳結果會憑空多出一堆假的「不見了」。
   *    所以：先排佇列，**佇列真的空了**（remaining === 0 且這次沒搬東西）
   *    才輪到對帳，那時候整份額度都是它的。
   *
   * 本機 `wrangler dev` 不會自己跑 cron，要測就打 http://localhost:8787/__scheduled
   */
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil((async () => {
      try {
        const r = await drainDriveTrash(env, 20);
        if (r.ok && (r.moved > 0 || r.failed.length > 0)) {
          console.log(`Drive 待搬：搬走 ${r.moved}，失敗 ${r.failed.length}，還剩 ${r.remaining}`);
        }
        // 佇列還有東西就把這個 tick 全讓給它，對帳等下一次（十分鐘後）
        if (!r.ok || r.moved > 0 || r.remaining > 0) return;
      } catch (e) {
        console.error("Drive 待搬佇列（cron）", e);
        return;
      }

      try {
        // 一次一本。上一輪掃完了就會在 runDriveAudit 裡直接返回（只花一次 D1 讀取）
        const state = await runDriveAudit(env, 1, false);
        if (state.last_error) console.error("Drive 對帳", state.last_error);
      } catch (e) {
        console.error("Drive 對帳（cron）", e);
      }
    })());
  },
};
