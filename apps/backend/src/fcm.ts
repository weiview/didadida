/**
 * Android App 的推播（Firebase Cloud Messaging HTTP v1）。
 *
 * 兩種推播，都從 index.ts 用 `ctx.waitUntil(sendPush(...))` 丟出來 ——
 * **推播失敗絕不影響原本那個請求**（上傳公告、心跳照常回 200）：
 *   - `upload`：有人傳了一批照片／影片（POST /api/uploads/announce）
 *   - `online`：有人離開超過 150 秒又回來（GET /api/presence 的條件式 UPDATE）
 *
 * ⚠️ 一律送 **data-only** 訊息（不帶 `notification` 區塊）：通知長什麼樣、
 *    App 開在前景時要不要跳、點下去開哪一本相簿，全由 App 的 PushService 決定。
 *    帶了 `notification` 的話 App 在背景時由系統直接畫，那些判斷一個都做不了。
 * ⚠️ HTTP v1 **沒有 multicast**，一支手機一個請求。一個家就幾支手機，
 *    `MAX_TOKENS` 只是保險絲（Workers 免費版單次上限 50 個 subrequest）。
 * ⚠️ access token 的快取**不能跟 drive.ts 共用** —— 那一份是綁 Drive scope 的，
 *    拿去打 FCM 會 403。所以金鑰解析那幾行在這裡另外一份（很短，不值得抽共用）。
 */

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const MAX_TOKENS = 40;

export interface PushEnv {
  DB: D1Database;
  /** 有 Firebase 專屬的 SA 就用它，沒有就退回 Drive 那一把（同一個 GCP 專案時可以共用） */
  FCM_SA_KEY?: string;
  GOOGLE_DRIVE_SA_KEY?: string;
  /** Firebase 專案 id。沒設就用金鑰裡的 `project_id` */
  FCM_PROJECT_ID?: string;
}

interface SaKey { client_email: string; private_key: string; project_id?: string }

function b64url(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
const b64urlStr = (s: string) => b64url(new TextEncoder().encode(s));

function pemToDer(pem: string): ArrayBuffer {
  const body = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '')
    .replace(/\s+/g, '');
  const raw = atob(body);
  const der = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) der[i] = raw.charCodeAt(i);
  return der.buffer;
}

function parseKey(json: string): SaKey {
  const key = JSON.parse(json);
  if (!key?.client_email || !key?.private_key) throw new Error('FCM 金鑰缺少 client_email 或 private_key');
  return {
    client_email: key.client_email,
    private_key: String(key.private_key).replace(/\\n/g, '\n'),
    project_id: key.project_id,
  };
}

let cachedToken: { value: string; expiresAt: number } | null = null;

async function fcmAccessToken(sa: SaKey): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && cachedToken.expiresAt > now + 60) return cachedToken.value;
  const header = b64urlStr(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64urlStr(JSON.stringify({
    iss: sa.client_email, scope: SCOPE, aud: TOKEN_URL, iat: now, exp: now + 3600,
  }));
  const input = `${header}.${claim}`;
  const key = await crypto.subtle.importKey(
    'pkcs8', pemToDer(sa.private_key), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign'],
  );
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(input));
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${input}.${b64url(sig)}`,
    }),
  });
  if (!res.ok) throw new Error(`FCM 授權失敗 (${res.status})`);
  const data: any = await res.json();
  if (!data?.access_token) throw new Error('FCM 授權回應沒有 access_token');
  cachedToken = { value: data.access_token, expiresAt: now + (Number(data.expires_in) || 3600) };
  return cachedToken.value;
}

/**
 * 推給「除了 `excludeUid` 以外、所有沒被停權的成員」的每一支手機。
 * `data` 的值一律要是字串（FCM 的規定）。
 *
 * 沒設金鑰、沒有任何裝置 → 安靜地什麼都不做。
 */
export async function sendPush(env: PushEnv, excludeUid: number, data: Record<string, string>): Promise<void> {
  const keyJson = env.FCM_SA_KEY || env.GOOGLE_DRIVE_SA_KEY;
  if (!keyJson) return;
  try {
    const { results } = await env.DB.prepare(
      `SELECT d.token FROM PushDevice d JOIN User u ON u.id = d.user_id
        WHERE u.active = 1 AND d.user_id != ? LIMIT ${MAX_TOKENS}`
    ).bind(excludeUid).all<{ token: string }>();
    const tokens = (results ?? []).map((r) => r.token);
    if (!tokens.length) return;

    const sa = parseKey(keyJson);
    const project = env.FCM_PROJECT_ID || sa.project_id;
    if (!project) { console.error('FCM: 沒有 project id'); return; }
    const access = await fcmAccessToken(sa);
    const endpoint = `https://fcm.googleapis.com/v1/projects/${project}/messages:send`;

    const dead: string[] = [];
    await Promise.all(tokens.map(async (token) => {
      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { Authorization: `Bearer ${access}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            message: {
              token,
              data,
              // 高優先權才叫得醒 Doze 裡的手機；TTL 一小時 —— 過了才送到的「上線囉」是假話
              android: { priority: 'HIGH', ttl: '3600s' },
            },
          }),
        });
        if (res.ok) return;
        const text = await res.text().catch(() => '');
        // App 被移除、資料被清掉：這個 token 再也用不到
        if (res.status === 404 || text.includes('UNREGISTERED')) dead.push(token);
        else console.error('FCM send failed', res.status, text.slice(0, 300));
      } catch (e) {
        console.error('FCM send error', e);
      }
    }));
    if (dead.length) {
      await env.DB.batch(dead.map((t) => env.DB.prepare('DELETE FROM PushDevice WHERE token = ?').bind(t)));
    }
  } catch (e) {
    console.error('sendPush failed', e);
  }
}
