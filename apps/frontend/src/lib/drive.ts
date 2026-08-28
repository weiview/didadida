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
 *
 * ⚠️ **影片不要走這支**，走 uploadToDriveResumable。multipart 是「整個檔一次
 *    POST 出去」：幾 GB 的檔要嘛中途斷線整份重來、要嘛在手機上直接把分頁
 *    撐爆，而且完全沒有進度可以回報。
 */
/** Drive 回了一個非 2xx。帶著 status 是為了讓重試判斷得出「這值不值得再試」 */
export class DriveHttpError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'DriveHttpError';
  }
}

/**
 * 這個錯誤再試一次有沒有意義。
 *
 * 5xx 與 429 是 Drive 那邊的暫時狀況，網路層自己丟出來的（斷線、DNS）更是 ——
 * 那種連請求都沒送出去。**4xx 一律不重試**：403 是權限、404 是資料夾被搬走，
 * 重試一百次結果一樣，只是把使用者多晾幾秒。
 */
const driveRetryable = (e: unknown): boolean =>
  !(e instanceof DriveHttpError) || e.status >= 500 || e.status === 429;

/** 重試幾次（含第一次）。3 次配上 1s／2s 的等待，涵蓋得了大多數瞬間的抖動 */
const DRIVE_MAX_TRIES = 3;

/**
 * 包一層重試。
 *
 * 為什麼非有不可：上傳這條路整段跑在**瀏覽器**裡，行動網路切換、Wi-Fi 掉一下、
 * Drive 偶爾的 503，每一種都會讓一張照片留下半套結果（R2 有、Drive 沒有），
 * 而使用者只會看到「失敗」兩個字。試三次幾乎都能救回來。
 *
 * ⚠️ 等待用指數退避而不是固定間隔：真的是 Drive 忙不過來時，一秒後再壓一次
 *    只會讓它更忙。
 */
async function withDriveRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= DRIVE_MAX_TRIES; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (attempt >= DRIVE_MAX_TRIES || !driveRetryable(e)) break;
      console.warn(`${label} 第 ${attempt} 次失敗，${attempt} 秒後重試`, e);
      await sleep(attempt * 1000);
    }
  }
  throw lastErr;
}

export async function uploadToDrive(
  token: string,
  blob: Blob,
  name: string,
  folderId: string,
): Promise<string> {
  return await withDriveRetry(`上傳 ${name}`, async () => {
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
      throw new DriveHttpError(res.status, `Drive 上傳失敗 ${res.status}: ${detail.slice(0, 200)}`);
    }
    const data = await res.json();
    if (!data?.id) throw new Error('Drive 上傳沒有回傳 file id');
    return data.id;
  });
}

/**
 * 把 file id 記回 D1，記不成就重試。
 *
 * **這一步比上傳本身更不能掉。** 檔案已經在 Drive 上了，這一趟沒回來就變成
 * 一個沒有任何一列指著的孤兒檔：站上看起來「沒有備份」（於是使用者去補傳，
 * Drive 上再多一份），而那個孤兒要等背景對帳（後端 runDriveAudit）隔天才收得掉。
 */
async function recordDriveIds(
  photoId: number,
  ids: { driveFileId?: string | null; driveOriginalId?: string | null },
): Promise<boolean> {
  for (let attempt = 1; attempt <= DRIVE_MAX_TRIES; attempt++) {
    const res = await recordPhotoDrive(photoId, ids);
    if (res.ok) return true;
    if (!res.retryable) return false;
    if (attempt < DRIVE_MAX_TRIES) await sleep(attempt * 1000);
  }
  return false;
}

/**
 * 分塊上傳的塊大小。**必須是 256KB 的整數倍**（Drive 的硬性要求，不然回 400）。
 *
 * 8MB 是折衷：太小的話 2GB 要切成幾千塊、每塊一趟往返；太大的話一塊失敗要重來
 * 的量就大，而且行動網路上單次請求越久越容易被中斷。
 */
const RESUMABLE_CHUNK_BYTES = 8 * 1024 * 1024;
/** 單一塊連續失敗幾次就放棄整支 */
const RESUMABLE_MAX_RETRY = 4;

/**
 * 分塊（resumable）上傳，給影片用。回傳 file id。
 *
 * 為什麼影片非這樣不可：
 *   - multipart 是一次 POST 整份，2GB 中途斷線就是整份重來；
 *   - 分塊才有辦法回報進度（`onProgress`），不然使用者要對著一條不動的
 *     進度條等十幾分鐘，那正是「以為當掉了」的情境；
 *   - 斷了可以接著傳 —— 問 Drive 收到哪個位元組了，從那裡繼續。
 *
 * ⚠️ **每一塊的 PUT 不帶 Authorization**：工作階段網址（session URI）本身就是
 *    授權過的，而它裡面帶著 upload_id。這也讓長時間上傳不怕 access token 過期
 *    ——token 只在開工作階段那一趟用到，之後一小時的效期跟上傳無關。
 *
 * ⚠️ 要讀得到回應的 `Location` 與 `Range` 兩個標頭，靠的是 Google 自己在 CORS
 *    回應裡把它們列進 Access-Control-Expose-Headers。**不要改成走 Worker 代理**
 *    —— 那會讓幾 GB 的位元組穿過 Worker（100MB 請求體上限，直接爆）。
 *
 * `File.slice()` 是惰性的，切出來的塊不會把整個檔案讀進記憶體。
 */
export async function uploadToDriveResumable(
  token: string,
  file: File,
  name: string,
  folderId: string,
  onProgress?: (sent: number, total: number) => void,
): Promise<string> {
  // 開工作階段這一趟很短但很關鍵，失敗就整支傳不了 —— 包一層重試
  const session = await withDriveRetry(`開上傳工作階段 ${name}`, async () => {
    const start = await fetch(`${DRIVE_UPLOAD}?uploadType=resumable&fields=id`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json; charset=UTF-8',
        // 先報總長度與型別，Drive 才知道要開多大的工作階段
        'X-Upload-Content-Type': file.type || 'application/octet-stream',
        'X-Upload-Content-Length': String(file.size),
      },
      body: JSON.stringify({ name, parents: [folderId] }),
    });
    if (!start.ok) {
      const detail = await start.text().catch(() => '');
      throw new DriveHttpError(start.status, `Drive 開上傳工作階段失敗 ${start.status}: ${detail.slice(0, 200)}`);
    }
    const location = start.headers.get('Location');
    if (!location) throw new Error('Drive 沒有回傳上傳工作階段的網址');
    return location;
  });

  let offset = 0;
  let attempt = 0;
  onProgress?.(0, file.size);

  while (offset < file.size) {
    const end = Math.min(offset + RESUMABLE_CHUNK_BYTES, file.size);
    let res: Response;
    try {
      res = await fetch(session, {
        method: 'PUT',
        // bytes <起>-<迄>/<總長>，迄是含端點
        headers: { 'Content-Range': `bytes ${offset}-${end - 1}/${file.size}` },
        body: file.slice(offset, end),
      });
    } catch (err) {
      // 斷線。問一次 Drive 到底收到哪了再從那裡接，不要盲目重送同一塊
      if (++attempt > RESUMABLE_MAX_RETRY) throw err;
      await sleep(attempt * 1000);
      offset = await resumeOffset(session, file.size);
      onProgress?.(offset, file.size);
      continue;
    }

    // 308 ＝ 還沒收完，繼續。Range 講的是「目前為止收到哪」
    if (res.status === 308) {
      attempt = 0;
      offset = rangeEnd(res.headers.get('Range')) ?? end;
      onProgress?.(offset, file.size);
      continue;
    }

    if (res.ok) {
      onProgress?.(file.size, file.size);
      const data = await res.json().catch(() => null);
      if (!data?.id) throw new Error('Drive 上傳完成卻沒有回傳 file id');
      return data.id as string;
    }

    // 5xx 是 Drive 自己的問題，退一步再接著傳；4xx 是我們送錯了，重試沒有意義
    if (res.status >= 500 && ++attempt <= RESUMABLE_MAX_RETRY) {
      await sleep(attempt * 1000);
      offset = await resumeOffset(session, file.size);
      onProgress?.(offset, file.size);
      continue;
    }
    const detail = await res.text().catch(() => '');
    throw new Error(`Drive 分塊上傳失敗 ${res.status}: ${detail.slice(0, 200)}`);
  }

  throw new Error('Drive 分塊上傳沒有收到完成回應');
}

/** 問 Drive「這個工作階段目前收到哪個位元組了」，回傳下一塊該從哪開始 */
async function resumeOffset(session: string, total: number): Promise<number> {
  const res = await fetch(session, {
    method: 'PUT',
    // 星號 ＝ 這次不送內容，只是問進度
    headers: { 'Content-Range': `bytes */${total}` },
  });
  if (res.status === 308) return rangeEnd(res.headers.get('Range')) ?? 0;
  // 200/201 代表其實已經傳完了；讓外層那一圈自己收尾
  if (res.ok) return total;
  throw new Error(`Drive 查詢上傳進度失敗 ${res.status}`);
}

/** `bytes=0-8388607` → 8388608（下一塊的起點） */
function rangeEnd(header: string | null): number | null {
  const m = header?.match(/bytes=0-(\d+)/);
  return m ? Number(m[1]) + 1 : null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 把一支影片的原始檔送上 Drive，再把 file id 記回 D1。
 *
 * ⚠️ **失敗一定要往外丟，不要像照片那樣吞掉。** 照片吞得起是因為 R2 上有
 *    800px 可看，Drive 只是備份；影片在 R2 只有一張封面圖，Drive 沒上去
 *    就等於相簿裡多一格點開只有靜止畫面的東西。呼叫端接到錯誤後會把剛建的
 *    那一列刪掉，讓使用者看到「失敗」而不是一格壞掉的影片。
 *
 * ⚠️ file id 記在 **drive_original_id**（不是 drive_file_id）—— 影片沒有
 *    「衍生的 4K」那一份，上去的就是原始檔（見 migrations/0019）。
 */
export async function pushVideoToDrive(
  target: { folderId: string; token: string },
  photoId: number,
  file: File,
  onProgress?: (sent: number, total: number) => void,
): Promise<boolean> {
  const driveOriginalId = await uploadToDriveResumable(
    target.token, file, `${photoId}_${file.name}`, target.folderId, onProgress,
  );
  /*
   * ⚠️ 記不回 D1 也要**丟出去**，不能回 false 了事。
   *
   * 檔案已經在 Drive 上了，但站上那一列不知道 —— 影片在 R2 只有一張封面，
   * 於是相簿裡多一格點開只有靜止畫面的東西。呼叫端收到錯誤才會把那一列收掉，
   * 使用者看到的是「失敗」，而 Drive 上那個孤兒檔由背景對帳收尾。
   */
  if (!(await recordDriveIds(photoId, { driveFileId: null, driveOriginalId }))) {
    throw new Error('影片傳上 Drive 了，但沒能記回網站（把同一個檔再拖進來上傳一次就會補上）');
  }
  return true;
}

/** pushPhotoToDrive 的結果。**半套也要講清楚是哪一半**，不然沒人查得出來 */
export interface DrivePushResult {
  /** 該傳的都傳了，而且記進 D1 了 */
  ok: boolean;
  /** 4K 這一份的下場 */
  fourK: 'ok' | 'skipped' | 'failed';
  /** 原始檔這一份的下場 */
  original: 'ok' | 'skipped' | 'failed';
  /** ok 為 false 時一定有：給人看的一句話 */
  reason?: string;
}

/**
 * 把一張照片的 4K 與原始檔送上 Drive，再把 file id 記回 D1。
 *
 * **兩份分開處理，一份失敗不影響另一份。** 後端的 COALESCE 收得下只有一個 id
 * 的情況，能存多少算多少 —— 照片在 R2 那邊早就存在了，這裡純粹是加分。
 *
 * ⚠️ **但半套不算成功。** 以前這裡只回一個 boolean，而且「兩份裡有一份上去了」
 *    就回 true —— 於是「原始檔傳失敗」在畫面上跟全成功長得一模一樣，
 *    使用者以為備份好了。回 DrivePushResult 就是為了讓半套講得出口。
 *
 * `need` 給補傳用：清單已經知道缺的是哪一半，把已經有的那一份再傳一次
 * 只會在 Drive 上多一個同名檔（Drive 不會去重）。預設兩份都傳。
 *
 * 檔名前面加照片 id，是為了在 Drive 上直接看得出哪個檔對應哪張照片；
 * 真正的對應關係還是靠 D1 的 drive_file_id，不靠檔名解析
 * （唯一的例外是後端對帳的孤兒判定，見 runDriveAudit）。
 *
 * `folderId` 是**相簿的**資料夾，不是 `didadida/` 根目錄（見 ensureAlbumFolder）。
 */
export async function pushPhotoToDrive(
  target: { folderId: string; token: string },
  photoId: number,
  rawFile: File,
  need: { fourK?: boolean; original?: boolean } = {},
): Promise<DrivePushResult> {
  const { folderId, token } = target;
  const base = rawFile.name.replace(/\.[^/.]+$/, '');
  const want4k = need.fourK !== false;
  const wantOriginal = need.original !== false;
  const reasons: string[] = [];

  let driveFileId: string | null = null;
  let fourK: DrivePushResult['fourK'] = want4k ? 'failed' : 'skipped';
  if (want4k) {
    try {
      // 一定要餵原始檔：resizeImageFile 的產物只有 2000px，放大成 4K 又大又糊
      const webp4k = await encode4kWebp(rawFile);
      if (webp4k) {
        driveFileId = await uploadToDrive(token, webp4k, `${photoId}_${base}_4k.webp`, folderId);
        fourK = 'ok';
      } else {
        reasons.push('這個格式編不出 4K WebP');
      }
    } catch (err) {
      console.warn(`照片 ${photoId} 的 4K 沒送上 Drive`, err);
      reasons.push(`4K：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  let driveOriginalId: string | null = null;
  let original: DrivePushResult['original'] = wantOriginal ? 'failed' : 'skipped';
  if (wantOriginal) {
    try {
      driveOriginalId = await uploadToDrive(token, rawFile, `${photoId}_${rawFile.name}`, folderId);
      original = 'ok';
    } catch (err) {
      console.warn(`照片 ${photoId} 的原始檔沒送上 Drive`, err);
      reasons.push(`原始檔：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (driveFileId || driveOriginalId) {
    if (!(await recordDriveIds(photoId, { driveFileId, driveOriginalId }))) {
      // 檔案上去了、網站不知道 —— 這是孤兒的來源，要講出來
      return {
        ok: false, fourK: 'failed', original: 'failed',
        reason: '傳上 Drive 了，但沒能記回網站（可以稍後再補傳一次）',
      };
    }
  }

  const ok = fourK !== 'failed' && original !== 'failed';
  return { ok, fourK, original, ...(ok ? {} : { reason: reasons.join('；') || 'Drive 上傳失敗' }) };
}

/* ---- 診斷（已移除）----
 *
 * 這裡原本有 diagnoseDriveAccess()：逐項回答「Drive 寫入帳號到底卡在哪」，
 * 掛在「Drive 寫入帳號」那顆 FAB 底下。2026-08-14 連同那顆按鈕一起拿掉 ——
 * 站上已經沒有任何跟 Drive 授權有關的動作可做，一個只能看不能修的檢查表
 * 沒有意義。真的要查就看 `wrangler tail` 的 /api/drive/token 回應。
 */
