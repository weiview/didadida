/**
 * 瀏覽器端的 Google Drive 存取。
 *
 * 為什麼上傳要在瀏覽器做，而不是像其他事情一樣丟給 Worker：
 * **service account 沒有自己的儲存配額，建不了檔。** 檔案必須由一個真人帳號
 * 建立。順帶的好處是 5 MB 的原始檔不必灌過 Worker 一趟。
 * 建完之後只把 file id 回報給後端（見 recordPhotoDrive）。
 *
 * ⚠️ **寫進 Drive 的身分永遠是同一個帳號，不是「現在登入的那個人」。**
 *
 *    scope 是 `drive.file`＝**per-file 授權：誰建的檔，才只有誰碰得到**。
 *    所以「每位管理員用自己的 token 寫」一定會在「A 建的相簿、B 要上傳」時
 *    撞 404。試過用 Google Picker 讓 B 授權整個 `didadida/` 根目錄，
 *    2026-08-10 實測結論：**根目錄的授權不會往下涵蓋別人建的子資料夾**，
 *    那條路走不通（Picker 的程式碼已經移除）。
 *
 *    現在的做法：管理員連結一次「Drive 寫入帳號」（後端存那個帳號的
 *    refresh token），任何人上傳時都跟後端換一張那個帳號的短效 access token，
 *    照片就都由同一個身分建檔。誰上傳的記在 D1，不看 Drive 的擁有者欄位。
 *    連結入口見 api.ts 的 driveWriterLoginUrl / fetchDriveWriterToken。
 *
 *    代價一：refresh token 會過期（同意畫面還在 Testing 的話 7 天），
 *    過期就得再連結一次，錯誤裡的 `expired` 就是在講這件事。
 *    代價二：舊做法留下的相簿資料夾是別的帳號建的，寫入身分看不見 ——
 *    探到 404 就在自己名下重建一個並改記（見 ensureAlbumFolder）。
 *
 * ⚠️ 同一個 per-file 限制也是為什麼 `didadida/` 一定要由網頁自己建 ——
 *    指定一個使用者手動建的資料夾當 parent，Drive 會回 404，
 *    因為 app 根本看不見它。
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
  fetchDriveWriterToken, DriveWriterError,
  type DriveConfig,
} from './api';
import { encode4kWebp } from './imageUtils';

const DRIVE_FILES = 'https://www.googleapis.com/drive/v3/files';
const DRIVE_UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const ROOT_FOLDER_NAME = 'didadida';
const TRASH_FOLDER_NAME = 'trash';

/**
 * 這一頁手上那張寫入 token。
 *
 * **只放記憶體**：它是別人（寫入帳號）的憑證，沒有理由留在 localStorage 讓
 * 每個分頁、每個擴充功能都讀得到。重整就重拿，反正只是一趟 API。
 */
let writerToken: { value: string; expiresAt: number } | null = null;

/**
 * 拿一張可用的 Drive 寫入 token，過期或還沒有就跟後端換一張。
 *
 * 失敗一律丟 `DriveWriterError`（帶 reason），呼叫端才分得出
 * 「要人去連結」跟「等一下再試」。
 */
async function requireToken(): Promise<string> {
  if (writerToken && Date.now() < writerToken.expiresAt) return writerToken.value;
  const minted = await fetchDriveWriterToken();
  writerToken = { value: minted.accessToken, expiresAt: Date.now() + minted.expiresIn * 1000 };
  return minted.accessToken;
}

/** 重新連結之後要叫一次，不然這一頁會抱著舊帳號的 token 直到它過期 */
export function resetDriveWriterToken(): void {
  writerToken = null;
  verifiedFolders.clear();
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
 * 先把後端的 Drive 設定抓回來放著。純粹是省掉真正要用時的那一趟往返，
 * 失敗不用理會，要用的時候還會再試一次。
 */
export function prewarmDrive(): void {
  getConfig().catch(() => {});
}

/** 連結完寫入帳號要重抓 —— 快取裡的 writer_email 還是「還沒連結」 */
export async function refreshDriveConfig(): Promise<DriveConfig | null> {
  cachedConfig = null;
  return await fetchDriveConfig().then((c) => (cachedConfig = c));
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

/* ---- 資料夾的存取檢查 ---- */

/**
 * 「寫入帳號碰不到那個資料夾」。跟一般的上傳失敗要分開處理 ——
 * 前者是身分／權限的事，重試一百次都一樣。
 *
 * 走到這裡通常代表 Drive 那邊被人動過手腳（資料夾被搬走、權限被改掉），
 * 因為寫入帳號自己建的東西本來就一直看得到。訊息要講清楚是哪一層，
 * 不要只寫「失敗」讓人去猜。
 */
export class DriveAccessError extends Error {
  constructor(
    public readonly scope: 'root' | 'album',
    public readonly reason: 'no_access' | 'not_editor',
    public readonly folderId: string,
    message: string,
  ) {
    super(message);
    this.name = 'DriveAccessError';
  }
}

interface FolderProbe {
  /** 這個帳號的 app 授權看不看得到它。false 幾乎都是 404 */
  ok: boolean;
  status: number;
  /** Drive ACL 上能不能在裡面建東西。看得到但不能寫＝只被分享成檢視者 */
  canAddChildren: boolean;
  name: string | null;
}

/**
 * 探一個資料夾的路。**看得到**與**寫得進去**是兩件事，分開回報：
 * 前者是 app 授權（drive.file / Picker），後者是 Drive 的分享權限。
 * 兩者的修法完全不同，混成一句「失敗」使用者只能亂試。
 */
async function probeFolder(token: string, folderId: string): Promise<FolderProbe> {
  const params = new URLSearchParams({ fields: 'id,name,capabilities/canAddChildren' });
  let res: Response;
  try {
    res = await fetch(`${DRIVE_FILES}/${folderId}?${params}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch (e) {
    return { ok: false, status: 0, canAddChildren: false, name: null };
  }
  if (!res.ok) return { ok: false, status: res.status, canAddChildren: false, name: null };
  const data = await res.json().catch(() => null);
  return {
    ok: true,
    status: 200,
    // 少了這個欄位就當它可以，不要為了讀不到欄位擋住上傳
    canAddChildren: data?.capabilities?.canAddChildren !== false,
    name: typeof data?.name === 'string' ? data.name : null,
  };
}

/**
 * 這一頁已經確認過的資料夾。授權是 Google 那邊長期記著的，
 * 但每次上傳都去問一次是白花一趟往返；只快取「通過」的，失敗永遠重探。
 */
const verifiedFolders = new Set<string>();

async function requireFolderAccess(
  token: string,
  folderId: string,
  scope: 'root' | 'album',
): Promise<void> {
  if (verifiedFolders.has(folderId)) return;
  const probe = await probeFolder(token, folderId);

  if (!probe.ok) {
    throw new DriveAccessError(
      scope, 'no_access', folderId,
      scope === 'root'
        ? `Drive 寫入帳號看不到 didadida 根目錄（HTTP ${probe.status}）—— 資料夾被刪掉或搬走了，或現在連結的是另一個帳號`
        : '這本相簿在 Drive 上的資料夾存取不到',
    );
  }
  if (!probe.canAddChildren) {
    throw new DriveAccessError(
      scope, 'not_editor', folderId,
      scope === 'root'
        ? 'Drive 寫入帳號在 didadida 根目錄上只有檢視權限，寫不進去'
        : '這本相簿的資料夾只有檢視權限，寫不進去',
    );
  }
  verifiedFolders.add(folderId);
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
 *
 * **資料夾已經存在時要先探路**（多一趟 GET，一次上傳只做一次）：寫入帳號換過
 * 或資料夾被搬走的話，直接把 id 交出去只會讓每一張照片各失敗一次、
 * 而且錯誤訊息是看不懂的 404。
 */
export async function ensureDriveFolders(): Promise<DriveFolders & { token: string }> {
  const token = await requireToken();
  const config = await getConfig();
  if (!config.sa_email) throw new Error('後端沒有設定 GOOGLE_DRIVE_SA_KEY');

  if (config.photos_folder_id && config.trash_folder_id) {
    await requireFolderAccess(token, config.photos_folder_id, 'root');
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
 *
 * **記著的 id 是別的帳號建的話會走重建**：那是「每位管理員用自己的身分寫」
 * 那段時期留下來的資料夾，寫入帳號永遠看不見它（`drive.file` 是 per-file 授權），
 * 不重建的話這本相簿從此傳不上 Drive。只有探路確定 404 才重建 —— 網路錯誤、
 * 權限不足都照舊丟錯，免得一次連線抖動就把相簿拆成兩個資料夾。
 * 舊資料夾裡的檔案不動：燈箱走 service account，它在根目錄有權限，兩邊都讀得到。
 */
export async function ensureAlbumFolder(
  drive: { photosFolderId: string; token: string },
  albumId: number,
): Promise<string> {
  // 自己去抓而不是讓呼叫端傳進來：另一個分頁剛建過的話，畫面上的 state 是舊的
  const album = await fetchAlbum(String(albumId));
  if (!album) throw new Error('找不到相簿');

  let rebind = false;
  if (album.drive_folder_id) {
    if (verifiedFolders.has(album.drive_folder_id)) return album.drive_folder_id;
    const probe = await probeFolder(drive.token, album.drive_folder_id);
    if (probe.ok && probe.canAddChildren) {
      verifiedFolders.add(album.drive_folder_id);
      return album.drive_folder_id;
    }
    // 404 才算「這個資料夾不屬於寫入帳號」。其他狀態（401/5xx/斷線）照舊丟錯
    if (probe.status !== 404) {
      throw new DriveAccessError(
        'album', probe.ok ? 'not_editor' : 'no_access', album.drive_folder_id,
        probe.ok
          ? '這本相簿的資料夾只有檢視權限，寫不進去'
          : `這本相簿在 Drive 上的資料夾存取不到（HTTP ${probe.status}）`,
      );
    }
    console.warn(`相簿 ${albumId} 的 Drive 資料夾是別的帳號建的，改在寫入帳號名下重建`);
    rebind = true;
  }

  const name = (album.name || '').trim() || `相簿 ${albumId}`;
  const folderId =
    (await findOwnFolder(drive.token, name, drive.photosFolderId))
    ?? (await createFolder(drive.token, name, drive.photosFolderId));

  // 後端可能回別人先建好的那個。以它為準，自己建的那個就放著別用
  const effective = await saveAlbumDriveFolder(albumId, folderId, rebind);
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

/* ---- 診斷 ---- */

/** 列出某個資料夾底下這個帳號看得見的子資料夾名字。看得見幾個是關鍵訊號，不是裝飾 */
async function listChildFolders(token: string, parentId: string): Promise<string[]> {
  const params = new URLSearchParams({
    q: `'${parentId}' in parents and mimeType = '${FOLDER_MIME}' and trashed = false`,
    fields: 'files(id,name)',
    pageSize: '100',
  });
  const data = await driveJson(token, `${DRIVE_FILES}?${params}`);
  return (data?.files ?? []).map((f: any) => String(f?.name ?? '?'));
}

/**
 * 丟進垃圾桶，不是刪除。
 *
 * 這個專案有一條不變量：**程式碼永遠不呼叫 `files.delete`**（原本是為了防止
 * service account 誤刪，見後端 drive.ts）。診斷用的測試檔也照這條走 ——
 * 例外開一次，下次就會有人照抄。
 */
async function trashDriveFile(token: string, fileId: string): Promise<void> {
  await driveJson(token, `${DRIVE_FILES}/${fileId}?fields=id`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ trashed: true }),
  });
}

export interface DriveCheck {
  label: string;
  /** null＝這一項不適用（例如相簿還沒有資料夾），不是失敗 */
  ok: boolean | null;
  detail: string;
}

/**
 * 把「Drive 寫入帳號到底碰得到哪些部分」一次問清楚。
 *
 * 存在的理由：靠上傳照片去試的話，症狀是「照片傳上去了但沒有 Drive 備份」，
 * 看不出是沒連結、token 過期、權限不足還是編碼失敗。這裡直接分項回答，
 * 最後一項還真的寫一個測試檔進去（寫完丟垃圾桶）。
 *
 * 讀取檢查沒有副作用；寫入檢查會在 Drive 上留一個垃圾桶裡的小檔案。
 */
export async function diagnoseDriveAccess(albumId?: number): Promise<DriveCheck[]> {
  const checks: DriveCheck[] = [];
  const add = (label: string, ok: boolean | null, detail: string) => checks.push({ label, ok, detail });
  const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

  let config: DriveConfig;
  try {
    config = await getConfig();
  } catch (e) {
    add('後端 Drive 設定', false, errText(e));
    return checks;
  }

  add(
    'Drive 寫入帳號',
    !!config.writer_email,
    config.writer_email
      ? `${config.writer_email}${config.writer_linked_at ? `（${new Date(config.writer_linked_at).toLocaleString('zh-TW')} 連結）` : ''}`
      : '還沒連結 —— 所有人都上傳不了 Drive 備份，按上面那顆按鈕連結一次',
  );

  let token: string;
  try {
    token = await requireToken();
  } catch (e) {
    add(
      '換得到寫入用的 token',
      false,
      e instanceof DriveWriterError && e.reason === 'expired'
        ? `${e.message} —— 同意畫面還在測試中的話 refresh token 只活 7 天，重新連結一次`
        : errText(e),
    );
    return checks;
  }
  add('換得到寫入用的 token', true, '後端用存著的授權換到了短效 token');

  add(
    '後端 Drive 設定',
    !!config.photos_folder_id && !!config.sa_email,
    `didadida 資料夾 id：${config.photos_folder_id ?? '（還沒建）'}｜service account：${config.sa_email ?? '（沒設 GOOGLE_DRIVE_SA_KEY）'}`,
  );

  const rootId = config.photos_folder_id;
  if (!rootId) {
    add('共用資料夾', null, '後端還沒有資料夾 id，第一次上傳時才會建起來');
    return checks;
  }

  const root = await probeFolder(token, rootId);
  add(
    '讀得到 didadida 根目錄',
    root.ok,
    root.ok
      ? `看得到，名字是「${root.name ?? '?'}」`
      : `HTTP ${root.status} —— 寫入帳號碰不到它。資料夾被刪／被搬走，或現在連結的是另一個帳號`,
  );
  if (root.ok) {
    add(
      '根目錄可以新增子項',
      root.canAddChildren,
      root.canAddChildren ? 'Drive 上是編輯者' : '只有檢視權限 —— 請資料夾擁有者改成「編輯者」',
    );

    // 看得見幾個子資料夾＝有幾本相簿是這個寫入帳號建的。
    // 少於實際相簿數不是壞事：舊做法留下的那幾本會在下次上傳時自動重建
    try {
      const names = await listChildFolders(token, rootId);
      add(
        '看得見根目錄底下的相簿子資料夾',
        names.length > 0,
        names.length > 0
          ? `看得到 ${names.length} 個：${names.slice(0, 8).join('、')}${names.length > 8 ? ' …' : ''}`
          : '一個都看不到（還沒有任何相簿由這個寫入帳號建過資料夾）',
      );
    } catch (e) {
      add('看得見根目錄底下的相簿子資料夾', false, errText(e));
    }
  }

  // 相簿子資料夾：真正的上傳目的地
  let albumFolderId: string | null = null;
  if (albumId) {
    const album = await fetchAlbum(String(albumId)).catch(() => null);
    albumFolderId = album?.drive_folder_id ?? null;
    if (!albumFolderId) {
      add('這本相簿的 Drive 資料夾', null, '還沒建（第一次成功上傳時才會建）');
    } else {
      const sub = await probeFolder(token, albumFolderId);
      add(
        '讀得到這本相簿的資料夾',
        sub.ok,
        sub.ok
          ? `看得到，名字是「${sub.name ?? '?'}」`
          : `HTTP ${sub.status} —— 這個子資料夾是另一個帳號建的（舊做法留下的），下次上傳會自動在寫入帳號名下重建一個`,
      );
      if (sub.ok) {
        add('相簿資料夾可以新增子項', sub.canAddChildren, sub.canAddChildren ? '可以' : '只有檢視權限');
      } else {
        albumFolderId = null;
      }
    }
  }

  // 寫入實測。能寫進相簿資料夾才是真的能備份照片，寫得進根目錄只是及格邊緣
  const writeTarget = albumFolderId ?? (root.ok ? rootId : null);
  if (!writeTarget) {
    add('寫入實測', null, '前面就卡住了，沒有可以測的目標資料夾');
    return checks;
  }
  const where = albumFolderId ? '相簿資料夾' : 'didadida 根目錄';
  try {
    const name = `.didadida-access-test-${Date.now()}.txt`;
    const blob = new Blob(['didadida drive access test'], { type: 'text/plain' });
    const fileId = await uploadToDrive(token, blob, name, writeTarget);
    let cleanup = '，已丟進垃圾桶';
    try {
      await trashDriveFile(token, fileId);
    } catch (e) {
      cleanup = `，但清不掉（${errText(e)}），Drive 上會留下 ${name}`;
    }
    add('寫入實測', true, `成功在${where}建了一個測試檔${cleanup}`);
  } catch (e) {
    add('寫入實測', false, `在${where}建檔失敗：${errText(e)}`);
  }

  return checks;
}
