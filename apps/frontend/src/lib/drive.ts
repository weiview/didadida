/**
 * 瀏覽器端的 Google Drive 存取。
 *
 * 為什麼上傳要在瀏覽器做，而不是像其他事情一樣丟給 Worker：
 * **service account 沒有自己的儲存配額，建不了檔。** 檔案必須由使用者本人的
 * Google 帳號建立。順帶的好處是 5 MB 的原始檔不必灌過 Worker 一趟。
 * 建完之後只把 file id 回報給後端（見 recordPhotoDrive）。
 *
 * **這裡不做授權。** token 是管理員登入時就拿到的（`/api/auth/google/login`
 * 一次要齊 `openid email` + `drive.file` + `photospicker`），存在 localStorage，
 * 這個檔只負責拿來用。所以沒有「連結 Google Drive」這個步驟 —— 登入即已連結。
 *
 * 早期版本用 GIS token client（彈出視窗）自己要授權，那條路有兩個治不好的毛病：
 * 彈窗要「短暫啟用狀態」才開得起來（所以不能在選完檔案之後才要授權），
 * 而且 token 只能放記憶體、重整就沒了（所以每個工作階段的第一批照片必然沒備份）。
 * 改成登入時一起拿之後兩個問題同時消失。
 *
 * 拿到的是 1 小時的 access token，沒有 refresh token，所以也就沒有
 * 「同意畫面還在 Testing → refresh token 7 天過期」那個問題。過期就重新登入。
 *
 * ⚠️ scope 是 `drive.file`：**per-file 授權，只看得到這個 app 自己建的檔案**。
 *    這也是為什麼 `didadida/` 一定要由網頁自己建 —— 指定一個使用者手動建的
 *    資料夾當 parent，Drive 會回 404，因為 app 根本看不見它。
 *    （2026-08-10 實測確認可行：資料夾建得起來，SA 也加得進去當 writer。）
 *
 * Drive 上的長相：
 *
 *     didadida/
 *       <相簿名>/
 *         <photoId>_<檔名>_4k.webp   ← 燈箱代理這份
 *         <photoId>_<原檔名>          ← 相機原始檔，純備份
 *       trash/                       ← 刪掉的檔搬進來，不鏡射相簿結構
 *
 * 相簿資料夾的 id 存在 D1 的 `Album.drive_folder_id`；照片不會在相簿之間搬動，
 * 所以檔案放進去就不用再動。相簿改名由後端跟著改資料夾名字（純外觀）。
 *
 * 換 NAS 的時候只有這個檔和 backend/src/drive.ts 要改。
 */

import {
  fetchDriveConfig, saveDriveFolders, saveAlbumDriveFolder, recordPhotoDrive, fetchAlbum,
  getGoogleToken,
  type DriveConfig,
} from './api';
import { encode4kWebp } from './imageUtils';

const DRIVE_FILES = 'https://www.googleapis.com/drive/v3/files';
const DRIVE_UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const ROOT_FOLDER_NAME = 'didadida';
const TRASH_FOLDER_NAME = 'trash';

/**
 * 手上還有沒有可用的 Drive token。
 *
 * 就是登入時拿到的那個 Google token（見 api.ts 的 getGoogleToken）。
 * 過期會被當作沒有 —— 那代表登入過期，要重新登入，不是「還沒連結 Drive」。
 */
export function hasDriveToken(): boolean {
  return !!getGoogleToken();
}

/** 沒 token 就講清楚是登入過期，不要讓呼叫端自己猜 */
function requireToken(): string {
  const token = getGoogleToken();
  if (!token) throw new Error('Google 登入已過期，請重新登入');
  return token;
}

let cachedConfig: DriveConfig | null = null;

async function getConfig(): Promise<DriveConfig> {
  if (cachedConfig) return cachedConfig;
  const config = await fetchDriveConfig();
  if (!config) throw new Error('拿不到 Drive 設定');
  cachedConfig = config;
  return config;
}

/**
 * 先把後端的 Drive 設定抓回來放著。
 *
 * 純粹是省掉真正要用時的那一趟往返 —— 已經沒有「彈窗來不及開」的壓力了
 * （授權在登入時就完成）。失敗不用理會，要用的時候還會再試一次。
 */
export function prewarmDrive(): void {
  getConfig().catch(() => {});
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

/**
 * 找這個 app 自己建過的資料夾。drive.file 之下 files.list 本來就只看得到自建的檔。
 *
 * 名字會被塞進 Drive 的查詢字串裡，所以要跳脫 —— 現在傳進來的是使用者取的
 * 相簿名，什麼字元都可能有。**反斜線要先跳脫**，不然它會把後面補的那個反斜線吃掉。
 */
async function findOwnFolder(token: string, name: string, parentId?: string): Promise<string | null> {
  const escaped = name.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  const clauses = [
    `name = '${escaped}'`,
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
  const token = requireToken();
  const config = await getConfig();
  if (!config.sa_email) throw new Error('後端沒有設定 GOOGLE_DRIVE_SA_KEY');

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
  // 快取跟著更新，不然下一次呼叫會拿到 folder id 還是 null 的舊設定，白跑一次 bootstrap
  cachedConfig = { ...config, photos_folder_id: photosFolderId, trash_folder_id: trashFolderId };
  return { photosFolderId, trashFolderId, token };
}

/**
 * 找出（必要時建立）這本相簿在 Drive 上的資料夾，回傳資料夾 id。
 *
 * **分類的邏輯全在這裡**：`didadida/<相簿名>/`。照片不會在相簿之間搬動，
 * 所以檔案放進去就不用再動；相簿改名由後端在 PUT /api/albums/:id 跟著改資料夾名字。
 *
 * 資料夾 id 存在 D1 的 `Album.drive_folder_id`，**不靠名字去找** ——
 * 名字會變，而且 Drive 允許同名資料夾並存，用名字當鍵遲早會建出第二個。
 * 只有第一次（D1 還沒有 id）才會退回名字搜尋，那是為了讓中途失敗重跑不會重複建。
 */
export async function ensureAlbumFolder(
  drive: { photosFolderId: string; token: string },
  albumId: number,
): Promise<string> {
  // 自己去抓而不是讓呼叫端傳進來：另一個分頁剛建過的話，畫面上的 state 是舊的
  const album = await fetchAlbum(String(albumId));
  if (!album) throw new Error('找不到相簿');
  if (album.drive_folder_id) return album.drive_folder_id;

  const name = (album.name || '').trim() || `相簿 ${albumId}`;
  const folderId =
    (await findOwnFolder(drive.token, name, drive.photosFolderId))
    ?? (await createFolder(drive.token, name, drive.photosFolderId));

  // 後端可能回別人先建好的那個。以它為準，自己建的那個就放著別用
  const effective = await saveAlbumDriveFolder(albumId, folderId);
  return effective || folderId;
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

/**
 * 把一張照片的 4K 與原始檔送上 Drive，再把 file id 記回 D1。
 *
 * **兩份分開處理，一份失敗不影響另一份。** 後端的 COALESCE 收得下只有一個 id
 * 的情況，能存多少算多少 —— 照片在 R2 那邊早就存在了，這裡純粹是加分。
 *
 * 檔名前面加照片 id，是為了在 Drive 上直接看得出哪個檔對應哪張照片；
 * 真正的對應關係還是靠 D1 的 drive_file_id，不靠檔名解析。
 *
 * 上傳與補傳共用同一條路 —— 補傳餵的就是同一批原始檔，沒有第二種語意。
 * 回傳「有沒有記進 D1」，補傳畫面要靠它算成功幾張。
 *
 * `folderId` 是**相簿的**資料夾，不是 `didadida/` 根目錄（見 ensureAlbumFolder）。
 */
export async function pushPhotoToDrive(
  target: { folderId: string; token: string },
  photoId: number,
  rawFile: File,
): Promise<boolean> {
  const { folderId, token } = target;
  const base = rawFile.name.replace(/\.[^/.]+$/, '');

  let driveFileId: string | null = null;
  try {
    // 一定要餵原始檔：resizeImageFile 的產物只有 2000px，放大成 4K 又大又糊
    const webp4k = await encode4kWebp(rawFile);
    if (webp4k) {
      driveFileId = await uploadToDrive(token, webp4k, `${photoId}_${base}_4k.webp`, folderId);
    }
  } catch (err) {
    console.warn(`照片 ${photoId} 的 4K 沒送上 Drive`, err);
  }

  let driveOriginalId: string | null = null;
  try {
    driveOriginalId = await uploadToDrive(token, rawFile, `${photoId}_${rawFile.name}`, folderId);
  } catch (err) {
    console.warn(`照片 ${photoId} 的原始檔沒送上 Drive`, err);
  }

  if (!driveFileId && !driveOriginalId) return false;
  return await recordPhotoDrive(photoId, { driveFileId, driveOriginalId });
}
