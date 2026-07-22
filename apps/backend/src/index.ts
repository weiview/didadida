import exifr from 'exifr';

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
        
        const { results: photos } = await env.DB.prepare(
          "SELECT * FROM Photo WHERE album_id = ? ORDER BY sort_order ASC, created_at DESC"
        ).bind(albumId).all();
        
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

      // 路由：取得所有標籤
      if (method === "GET" && pathname === "/api/tags") {
        const { results } = await env.DB.prepare("SELECT * FROM Tag ORDER BY name ASC").all();
        return new Response(JSON.stringify(results), { headers });
      }

      // 路由：取得全站所有照片 (含 Tags 與 所屬相簿名稱)
      if (method === "GET" && pathname === "/api/all-photos") {
        const { results: photos } = await env.DB.prepare(`
          SELECT p.*, a.name as album_name 
          FROM Photo p 
          LEFT JOIN Album a ON p.album_id = a.id 
          ORDER BY p.taken_at DESC, p.created_at DESC
        `).all();

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

      // 路由：處理 R2 照片上傳
      if (method === "POST" && pathname === "/api/upload") {
        const formData = await request.formData();
        const file = formData.get('file') as File;
        const thumb = formData.get('thumb') as File | null;
        const albumId = formData.get('album_id') as string;
        const exifData = formData.get('exif') as string || null;
        const takenAt = formData.get('taken_at') as string || null;
        
        if (!file || !albumId) {
          return new Response(JSON.stringify({ error: "File and album_id are required" }), { status: 400, headers });
        }
        
        const allowedTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic'];
        if (!allowedTypes.includes(file.type.toLowerCase())) {
          return new Response(JSON.stringify({ error: "Invalid file type. Only images are allowed." }), { status: 400, headers });
        }
        
        const fileName = `${Date.now()}_${file.name.replace(/[^a-zA-Z0-9.-]/g, '_')}`;
        await env.BUCKET.put(fileName, file.stream(), {
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
        
        await env.DB.prepare(
          "INSERT INTO Photo (title, file_name, album_id, url, thumb_url, exif, taken_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
        ).bind(file.name, fileName, albumId, fileUrl, thumbUrl, exifData, takenAt).run();
        
        return new Response(JSON.stringify({ success: true, url: fileUrl, thumb_url: thumbUrl }), { headers });
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
        return new Response(JSON.stringify({ success: true }), { headers });
      }

      // 路由：Google OAuth 登入跳轉
      if (method === "GET" && pathname === "/api/auth/google/login") {
        const urlObj = new URL(request.url);
        const stateParam = urlObj.searchParams.get("state") || "";
        const clientId = env.GOOGLE_CLIENT_ID;
        const redirectUri = new URL(request.url).origin + "/api/auth/google/callback";
        const scope = "https://www.googleapis.com/auth/photospicker.mediaitems.readonly";
        
        const url = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=${encodeURIComponent(scope)}&access_type=offline&prompt=consent&state=${stateParam}`;
        return Response.redirect(url, 302);
      }

      // 路由：Google OAuth 回呼
      if (method === "GET" && pathname === "/api/auth/google/callback") {
        const urlObj = new URL(request.url);
        const code = urlObj.searchParams.get("code");
        const state = urlObj.searchParams.get("state") || "";
        if (!code) return new Response("Missing code", { status: 400 });

        const clientId = env.GOOGLE_CLIENT_ID;
        const clientSecret = env.GOOGLE_CLIENT_SECRET;
        const redirectUri = new URL(request.url).origin + "/api/auth/google/callback";

        const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            client_id: clientId || "",
            client_secret: clientSecret || "",
            code: code,
            grant_type: "authorization_code",
            redirect_uri: redirectUri
          }).toString()
        });
        
        const tokenData = await tokenRes.json() as any;
        
        if (!tokenData.access_token) {
          return new Response(`
            <html><body>
            <h2>Google OAuth Error</h2>
            <pre>${JSON.stringify(tokenData, null, 2)}</pre>
            <p>ClientId: ${clientId}</p>
            </body></html>
          `, { headers: { "Content-Type": "text/html" } });
        }
        
        const isLocal = urlObj.hostname.includes("localhost") || urlObj.hostname.includes("127.0.0.1");
        const baseFrontEndUrl = isLocal ? "http://localhost:3000" : "https://didadida-frontend.pages.dev";
        const finalUrl = state ? `${baseFrontEndUrl}/album?id=${state}&googleToken=${tokenData.access_token}` : `${baseFrontEndUrl}/?googleToken=${tokenData.access_token}`;
        
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
        
        if (!statusData.mediaItemsSet) {
          return new Response(JSON.stringify({ ready: false }), { headers });
        }
        
        // 2. 如果使用者選完了，就去抓照片清單
        const itemsRes = await fetch(`https://photospicker.googleapis.com/v1/mediaItems?sessionId=${sessionId}`, {
          headers: { Authorization: `Bearer ${googleToken}` }
        });
        const itemsData = await itemsRes.json();
        return new Response(JSON.stringify({ ready: true, mediaItems: itemsData.mediaItems || [] }), { headers });
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
        const { targetAlbumId, googlePhotoUrl, filename, creationTime, exif } = body;
        
        const googleToken = request.headers.get("X-Google-Token");
        
        if (!googlePhotoUrl) {
          console.error("400 Bad Request - Missing googlePhotoUrl. Body received:", body);
          return new Response(JSON.stringify({ error: "Missing googlePhotoUrl" }), { status: 400, headers });
        }
        
        // 取得照片原始檔案 (Picker API 的 baseUrl 加上 =d 來下載原始解析度，而且必須帶有 Authorization token)
        const fetchPhotoRes = await fetch(googlePhotoUrl + "=d", {
          headers: {
            "Authorization": `Bearer ${googleToken}`
          }
        });
        if (!fetchPhotoRes.ok) {
          const errText = await fetchPhotoRes.text();
          console.error("下載照片失敗:", fetchPhotoRes.status, errText);
          return new Response(JSON.stringify({ error: "Download failed" }), { status: 500, headers });
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
        
        // 檢查是否已存在同名檔案 (包含 _new 後綴)
        const existingPhotosResult = await env.DB.prepare(
          "SELECT * FROM Photo WHERE album_id = ? AND (title = ? OR title LIKE ?)"
        ).bind(targetAlbumId, finalTitle, `${baseName}_new%${ext}`).all();
        
        const existingPhotos = existingPhotosResult.results;
        
        const arrayBuffer = await fetchPhotoRes.arrayBuffer();
        
        let parsedExif = exif;
        let finalTakenAt = creationTime;
        try {
          // 在後端直接解析 EXIF
          const rawExif = await exifr.parse(arrayBuffer, { tiff: true, ifd0: true, exif: true });
          if (rawExif) {
            parsedExif = {
              Make: rawExif.Make || (exif ? exif.Make : undefined),
              Model: rawExif.Model || (exif ? exif.Model : undefined),
              FocalLength: rawExif.FocalLength || (exif ? exif.FocalLength : undefined),
              FNumber: rawExif.FNumber || (exif ? exif.FNumber : undefined),
              ISO: rawExif.ISO || (exif ? exif.ISO : undefined),
              ExposureTime: rawExif.ExposureTime || (exif ? exif.ExposureTime : undefined),
              DateTimeOriginal: rawExif.DateTimeOriginal || (exif ? exif.DateTimeOriginal : undefined)
            };
            if (rawExif.DateTimeOriginal) {
              finalTakenAt = new Date(rawExif.DateTimeOriginal).toISOString();
            }
          }
        } catch (err) {
          console.error("Exif parsing error in backend", err);
        }

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
          exif: finalExif
        };

        if (existingPhotos && existingPhotos.length > 0) {
          return new Response(JSON.stringify({ conflict: true, existingPhotos, tempPhoto }), { headers });
        }
        
        await env.DB.prepare(
          "INSERT INTO Photo (title, file_name, album_id, url, taken_at, exif) VALUES (?, ?, ?, ?, ?, ?)"
        ).bind(tempPhoto.title, tempPhoto.file_name, tempPhoto.album_id, tempPhoto.url, tempPhoto.taken_at, tempPhoto.exif).run();
        
        return new Response(JSON.stringify({ success: true, url: fileUrl }), { headers });
      }

      // 路由：處理照片衝突
      if (method === "POST" && pathname === "/api/google/resolve-conflict") {
        const body = await request.json() as any;
        const { decision, existingPhotos, tempPhoto, replacePhotoIds } = body;
        
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
            "INSERT INTO Photo (title, file_name, album_id, url, taken_at, exif) VALUES (?, ?, ?, ?, ?, ?)"
          ).bind(tempPhoto.title, tempPhoto.file_name, tempPhoto.album_id, tempPhoto.url, tempPhoto.taken_at, tempPhoto.exif).run();
        } else if (decision === "keep_both") {
          // 修改標題避免混淆
          const count = existingPhotos ? existingPhotos.length : 1;
          const newTitle = tempPhoto.title.replace(/(\.[^.]+)$/, `_new_${count}$1`);
          await env.DB.prepare(
            "INSERT INTO Photo (title, file_name, album_id, url, taken_at, exif) VALUES (?, ?, ?, ?, ?, ?)"
          ).bind(newTitle, tempPhoto.file_name, tempPhoto.album_id, tempPhoto.url, tempPhoto.taken_at, tempPhoto.exif).run();
        }
        return new Response(JSON.stringify({ success: true }), { headers });
      }

      return new Response(JSON.stringify({ error: "Not Found" }), { status: 404, headers });
    } catch (error: any) {
      console.error("API Error: ", error.message, error.stack);
      return new Response(JSON.stringify({ error: error.message }), { status: 500, headers });
    }
  },
};
