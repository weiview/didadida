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
 *    現在的做法：**那個帳號永遠是站長**，任何人上傳時都跟後端換一張站長的
 *    短效 access token，照片就都由同一個身分建檔。誰上傳的記在 D1，
 *    不看 Drive 的擁有者欄位。見 api.ts 的 fetchDriveWriterToken。
 *
 *    **站上沒有「連結 Drive 帳號」這個動作**（2026-08-14 拿掉）：憑據就是站長
 *    那一列的 `User.google_refresh_token` —— 他用 Google 登入站台時收下的那一份，
 *    跟「從 Google 相簿匯入」用的是同一張（登入 scope 本來就含 drive.file）。
 *    誰都不必記得去點什麼，站長每次登入還會順便把它刷新。
 *
 *    代價一：refresh token 還是可能失效（被撤銷、換過 OAuth client），錯誤裡的
 *    `expired` 就是在講這件事 —— 站長重新用 Google 登入一次就會自己收回來。
 *    ⚠️ 同意畫面**早就發布成正式狀態了，沒有「測試中 7 天到期」這回事**，
 *    往那個方向查會走冤枉路。
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
/**
 * 根資料夾的名字**由後端決定**（`root_folder_name`），不寫死在這裡：
 * local / dev / prod 的備份全都寫進站長同一個 Drive，三邊同名的話
 * findOwnFolder 會照名字找到別的環境那一個，資料就混在一起了。
 * 拿不到就退回 `didadida`（＝prod 的名字，也是舊版的行為）。
 */
const FALLBACK_ROOT_FOLDER_NAME = 'didadida';
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

  const rootName = config.root_folder_name || FALLBACK_ROOT_FOLDER_NAME;
  const photosFolderId =
    (await findOwnFolder(token, rootName)) ?? (await createFolder(token, rootName));
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

/* ---- 診斷（已移除）----
 *
 * 這裡原本有 diagnoseDriveAccess()：逐項回答「Drive 寫入帳號到底卡在哪」，
 * 掛在「Drive 寫入帳號」那顆 FAB 底下。2026-08-14 連同那顆按鈕一起拿掉 ——
 * 站上已經沒有任何跟 Drive 授權有關的動作可做，一個只能看不能修的檢查表
 * 沒有意義。真的要查就看 `wrangler tail` 的 /api/drive/token 回應。
 */
