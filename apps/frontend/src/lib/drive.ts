/**
 * 瀏覽器端的 Google Drive 存取。
 *
 * 為什麼上傳要在瀏覽器做，而不是像其他事情一樣丟給 Worker：
 * **service account 沒有自己的儲存配額，建不了檔。** 檔案必須由使用者本人的
 * Google 帳號建立。順帶的好處是 5 MB 的原始檔不必灌過 Worker 一趟。
 * 建完之後只把 file id 回報給後端（見 recordPhotoDrive）。
 *
 * 授權用 Google Identity Services 的 token client（彈出視窗），不是沿用
 * `/api/auth/google/login` 那條整頁跳轉 —— 跳轉會把使用者選好的檔案清單弄丟。
 * 拿到的是 1 小時的 access token，沒有 refresh token，所以也就沒有
 * 「同意畫面還在 Testing → refresh token 7 天過期」那個問題。
 *
 * ⚠️ scope 是 `drive.file`：**per-file 授權，只看得到這個 app 自己建的檔案**。
 *    這也是為什麼 `didadida/` 一定要由網頁自己建 —— 指定一個使用者手動建的
 *    資料夾當 parent，Drive 會回 404，因為 app 根本看不見它。
 *
 * 換 NAS 的時候只有這個檔和 backend/src/drive.ts 要改。
 */

import { fetchDriveConfig, saveDriveFolders } from './api';

const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const GIS_SRC = 'https://accounts.google.com/gsi/client';
const DRIVE_FILES = 'https://www.googleapis.com/drive/v3/files';
const DRIVE_UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const ROOT_FOLDER_NAME = 'didadida';
const TRASH_FOLDER_NAME = 'trash';

interface TokenResponse {
  access_token?: string;
  expires_in?: number;
  error?: string;
}

interface TokenClient {
  requestAccessToken: (overrides?: { prompt?: string }) => void;
  callback: (res: TokenResponse) => void;
}

declare global {
  interface Window {
    google?: {
      accounts?: {
        oauth2?: {
          initTokenClient: (cfg: {
            client_id: string;
            scope: string;
            callback: (res: TokenResponse) => void;
            error_callback?: (err: unknown) => void;
          }) => TokenClient;
        };
      };
    };
  }
}

let gisPromise: Promise<void> | null = null;

function loadGis(): Promise<void> {
  if (window.google?.accounts?.oauth2) return Promise.resolve();
  if (gisPromise) return gisPromise;

  gisPromise = new Promise<void>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = GIS_SRC;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => {
      // 失敗就把 promise 清掉，下次再試。留著一個 rejected promise 會讓
      // 之後每一次呼叫都直接失敗，即使只是一時的網路問題
      gisPromise = null;
      reject(new Error('載入 Google 授權元件失敗'));
    };
    document.head.appendChild(script);
  });
  return gisPromise;
}

// token 只放在記憶體。上傳是一次頁面工作階段內的事，沒必要留到 sessionStorage 去
let cachedToken: { value: string; expiresAt: number } | null = null;
let tokenClient: TokenClient | null = null;

/**
 * 取得 drive.file 的 access token，必要時彈出 Google 的授權視窗。
 *
 * 第一次會要使用者選帳號並同意；之後只要 Google 那邊的登入還在，
 * 同一個工作階段內續期不會再打擾（GIS 自己處理）。
 *
 * ⚠️ 一定要由使用者的點擊直接觸發，否則彈出視窗會被瀏覽器擋掉。
 */
export async function getDriveToken(clientId: string): Promise<string> {
  const now = Date.now();
  // 留 60 秒餘裕，免得拿到一個正好在上傳途中過期的 token
  if (cachedToken && cachedToken.expiresAt > now + 60_000) return cachedToken.value;

  await loadGis();
  const oauth2 = window.google?.accounts?.oauth2;
  if (!oauth2) throw new Error('Google 授權元件沒有就緒');

  return new Promise<string>((resolve, reject) => {
    if (!tokenClient) {
      tokenClient = oauth2.initTokenClient({
        client_id: clientId,
        scope: SCOPE,
        // callback 每次 requestAccessToken 都會被叫到，所以下面每次都重新指派
        callback: () => {},
        error_callback: (err) => reject(err instanceof Error ? err : new Error('Google 授權被取消或失敗')),
      });
    }
    tokenClient.callback = (res) => {
      if (!res.access_token) {
        reject(new Error(res.error || 'Google 沒有回傳 access token'));
        return;
      }
      cachedToken = {
        value: res.access_token,
        expiresAt: Date.now() + (Number(res.expires_in) || 3600) * 1000,
      };
      resolve(res.access_token);
    };
    tokenClient.requestAccessToken();
  });
}

async function driveJson(token: string, url: string, init?: RequestInit): Promise<any> {
  const res = await fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...(init?.headers || {}) },
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Drive API ${res.status}: ${detail.slice(0, 200)}`);
  }
  return res.json();
}

/** 找這個 app 自己建過的資料夾。drive.file 之下 files.list 本來就只看得到自建的檔 */
async function findOwnFolder(token: string, name: string, parentId?: string): Promise<string | null> {
  const clauses = [
    `name = '${name.replace(/'/g, "\\'")}'`,
    `mimeType = '${FOLDER_MIME}'`,
    'trashed = false',
  ];
  if (parentId) clauses.push(`'${parentId}' in parents`);
  const params = new URLSearchParams({ q: clauses.join(' and '), fields: 'files(id)', pageSize: '1' });
  const data = await driveJson(token, `${DRIVE_FILES}?${params}`);
  return data?.files?.[0]?.id ?? null;
}

async function createFolder(token: string, name: string, parentId?: string): Promise<string> {
  const data = await driveJson(token, `${DRIVE_FILES}?fields=id`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name,
      mimeType: FOLDER_MIME,
      ...(parentId ? { parents: [parentId] } : {}),
    }),
  });
  if (!data?.id) throw new Error(`建立 Drive 資料夾「${name}」失敗`);
  return data.id;
}

async function shareWithServiceAccount(token: string, folderId: string, saEmail: string): Promise<void> {
  // sendNotificationEmail=false 是必要的：service account 的信箱收不了信，
  // 帶著通知寄過去 Drive 會直接回錯誤，整個 bootstrap 就卡在這裡
  const params = new URLSearchParams({ sendNotificationEmail: 'false', fields: 'id' });
  await driveJson(token, `${DRIVE_FILES}/${folderId}/permissions?${params}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role: 'writer', type: 'user', emailAddress: saEmail }),
  });
}

export interface DriveFolders {
  photosFolderId: string;
  trashFolderId: string;
}

/**
 * 確保 `didadida/` 與 `didadida/trash/` 存在、已分享給 service account，
 * 而且 id 已經存進後端。整個流程只有第一次上傳會真的跑。
 *
 * 每一步都先找再建：中途失敗（例如分享那步斷掉）再跑一次不會生出第二個資料夾。
 * 兩個分頁同時第一次上傳理論上還是可能各建一個，後端的 409 會擋掉後到的那個，
 * 代價是 Drive 上多一個空資料夾 —— 罕見而且無害，不值得為它上鎖。
 */
export async function ensureDriveFolders(): Promise<DriveFolders & { token: string }> {
  const config = await fetchDriveConfig();
  if (!config) throw new Error('拿不到 Drive 設定');
  if (!config.client_id) throw new Error('後端沒有設定 GOOGLE_CLIENT_ID');
  if (!config.sa_email) throw new Error('後端沒有設定 GOOGLE_DRIVE_SA_KEY');

  const token = await getDriveToken(config.client_id);

  if (config.photos_folder_id && config.trash_folder_id) {
    return {
      photosFolderId: config.photos_folder_id,
      trashFolderId: config.trash_folder_id,
      token,
    };
  }

  const photosFolderId =
    (await findOwnFolder(token, ROOT_FOLDER_NAME)) ?? (await createFolder(token, ROOT_FOLDER_NAME));
  const trashFolderId =
    (await findOwnFolder(token, TRASH_FOLDER_NAME, photosFolderId))
    ?? (await createFolder(token, TRASH_FOLDER_NAME, photosFolderId));

  // trash 是 didadida 的子資料夾，分享根目錄就一起涵蓋了。
  // 重複分享同一個人 Drive 會回錯，所以吞掉 —— 已經分享過就是我們要的狀態
  try {
    await shareWithServiceAccount(token, photosFolderId, config.sa_email);
  } catch (e) {
    console.warn('分享資料夾給 service account 失敗（可能本來就分享過了）', e);
  }

  await saveDriveFolders(photosFolderId, trashFolderId);
  return { photosFolderId, trashFolderId, token };
}

/**
 * 把一個 blob 建成 Drive 上的檔案，回傳 file id。
 *
 * 用 multipart 而不是 resumable：這裡最大的檔是相機原始檔，幾 MB 而已，
 * resumable 要多一趟往返去開工作階段，對這個大小不划算。
 */
export async function uploadToDrive(
  token: string,
  blob: Blob,
  name: string,
  folderId: string,
): Promise<string> {
  const metadata = { name, parents: [folderId] };
  const form = new FormData();
  form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
  form.append('file', blob);

  const res = await fetch(`${DRIVE_UPLOAD}?uploadType=multipart&fields=id`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Drive 上傳失敗 ${res.status}: ${detail.slice(0, 200)}`);
  }
  const data = await res.json();
  if (!data?.id) throw new Error('Drive 上傳沒有回傳 file id');
  return data.id;
}
