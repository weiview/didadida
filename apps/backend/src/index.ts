export interface Env {
  DB: D1Database;
  BUCKET: R2Bucket;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const { pathname, method } = url;

    // CORS Headers
    const headers = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Content-Type": "application/json",
    };

    if (method === "OPTIONS") {
      return new Response(null, { headers });
    }

    try {
      // 路由：取得所有相簿
      if (method === "GET" && pathname === "/api/albums") {
        const { results } = await env.DB.prepare("SELECT * FROM Album ORDER BY created_at DESC").all();
        return new Response(JSON.stringify(results), { headers });
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

      // 路由：處理 R2 照片上傳 (範例)
      if (method === "POST" && pathname === "/api/upload") {
        // 取得上傳的檔案
        // const formData = await request.formData();
        // const file = formData.get('file') as File;
        // await env.BUCKET.put(file.name, file.stream());
        // 寫入 D1 資料庫邏輯...
        return new Response(JSON.stringify({ message: "Upload success" }), { headers });
      }

      // 404 Not Found
      return new Response(JSON.stringify({ error: "Not Found" }), { status: 404, headers });
    } catch (error: any) {
      return new Response(JSON.stringify({ error: error.message }), { status: 500, headers });
    }
  },
};
