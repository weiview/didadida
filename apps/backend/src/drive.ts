/**
 * Google Drive 存取層。兩種用途共用同一個 service account：
 *
 *   1. GPS 軌跡（唯讀）—— 手機上的 GPSLogger 一天寫一個 GPX 檔並就地覆寫同一個
 *      檔案，auto-send 到 Drive；我們讀那個被分享的資料夾。
 *   2. 照片主檔（讀 + 搬）—— 燈箱代理 4K WebP，刪照片時把 Drive 檔搬進
 *      `didadida/trash/`。
 *
 * 這裡刻意只做 I/O —— 列檔、拿 bytes、改 parents。GPX 解析與抽稀都在瀏覽器跑，
 * 因為免費方案的 Worker CPU 上限很緊，把幾千個點的 XML 解析放進來並不划算。
 *
 * ⚠️ scope 是完整的 `drive`（Phase 3 要搬檔，`drive.readonly` 做不到）。
 *    **實際能碰什麼由 Drive 的 ACL 決定，不是由 scope 決定** —— GPSLogger 的資料夾
 *    只分享 Viewer 給這個 SA，所以軌跡檔仍然改不了也刪不掉；只有 `didadida/`
 *    分享了 Editor。scope 放寬但 ACL 收緊，是這裡唯一的安全邊界。
 *
 * ⚠️ 這裡永遠不呼叫 `files.delete`。刪照片是「搬進 trash 資料夾」，
 *    使用者的 Drive 上不會有東西真的消失。
 *
 * service account 沒有自己的儲存配額，**不能建檔**。上傳走瀏覽器端本人帳號
 * （見 frontend/src/lib/drive.ts）。
 */

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const DRIVE_FILES_URL = 'https://www.googleapis.com/drive/v3/files';
const SCOPE = 'https://www.googleapis.com/auth/drive';

export interface DriveFile {
  id: string;
  name: string;
  /** 內容雜湊。用它判斷要不要重抓，不要用 modifiedTime —— 見下方 listGpxFiles 註解 */
  md5Checksum?: string;
  modifiedTime?: string;
  size?: string;
}

interface ServiceAccountKey {
  client_email: string;
  private_key: string;
}

const b64url = (buf: ArrayBuffer): string =>
  btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const b64urlStr = (s: string): string =>
  btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** PEM (PKCS#8) → DER bytes */
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

function parseKey(json: string): ServiceAccountKey {
  const key = JSON.parse(json);
  if (!key?.client_email || !key?.private_key) {
    throw new Error('service account 金鑰缺少 client_email 或 private_key');
  }
  // wrangler secret 經過 shell 之後換行常常變成字面上的 \n，這裡一律還原
  return { client_email: key.client_email, private_key: String(key.private_key).replace(/\\n/g, '\n') };
}

/**
 * SA 的帳號位址。網頁建完 `didadida/` 之後要把它加成 writer，才輪得到後端讀得到
 * 裡面的檔案 —— 那一步在瀏覽器跑，所以這個位址得傳給前端。
 *
 * 不是機密：它就是個 `...@....iam.gserviceaccount.com`，光有位址什麼也做不了，
 * 能做事的是同一份 JSON 裡的 private_key（那個絕對不出 Worker）。
 */
export function serviceAccountEmail(saKeyJson: string): string {
  return parseKey(saKeyJson).client_email;
}

// access token 有效一小時。isolate 活著的期間重用，省掉每次同步都跑一次 RSA 簽章與往返。
// isolate 被回收就跟著沒了，那也只是重簽一次，沒有正確性問題。
let cachedToken: { value: string; expiresAt: number } | null = null;

async function getAccessToken(saKeyJson: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  // 留 60 秒餘裕，避免拿到一個正好在路上過期的 token
  if (cachedToken && cachedToken.expiresAt > now + 60) return cachedToken.value;

  const sa = parseKey(saKeyJson);
  const header = b64urlStr(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64urlStr(JSON.stringify({
    iss: sa.client_email,
    scope: SCOPE,
    aud: TOKEN_URL,
    iat: now,
    exp: now + 3600,
  }));
  const signingInput = `${header}.${claim}`;

  const key = await crypto.subtle.importKey(
    'pkcs8',
    pemToDer(sa.private_key),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key,
    new TextEncoder().encode(signingInput),
  );

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${signingInput}.${b64url(sig)}`,
    }),
  });

  if (!res.ok) {
    // 不要把回應原文往外丟，裡面可能帶著金鑰相關線索
    throw new Error(`Drive 授權失敗 (${res.status})`);
  }
  const data: any = await res.json();
  if (!data?.access_token) throw new Error('Drive 授權回應沒有 access_token');

  cachedToken = { value: data.access_token, expiresAt: now + (Number(data.expires_in) || 3600) };
  return cachedToken.value;
}

/**
 * 列出資料夾裡的 GPX 檔。
 *
 * 只認 .gpx —— GPSLogger 設定頁的「Test upload」會在同一個資料夾留下
 * gpslogger_test.xml，那不是軌跡檔。
 *
 * 回傳的 md5Checksum 才是判斷「要不要重抓」的依據：每次 auto-send 都會更新
 * modifiedTime，即使那段時間人是靜止的、檔案內容一個點都沒變。
 */
export async function listGpxFiles(saKeyJson: string, folderId: string): Promise<DriveFile[]> {
  const token = await getAccessToken(saKeyJson);
  const params = new URLSearchParams({
    q: `'${folderId}' in parents and trashed = false`,
    fields: 'files(id,name,md5Checksum,modifiedTime,size)',
    pageSize: '1000',
    orderBy: 'name',
  });

  const res = await fetch(`${DRIVE_FILES_URL}?${params}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Drive 列檔失敗 (${res.status})`);

  const data: any = await res.json();
  const files: DriveFile[] = Array.isArray(data?.files) ? data.files : [];
  return files.filter((f) => typeof f.name === 'string' && f.name.toLowerCase().endsWith('.gpx'));
}

/**
 * 取單一檔案的原始 bytes。
 *
 * GPX 是交給前端解析（Worker 不碰內容），照片則是直接把這個 Response 的 body
 * 串流給瀏覽器 —— 兩邊都不該把整個檔案讀進 Worker 記憶體。
 */
export async function fetchDriveMedia(saKeyJson: string, fileId: string): Promise<Response> {
  const token = await getAccessToken(saKeyJson);
  const res = await fetch(`${DRIVE_FILES_URL}/${encodeURIComponent(fileId)}?alt=media`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Drive 下載失敗 (${res.status})`);
  return res;
}

/**
 * 把檔案搬到另一個資料夾。刪照片時用它送進 `didadida/trash/`。
 *
 * Drive 沒有「移動」這個動作，只有改 parents，而且 `removeParents` 必須指名
 * 現在的 parent，所以要先 get 一次。整個操作是純 metadata，不動內容、不耗配額。
 *
 * 對 GPSLogger 那個唯讀資料夾裡的檔案呼叫會被 Drive 以 403 擋掉（ACL 只有
 * Viewer），這是刻意的防線 —— 見檔頭。
 */
export async function moveDriveFile(
  saKeyJson: string,
  fileId: string,
  targetFolderId: string,
): Promise<void> {
  const token = await getAccessToken(saKeyJson);
  const auth = { Authorization: `Bearer ${token}` };
  const id = encodeURIComponent(fileId);

  const metaRes = await fetch(`${DRIVE_FILES_URL}/${id}?fields=parents`, { headers: auth });
  if (!metaRes.ok) throw new Error(`Drive 讀取檔案資訊失敗 (${metaRes.status})`);
  const meta: any = await metaRes.json();
  const parents: string[] = Array.isArray(meta?.parents) ? meta.parents : [];

  // 已經在目標資料夾就不用動。重試或重複呼叫時會走到這裡
  if (parents.length === 1 && parents[0] === targetFolderId) return;

  const params = new URLSearchParams({
    addParents: targetFolderId,
    fields: 'id,parents',
  });
  if (parents.length > 0) params.set('removeParents', parents.join(','));

  const res = await fetch(`${DRIVE_FILES_URL}/${id}?${params}`, {
    method: 'PATCH',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: '{}',
  });
  if (!res.ok) throw new Error(`Drive 搬檔失敗 (${res.status})`);
}

/**
 * 改 Drive 資料夾的名字。相簿改名時跟著叫一次，讓備份看起來跟站上一致。
 *
 * **失敗不是問題**，呼叫端該用 `ctx.waitUntil()` 丟出去就好：資料夾 id 存在 D1，
 * 名字只是給人看的。漏改了只是 Drive 上的名字舊了，照片一張也不會找不到。
 *
 * 資料夾是瀏覽器端用使用者本人帳號建的，SA 只是 writer —— writer 改得動名字。
 */
export async function renameDriveFolder(
  saKeyJson: string, folderId: string, name: string,
): Promise<void> {
  const token = await getAccessToken(saKeyJson);
  const res = await fetch(`${DRIVE_FILES_URL}/${encodeURIComponent(folderId)}?fields=id`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) throw new Error(`Drive 資料夾改名失敗 (${res.status})`);
}
