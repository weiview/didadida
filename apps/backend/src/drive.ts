/**
 * Google Drive 唯讀存取（GPS 軌跡的傳輸層）。
 *
 * 手機上的 GPSLogger 一天寫一個 GPX 檔並就地覆寫同一個檔案，auto-send 到 Drive；
 * 我們用一個唯讀的 service account 讀那個被分享的資料夾。
 *
 * 這裡刻意只做 I/O —— 列檔、拿 bytes。GPX 解析與抽稀都在瀏覽器跑，
 * 因為免費方案的 Worker CPU 上限很緊，把幾千個點的 XML 解析放進來並不划算。
 *
 * service account 沒有自己的 Drive 配額，也只給了唯讀權限，
 * 所以這條路徑不可能寫入或刪除使用者的 Drive 檔案。
 */

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const DRIVE_FILES_URL = 'https://www.googleapis.com/drive/v3/files';
const SCOPE = 'https://www.googleapis.com/auth/drive.readonly';

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

/** 取單一檔案的原始 bytes。交給前端解析，Worker 不碰內容 */
export async function fetchGpxBytes(saKeyJson: string, fileId: string): Promise<Response> {
  const token = await getAccessToken(saKeyJson);
  const res = await fetch(`${DRIVE_FILES_URL}/${encodeURIComponent(fileId)}?alt=media`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Drive 下載失敗 (${res.status})`);
  return res;
}
