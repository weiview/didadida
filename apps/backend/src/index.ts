export interface Env {
  DB: D1Database;
  BUCKET: R2Bucket;
  APP_PASSWORD: string;
}

function isAuthorized(request: Request, env: Env): boolean {
  const authHeader = request.headers.get("Authorization");
  if (!authHeader) return false;
  const token = authHeader.replace("Bearer ", "");
  return token === env.APP_PASSWORD;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const pathname = url.pathname;
    const method = request.method;

    // CORS Headers
    const headers = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Content-Type": "application/json",
    };

    if (method === "OPTIONS") {
      return new Response(null, { headers });
    }

    try {
      // 路由：驗證密碼
      if (method === "POST" && pathname === "/api/verify-password") {
        const body: { password: string } = await request.json();
        if (body.password === env.APP_PASSWORD) {
          return new Response(JSON.stringify({ success: true }), { headers });
        }
        return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers });
      }

      // 路由：取得所有相簿
      if (method === "GET" && pathname === "/api/albums") {
        const { results } = await env.DB.prepare("SELECT * FROM Album ORDER BY sort_order ASC, created_at DESC").all();
        return new Response(JSON.stringify(results), { headers });
      }

      // 以下路由需要驗證
      const requiresAuth = ["POST", "PUT", "DELETE"].includes(method);
      if (requiresAuth && !isAuthorized(request, env)) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers });
      }

      // 路由：重新排序相簿
      if (method === "PUT" && pathname === "/api/albums/reorder") {
        const body: { id: number; sort_order: number }[] = await request.json();
        
        const statements = body.map(item => 
          env.DB.prepare("UPDATE Album SET sort_order = ? WHERE id = ?").bind(item.sort_order, item.id)
        );
        
        if (statements.length > 0) {
          await env.DB.batch(statements);
        }
        
        return new Response(JSON.stringify({ success: true }), { headers });
      }

      // 路由：新增相簿
      if (method === "POST" && pathname === "/api/albums") {
        const body: any = await request.json();
        if (!body.name) {
          return new Response(JSON.stringify({ error: "Name is required" }), { status: 400, headers });
        }
        
        await env.DB.prepare("INSERT OR IGNORE INTO User (id, name, email) VALUES (1, 'Admin', 'admin@didadida.com')").run();

        const { success } = await env.DB.prepare(
          "INSERT INTO Album (name, description, user_id) VALUES (?, ?, 1)"
        ).bind(body.name, body.description || null).run();
        
        if (success) {
          return new Response(JSON.stringify({ success: true }), { headers });
        }
        return new Response(JSON.stringify({ error: "Failed to insert" }), { status: 500, headers });
      }

      // 路由：取得特定相簿的照片
      if (method === "GET" && pathname.startsWith("/api/albums/") && pathname.endsWith("/photos")) {
        const parts = pathname.split("/");
        const albumId = parts[3];
        
        const { results } = await env.DB.prepare(
          "SELECT * FROM Photo WHERE album_id = ? ORDER BY created_at DESC"
        ).bind(albumId).all();
        
        return new Response(JSON.stringify(results), { headers });
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

      // 路由：處理 R2 照片上傳
      if (method === "POST" && pathname === "/api/upload") {
        const formData = await request.formData();
        const file = formData.get('file') as File;
        const albumId = formData.get('album_id') as string;
        
        if (!file || !albumId) {
          return new Response(JSON.stringify({ error: "File and album_id are required" }), { status: 400, headers });
        }
        
        const fileName = `${Date.now()}_${file.name}`;
        await env.BUCKET.put(fileName, file.stream(), {
          httpMetadata: { contentType: file.type }
        });
        
        const host = new URL(request.url).origin;
        const fileUrl = `${host}/api/photos/view/${encodeURIComponent(fileName)}`;
        
        await env.DB.prepare(
          "INSERT INTO Photo (title, file_name, album_id, url) VALUES (?, ?, ?, ?)"
        ).bind(file.name, fileName, albumId, fileUrl).run();
        
        return new Response(JSON.stringify({ success: true, url: fileUrl }), { headers });
      }

      // 路由：刪除照片
      if (method === "DELETE" && pathname.startsWith("/api/photos/")) {
        const photoId = pathname.split("/")[3];
        
        const photo = await env.DB.prepare("SELECT file_name FROM Photo WHERE id = ?").bind(photoId).first();
        if (!photo) {
          return new Response(JSON.stringify({ error: "Photo not found" }), { status: 404, headers });
        }
        
        await env.BUCKET.delete(photo.file_name as string);
        await env.DB.prepare("DELETE FROM Photo WHERE id = ?").bind(photoId).run();
        
        return new Response(JSON.stringify({ success: true }), { headers });
      }

      return new Response(JSON.stringify({ error: "Not Found" }), { status: 404, headers });
    } catch (error: any) {
      return new Response(JSON.stringify({ error: error.message }), { status: 500, headers });
    }
  },
};
