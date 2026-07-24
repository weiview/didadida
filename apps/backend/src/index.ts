import exifr from 'exifr';
import { normalizeGeo, formatWallClock, wallClockFromUtc } from './geo';

export interface Env {
  DB: D1Database;
  BUCKET: R2Bucket;
  APP_PASSWORD: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
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

async function isAuthorized(request: Request, env: Env): Promise<boolean> {
  const authHeader = request.headers.get("Authorization");
  if (!authHeader) return false;
  const token = authHeader.replace("Bearer ", "");
  if (token === env.APP_PASSWORD) return true; // Backward compatibility
  return await verifyJWT(token, env);
}

/**
 * 移除不該對外曝光的座標。
 *
 * 注意：所有 GET 路由都是公開的（只有 POST/PUT/DELETE 需要驗證），所以座標必須在
 * 後端就拿掉 —— 只在前端不繪製地圖是無效的，按 F12 就能從 JSON 看到經緯度。
 * 相簿層級 (map_private) 或照片層級 (geo_private) 任一為私密，就不輸出座標。
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
 * 新資料直接用 taken_at_local；舊資料沒有這欄，就把 taken_at 的 ISO 格式
 * ('2026-03-01T09:30:00.000Z') 截到秒並把 T 換成空白，才能跟行程段做字串比對。
 * 使用此常數的 SQL 必須把 Photo 表別名為 p。
 */
const LOCAL_TIME_EXPR =
  "COALESCE(p.taken_at_local, REPLACE(SUBSTR(p.taken_at, 1, 19), 'T', ' '))";

/** 座標合法性檢查 —— 手動輸入與 API 傳入都要過這關 */
function isValidLatLng(lat: unknown, lng: unknown): boolean {
  return (
    typeof lat === 'number' && Number.isFinite(lat) && Math.abs(lat) <= 90 &&
    typeof lng === 'number' && Number.isFinite(lng) && Math.abs(lng) <= 180
  );
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
        const file = formData.get('file') as File;
        const thumb = formData.get('thumb') as File | null;
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

        await env.DB.prepare(
          `INSERT INTO Photo
             (title, file_name, album_id, url, thumb_url, exif, taken_at, file_hash, phash,
              lat, lng, geo_source, taken_at_local, tz_offset_minutes)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(
          file.name, fileName, albumId, fileUrl, thumbUrl, exifData,
          geo.takenAtUtc || takenAt, fileHash, clientPhash,
          geo.lat, geo.lng, geo.geoSource, geo.takenAtLocal, geo.tzOffsetMinutes,
        ).run();

        return new Response(JSON.stringify({ success: true, url: fileUrl, thumb_url: thumbUrl, file_hash: fileHash }), { headers });
      }

      // 路由：更新照片資訊 (description, taken_at)
      if (method === "PUT" && pathname.startsWith("/api/photos/") && pathname.split("/").length === 4) {
        const photoId = pathname.split("/")[3];
        const body: any = await request.json();
        await env.DB.prepare("UPDATE Photo SET description = ?, taken_at = ? WHERE id = ?")
          .bind(body.description || null, body.taken_at || null, photoId).run();
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
          const rawExif = await exifr.parse(arrayBuffer, { tiff: true, ifd0: true, exif: true, gps: true });
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
          tz_offset_minutes: syncGeo.tzOffsetMinutes
        };

        if (existingPhotos && existingPhotos.length > 0) {
          return new Response(JSON.stringify({ conflict: true, existingPhotos, tempPhoto }), { headers });
        }

        await env.DB.prepare(
          `INSERT INTO Photo
             (title, file_name, album_id, url, taken_at, exif, file_hash, phash,
              lat, lng, geo_source, taken_at_local, tz_offset_minutes)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(
          tempPhoto.title, tempPhoto.file_name, tempPhoto.album_id, tempPhoto.url,
          tempPhoto.taken_at, tempPhoto.exif, tempPhoto.file_hash, tempPhoto.phash,
          tempPhoto.lat, tempPhoto.lng, tempPhoto.geo_source,
          tempPhoto.taken_at_local, tempPhoto.tz_offset_minutes,
        ).run();

        return new Response(JSON.stringify({ success: true, url: fileUrl }), { headers });
      }

      // 路由：處理照片衝突
      if (method === "POST" && pathname === "/api/google/resolve-conflict") {
        const body = await request.json() as any;
        const { decision, existingPhotos, tempPhoto, replacePhotoIds } = body;

        // tempPhoto 是由前端原樣送回來的，座標不能照單全收
        const tpLat = isValidLatLng(tempPhoto?.lat, tempPhoto?.lng) ? tempPhoto.lat : null;
        const tpLng = tpLat === null ? null : tempPhoto.lng;
        const tpGeoSource = tpLat === null ? null : (tempPhoto.geo_source ?? null);
        const tpLocal = typeof tempPhoto?.taken_at_local === 'string' ? tempPhoto.taken_at_local : null;
        const tpTz = Number.isFinite(tempPhoto?.tz_offset_minutes) ? tempPhoto.tz_offset_minutes : null;

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
                lat, lng, geo_source, taken_at_local, tz_offset_minutes)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          ).bind(
            tempPhoto.title, tempPhoto.file_name, tempPhoto.album_id, tempPhoto.url,
            tempPhoto.taken_at, tempPhoto.exif, tempPhoto.file_hash || null, tempPhoto.phash || null,
            tpLat, tpLng, tpGeoSource, tpLocal, tpTz,
          ).run();
        } else if (decision === "keep_both") {
          // 修改標題避免混淆
          const count = existingPhotos ? existingPhotos.length : 1;
          const newTitle = tempPhoto.title.replace(/(\.[^.]+)$/, `_new_${count}$1`);
          await env.DB.prepare(
            `INSERT INTO Photo
               (title, file_name, album_id, url, taken_at, exif,
                lat, lng, geo_source, taken_at_local, tz_offset_minutes)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          ).bind(
            newTitle, tempPhoto.file_name, tempPhoto.album_id, tempPhoto.url,
            tempPhoto.taken_at, tempPhoto.exif,
            tpLat, tpLng, tpGeoSource, tpLocal, tpTz,
          ).run();
        }
        return new Response(JSON.stringify({ success: true }), { headers });
      }

      // ===== 足跡地圖 =====

      // 路由：取得足跡點位
      // 時間篩選一律用當地牆上時間 —— 使用者說「3/1 我在京都」指的是當地時間。
      // 舊資料若無 taken_at_local，就把 taken_at 的 ISO 格式轉成同樣格式再比對。
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
                 ${LOCAL_TIME_EXPR} AS local_time
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
        const ids: number[] = Array.isArray(body?.photoIds) ? body.photoIds.map(Number).filter(Number.isFinite) : [];
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
        const guard = overwriteExif ? "" : " AND (geo_source IS NULL OR geo_source != 'exif')";
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
          stmts.push(env.DB.prepare(
            "UPDATE Photo SET lat = ?, lng = ?, place_name = ?, geo_source = 'manual' WHERE id = ? AND geo_source IS NOT 'exif'"
          ).bind(hit.lat, hit.lng, hit.place_name, p.id));
        }
        if (stmts.length > 0) await env.DB.batch(stmts);

        return new Response(JSON.stringify({ success: true, updated: stmts.length }), { headers });
      }

      // 路由：以時間對無座標照片做線性內插
      // 用途：手機拍的有 GPS、相機拍的沒有，混拍時可自動補上中間那些。
      // 只在前後兩個 exif 錨點的時間差夠近時才內插，否則推論沒有意義。
      if (method === "POST" && pathname === "/api/photos/geo/interpolate") {
        const body: any = await request.json().catch(() => ({}));
        const albumId = Number.isFinite(body?.albumId) ? body.albumId : null;
        const maxGapHours = Number.isFinite(body?.maxGapHours) ? body.maxGapHours : 24;

        const { results: rows } = albumId !== null
          ? await env.DB.prepare(`
              SELECT p.id, p.lat, p.lng, p.geo_source, ${LOCAL_TIME_EXPR} AS local_time
              FROM Photo p WHERE p.album_id = ? ORDER BY local_time ASC
            `).bind(albumId).all()
          : await env.DB.prepare(`
              SELECT p.id, p.lat, p.lng, p.geo_source, ${LOCAL_TIME_EXPR} AS local_time
              FROM Photo p ORDER BY local_time ASC
            `).all();

        const list = (rows as any[]).filter(r => r.local_time);
        const msOf = (s: string) => {
          const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})/);
          return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : NaN;
        };

        const anchors = list
          .map((r, i) => ({ ...r, idx: i, ms: msOf(r.local_time) }))
          .filter(r => r.geo_source === 'exif' && r.lat !== null && Number.isFinite(r.ms));

        const stmts: D1PreparedStatement[] = [];
        for (let a = 0; a < anchors.length - 1; a++) {
          const left = anchors[a];
          const right = anchors[a + 1];
          const spanMs = right.ms - left.ms;
          if (spanMs <= 0 || spanMs > maxGapHours * 3600_000) continue;

          for (let i = left.idx + 1; i < right.idx; i++) {
            const p = list[i];
            if (p.lat !== null) continue; // 已有座標（含手動指定）就不覆蓋
            const ms = msOf(p.local_time);
            if (!Number.isFinite(ms)) continue;
            const t = (ms - left.ms) / spanMs;
            // 註：跨換日線的經度內插會繞遠路，屬已知限制，實務上極少遇到
            const lat = left.lat + (right.lat - left.lat) * t;
            const lng = left.lng + (right.lng - left.lng) * t;
            stmts.push(env.DB.prepare(
              "UPDATE Photo SET lat = ?, lng = ?, geo_source = 'interpolated' WHERE id = ?"
            ).bind(lat, lng, p.id));
          }
        }
        if (stmts.length > 0) await env.DB.batch(stmts);

        return new Response(JSON.stringify({ success: true, updated: stmts.length, anchors: anchors.length }), { headers });
      }

      // 路由：批次切換照片層級的位置隱私
      if (method === "PUT" && pathname === "/api/photos/geo/privacy") {
        const body: any = await request.json();
        const ids: number[] = Array.isArray(body?.photoIds) ? body.photoIds.map(Number).filter(Number.isFinite) : [];
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

      // 路由：回填舊資料的 taken_at_local
      // 舊照片的 taken_at 是用瀏覽器時區解讀出來的，時區資訊已經遺失，
      // 只能由呼叫端指定一個預設偏移來還原牆上時間。
      if (method === "POST" && pathname === "/api/photos/geo/backfill-local-time") {
        const body: any = await request.json().catch(() => ({}));
        const defaultOffset = Number.isFinite(body?.defaultOffsetMinutes) ? body.defaultOffsetMinutes : 0;

        const { results } = await env.DB.prepare(
          "SELECT id, taken_at, tz_offset_minutes FROM Photo WHERE taken_at_local IS NULL AND taken_at IS NOT NULL"
        ).all();

        const stmts: D1PreparedStatement[] = [];
        for (const r of results as any[]) {
          const ms = Date.parse(r.taken_at);
          if (!Number.isFinite(ms)) continue;
          const off = Number.isFinite(r.tz_offset_minutes) ? r.tz_offset_minutes : defaultOffset;
          const local = formatWallClock(wallClockFromUtc(ms, off));
          stmts.push(env.DB.prepare(
            "UPDATE Photo SET taken_at_local = ?, tz_offset_minutes = COALESCE(tz_offset_minutes, ?) WHERE id = ?"
          ).bind(local, off, r.id));
        }
        if (stmts.length > 0) {
          // D1 batch 有大小上限，分批送
          for (let i = 0; i < stmts.length; i += 100) {
            await env.DB.batch(stmts.slice(i, i + 100));
          }
        }
        return new Response(JSON.stringify({ success: true, updated: stmts.length }), { headers });
      }

      return new Response(JSON.stringify({ error: "Not Found" }), { status: 404, headers });
    } catch (error: any) {
      console.error("API Error: ", error.message, error.stack);
      return new Response(JSON.stringify({ error: error.message }), { status: 500, headers });
    }
  },
};
