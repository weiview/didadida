import exifr from 'exifr';
import {
  normalizeGeo, formatWallClock, utcFromLocal,
  parseExifDateTime, geoOverwriteGuard, DEFAULT_TZ_OFFSET_MINUTES,
} from './geo';
import { listGpxFiles, fetchGpxBytes } from './drive';

export interface Env {
  DB: D1Database;
  BUCKET: R2Bucket;
  APP_PASSWORD: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  /** service account 金鑰 JSON 全文。唯讀，只看得到被分享的那一個 Drive 資料夾 */
  GOOGLE_DRIVE_SA_KEY?: string;
  /** GPSLogger 上傳目的地資料夾的 Drive file id */
  GOOGLE_DRIVE_FOLDER_ID?: string;
  /**
   * map matching（軌跡貼路）用的 Valhalla 服務位址，例如
   * https://valhalla1.openstreetmap.de。放在設定裡而不是寫死在程式碼，
   * 是 FOSSGIS 使用條款明文要求的（「不要把服務網址硬寫進 app」），
   * 這樣要換實例或臨時關掉都不必改程式。沒設就等於這個功能關閉。
   */
  VALHALLA_URL?: string;
}

async function generateJWT(env: Env): Promise<string> {
  const encoder = new TextEncoder();
  const header = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = btoa(JSON.stringify({ iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 86400 * 7 })); // 7 days
  const data = `${header}.${payload}`;
  
  const key = await crypto.subtle.importKey('raw', encoder.encode(env.APP_PASSWORD), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(data));
  const signatureB64 = btoa(String.fromCharCode(...new Uint8Array(signature))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  
  return `${data}.${signatureB64}`;
}

async function verifyJWT(token: string, env: Env): Promise<boolean> {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return false;
    const [header, payload, signature] = parts;
    
    const payloadObj = JSON.parse(atob(payload));
    if (payloadObj.exp < Math.floor(Date.now() / 1000)) return false;

    const data = `${header}.${payload}`;
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey('raw', encoder.encode(env.APP_PASSWORD), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
    
    const sigBytes = Uint8Array.from(atob(signature.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
    
    return await crypto.subtle.verify('HMAC', key, sigBytes, encoder.encode(data));
  } catch (e) {
    return false;
  }
}

/**
 * 只認 /api/verify-password 發出的 JWT。
 *
 * 以前這裡也接受裸的 APP_PASSWORD 當 bearer（backward compatibility），已經移除：
 * 那個密碼同時是 JWT 的簽章金鑰，一旦外流等於可以自簽任意 token，而且撤不掉。
 */
async function isAuthorized(request: Request, env: Env): Promise<boolean> {
  const authHeader = request.headers.get("Authorization");
  if (!authHeader) return false;
  const token = authHeader.replace("Bearer ", "");
  return await verifyJWT(token, env);
}

/**
 * 移除不該對外曝光的座標。
 *
 * 注意：所有 GET 路由都是公開的（只有 POST/PUT/DELETE 需要驗證），所以座標必須在
 * 後端就拿掉 —— 只在前端不繪製地圖是無效的，按 F12 就能從 JSON 看到經緯度。
 * 相簿層級 (map_private) 或照片層級 (geo_private) 任一為私密，就不輸出座標。
 * 實務上閘門是相簿：geo_private 預設 0（見 migrate_geo_private_default.sql），
 * 只有被單獨標成私密的那幾張才會在公開相簿裡被扣住。
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

/** SQLite 日期修飾字串。-90 -> '-90 minutes'、90 -> '+90 minutes' */
const minutesModifier = (n: number) => `${n >= 0 ? '+' : ''}${n} minutes`;

/**
 * 公開相簿各自涵蓋的 UTC 時間窗，前後各留 6 小時。
 *
 * 用途：把「這本相簿公開」翻譯成「這段時間的軌跡也公開」。使用者的規則是
 * 相簿公開就連同軌跡公開、相簿不公開就只有登入時看得到 —— 所以軌跡的
 * is_private 不再是唯一的閘門，它現在的意思是「就算沒有任何公開相簿也要公開」。
 *
 * 為什麼用時間窗而不是整個 day_key：一天裡可能只有下午那趟屬於這次旅行，
 * 早上還在家。用相簿照片的時間範圍去交集，公開出去的就只有那一趟。
 * 前後 6 小時是去程與回程 —— 沒有它，公開的軌跡會從抵達目的地才開始。
 * 跟前端地圖頁推算軌跡範圍用的是同一個數字，兩邊看到的東西才會一致。
 *
 * taken_at 與 t_utc 都是 'YYYY-MM-DDTHH:MM:SS.sssZ'，可以直接字串比大小。
 */
const TRIP_PAD_MS = 6 * 60 * 60 * 1000;
async function publicTripWindows(env: Env): Promise<{ from: string; to: string }[]> {
  const { results } = await env.DB.prepare(`
    SELECT MIN(p.taken_at) AS lo, MAX(p.taken_at) AS hi
    FROM Photo p JOIN Album a ON a.id = p.album_id
    WHERE a.map_private = 0 AND p.taken_at IS NOT NULL
    GROUP BY a.id
  `).all();

  const out: { from: string; to: string }[] = [];
  for (const r of results as any[]) {
    const lo = Date.parse(r.lo);
    const hi = Date.parse(r.hi);
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) continue;
    out.push({
      from: new Date(lo - TRIP_PAD_MS).toISOString(),
      to: new Date(hi + TRIP_PAD_MS).toISOString(),
    });
  }
  return out;
}

/** 這一段時間（ISO 字串）有沒有跟任何一個公開行程的時間窗重疊 */
function overlapsTripWindows(from: string, to: string, windows: { from: string; to: string }[]): boolean {
  return windows.some(w => from <= w.to && to >= w.from);
}

/**
 * Google 時間軸貼路結果的 day_key 前綴（前端的 TIMELINE_DAY_PREFIX，兩邊要一致）。
 * 這些日子在 TrackDay 裡沒有列 —— 時間軸是唯讀紀念層，刻意不進 D1。
 */
const TIMELINE_DAY_PREFIX = 'timeline:';

/**
 * 整個 day_key 對外可不可見。給那些「只能整份給或整份不給」的東西用
 * （貼路結果是 R2 上的一顆檔案，沒辦法只給其中一段）。
 *
 * 條件同 /api/tracks：明確公開，或這一天有任何一點落在公開相簿的行程時間窗裡。
 * 注意這比 /api/tracks 寬鬆 —— 只要有一點對上就整天給出去。會這樣是因為
 * 檔案本身不可分割，而它終究是從那些點推出來的，不含更多資訊。
 */
async function isTrackDayPublic(env: Env, dayKey: string): Promise<boolean> {
  // Google 時間軸的日子在 TrackDay / TrackPoint 裡都沒有列，沒有點可以查，
  // 只能拿 key 裡那個日期去比。整天當一段（UTC 00:00～23:59），窗本身
  // 前後已經各留了 6 小時，時區差那幾小時吃得下
  if (dayKey.startsWith(TIMELINE_DAY_PREFIX)) {
    const day = dayKey.slice(TIMELINE_DAY_PREFIX.length);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
    const windows = await publicTripWindows(env);
    return overlapsTripWindows(`${day}T00:00:00.000Z`, `${day}T23:59:59.999Z`, windows);
  }

  const day = await env.DB.prepare(
    "SELECT is_private FROM TrackDay WHERE day_key = ?"
  ).bind(dayKey).first<{ is_private: number }>();
  if (day && Number(day.is_private) === 0) return true;

  const windows = await publicTripWindows(env);
  if (windows.length === 0) return false;
  const ors = windows.map(() => "(t_utc >= ? AND t_utc <= ?)").join(" OR ");
  const binds = windows.flatMap(w => [w.from, w.to]);
  const hit = await env.DB.prepare(
    `SELECT 1 AS ok FROM TrackPoint WHERE day_key = ? AND (${ors}) LIMIT 1`
  ).bind(dayKey, ...binds).first();
  return !!hit;
}

// Rate Limiting (In-memory)
interface LoginAttempt {
  count: number;
  lockUntil?: number;
}
const loginAttempts = new Map<string, LoginAttempt>();

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const pathname = url.pathname;
    const method = request.method;

const origin = request.headers.get("Origin") || "";
    const allowedOrigins = [
      "https://didadida-frontend.pages.dev",
      "https://dev.didadida-frontend.pages.dev",
      "http://localhost:3000"
    ];
    
    const allowOrigin = allowedOrigins.includes(origin) ? origin : allowedOrigins[0];

    // CORS Headers
    const headers = {
      "Access-Control-Allow-Origin": allowOrigin,
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Google-Token",
      "Content-Type": "application/json",
    };

    if (method === "OPTIONS") {
      return new Response(null, { headers });
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
          const token = await generateJWT(env);
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

      // 路由：確認手上的 token 還有效（沒過期、簽章對）
      //
      // 前端每次進站都靠這一條決定要不要顯示編輯介面 —— 只看 localStorage 有沒有
      // token 是不夠的，過期後那個 key 還在。刻意不套 verify-password 的 2 秒延遲
      // 與登入節流：它不接受密碼，沒有可暴力破解的東西，也沒有任何副作用。
      if (method === "GET" && pathname === "/api/auth/me") {
        if (!(await isAuthorized(request, env))) {
          return new Response(JSON.stringify({ admin: false }), { status: 401, headers });
        }
        return new Response(JSON.stringify({ admin: true }), { headers });
      }

      // 路由：取得所有相簿
      if (method === "GET" && pathname === "/api/albums") {
        const { results: albums } = await env.DB.prepare("SELECT * FROM Album ORDER BY sort_order ASC, created_at DESC").all();
        
        // Fetch preview photos for the carousel using a window function to limit to 10 per album
        const { results: allPhotos } = await env.DB.prepare(`
          SELECT album_id, COALESCE(thumb_url, url) as url FROM (
            SELECT album_id, url, thumb_url, 
                   ROW_NUMBER() OVER(PARTITION BY album_id ORDER BY sort_order ASC, created_at DESC) as rn
            FROM Photo
          ) WHERE rn <= 10
        `).all();
        
        const albumsWithPhotos = albums.map((album: any) => {
          const albumPhotos = allPhotos.filter((p: any) => p.album_id === album.id).map((p: any) => p.url);
          return { ...album, preview_photos: albumPhotos };
        });

        return new Response(JSON.stringify(albumsWithPhotos), { headers });
      }



      // 路由：查看 R2 照片
      if (method === "GET" && pathname.startsWith("/api/photos/view/")) {
        const fileName = decodeURIComponent(pathname.split("/")[4]);
        const object = await env.BUCKET.get(fileName);

        if (object === null) {
          return new Response(JSON.stringify({ error: "Photo not found" }), { status: 404, headers });
        }

        const photoHeaders = new Headers();
        object.writeHttpMetadata(photoHeaders);
        photoHeaders.set("etag", object.httpEtag);
        photoHeaders.set("Access-Control-Allow-Origin", "*");
        photoHeaders.set("Cache-Control", "public, max-age=31536000");

        return new Response(object.body, { headers: photoHeaders });
      }

      // 路由：取得特定相簿的照片 (含 Tags)
      if (method === "GET" && pathname.startsWith("/api/albums/") && pathname.endsWith("/photos")) {
        const parts = pathname.split("/");
        const albumId = parts[3];
        
        const { results: rawPhotos } = await env.DB.prepare(`
          SELECT p.*, a.map_private
          FROM Photo p
          LEFT JOIN Album a ON a.id = p.album_id
          WHERE p.album_id = ?
          ORDER BY p.sort_order ASC, p.created_at DESC
        `).bind(albumId).all();
        const photos = applyGeoPrivacy(rawPhotos as any[], await isAuthorized(request, env));

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
          
          // 將 tag 附加到 photo 上
          for (let photo of photos) {
            (photo as any).tags = tags.filter(t => t.photo_id === photo.id).map(t => ({ id: t.id, name: t.name }));
          }
        }
        
        return new Response(JSON.stringify(photos), { headers });
      }

      // 路由：取得所有正在使用的標籤
      if (method === "GET" && pathname === "/api/tags") {
        const { results } = await env.DB.prepare(`
          SELECT DISTINCT t.* 
          FROM Tag t 
          INNER JOIN PhotoTag pt ON t.id = pt.tag_id 
          ORDER BY t.name ASC
        `).all();
        return new Response(JSON.stringify(results), { headers });
      }

      // 路由：取得全站所有照片 (含 Tags 與 所屬相簿名稱)
      if (method === "GET" && pathname === "/api/all-photos") {
        const { results: rawAllPhotos } = await env.DB.prepare(`
          SELECT p.*, a.name as album_name, a.map_private
          FROM Photo p
          LEFT JOIN Album a ON p.album_id = a.id
          ORDER BY p.taken_at DESC, p.created_at DESC
        `).all();
        const photos = applyGeoPrivacy(rawAllPhotos as any[], await isAuthorized(request, env));

        if (photos.length > 0) {
          const { results: tags } = await env.DB.prepare(`
            SELECT pt.photo_id, t.id, t.name 
            FROM PhotoTag pt 
            JOIN Tag t ON pt.tag_id = t.id
          `).all();

          for (let photo of photos) {
            (photo as any).tags = tags.filter(t => String(t.photo_id) === String((photo as any).id)).map(t => ({ id: t.id, name: t.name }));
          }
        }
        return new Response(JSON.stringify(photos), { headers });
      }

      // 以下路由需要驗證
      const requiresAuth = ["POST", "PUT", "DELETE"].includes(method);
      if (requiresAuth && !(await isAuthorized(request, env))) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers });
      }

      // 路由：重新排序相簿
      if (method === "PUT" && pathname === "/api/albums/reorder") {
        const body: { id: number; sort_order: number }[] = await request.json();
        const statements = body.map(item => env.DB.prepare("UPDATE Album SET sort_order = ? WHERE id = ?").bind(item.sort_order, item.id));
        if (statements.length > 0) await env.DB.batch(statements);
        return new Response(JSON.stringify({ success: true }), { headers });
      }

      // 路由：重新排序照片
      if (method === "PUT" && pathname === "/api/photos/reorder") {
        const body: { id: number; sort_order: number }[] = await request.json();
        const statements = body.map(item => env.DB.prepare("UPDATE Photo SET sort_order = ? WHERE id = ?").bind(item.sort_order, item.id));
        if (statements.length > 0) await env.DB.batch(statements);
        return new Response(JSON.stringify({ success: true }), { headers });
      }

      // 路由：新增相簿
      if (method === "POST" && pathname === "/api/albums") {
        const body: any = await request.json();
        if (!body.name) return new Response(JSON.stringify({ error: "Name is required" }), { status: 400, headers });
        await env.DB.prepare("INSERT OR IGNORE INTO User (id, name, email) VALUES (1, 'Admin', 'admin@didadida.com')").run();
        const { success } = await env.DB.prepare("INSERT INTO Album (name, description, user_id) VALUES (?, ?, 1)").bind(body.name, body.description || null).run();
        return new Response(JSON.stringify({ success: success }), { headers });
      }

      // 路由：更新相簿設定 (封面照、封面文字等)
      if (method === "PUT" && pathname.startsWith("/api/albums/") && pathname.split("/").length === 4) {
        const albumId = pathname.split("/")[3];
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
        
        return new Response(JSON.stringify({ success: true }), { headers });
      }

      // 路由：刪除相簿 (連同底下的照片)
      if (method === "DELETE" && pathname.startsWith("/api/albums/") && pathname.split("/").length === 4) {
        const albumId = pathname.split("/")[3];
        
        // 1. 抓出這本相簿所有的照片
        const { results: photos } = await env.DB.prepare("SELECT id, file_name FROM Photo WHERE album_id = ?").bind(albumId).all();
        
        if (photos.length > 0) {
          // 2. 從 R2 刪除實體檔案
          const fileNames = photos.map(p => p.file_name as string);
          await env.BUCKET.delete(fileNames);
          
          // 3. 刪除所有這些照片的 Tag 關聯
          await env.DB.prepare(`DELETE FROM PhotoTag WHERE photo_id IN (SELECT id FROM Photo WHERE album_id = ?)`).bind(albumId).run();
        }
        
        // 4. 刪除這些照片紀錄
        await env.DB.prepare("DELETE FROM Photo WHERE album_id = ?").bind(albumId).run();
        
        // 5. 刪除相簿本身
        await env.DB.prepare("DELETE FROM Album WHERE id = ?").bind(albumId).run();
        
        return new Response(JSON.stringify({ success: true }), { headers });
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
        const thumb = formData.get('thumb') as unknown as File | null;
        const albumId = formData.get('album_id') as string;
        const exifData = formData.get('exif') as string || null;
        const takenAt = formData.get('taken_at') as string || null;
        const clientPhash = formData.get('phash') as string || null;
        
        if (!file || !albumId) {
          return new Response(JSON.stringify({ error: "File and album_id are required" }), { status: 400, headers });
        }
        
        const allowedTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic'];
        if (!allowedTypes.includes(file.type.toLowerCase())) {
          return new Response(JSON.stringify({ error: "Invalid file type. Only images are allowed." }), { status: 400, headers });
        }

        const buffer = await file.arrayBuffer();
        const fileHash = await calculateFileHash(buffer);
        
        const fileName = `${Date.now()}_${file.name.replace(/[^a-zA-Z0-9.-]/g, '_')}`;
        await env.BUCKET.put(fileName, buffer, {
          httpMetadata: { contentType: file.type }
        });
        
        let thumbUrl = null;
        if (thumb) {
          const thumbFileName = `thumb_${fileName}`;
          await env.BUCKET.put(thumbFileName, thumb.stream(), {
            httpMetadata: { contentType: thumb.type || 'image/jpeg' }
          });
          thumbUrl = `${new URL(request.url).origin}/api/photos/view/${encodeURIComponent(thumbFileName)}`;
        }
        
        const host = new URL(request.url).origin;
        const fileUrl = `${host}/api/photos/view/${encodeURIComponent(fileName)}`;

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

        const inserted = await env.DB.prepare(
          `INSERT INTO Photo
             (title, file_name, album_id, url, thumb_url, exif, taken_at, file_hash, phash,
              lat, lng, geo_source, taken_at_local, tz_offset_minutes, time_source)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(
          file.name, fileName, albumId, fileUrl, thumbUrl, exifData,
          uploadTakenAt, fileHash, clientPhash,
          geo.lat, geo.lng, geo.geoSource, geo.takenAtLocal, geo.tzOffsetMinutes,
          uploadTimeSource,
        ).run();

        // 回傳 id 與座標，前端才有辦法在上傳結束後認出「這一批」是哪幾張、
        // 以及其中哪幾張沒有 EXIF 位置需要補。
        return new Response(JSON.stringify({
          success: true,
          id: inserted.meta?.last_row_id ?? null,
          url: fileUrl,
          thumb_url: thumbUrl,
          file_hash: fileHash,
          lat: geo.lat,
          lng: geo.lng,
        }), { headers });
      }

      // 路由：更新照片資訊 (description, taken_at)
      if (method === "PUT" && pathname.startsWith("/api/photos/") && pathname.split("/").length === 4) {
        const photoId = pathname.split("/")[3];
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
        return new Response(JSON.stringify({ success: true }), { headers });
      }

      // 路由：刪除照片
      if (method === "DELETE" && pathname.startsWith("/api/photos/") && pathname.split("/").length === 4) {
        const photoId = pathname.split("/")[3];
        const photo = await env.DB.prepare("SELECT file_name, url FROM Photo WHERE id = ?").bind(photoId).first();
        if (!photo) return new Response(JSON.stringify({ error: "Photo not found" }), { status: 404, headers });
        
        await env.BUCKET.delete(photo.file_name as string);
        await env.DB.prepare("DELETE FROM PhotoTag WHERE photo_id = ?").bind(photoId).run();
        // 如果該照片是某個相簿的封面，則清除該相簿的封面
        await env.DB.prepare("UPDATE Album SET cover_photo_url = NULL WHERE cover_photo_url = ?").bind(photo.url).run();
        await env.DB.prepare("DELETE FROM Photo WHERE id = ?").bind(photoId).run();
        return new Response(JSON.stringify({ success: true }), { headers });
      }

      // 路由：新增照片標籤
      if (method === "POST" && pathname.startsWith("/api/photos/") && pathname.endsWith("/tags")) {
        const photoId = pathname.split("/")[3];
        const { tagName } = await request.json() as { tagName: string };
        if (!tagName) return new Response(JSON.stringify({ error: "Tag name required" }), { status: 400, headers });
        
        await env.DB.prepare("INSERT OR IGNORE INTO Tag (name) VALUES (?)").bind(tagName).run();
        const tag = await env.DB.prepare("SELECT id FROM Tag WHERE name = ?").bind(tagName).first();
        if (tag) {
          await env.DB.prepare("INSERT OR IGNORE INTO PhotoTag (photo_id, tag_id) VALUES (?, ?)").bind(photoId, tag.id).run();
        }
        return new Response(JSON.stringify({ success: true, tag: { id: tag?.id, name: tagName } }), { headers });
      }

      // 路由：刪除照片標籤
      if (method === "DELETE" && pathname.startsWith("/api/photos/") && pathname.includes("/tags/")) {
        const parts = pathname.split("/");
        const photoId = parts[3];
        const tagId = parts[5];
        await env.DB.prepare("DELETE FROM PhotoTag WHERE photo_id = ? AND tag_id = ?").bind(photoId, tagId).run();
        // 清理完全沒有任何照片使用的孤立標籤
        await env.DB.prepare("DELETE FROM Tag WHERE id NOT IN (SELECT DISTINCT tag_id FROM PhotoTag)").run();
        return new Response(JSON.stringify({ success: true }), { headers });
      }

      // 路由：Google OAuth 登入跳轉
      if (method === "GET" && pathname === "/api/auth/google/login") {
        const urlObj = new URL(request.url);
        const albumId = urlObj.searchParams.get("state") || "";
        const referer = request.headers.get("referer") || request.headers.get("origin");
        let redirectHost = "";
        if (referer) {
          try {
            redirectHost = new URL(referer).origin;
          } catch (e) {}
        }
        const combinedState = encodeURIComponent(JSON.stringify({ albumId, redirectHost }));
        const clientId = env.GOOGLE_CLIENT_ID || "";
        const redirectUri = new URL(request.url).origin + "/api/auth/google/callback";
        const scope = "https://www.googleapis.com/auth/photospicker.mediaitems.readonly";
        
        const url = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=${encodeURIComponent(scope)}&access_type=offline&prompt=select_account&state=${combinedState}`;
        return Response.redirect(url, 302);
      }

      // 路由：Google OAuth 回呼
      if (method === "GET" && pathname === "/api/auth/google/callback") {
        const urlObj = new URL(request.url);
        const code = urlObj.searchParams.get("code");
        const rawState = urlObj.searchParams.get("state") || "";
        let albumId = rawState;
        let redirectHost = "";
        try {
          const parsed = JSON.parse(decodeURIComponent(rawState));
          if (parsed && typeof parsed === "object") {
            albumId = parsed.albumId || "";
            redirectHost = parsed.redirectHost || "";
          }
        } catch (e) {}

        if (!code) return new Response("Missing code", { status: 400 });

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

        if (!tokenData.access_token) {
          return new Response(`
            <html><body>
            <h2>Google OAuth Error</h2>
            <pre>${JSON.stringify(tokenData, null, 2)}</pre>
            <p>ClientId: ${clientId}</p>
            </body></html>
          `, { headers: { "Content-Type": "text/html" } });
        }
        
        // 優先使用傳過來的 redirectHost
        let baseFrontEndUrl = redirectHost || "https://didadida-frontend.pages.dev";
        if (!redirectHost && (urlObj.hostname.includes("localhost") || urlObj.hostname.includes("127.0.0.1"))) {
          baseFrontEndUrl = "http://localhost:3000";
        }
        
        const finalUrl = albumId ? `${baseFrontEndUrl}/album?id=${albumId}&googleToken=${tokenData.access_token}` : `${baseFrontEndUrl}/?googleToken=${tokenData.access_token}`;
        
        return Response.redirect(finalUrl, 302);
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

        await env.DB.prepare(
          `INSERT INTO Photo
             (title, file_name, album_id, url, taken_at, exif, file_hash, phash,
              lat, lng, geo_source, taken_at_local, tz_offset_minutes, time_source)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(
          tempPhoto.title, tempPhoto.file_name, tempPhoto.album_id, tempPhoto.url,
          tempPhoto.taken_at, tempPhoto.exif, tempPhoto.file_hash, tempPhoto.phash,
          tempPhoto.lat, tempPhoto.lng, tempPhoto.geo_source,
          tempPhoto.taken_at_local, tempPhoto.tz_offset_minutes, tempPhoto.time_source,
        ).run();

        return new Response(JSON.stringify({ success: true, url: fileUrl }), { headers });
      }

      // 路由：處理照片衝突
      if (method === "POST" && pathname === "/api/google/resolve-conflict") {
        const body = await request.json() as any;
        const { decision, existingPhotos, tempPhoto, replacePhotoIds } = body;

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

        if (decision === "skip") {
          // 刪除暫存在 R2 的新檔案
          await env.BUCKET.delete(tempPhoto.file_name);
        } else if (decision === "replace") {
          // 刪除多個舊檔案
          if (replacePhotoIds && Array.isArray(replacePhotoIds) && replacePhotoIds.length > 0) {
            const filesToDelete: string[] = [];
            const validIds: number[] = [];
            for (const id of replacePhotoIds) {
              const existingPhoto = (existingPhotos || []).find((p: any) => p.id === id);
              if (existingPhoto) {
                filesToDelete.push(existingPhoto.file_name);
                validIds.push(existingPhoto.id);
              }
            }
            if (filesToDelete.length > 0) {
              await env.BUCKET.delete(filesToDelete);
              const placeholders = validIds.map(() => '?').join(',');
              await env.DB.prepare(`DELETE FROM Photo WHERE id IN (${placeholders})`).bind(...validIds).run();
            }
          }
          // 新增新檔案
          await env.DB.prepare(
            `INSERT INTO Photo
               (title, file_name, album_id, url, taken_at, exif, file_hash, phash,
                lat, lng, geo_source, taken_at_local, tz_offset_minutes, time_source)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          ).bind(
            tempPhoto.title, tempPhoto.file_name, tempPhoto.album_id, tempPhoto.url,
            tempPhoto.taken_at, tempPhoto.exif, tempPhoto.file_hash || null, tempPhoto.phash || null,
            tpLat, tpLng, tpGeoSource, tpLocal, tpTz, tpTimeSource,
          ).run();
        } else if (decision === "keep_both") {
          // 修改標題避免混淆
          const count = existingPhotos ? existingPhotos.length : 1;
          const newTitle = tempPhoto.title.replace(/(\.[^.]+)$/, `_new_${count}$1`);
          await env.DB.prepare(
            `INSERT INTO Photo
               (title, file_name, album_id, url, taken_at, exif,
                lat, lng, geo_source, taken_at_local, tz_offset_minutes, time_source)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          ).bind(
            newTitle, tempPhoto.file_name, tempPhoto.album_id, tempPhoto.url,
            tempPhoto.taken_at, tempPhoto.exif,
            tpLat, tpLng, tpGeoSource, tpLocal, tpTz, tpTimeSource,
          ).run();
        }
        return new Response(JSON.stringify({ success: true }), { headers });
      }

      // ===== 足跡地圖 =====

      // 路由：取得足跡點位
      // 時間篩選一律用當地牆上時間 —— 使用者說「3/1 我在京都」指的是當地時間。
      // 舊資料若無 taken_at_local，由 LOCAL_TIME_EXPR 從 taken_at 加時區推回來再比對。
      if (method === "GET" && pathname === "/api/footprint") {
        const isAdmin = await isAuthorized(request, env);
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
                 COALESCE(p.thumb_url, p.url) AS url,
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

        const ph = ids.map(() => "?").join(",");
        const { results: sel } = await env.DB.prepare(`
          SELECT p.id, p.album_id, p.geo_source, ${LOCAL_TIME_EXPR} AS local_time
          FROM Photo p WHERE p.id IN (${ph})
        `).bind(...ids).all();

        const times = (sel as any[]).map(r => r.local_time).filter(Boolean).sort();
        const startLocal = times[0] ?? null;
        const endLocal = times[times.length - 1] ?? null;
        const withExif = (sel as any[]).filter(r => r.geo_source === 'exif').length;
        const albumIds = Array.from(new Set((sel as any[]).map(r => r.album_id)));

        // 落在同一時間範圍、同相簿，卻沒被選到的照片
        let alsoInRange: any[] = [];
        if (startLocal && endLocal && albumIds.length > 0) {
          const aph = albumIds.map(() => "?").join(",");
          const { results } = await env.DB.prepare(`
            SELECT p.id, p.title, COALESCE(p.thumb_url, p.url) AS url, ${LOCAL_TIME_EXPR} AS local_time
            FROM Photo p
            WHERE p.album_id IN (${aph})
              AND p.id NOT IN (${ph})
              AND ${LOCAL_TIME_EXPR} BETWEEN ? AND ?
            ORDER BY local_time ASC
          `).bind(...albumIds, ...ids, startLocal, endLocal).all();
          alsoInRange = results as any[];
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

        const placeName = typeof body.placeName === 'string' ? body.placeName : null;
        const overwriteExif = body.overwriteExif === true;

        const ph = ids.map(() => "?").join(",");
        // 這是使用者親手指定，權威最高，唯一預設不動的是照片自帶的 GPS。
        // 用 IS NOT 而非 != ：後者遇到 geo_source IS NULL 會得到 NULL，
        // 反而把最需要寫入的「還沒定位」那些照片排除掉。
        const guard = overwriteExif ? "" : " AND geo_source IS NOT 'exif'";
        const upd = await env.DB.prepare(`
          UPDATE Photo SET lat = ?, lng = ?, place_name = ?, geo_source = 'manual'
          WHERE id IN (${ph})${guard}
        `).bind(lat, lng, placeName, ...ids).run();

        // 推導時間區段
        const { results: sel } = await env.DB.prepare(`
          SELECT ${LOCAL_TIME_EXPR} AS local_time FROM Photo p WHERE p.id IN (${ph})
        `).bind(...ids).all();
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
          updated: (upd.meta as any)?.changes ?? 0,
          skippedExif: ids.length - ((upd.meta as any)?.changes ?? 0),
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

        await env.DB.batch(items.map((it: { photoId: number; placeName: string }) =>
          env.DB.prepare("UPDATE Photo SET place_name = ? WHERE id = ?").bind(it.placeName, it.photoId)
        ));
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

        const overwriteExif = body?.overwriteExif === true;
        // overwriteExif 只放行 'exif' 這一層；'manual' 是使用者親手指定的，
        // 任何自動流程都不得覆蓋，所以它不在放行範圍內。
        const guard = overwriteExif
          ? " AND geo_source IS NOT 'manual'"
          : geoOverwriteGuard('timeline');

        const stmts: D1PreparedStatement[] = [];
        let invalid = 0;
        for (const m of matches) {
          const id = Number(m?.photoId);
          if (!Number.isFinite(id) || !isValidLatLng(m?.lat, m?.lng)) { invalid++; continue; }
          const place = typeof m.placeName === 'string' ? m.placeName : null;
          const tz = Number.isFinite(m?.tzOffsetMinutes) ? m.tzOffsetMinutes : null;
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
        const value = body?.geoPrivate === 0 || body?.geoPrivate === false ? 0 : 1;
        const ph = ids.map(() => "?").join(",");
        const res = await env.DB.prepare(
          `UPDATE Photo SET geo_private = ? WHERE id IN (${ph})`
        ).bind(value, ...ids).run();
        return new Response(JSON.stringify({ success: true, updated: (res.meta as any)?.changes ?? 0 }), { headers });
      }

      // 路由：切換相簿層級的地圖隱私
      if (method === "PUT" && pathname.startsWith("/api/albums/") && pathname.endsWith("/map-privacy")) {
        const albumId = pathname.split("/")[3];
        const body: any = await request.json();
        const value = body?.mapPrivate === 0 || body?.mapPrivate === false ? 0 : 1;
        await env.DB.prepare("UPDATE Album SET map_private = ? WHERE id = ?").bind(value, albumId).run();
        return new Response(JSON.stringify({ success: true, map_private: value }), { headers });
      }

      // 路由：刪除行程段
      if (method === "DELETE" && pathname.startsWith("/api/trip-segments/")) {
        const segId = pathname.split("/")[3];
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

        const mod = minutesModifier(minutes);
        const ph = ids.map(() => "?").join(",");
        // 一句 UPDATE 做完，不逐張讀回來在 JS 算：D1 免費額度是按寫入列數計費的，
        // 這樣整批只花 ids.length 列。同一句 UPDATE 裡右側取到的都是舊值。
        const res = await env.DB.prepare(`
          UPDATE Photo SET
            taken_at = strftime('%Y-%m-%dT%H:%M:%fZ', taken_at, ?),
            taken_at_local = strftime('%Y-%m-%d %H:%M:%S', taken_at_local, ?),
            time_source = 'manual'
          WHERE id IN (${ph}) AND taken_at IS NOT NULL
        `).bind(mod, mod, ...ids).run();

        const updated = (res.meta as any)?.changes ?? 0;
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

        const tz = body.tzOffsetMinutes;
        const ph = ids.map(() => "?").join(",");
        const res = await env.DB.prepare(`
          UPDATE Photo SET
            tz_offset_minutes = ?,
            taken_at_local = strftime('%Y-%m-%d %H:%M:%S', taken_at, ?)
          WHERE id IN (${ph}) AND taken_at IS NOT NULL
        `).bind(tz, minutesModifier(tz), ...ids).run();

        const updated = (res.meta as any)?.changes ?? 0;
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

        const upstream = await fetchGpxBytes(env.GOOGLE_DRIVE_SA_KEY, fileId);
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
        // 隱私比照 /api/tracks 而不是 /api/tracks/raw：這是從已存的軌跡點
        // 推出來的，沒有比那些點更敏感。私密的日子還是要擋
        if (!(await isAuthorized(request, env)) && !(await isTrackDayPublic(env, dayKey))) {
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
      // 對外可見的條件有兩條，任一成立即可：
      //   1. 這一天被明確標成公開（TrackDay.is_private = 0）
      //   2. 這個瞬間落在某本公開相簿的行程時間窗裡（見 publicTripWindows）
      //
      // 第二條是使用者定的規則「相簿公開就連同軌跡公開」。刻意做在點的層級而不是
      // 整個 day_key：一天裡不屬於那趟行程的時段（例如出發前還在家）不會跟著曝光。
      // 所有 GET 路由都是公開的，所以過濾必須發生在 SQL 裡 —— 只在前端不畫是無效的。
      if (method === "GET" && pathname === "/api/tracks") {
        const isAdmin = await isAuthorized(request, env);
        const conds: string[] = [];
        const binds: any[] = [];

        if (!isAdmin) {
          const windows = await publicTripWindows(env);
          const ors = ["d.is_private = 0"];
          for (const w of windows) {
            ors.push("(p.t_utc >= ? AND p.t_utc <= ?)");
            binds.push(w.from, w.to);
          }
          conds.push(`(${ors.join(" OR ")})`);
        }

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
          // 一定要同時比對 day_key：否則帶著別天的 id 進來就能刪掉任意軌跡點
          const holes = deleteIds.map(() => '?').join(',');
          stmts.push(env.DB.prepare(
            `DELETE FROM TrackPoint WHERE day_key = ? AND id IN (${holes})`
          ).bind(dayKey, ...deleteIds));
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
};
