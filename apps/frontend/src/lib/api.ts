// 這裡設定 Cloudflare Workers API 的預設位置
const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'http://127.0.0.1:8787/api';

/**
 * 進站 token 的 localStorage key。
 *
 * 名字是歷史遺留：**這個 key 現在裝的可能是管理員 token，也可能是訪客 token**。
 * 兩種都是後端簽的 JWT，差別在 payload 裡的 role，前端一律原封不動送出去，
 * 由後端決定給到哪裡。沒有改名是因為改了會把所有還沒過期的登入狀態洗掉，
 * 而那個代價換不到任何實質好處。
 */
const SITE_TOKEN_KEY = 'admin_token';

function clearSiteToken(): void {
  if (typeof window === 'undefined') return;
  localStorage.removeItem(SITE_TOKEN_KEY);
}

function getAuthHeaders() {
  const token = typeof window !== 'undefined' ? localStorage.getItem(SITE_TOKEN_KEY) : '';
  return {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`
  };
}

/*
 * ── Google 登入 ────────────────────────────────────────────────────────────
 *
 * 一次登入拿齊三樣：管理員身分、Drive 備份權限、相簿匯入權限。
 * 所以只有一個 Google token，Picker 與 Drive 共用它，不會互相蓋掉。
 *
 * 走整頁跳轉（後端 /api/auth/google/login）而不是 GIS 彈窗：彈窗要「短暫啟用
 * 狀態」才開得起來，而且拿到的 token 只能放記憶體、重整就沒了。跳轉回來的
 * token 存得下，所以重整之後照樣傳得上 Drive。
 */
const GOOGLE_TOKEN_KEY = 'google_access_token';
const GOOGLE_TOKEN_EXP_KEY = 'google_token_expires_at';

/** 管理員登入 = Google 登入。`albumId` 只是為了登入後回到原本那本相簿 */
export function googleLoginUrl(albumId?: string | number): string {
  return `${API_BASE_URL}/auth/google/login${albumId ? `?state=${albumId}` : ''}`;
}

export function storeGoogleToken(token: string, expiresInSec: number): void {
  localStorage.setItem(GOOGLE_TOKEN_KEY, token);
  // 留 60 秒餘裕，免得拿到一個正好在上傳途中過期的 token
  localStorage.setItem(GOOGLE_TOKEN_EXP_KEY, String(Date.now() + (expiresInSec - 60) * 1000));
}

/** 還沒過期就回 token，過期就順手清掉 —— 留著只會讓每個呼叫端各自吃一次 401 */
export function getGoogleToken(): string | null {
  if (typeof window === 'undefined') return null;
  const token = localStorage.getItem(GOOGLE_TOKEN_KEY);
  if (!token) return null;
  const exp = Number(localStorage.getItem(GOOGLE_TOKEN_EXP_KEY) || 0);
  // 沒有到期時刻的是舊版存的，當作還能用；真的過期會由 Google 回 401
  if (exp && exp <= Date.now()) {
    clearGoogleToken();
    return null;
  }
  return token;
}

export function clearGoogleToken(): void {
  localStorage.removeItem(GOOGLE_TOKEN_KEY);
  localStorage.removeItem(GOOGLE_TOKEN_EXP_KEY);
}

/**
 * 把登入回呼塞在網址 fragment 裡的東西收進 localStorage，然後把網址擦乾淨。
 *
 * 為什麼是 fragment 不是 query：`#` 後面的東西不會送到任何伺服器 ——
 * 不進 Worker 的存取記錄、不進 Referer、也不會被 CDN 記下來。
 * 讀完立刻 replaceState 擦掉，是為了不留在瀏覽器歷史裡。
 *
 * 認不得的 fragment 一律不碰（可能是別人用的錨點）。
 */
export interface AuthHashResult {
  admin: boolean;
  error: string | null;
}

export function consumeAuthHash(): AuthHashResult {
  const empty: AuthHashResult = { admin: false, error: null };
  if (typeof window === 'undefined') return empty;
  const raw = window.location.hash.replace(/^#/, '');
  if (!raw) return empty;

  const p = new URLSearchParams(raw);
  const error = p.get('authError');
  const token = p.get('token');
  const googleToken = p.get('googleToken');
  if (!error && !token && !googleToken) return empty;

  if (token) localStorage.setItem(SITE_TOKEN_KEY, token);
  if (googleToken) storeGoogleToken(googleToken, Number(p.get('googleExpiresIn')) || 3600);
  window.history.replaceState({}, document.title, window.location.pathname + window.location.search);
  return { admin: !!token, error };
}

export interface Album {
  id: number;
  name: string;
  description?: string;
  sort_order: number;
  created_at: string;
  cover_photo_url?: string;
  cover_text?: string;
  preview_photos?: string[];
  /** 1 = 足跡地圖不對外公開（預設） */
  map_private?: number;
  /** 這本相簿在 Drive 上的資料夾。null = 還沒建過（沒上傳過、或上傳時 Drive 沒接上） */
  drive_folder_id?: string | null;
  /** 建立這本相簿的人。搭配 useAdmin 的 canEdit() 決定要不要端出編輯與刪除 */
  user_id?: number | null;
}

export interface Tag {
  id: number;
  name: string;
}

/**
 * 挑一張照片該用哪個網址當縮圖。
 *
 * `'sm'` 是小格子（首頁搜尋結果、選取面板、地圖泡泡），`'md'` 是相簿格線。
 * 一定要逐級退回而不是直接取單一欄位：Phase 2 之前上傳的照片沒有 thumb_sm_url，
 * Google 同步進來的連 thumb_url 都是 null —— 少寫一級就會安靜地掉到全尺寸原圖，
 * 一頁載幾十張的地方等於把 R2 流量放大幾十倍，而畫面看起來完全正常。
 * （新照片的 `url` 已經就是 800px 那顆，退到底也不會變大，但舊資料還在。）
 */
export function photoThumbSrc(
  photo: { url: string; thumb_url?: string; thumb_sm_url?: string },
  size: 'sm' | 'md' = 'md',
): string {
  return size === 'sm'
    ? photo.thumb_sm_url || photo.thumb_url || photo.url
    : photo.thumb_url || photo.thumb_sm_url || photo.url;
}

/**
 * 燈箱大圖的網址。
 *
 * 一律走 `/api/photos/:id/full`，**不要直接用 `photo.url`**。Drive 上的 4K 沒有
 * 分享給任何人，只有 service account 讀得到，所以必須經過 Worker 代理；
 * 那條路由自己會處理「還沒搬上 Drive」與「Drive 掛掉」，退回 R2 的 2000px。
 *
 * 前端因此不需要知道 drive_file_id 有沒有值 —— 也不該知道，那是後端的事。
 */
export function photoFullSrc(photo: { id: number }): string {
  return `${API_BASE_URL}/photos/${photo.id}/full`;
}

export interface Photo {
  id: number;
  title: string;
  description?: string;
  file_name: string;
  album_id: number;
  /**
   * 本機上傳的照片：**這就是 800px 那顆**（`thumb_url` 的同一個網址）。
   * R2 從 2026-08-14 起不再存 2000px 的中間版本。
   * Google 同步進來的舊照片才是真的全尺寸原圖。
   */
  url: string;
  /** 800px WebP，相簿格線用。Phase 2 之前上傳的是 400px JPEG */
  thumb_url?: string;
  /** 400px WebP，小格子與地圖標記用。Phase 2 之前上傳的照片是 null */
  thumb_sm_url?: string;
  /**
   * Drive 上那份 4K WebP 的 file id，燈箱大圖就是它（經 Worker 代理）。
   * null ＝ 這張沒有 Drive 備份（沒接上、上傳當下失敗、或是舊資料），
   * 燈箱會退回 800px 並在角落標示。補傳 Drive 之後就會有值。
   */
  drive_file_id?: string | null;
  sort_order: number;
  taken_at?: string;
  /** 牆上時間 'YYYY-MM-DD HH:MM:SS'，顯示與行程段比對都用這個 */
  taken_at_local?: string | null;
  tz_offset_minutes?: number | null;
  /** taken_at 是怎麼算出來的，決定它能不能拿去比對 GPS 軌跡 */
  time_source?: TimeSource | null;
  exif?: string;
  created_at: string;
  tags?: Tag[];
  lat?: number | null;
  lng?: number | null;
  geo_source?: GeoSource;
  place_name?: string | null;
  /**
   * 「這一張特別不要出現在地圖上」。預設 0 ＝ 跟著相簿的 map_private 走。
   * 非管理者取得的資料中，被扣住的照片座標一律為 null
   */
  geo_private?: number;
  /**
   * 擁有權。跟後端 actorOwns 讀的是同一組欄位：
   * `user_id` 是**相簿主人**（不是照片自己的欄位，後端 JOIN 出來的），
   * `uploaded_by` 是傳這張的人（舊照片是 null，退回看相簿主人）。
   */
  user_id?: number | null;
  uploaded_by?: number | null;
}

// 值域與權威順序定義在 geo.ts（前後端共用同一份），這裡只做轉出，
// 避免兩邊各維護一份字串聯集而慢慢長歪。
export type { GeoSource, TimeSource } from './geo';
import type { GeoSource, TimeSource } from './geo';

export interface FootprintPoint {
  id: number;
  title: string;
  album_id: number;
  album_name?: string;
  url: string;
  lat: number;
  lng: number;
  place_name: string | null;
  geo_source: GeoSource;
  /** 顯示用的當地牆上時間 'YYYY-MM-DD HH:MM:SS' */
  local_time: string;
  /** UTC 瞬間。要跟 GPS 軌跡排到同一條時間軸上只能用這個 */
  taken_at: string | null;
}

export interface TripSegment {
  id: number;
  album_id: number | null;
  label: string;
  start_local: string;
  end_local: string;
  lat: number;
  lng: number;
  place_name: string | null;
  tz_offset_minutes: number | null;
  created_at: string;
}

export interface GeoPreview {
  selectedCount: number;
  startLocal: string | null;
  endLocal: string | null;
  /** 選取的照片中缺少拍攝時間的張數，這些無法納入時間區段 */
  missingTimeCount: number;
  /** 選取的照片中已有 EXIF 座標的張數，預設不會被覆蓋 */
  existingExifCount: number;
  /** 落在同一時間範圍卻沒被選到的照片 —— 顯示順序與時間順序不一致時就會出現 */
  alsoInRange: { id: number; title: string; url: string; local_time: string }[];
}

export async function verifyLogin(password: string): Promise<{ success: boolean; message?: string }> {
  try {
    const res = await fetch(`${API_BASE_URL}/verify-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password })
    });
    
    // 如果不是 JSON 格式（例如被 Cloudflare 阻擋的 403 純文字）
    const contentType = res.headers.get("content-type");
    if (!contentType || !contentType.includes("application/json")) {
      const text = await res.text();
      return { success: false, message: `伺服器阻擋: ${res.status} ${text}` };
    }

    const data = await res.json();
    if (res.ok && data.success && data.token) {
      localStorage.setItem(SITE_TOKEN_KEY, data.token);
      return { success: true };
    }
    return { success: false, message: data.error || "密碼錯誤" };
  } catch (error: any) {
    console.error(error);
    return { success: false, message: `連線錯誤: ${error.message}` };
  }
}

/**
 * 進站密碼 → 訪客 token。
 *
 * 跟 verifyLogin 是兩把不同的鑰匙：這一把只換得到「看得到公開內容」的身分，
 * 換不到編輯權。成功之後 token 存在同一個 key（見 SITE_TOKEN_KEY），
 * 所以之後每一個請求都會自動帶著它 —— 相簿清單那批現在沒有它就 401。
 *
 * `notConfigured` 是後端還沒設 GUEST_PASSWORD。這件事跟「密碼打錯」要分開講，
 * 不然使用者會一直重打一個永遠不可能對的密碼。
 */
export async function verifyGuest(
  password: string,
): Promise<{ success: boolean; message?: string; notConfigured?: boolean }> {
  try {
    const res = await fetch(`${API_BASE_URL}/verify-guest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });

    const contentType = res.headers.get('content-type');
    if (!contentType || !contentType.includes('application/json')) {
      const text = await res.text();
      return { success: false, message: `伺服器阻擋: ${res.status} ${text}` };
    }

    const data = await res.json();
    if (res.ok && data.success && data.token) {
      localStorage.setItem(SITE_TOKEN_KEY, data.token);
      return { success: true };
    }
    if (res.status === 503 || data.error === 'not_configured') {
      return { success: false, notConfigured: true, message: '這個網站還沒設定進站密碼' };
    }
    return { success: false, message: data.error === 'Unauthorized' ? '密碼錯誤' : (data.error || '密碼錯誤') };
  } catch (error: any) {
    console.error(error);
    return { success: false, message: `連線錯誤: ${error.message}` };
  }
}

/**
 * 登入中的那個人。訪客一律是 null。
 *
 * `id` 為 null 只可能發生在「資料庫裡連一個帳號都沒有 + 用管理員密碼登入」，
 * 那時後端把他當站長。畫面上照樣顯示得出來，只是改不了名字。
 */
export interface CurrentUser {
  id: number | null;
  name: string | null;
  email: string | null;
  /** 'owner' = 站長，唯一看得到後台設定的人 */
  role: 'owner' | 'member';
  /** 1 = 可以新增／刪除別人的相簿與照片 */
  can_manage_others: number;
  /**
   * 1 = 可以把照片**加進**別人建的相簿（上傳／從 Google 相簿匯入）。**預設就是 1。**
   *
   * 跟 can_manage_others 是兩件事：加進去的照片主人自己刪得掉，改名／刪相簿
   * 則救不回來（見後端 migrations/0010）。`can_manage_others=1` 的人後端一律
   * 回 1，前端不必自己再 or 一次。
   *
   * 選填是為了舊後端 —— 讀不到就當作沒有這個能力，畫面少一顆按鈕比多一顆
   * 按了 403 的好。
   */
  can_add_to_others?: number;
  /** 1 = 可以調整別人相簿裡的照片順序。預設 0，站長在 /admin 給 */
  can_reorder_others?: number;
  /**
   * 他的軌跡在地圖上的顏色（'#rrggbb'）。後端一律回**算好的值** ——
   * 沒挑過色的人也會拿到依 uid 分配的預設，所以正常情況下不會是 null。
   * （舊後端沒有這一欄，所以型別上仍然可能缺。）
   */
  track_color?: string | null;
}

/** 進站狀態。admin 與 guest 都是 false 代表連門都還沒進，該顯示進站畫面 */
export interface AuthState {
  admin: boolean;
  guest: boolean;
  /**
   * 看不看得到足跡地圖。管理員永遠 true；訪客要站長在後台開了才有。
   * 沒開的話首頁不會出現那個連結，直接打 /map 也會被擋。
   */
  canViewMap: boolean;
  user: CurrentUser | null;
}

/**
 * 確認 localStorage 裡的 token 還有效（沒過期、簽章對），以及它是哪一種身分。
 *
 * 這是「是不是管理員」與「進不進得了站」的唯一依據。以前是把明文密碼存在
 * localStorage 再重打一次 verify-password，那個密碼同時是 JWT 的簽章金鑰，
 * 不該留在瀏覽器裡；而只檢查 token 這個 key 存不存在也不行 —— 過期後 key 還在，
 * 編輯介面會繼續出現然後每一個按鈕都被後端 401 擋掉。
 *
 * 連不上後端時回全 false。**這代表整站被擋在進站畫面外**，看起來很嚴厲，
 * 但反過來（樂觀放行）更糟：畫面會進得去而每一支 API 都空手而回，
 * 使用者只會看到一個空相簿列表，完全不知道是網路斷了。
 */
export async function checkAuth(): Promise<AuthState> {
  const locked: AuthState = { admin: false, guest: false, canViewMap: false, user: null };
  if (typeof window === 'undefined') return locked;
  // 舊版把明文密碼存在這個 key。清掉已經留在使用者瀏覽器裡的那一份，
  // 否則它會一直躺在那裡。等所有裝置都開過一次站之後這行就可以刪了。
  localStorage.removeItem('admin_password');
  if (!localStorage.getItem(SITE_TOKEN_KEY)) return locked;
  try {
    const res = await fetch(`${API_BASE_URL}/auth/me`, { headers: getAuthHeaders() });
    if (res.ok) {
      const data = await res.json();
      return {
        admin: !!data.admin,
        guest: !!data.guest,
        // 舊後端不回這個欄位 —— 管理員照樣看得到，訪客則保守地當成沒開
        canViewMap: data.can_view_map != null ? !!data.can_view_map : !!data.admin,
        user: data.user ?? null,
      };
    }
    // 401 = 過期或無效。留著只會讓下次進站又錯判一遍
    if (res.status === 401) clearSiteToken();
    return locked;
  } catch (error) {
    console.error(error);
    return locked;
  }
}

/**
 * 登出：把手上的兩張 token 都丟掉。
 *
 * Google 的那張一定要一起清 —— 只清站上的 token，下一個人在同一台電腦上
 * 按「傳到 Drive」時用的還是前一個人的 Google 授權。
 *
 * 沒有對應的後端呼叫：JWT 是無狀態的，作廢它只能等過期，或由站長在後台
 * 把那個帳號移出白名單（那一步是立刻生效的，見後端的 currentActor）。
 */
export function logout(): void {
  clearSiteToken();
  clearGoogleToken();
}

/**
 * 改自己的個人設定。就顯示名稱與軌跡顏色兩欄改得動，信箱與權限都不行。
 *
 * 兩個都是選填、各自獨立更新 —— 只送顏色不會把名字洗掉。
 * `track_color` 送 null 是清掉（退回依 uid 的預設色），不是「不要改」。
 */
async function updateMe(
  patch: { name?: string; track_color?: string | null },
  failMessage: string,
): Promise<{ success: boolean; user?: CurrentUser; message?: string }> {
  try {
    const res = await fetch(`${API_BASE_URL}/me`, {
      method: 'PUT',
      headers: getAuthHeaders(),
      body: JSON.stringify(patch),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.success) return { success: true, user: data.user };
    return { success: false, message: data.error || failMessage };
  } catch (error: any) {
    return { success: false, message: `連線錯誤: ${error.message}` };
  }
}

/** 改自己的顯示名稱 */
export function updateMyName(name: string) {
  return updateMe({ name }, '改名失敗');
}

/** 挑自己在地圖上的軌跡顏色。只收 TRACK_PALETTE 裡的值，null 是退回預設色 */
export function updateMyTrackColor(color: string | null) {
  return updateMe({ track_color: color }, '換色失敗');
}

/**
 * 站上的一個家人。只有畫地圖與色票列需要的三欄 ——
 * 信箱、權限那些是 /api/admin/users（站長專屬）的事。
 */
export interface TrackMember {
  id: number;
  name: string | null;
  /** 後端算好的顏色，一定有值 */
  track_color: string;
}

/**
 * 站上有哪些家人、各是什麼顏色。任何管理員都讀得到（不是站長專屬）——
 * 地圖圖例要把 user_id 換成人名，帳號牌的色票列要標出誰用了哪個顏色。
 */
export async function fetchTrackMembers(): Promise<TrackMember[]> {
  try {
    const res = await fetch(`${API_BASE_URL}/track-members`, { headers: getAuthHeaders() });
    if (!res.ok) return [];
    return await res.json();
  } catch (error) {
    console.error(error);
    return [];
  }
}

/* ── 站長專用：白名單 ──────────────────────────────────────────────────────
 *
 * 這幾支後端只讓 role='owner' 進，前端的 /admin 頁面也只在站長身上顯示。
 * 兩邊都擋不是重複 —— 前端那層是為了不端出按下去必定失敗的介面。
 */

export interface WhitelistUser extends CurrentUser {
  id: number;
  active: number;
  last_login_at: string | null;
  created_at: string | null;
  /** 他名下有多少東西。移除他之前要讓站長看得到這個數字 */
  album_count: number;
  photo_count: number;
  /** 他在地圖上的軌跡顏色（P2 才給他自己挑，這裡先讀得到） */
  track_color: string | null;
  /** 他那個 GPSLogger Drive 資料夾的 id。null ＝ 還沒綁，他同步不到任何東西 */
  track_drive_folder_id: string | null;
}

/** 分享給服務帳號的一個 Drive 資料夾。站長從這份清單挑來綁人 */
export interface SharedDriveFolder {
  id: string;
  name: string;
  /** 分享者的 Google 信箱。用它自動猜出這是誰的資料夾 */
  ownerEmail: string | null;
  modifiedTime: string | null;
  /** 信箱對得上站上帳號時的建議人選，對不上是 null */
  suggestedUserId: number | null;
}

/**
 * 列出所有分享給服務帳號的 Drive 資料夾。站長限定。
 *
 * `serviceAccount` 是要請家人分享給誰的那個信箱 —— 畫面上一定要顯示，
 * 不然沒有人知道資料夾該分享給誰。
 */
export async function fetchSharedDriveFolders(): Promise<{
  serviceAccount: string; folders: SharedDriveFolder[];
}> {
  const res = await fetch(`${API_BASE_URL}/tracks/drive/shared-folders`, { headers: getAuthHeaders() });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || '讀取分享資料夾失敗');
  return await res.json();
}

/** 綁定（或用 null 解除）某個人的 GPSLogger 資料夾。站長限定 */
export async function setUserTrackFolder(
  id: number, folderId: string | null,
): Promise<{ success: boolean; message?: string }> {
  const res = await fetch(`${API_BASE_URL}/admin/users/${id}/track-folder`, {
    method: 'PUT',
    headers: getAuthHeaders(),
    body: JSON.stringify({ folder_id: folderId }),
  });
  const data = await res.json().catch(() => ({}));
  if (res.ok && data.success) return { success: true };
  return { success: false, message: data.error || '綁定失敗' };
}

export async function fetchWhitelist(): Promise<WhitelistUser[]> {
  const res = await fetch(`${API_BASE_URL}/admin/users`, { headers: getAuthHeaders() });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || '讀取白名單失敗');
  return await res.json();
}

export async function addWhitelistUser(
  email: string, name: string, canManageOthers: boolean,
): Promise<{ success: boolean; restored?: boolean; message?: string }> {
  const res = await fetch(`${API_BASE_URL}/admin/users`, {
    method: 'POST',
    headers: getAuthHeaders(),
    body: JSON.stringify({ email, name, can_manage_others: canManageOthers }),
  });
  const data = await res.json().catch(() => ({}));
  if (res.ok && data.success) return { success: true, restored: !!data.restored };
  return { success: false, message: data.error || '新增失敗' };
}

export async function updateWhitelistUser(
  id: number,
  patch: {
    name?: string; can_manage_others?: boolean; active?: boolean;
    can_add_to_others?: boolean; can_reorder_others?: boolean;
  },
): Promise<{ success: boolean; message?: string }> {
  const res = await fetch(`${API_BASE_URL}/admin/users/${id}`, {
    method: 'PUT',
    headers: getAuthHeaders(),
    body: JSON.stringify(patch),
  });
  const data = await res.json().catch(() => ({}));
  if (res.ok && data.success) return { success: true };
  return { success: false, message: data.error || '修改失敗' };
}

/**
 * 移出白名單 ＝ **停權**，後端永遠不刪那一列（刪了會 CASCADE 掉他的相簿，而且
 * 停權的人留在名單上才看得見、才點得回來）。`albumCount` 是他名下還留著幾本相簿，
 * 用來告訴站長「東西還在」。
 */
export async function removeWhitelistUser(
  id: number,
): Promise<{ success: boolean; albumCount?: number; message?: string }> {
  const res = await fetch(`${API_BASE_URL}/admin/users/${id}`, {
    method: 'DELETE',
    headers: getAuthHeaders(),
  });
  const data = await res.json().catch(() => ({}));
  if (res.ok && data.success) return { success: true, albumCount: data.album_count };
  return { success: false, message: data.error || '移除失敗' };
}

/** 刪掉一個帳號**之前**先問清楚會少掉什麼。三個數字互相獨立，勾選才有意義 */
export interface PurgePreview {
  id: number;
  email: string;
  /** 他建立的相簿有幾本 */
  albums: number;
  /** 那些相簿裡總共幾張照片（含別人傳進去的 —— 相簿刪掉它們也留不住） */
  photos_in_albums: number;
  /** 他上傳過的照片總數，也就是勾「清除他上傳的相片」會刪掉的量 */
  photos_uploaded: number;
  /** 上一個數字裡面，放在**別人**相簿的有幾張。會動到別人的東西，得單獨講 */
  photos_elsewhere: number;
  /** 他名下有幾天的足跡。跟相簿完全無關，所以是第四個獨立的勾選 */
  track_days: number;
}

export async function fetchPurgePreview(id: number): Promise<PurgePreview> {
  const res = await fetch(`${API_BASE_URL}/admin/users/${id}/purge`, { headers: getAuthHeaders() });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || '讀取失敗');
  return await res.json();
}

/**
 * **刪除帳號**，跟 removeWhitelistUser（停權）是兩件事：這一支真的把 User 那一列
 * 刪掉，白名單上再也看不到他，而且不可逆。
 *
 * 三個範圍各自獨立，都不勾就只是把帳號抹掉：
 * - `albums`：他建的相簿整本刪掉，**連裡面別人傳的照片也一起沒了**。
 * - `photos`：他上傳的照片刪掉，**包含放在別人相簿裡的那些**。
 * - `tracks`：他的足跡整批刪掉，連 R2 上的原始 GPX 與貼路結果一起清。
 *
 * 沒被勾到的東西不會消失，會改掛到站長名下（相簿的主人欄位不允許空白）。
 */
export async function purgeWhitelistUser(
  id: number, scope: { albums: boolean; photos: boolean; tracks: boolean },
): Promise<{
  success: boolean; message?: string;
  deletedAlbums?: number; deletedPhotos?: number; keptAlbums?: number;
  deletedTrackDays?: number; keptTrackDays?: number;
}> {
  const query = `albums=${scope.albums ? 1 : 0}&photos=${scope.photos ? 1 : 0}&tracks=${scope.tracks ? 1 : 0}`;
  const res = await fetch(`${API_BASE_URL}/admin/users/${id}/purge?${query}`, {
    method: 'DELETE',
    headers: getAuthHeaders(),
  });
  const data = await res.json().catch(() => ({}));
  if (res.ok && data.success) {
    return {
      success: true,
      deletedAlbums: data.deleted_albums,
      deletedPhotos: data.deleted_photos,
      keptAlbums: data.kept_albums,
      deletedTrackDays: data.deleted_track_days,
      keptTrackDays: data.kept_track_days,
    };
  }
  return { success: false, message: data.error || '刪除失敗' };
}

/** 站台開關。目前只有一個，之後要加就往這裡放 */
export interface SiteSettings {
  /** 訪客能不能看足跡地圖。預設 0 */
  guest_can_view_map: number;
}

export async function fetchSiteSettings(): Promise<SiteSettings> {
  const res = await fetch(`${API_BASE_URL}/admin/settings`, { headers: getAuthHeaders() });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || '讀取站台設定失敗');
  return await res.json();
}

export async function updateSiteSettings(
  patch: Partial<Record<keyof SiteSettings, boolean>>,
): Promise<{ success: boolean; settings?: SiteSettings; message?: string }> {
  const res = await fetch(`${API_BASE_URL}/admin/settings`, {
    method: 'PUT',
    headers: getAuthHeaders(),
    body: JSON.stringify(patch),
  });
  const data = await res.json().catch(() => ({}));
  if (res.ok && data.success) {
    return { success: true, settings: { guest_can_view_map: data.guest_can_view_map ?? 0 } };
  }
  return { success: false, message: data.error || '修改失敗' };
}

/** 分頁查詢的共用參數。q 與 tags 交給後端做，前端不再自己過濾 */
export interface QueryOptions {
  q?: string;
  tagIds?: number[];
  offset?: number;
  limit?: number;
  /** 只有相簿清單看得懂；照片一律照拍攝時間新到舊 */
  sort?: 'custom' | 'upload_date';
}

function queryString(opts: QueryOptions): string {
  const sp = new URLSearchParams();
  if (opts.q?.trim()) sp.set('q', opts.q.trim());
  if (opts.tagIds?.length) sp.set('tags', opts.tagIds.join(','));
  if (opts.offset) sp.set('offset', String(opts.offset));
  if (opts.limit) sp.set('limit', String(opts.limit));
  if (opts.sort) sp.set('sort', opts.sort);
  const s = sp.toString();
  return s ? `?${s}` : '';
}

/**
 * 相簿清單，一次一頁。
 *
 * 以前是一次回傳全部相簿、連同每本的 10 張預覽圖，而那 10 張是後端用窗口函式
 * 掃過整張 Photo 表算出來的。現在改成分頁 + 每本 5 張隨機預覽（後端走
 * shuffle_key 索引），`has_more` 為 true 就再要下一頁。
 *
 * q / tagIds 也一起送給後端 —— 相簿既然是分頁的，就不可能再靠前端過濾，
 * 手上根本沒有還沒載入的那幾頁。
 */
export async function fetchAlbums(
  opts: QueryOptions = {},
): Promise<{ albums: Album[]; hasMore: boolean }> {
  try {
    // 進站閘門之後這條也要帶 token（訪客或管理員都行），不帶就是 401
    const res = await fetch(`${API_BASE_URL}/albums${queryString(opts)}`, {
      headers: getAuthHeaders(),
    });
    if (!res.ok) throw new Error('Failed to fetch albums');
    const data = await res.json();
    return { albums: data.albums ?? [], hasMore: !!data.has_more };
  } catch (error) {
    console.error(error);
    return { albums: [], hasMore: false };
  }
}

/**
 * 整份相簿清單（自動翻頁）。只給真的需要「全部」的地方用 —— 目前是地圖頁的
 * 相簿下拉選單與隱私開關。每頁 60 本是後端 limit 上限，300 本相簿約 5 次請求；
 * 一般列表請改用分頁版 fetchAlbums()，不要為了方便就把整份抓下來。
 */
export async function fetchAllAlbums(): Promise<Album[]> {
  const all: Album[] = [];
  // 上限當保險絲：後端若哪天 has_more 恆為 true，也不會變成無窮迴圈
  for (let page = 0; page < 50; page++) {
    const { albums, hasMore } = await fetchAlbums({ limit: 60, offset: all.length });
    all.push(...albums);
    if (!hasMore || albums.length === 0) break;
  }
  return all;
}

/**
 * 單一相簿。相簿頁只需要這一本的名稱與封面，不該為此把整份清單抓下來
 * —— 清單分頁之後那招也不再成立，要的那本可能根本不在第一頁。
 */
export async function fetchAlbum(albumId: string | number): Promise<Album | null> {
  try {
    const res = await fetch(`${API_BASE_URL}/albums/${albumId}`, {
      headers: getAuthHeaders(),
    });
    if (!res.ok) throw new Error('Failed to fetch album');
    return res.json();
  } catch (error) {
    console.error(error);
    return null;
  }
}

/**
 * 相簿裡的照片。**一定要帶 token**（跟 searchPhotos 同理）：
 * 這條路由本身公開，但後端的 applyGeoPrivacy 對沒登入的請求會把 lat/lng/place_name
 * 抹成 null，而 map_private **預設就是 1**。不帶 token 的話管理者在自己的相簿頁
 * 看到的每張照片都是「沒有位置」，指定完地點也不會變 —— 資料其實寫進去了，
 * 只是這支 API 不肯把它交出來。
 */
export async function fetchPhotos(albumId: string | number): Promise<Photo[]> {
  try {
    const res = await fetch(`${API_BASE_URL}/albums/${albumId}/photos`, {
      headers: getAuthHeaders(),
    });
    if (!res.ok) throw new Error('Failed to fetch photos');
    return res.json();
  } catch (error) {
    console.error(error);
    return [];
  }
}

/**
 * 全站照片搜尋（取代舊的 fetchAllPhotos）。
 *
 * 以前是把全站每一張照片抓回瀏覽器再用 includes() 過濾。首頁沒打關鍵字時那份
 * 資料根本沒用到，卻每次進站都掃完整張 Photo 表。現在關鍵字與標籤都由後端的
 * PhotoFts / idx_phototag_tag 處理，只回傳真正命中的那一頁。
 *
 * 一樣帶 token：這條路由公開，但沒帶驗證時後端會套 applyGeoPrivacy，而
 * map_private **預設就是 1**，管理者會看到自己每張照片都「沒有位置」。
 * 未登入時 token 是空字串，後端驗不過，行為與匿名請求相同。
 */
export async function searchPhotos(
  opts: QueryOptions = {},
): Promise<{ photos: Photo[]; hasMore: boolean }> {
  try {
    const res = await fetch(`${API_BASE_URL}/search${queryString(opts)}`, {
      headers: getAuthHeaders(),
    });
    if (!res.ok) throw new Error('Failed to search photos');
    const data = await res.json();
    return { photos: data.photos ?? [], hasMore: !!data.has_more };
  } catch (error) {
    console.error(error);
    return { photos: [], hasMore: false };
  }
}

/**
 * 時間軸比對用的照片清單（僅管理者）。
 *
 * 這是唯一還需要「全部照片」的地方 —— 要知道哪張照片對得上哪個時間點，本來就
 * 得看過每一張。差別在於只取比對真正用得到的四個欄位，而且用 id 當游標分批抓，
 * 不會有單一個超大回應把 Worker 的記憶體或 CPU 撐爆。
 *
 * onlyMissing 交給後端過濾，能少載回幾萬張已經有座標的照片。
 */
export async function fetchGeoPendingPhotos(onlyMissing: boolean): Promise<Photo[] | null> {
  const out: Photo[] = [];
  let cursor = 0;
  try {
    // 上限純粹是保險絲：正常情況下 done 會先為 true。沒有它的話，後端若因為
    // 某個 bug 一直回同一個 cursor，這裡會變成無窮迴圈把瀏覽器鎖死。
    for (let page = 0; page < 200; page++) {
      const res = await fetch(
        `${API_BASE_URL}/photos/geo-pending?cursor=${cursor}&limit=1000`
          + (onlyMissing ? '&only_missing=1' : ''),
        { headers: getAuthHeaders() },
      );
      if (!res.ok) throw new Error('Failed to fetch geo-pending photos');
      const data = await res.json();
      out.push(...(data.photos ?? []));
      if (data.done || !data.photos?.length) break;
      cursor = data.next_cursor;
    }
    return out;
  } catch (error) {
    console.error(error);
    /*
     * 失敗回 null 而不是空陣列。
     *
     * 空陣列在這裡是個合法且有意義的答案（「全部都有座標了」），呼叫端會拿它
     * 去顯示「沒有待處理的照片」。把失敗也講成空陣列，使用者看到的就是一個
     * 假的完成畫面。回傳已經抓到的半套資料同樣不行 —— 那會讓比對只跑一部分
     * 照片，卻表現得像跑完了。
     */
    return null;
  }
}

/*
 * ---- R2 縮圖 ----
 *
 * 舊版只產一張 400px，而且是用 `'image/jpeg', 1.0` 編碼的。q1.0 幾乎不壓縮，
 * 實測 133 張現有縮圖平均 118 KB —— 光縮圖在 15 萬張時就要 18 GB，
 * 現有程式碼本身就會撐爆 R2 的 10 GB 免費額度，跟任何新功能無關。
 *
 * 改成兩個尺寸的 WebP q80：
 *   400px（10.9 KB）給首頁相簿卡片輪播與地圖標記
 *   800px（41.3 KB）給相簿格線
 * 兩張加起來 52.2 KB，還不到舊版一張的一半。
 *
 * 主檔（resizeImageFile 產的 2000px JPEG）刻意不動：它帶著 piexifjs 寫回去的
 * EXIF，而 piexifjs 不支援 WebP，改格式等於把 EXIF 從檔案裡剝掉。
 * 主檔搬去 Drive 是 Phase 3 的事。
 */
const THUMB_QUALITY = 0.8;
const THUMB_MAX_EDGE_SM = 400;
const THUMB_MAX_EDGE_MD = 800;

let webpEncodable: boolean | null = null;
/**
 * `canvas.toBlob` 給不認得的 MIME 型別時會**安靜地**吐 PNG 回來，不會報錯。
 * 不先問清楚的話，不支援 WebP 編碼的瀏覽器會把 PNG 當縮圖傳上去 —— 那比原本的
 * JPEG 還大，等於在修額度問題的同時把它弄得更糟。
 */
function canEncodeWebp(): boolean {
  if (webpEncodable === null) {
    const probe = document.createElement('canvas');
    probe.width = probe.height = 1;
    webpEncodable = probe.toDataURL('image/webp').startsWith('data:image/webp');
  }
  return webpEncodable;
}

function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    // 用 objectURL 而不是 FileReader 的 data URL：後者要先把整份檔案 base64 化，
    // 多花 33% 記憶體與一趟編碼，批次上傳幾百張時很有感
    const objectUrl = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(objectUrl); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(objectUrl); reject(new Error('圖片解碼失敗')); };
    img.src = objectUrl;
  });
}

function encodeThumb(img: HTMLImageElement, maxEdge: number): Promise<Blob | null> {
  // 只縮不放：原圖比目標還小的時候放大只會多佔位元組，畫質一點都不會變好
  const scale = Math.min(1, maxEdge / Math.max(img.width, img.height));
  const width = Math.max(1, Math.round(img.width * scale));
  const height = Math.max(1, Math.round(img.height * scale));

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return Promise.resolve(null);

  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, width, height);

  const type = canEncodeWebp() ? 'image/webp' : 'image/jpeg';
  return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob), type, THUMB_QUALITY));
}

interface ThumbnailSet {
  /** 400px，給首頁卡片輪播與地圖標記 */
  sm: Blob | null;
  /** 800px，給相簿格線 */
  md: Blob | null;
}

async function generateThumbnails(file: File): Promise<ThumbnailSet> {
  if (!file.type.startsWith('image/')) return { sm: null, md: null };

  // 兩個尺寸共用同一次解碼。2000px 的 JPEG 解一次就要好幾十毫秒，
  // 各解一次等於整批上傳白等一倍的時間
  const img = await loadImage(file);
  const [sm, md] = await Promise.all([
    encodeThumb(img, THUMB_MAX_EDGE_SM),
    encodeThumb(img, THUMB_MAX_EDGE_MD),
  ]);
  return { sm, md };
}

/** 上傳成功後回傳的那一筆，null 代表失敗 */
export interface UploadedPhoto {
  id: number;
  /** EXIF 有帶座標才有值。null 代表這張需要事後補位置 */
  lat: number | null;
  lng: number | null;
}

/** 後端判定「這張跟相簿裡某幾張撞了」時回報的那幾張 */
export interface DuplicateMatch {
  id: number;
  title: string | null;
  thumb_url: string | null;
  taken_at: string | null;
}

/**
 * 上傳的三種結局。
 *
 * 以前只回 `UploadedPhoto | null`，`null` 同時代表「壞掉」與「不該傳」，
 * 呼叫端沒辦法分辨，重複偵測就無從顯示。分成三種之後每種都講得出下一步。
 */
export type UploadResult =
  | { status: 'ok'; photo: UploadedPhoto }
  | { status: 'duplicate'; reason: 'same_file' | 'same_time'; existing: DuplicateMatch[] }
  | { status: 'error' };

export async function uploadPhoto(
  albumId: string,
  file: File,
  exifData?: any,
  takenAt?: string,
  /** 使用者在重複清單裡選了「照樣上傳」才給 true */
  allowDuplicate = false,
): Promise<UploadResult> {
  const formData = new FormData();
  formData.append('album_id', albumId);
  // 檔名要另外送：R2 只收縮圖，而縮圖的 blob 沒有原始檔名
  formData.append('filename', file.name);
  if (allowDuplicate) formData.append('allow_duplicate', '1');

  /*
   * **只送兩張縮圖，不再送 2000px 那份**（2026-08-14）。
   * R2 現在只存 800 + 400，全尺寸的版本在 Drive（4K + 原始檔）。
   * 少傳一份 2000px 的 JPEG，手機上傳的流量也跟著省下來。
   *
   * 800px 那張是必要的 —— 它同時是相簿格線的圖、燈箱在沒有 Drive 時的退路，
   * 沒有它後端會直接回 400，這張照片不會進資料庫。
   */
  let md: Blob | null = null;
  let sm: Blob | null = null;
  try {
    ({ sm, md } = await generateThumbnails(file));
  } catch (err) {
    console.warn("縮圖產生失敗，這張照片不會上傳", err);
  }
  if (!md) return { status: 'error' };
  // R2 的物件鍵副檔名由後端依 blob.type 決定，這裡的檔名只是 FormData 的擺設
  formData.append('thumb', md, 'thumb');
  if (sm) formData.append('thumb_sm', sm, 'thumb_sm');

  if (exifData) {
    try {
      const allowedKeys = [
        'Make', 'Model', 'DateTimeOriginal', 'Software', 'Orientation',
        'ExposureTime', 'FNumber', 'ISO', 'FocalLength', 'LensModel',
        // GPS：latitude/longitude 是 exifr 已換算好的十進位座標，優先採用
        'latitude', 'longitude',
        // 原始 GPS 值 + 半球參考 (N/S、E/W)，缺 Ref 就無法判斷南北半球
        'GPSLatitude', 'GPSLatitudeRef', 'GPSLongitude', 'GPSLongitudeRef',
        'GPSAltitude', 'GPSAltitudeRef',
        // 時區還原：OffsetTimeOriginal 是拍攝當下的 UTC 偏移；
        // GPSDateStamp/GPSTimeStamp 為 UTC，可與 DateTimeOriginal 相減反推偏移
        'OffsetTimeOriginal', 'GPSDateStamp', 'GPSTimeStamp',
      ];
      const filteredExif: any = {};
      for (const key of allowedKeys) {
        if (exifData[key] !== undefined) {
          filteredExif[key] = exifData[key];
        }
      }
      formData.append('exif', JSON.stringify(filteredExif));
    } catch (err) {
      console.warn("Failed to stringify EXIF data", err);
    }
  }
  if (takenAt) formData.append('taken_at', takenAt);

  try {
    const token = localStorage.getItem(SITE_TOKEN_KEY) || '';
    const res = await fetch(`${API_BASE_URL}/upload`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}` },
      body: formData,
    });
    if (!res.ok) return { status: 'error' };
    const data = await res.json();
    if (data?.duplicate) {
      return {
        status: 'duplicate',
        reason: data.reason === 'same_file' ? 'same_file' : 'same_time',
        existing: Array.isArray(data.existing) ? data.existing : [],
      };
    }
    if (typeof data?.id !== 'number') return { status: 'error' };
    return {
      status: 'ok',
      photo: {
        id: data.id,
        lat: typeof data.lat === 'number' ? data.lat : null,
        lng: typeof data.lng === 'number' ? data.lng : null,
      },
    };
  } catch (error) {
    console.error(error);
    return { status: 'error' };
  }
}

/* ---- Drive（Phase 3）---- */

export interface DriveConfig {
  /** OAuth 用戶端 id。拿 drive.file token 用 */
  client_id: string | null;
  /** service account 的信箱，網頁建完資料夾要把它加成 writer */
  sa_email: string | null;
  /** null 代表還沒建過，網頁該去 bootstrap */
  photos_folder_id: string | null;
  trash_folder_id: string | null;
  /**
   * 這個環境的根資料夾要叫什麼：local `local.didadida`／dev `dev.didadida`／
   * prod `didadida`。三個環境共用站長同一個 Drive，名字是唯一的隔離手段。
   * 由後端依部署環境回，前端不自己判斷。
   */
  root_folder_name: string | null;
  /**
   * Drive 上唯一的寫入身分＝**站長**，不是「現在登入的人」。所有管理員上傳時都跟
   * 後端換這個帳號的短效 token，這樣誰建的相簿都寫得進去（見 lib/drive.ts 檔頭）。
   *
   * 授權來自環境 secret 或站長登入時後端自動收下的那份，站上沒有連結入口，
   * 所以這一欄**可能是 null 但備份照樣正常**（走 secret 那條就沒有信箱可記）。
   * 別拿它當「能不能上傳」的判斷。
   */
  writer_email: string | null;
  /** 站長那份授權是什麼時候收下的（ISO）。走 secret 的話是 null */
  writer_linked_at: string | null;
  /** client_id、sa_email、寫入帳號三樣都齊了才有辦法上傳 */
  ready: boolean;
}

export interface DriveWriterToken {
  accessToken: string;
  /** 後端已經先扣掉一點餘裕了，直接拿來算過期時間即可 */
  expiresIn: number;
  email: string | null;
}

export class DriveWriterError extends Error {
  constructor(
    /** `not_linked`／`expired` 要人去連結，`failed` 才值得重試 */
    readonly reason: 'not_linked' | 'expired' | 'failed',
    message: string,
  ) {
    super(message);
    this.name = 'DriveWriterError';
  }
}

/**
 * 跟後端換一張 Drive 寫入用的 access token。
 *
 * 拿不到就丟 DriveWriterError —— 上傳流程要靠 reason 決定是「叫人重新連結」
 * 還是「等一下再試」，回 null 的話這兩件事分不出來。
 */
export async function fetchDriveWriterToken(): Promise<DriveWriterToken> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE_URL}/drive/token`, { method: 'POST', headers: getAuthHeaders() });
  } catch (error) {
    console.error(error);
    throw new DriveWriterError('failed', '連不上後端，拿不到 Drive 授權');
  }
  const data = await res.json().catch(() => null) as
    | { access_token?: string; expires_in?: number; email?: string | null; error?: string; reason?: string }
    | null;

  if (!res.ok || !data?.access_token) {
    const reason = data?.reason === 'not_linked' || data?.reason === 'expired' ? data.reason : 'failed';
    throw new DriveWriterError(reason, data?.error || `Drive 授權失敗（HTTP ${res.status}）`);
  }
  return {
    accessToken: data.access_token,
    expiresIn: Number(data.expires_in) || 300,
    email: data.email ?? null,
  };
}

export async function fetchDriveConfig(): Promise<DriveConfig | null> {
  try {
    const res = await fetch(`${API_BASE_URL}/config/drive`, { headers: getAuthHeaders() });
    if (!res.ok) return null;
    return await res.json();
  } catch (error) {
    console.error(error);
    return null;
  }
}

/** 只寫得進去一次；後端對已設定過的回 409（見那條路由的說明） */
export async function saveDriveFolders(photosFolderId: string, trashFolderId: string): Promise<boolean> {
  try {
    const res = await fetch(`${API_BASE_URL}/config/drive-folders`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({ photos_folder_id: photosFolderId, trash_folder_id: trashFolderId }),
    });
    // 409 = 別人已經寫過了。那正是我們要的狀態，不算失敗
    return res.ok || res.status === 409;
  } catch (error) {
    console.error(error);
    return false;
  }
}

/**
 * 把 Drive 的 file id 記回 D1。兩個都是選填 —— 只成功一個也要記，
 * 後端用 COALESCE 保護已有的值，重跑不會把上次的成果洗成 NULL。
 */
export async function recordPhotoDrive(
  photoId: number,
  ids: { driveFileId?: string | null; driveOriginalId?: string | null },
): Promise<boolean> {
  if (!ids.driveFileId && !ids.driveOriginalId) return false;
  try {
    const res = await fetch(`${API_BASE_URL}/photos/${photoId}/drive`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({
        drive_file_id: ids.driveFileId ?? undefined,
        drive_original_id: ids.driveOriginalId ?? undefined,
      }),
    });
    return res.ok;
  } catch (error) {
    console.error(error);
    return false;
  }
}

/**
 * 登記相簿在 Drive 上的資料夾 id，回傳實際生效的那個。
 *
 * **一定要用回傳值，不要用自己傳進去的那個** —— 後端用 COALESCE 保護既有值，
 * 別的分頁先建過的話會回它那個，這時候自己建的那個資料夾就該放著別用了。
 *
 * `rebind` 會蓋掉既有值，只給一種情況用：記著的資料夾是別的帳號建的、
 * 寫入身分看不見（探路回 404）。其他任何理由都不該傳（見後端那條路由的說明）。
 */
export async function saveAlbumDriveFolder(
  albumId: number,
  folderId: string,
  rebind = false,
): Promise<string | null> {
  try {
    const res = await fetch(`${API_BASE_URL}/albums/${albumId}/drive-folder`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({ folder_id: folderId, ...(rebind ? { rebind: true } : {}) }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return typeof data?.folder_id === 'string' ? data.folder_id : null;
  } catch (error) {
    console.error(error);
    return null;
  }
}

export interface DrivePendingPhoto {
  id: number;
  url: string;
  /** 加了時間戳的 R2 鍵，不是使用者看到的檔名 */
  file_name: string;
  /** 上傳當下的客戶端檔名。補傳時靠這個對回重選的原始檔 */
  title: string;
}

/**
 * 還沒搬上 Drive 的照片。舊照片與上傳時 Drive 失敗的照片在這裡看起來一樣。
 * 帶 albumId 就只看那本相簿（補傳從相簿頁進去時該帶）。
 */
export async function fetchDrivePending(
  cursor = 0,
  limit = 200,
  albumId?: number,
): Promise<{ photos: DrivePendingPhoto[]; remaining: number; next_cursor: number; done: boolean } | null> {
  try {
    const params = new URLSearchParams({ cursor: String(cursor), limit: String(limit) });
    if (albumId) params.set('album_id', String(albumId));
    const res = await fetch(
      `${API_BASE_URL}/photos/drive-pending?${params}`,
      { headers: getAuthHeaders() },
    );
    if (!res.ok) return null;
    return await res.json();
  } catch (error) {
    console.error(error);
    return null;
  }
}

export async function createAlbum(name: string, description?: string): Promise<boolean> {
  try {
    const res = await fetch(`${API_BASE_URL}/albums`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({ name, description }),
    });
    return res.ok;
  } catch (error) {
    console.error(error);
    return false;
  }
}

export async function deleteAlbum(id: number): Promise<boolean> {
  try {
    const res = await fetch(`${API_BASE_URL}/albums/${id}`, {
      method: 'DELETE',
      headers: getAuthHeaders(),
    });
    return res.ok;
  } catch (error) {
    console.error(error);
    return false;
  }
}

export async function updateAlbum(id: number, data: { name?: string; cover_photo_url?: string; cover_text?: string }): Promise<boolean> {
  try {
    const res = await fetch(`${API_BASE_URL}/albums/${id}`, {
      method: 'PUT',
      headers: getAuthHeaders(),
      body: JSON.stringify(data),
    });
    return res.ok;
  } catch (error) {
    console.error(error);
    return false;
  }
}

export async function deletePhoto(photoId: string | number): Promise<boolean> {
  try {
    const res = await fetch(`${API_BASE_URL}/photos/${photoId}`, {
      method: 'DELETE',
      headers: getAuthHeaders(),
    });
    return res.ok;
  } catch (error) {
    console.error(error);
    return false;
  }
}

export async function reorderAlbums(updates: { id: number; sort_order: number }[]): Promise<boolean> {
  try {
    const res = await fetch(`${API_BASE_URL}/albums/reorder`, {
      method: 'PUT',
      headers: getAuthHeaders(),
      body: JSON.stringify(updates),
    });
    return res.ok;
  } catch (error) {
    console.error(error);
    return false;
  }
}

export async function reorderPhotos(updates: { id: number; sort_order: number }[]): Promise<boolean> {
  try {
    const res = await fetch(`${API_BASE_URL}/photos/reorder`, {
      method: 'PUT',
      headers: getAuthHeaders(),
      body: JSON.stringify(updates),
    });
    return res.ok;
  } catch (error) {
    console.error(error);
    return false;
  }
}

export async function updatePhoto(id: number, data: { description?: string; taken_at?: string }): Promise<boolean> {
  try {
    const res = await fetch(`${API_BASE_URL}/photos/${id}`, {
      method: 'PUT',
      headers: getAuthHeaders(),
      body: JSON.stringify(data),
    });
    return res.ok;
  } catch (error) {
    console.error(error);
    return false;
  }
}

export async function addPhotoTag(photoId: number, tagName: string): Promise<Tag | null> {
  try {
    const res = await fetch(`${API_BASE_URL}/photos/${photoId}/tags`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({ tagName }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.tag;
  } catch (error) {
    console.error(error);
    return null;
  }
}

export async function removePhotoTag(photoId: number, tagId: number): Promise<boolean> {
  try {
    const res = await fetch(`${API_BASE_URL}/photos/${photoId}/tags/${tagId}`, {
      method: 'DELETE',
      headers: getAuthHeaders(),
    });
    return res.ok;
  } catch (error) {
    console.error(error);
    return false;
  }
}

export async function fetchTags(): Promise<Tag[]> {
  try {
    const res = await fetch(`${API_BASE_URL}/tags`, { headers: getAuthHeaders() });
    if (!res.ok) throw new Error('Failed to fetch tags');
    return await res.json();
  } catch (error) {
    console.error(error);
    return [];
  }
}

function getGoogleAuthHeaders() {
  // 走 getGoogleToken() 而不是直接讀 key：過期的 token 應該當作沒有，
  // 不要送出去換一個看不懂的 401
  const token = getGoogleToken();
  const adminToken = typeof window !== 'undefined' ? localStorage.getItem(SITE_TOKEN_KEY) : '';
  return {
    'Content-Type': 'application/json',
    'X-Google-Token': token || '',
    'Authorization': `Bearer ${adminToken}`
  };
}

export async function fetchGoogleAlbums(): Promise<any[]> {
  try {
    const res = await fetch(`${API_BASE_URL}/google/albums`, {
      headers: getGoogleAuthHeaders(),
    });
    if (res.status === 401) return [{ error: 'unauthorized' }];
    if (!res.ok) {
      console.log("Google API Failed:", await res.text());
      return [];
    }
    const data = await res.json();
    console.log("Google Albums API Response:", data);
    return data.albums || [];
  } catch (err) {
    console.error(err);
    return [];
  }
}

export async function createGooglePickerSession(): Promise<{ id?: string, pickerUri?: string }> {
  try {
    const res = await fetch(`${API_BASE_URL}/google/picker/sessions`, {
      method: "POST",
      headers: getGoogleAuthHeaders(),
    });
    if (!res.ok) return {};
    return await res.json();
  } catch (err) {
    console.error(err);
    return {};
  }
}

export async function fetchGooglePickerPhotos(sessionId: string): Promise<{ ready: boolean, mediaItems?: any[] }> {
  try {
    const res = await fetch(`${API_BASE_URL}/google/picker/sessions/${sessionId}/photos`, {
      headers: getGoogleAuthHeaders(),
    });
    if (!res.ok) return { ready: false };
    return await res.json();
  } catch (err) {
    console.error(err);
    return { ready: false };
  }
}

export async function syncGooglePhoto(albumId: string, googlePhotoUrl: string, filename: string, creationTime: string, exif?: any): Promise<boolean | any> {
  try {
    const res = await fetch(`${API_BASE_URL}/google/sync-photo`, {
      method: "POST",
      headers: getGoogleAuthHeaders(),
      body: JSON.stringify({
        targetAlbumId: albumId,
        googlePhotoUrl,
        filename,
        creationTime,
        exif
      })
    });
    
    if (res.ok) {
      const data = await res.json();
      if (data.conflict) {
        return data;
      }
      return true;
    }
    return false;
  } catch (err) {
    console.error(err);
    return false;
  }
}

export async function resolveGooglePhotoConflict(decision: string, existingPhotos: any[], tempPhoto: any, replacePhotoIds?: number[]): Promise<boolean> {
  try {
    const res = await fetch(`${API_BASE_URL}/google/resolve-conflict`, {
      method: "POST",
      headers: getGoogleAuthHeaders(),
      body: JSON.stringify({
        decision,
        existingPhotos,
        tempPhoto,
        replacePhotoIds
      })
    });
    return res.ok;
  } catch (err) {
    console.error(err);
    return false;
  }
}

// ===== 足跡地圖 =====

/** 取得足跡點位。時間參數為當地牆上時間，格式 'YYYY-MM-DD' 或 'YYYY-MM-DD HH:MM:SS' */
export async function fetchFootprint(opts: {
  from?: string;
  to?: string;
  albumId?: number;
} = {}): Promise<FootprintPoint[]> {
  try {
    const qs = new URLSearchParams();
    if (opts.from) qs.set('from', opts.from);
    if (opts.to) qs.set('to', opts.to);
    if (opts.albumId !== undefined) qs.set('album_id', String(opts.albumId));
    const res = await fetch(`${API_BASE_URL}/footprint?${qs.toString()}`, {
      headers: getAuthHeaders(),
    });
    if (!res.ok) return [];
    return await res.json();
  } catch (err) {
    console.error(err);
    return [];
  }
}

export async function fetchTripSegments(albumId?: number): Promise<TripSegment[]> {
  try {
    const qs = albumId !== undefined ? `?album_id=${albumId}` : '';
    const res = await fetch(`${API_BASE_URL}/trip-segments${qs}`, { headers: getAuthHeaders() });
    if (!res.ok) return [];
    return await res.json();
  } catch (err) {
    console.error(err);
    return [];
  }
}

export async function deleteTripSegment(id: number): Promise<boolean> {
  try {
    const res = await fetch(`${API_BASE_URL}/trip-segments/${id}`, {
      method: 'DELETE',
      headers: getAuthHeaders(),
    });
    return res.ok;
  } catch (err) {
    console.error(err);
    return false;
  }
}

/** 套用地點前先預覽影響範圍，用來提示「顯示順序 != 時間順序」造成的意外涵蓋 */
export async function previewGeoBatch(photoIds: number[]): Promise<GeoPreview | null> {
  try {
    const res = await fetch(`${API_BASE_URL}/photos/geo/preview`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({ photoIds }),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch (err) {
    console.error(err);
    return null;
  }
}

export async function assignGeoBatch(params: {
  photoIds: number[];
  lat: number;
  lng: number;
  placeName?: string;
  label?: string;
  createSegment?: boolean;
  albumId?: number;
  tzOffsetMinutes?: number;
  overwriteExif?: boolean;
}): Promise<
  | { success: true; updated: number; skippedExif: number; segmentId: number | null }
  | { success: false; error: string }
> {
  // 這條不照其他 API「失敗就回 null」的慣例：套用地點是使用者按下去等結果的動作，
  // 失敗卻什麼都不說的話，畫面看起來就只是「沒反應」，連是不是登入過期都不知道
  try {
    const res = await fetch(`${API_BASE_URL}/photos/geo/batch`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify(params),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return {
        success: false,
        error: res.status === 401
          ? '登入已過期，請重新登入後再試'
          : `伺服器回應 ${res.status}${body ? `：${body.slice(0, 200)}` : ''}`,
      };
    }
    const data = await res.json();
    return { success: true, updated: data.updated ?? 0, skippedExif: data.skippedExif ?? 0, segmentId: data.segmentId ?? null };
  } catch (err) {
    console.error(err);
    return { success: false, error: '連線失敗，請確認網路與後端服務是否正常' };
  }
}

/** 把行程段套用到還沒有座標的照片 */
export async function applyTripSegments(albumId?: number): Promise<number> {
  try {
    const res = await fetch(`${API_BASE_URL}/photos/geo/apply-segments`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({ albumId }),
    });
    if (!res.ok) return 0;
    const data = await res.json();
    return data.updated ?? 0;
  } catch (err) {
    console.error(err);
    return 0;
  }
}

// ===== 手動編輯 =====
// 不管照片有沒有 GPS、有沒有時區標籤，都要能靠手改到正確位置與時間。
// 後端維持不變式 taken_at === taken_at_local − tz_offset_minutes，
// 所以「改牆上時間」與「改時區」是兩個不同的操作，別混在一起送。

/**
 * 單張照片的手動編輯。**只送使用者真的動過的欄位**，
 * 欄位存在與不存在對後端是不同語意。
 */
export interface PhotoGeoPatch {
  /** lat/lng 要成對送。兩個都給 null 代表清掉座標；整組省略才是「不要動」 */
  lat?: number | null;
  lng?: number | null;
  placeName?: string | null;
  /** 牆上時間 'YYYY-MM-DD HH:MM:SS'。送了代表相機時鐘記錯，taken_at 會重算 */
  takenAtLocal?: string;
  /** 只送這個代表瞬間沒錯、只是拿錯時區在顯示，taken_at 不動 */
  tzOffsetMinutes?: number;
}

type PhotoGeoFields = Pick<
  Photo,
  'id' | 'lat' | 'lng' | 'place_name' | 'geo_source'
  | 'taken_at' | 'taken_at_local' | 'tz_offset_minutes' | 'time_source'
>;

/** 手動編輯單張照片的座標與時間。手動是最高權威，之後任何自動流程都不會覆蓋 */
export async function updatePhotoGeo(
  photoId: number,
  patch: PhotoGeoPatch,
): Promise<PhotoGeoFields | null> {
  try {
    const res = await fetch(`${API_BASE_URL}/photos/${photoId}/geo`, {
      method: 'PUT',
      headers: getAuthHeaders(),
      body: JSON.stringify(patch),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.photo ?? null;
  } catch (err) {
    console.error(err);
    return null;
  }
}

/**
 * 批次平移拍攝時間，用於相機時鐘走差（D800 每年慢約一分鐘）。
 * 瞬間與牆上時間一起移動、時區不變。
 */
export async function shiftPhotoTime(
  photoIds: number[],
  minutes: number,
): Promise<{ success: boolean; updated: number; skippedNoTime: number } | null> {
  try {
    const res = await fetch(`${API_BASE_URL}/photos/geo/shift-time`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({ photoIds, minutes }),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch (err) {
    console.error(err);
    return null;
  }
}

/**
 * 批次改時區，用於出國拍照但機身時區沒改。
 * taken_at 是對的，錯的只是「拿哪個時區去顯示」，所以只重算牆上時間。
 */
export async function setPhotoTimezone(
  photoIds: number[],
  tzOffsetMinutes: number,
): Promise<{ success: boolean; updated: number; skippedNoTime: number } | null> {
  try {
    const res = await fetch(`${API_BASE_URL}/photos/geo/set-timezone`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({ photoIds, tzOffsetMinutes }),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch (err) {
    console.error(err);
    return null;
  }
}

export async function setPhotoGeoPrivacy(photoIds: number[], geoPrivate: boolean): Promise<boolean> {
  try {
    const res = await fetch(`${API_BASE_URL}/photos/geo/privacy`, {
      method: 'PUT',
      headers: getAuthHeaders(),
      body: JSON.stringify({ photoIds, geoPrivate: geoPrivate ? 1 : 0 }),
    });
    return res.ok;
  } catch (err) {
    console.error(err);
    return false;
  }
}

export async function setAlbumMapPrivacy(albumId: number, mapPrivate: boolean): Promise<boolean> {
  try {
    const res = await fetch(`${API_BASE_URL}/albums/${albumId}/map-privacy`, {
      method: 'PUT',
      headers: getAuthHeaders(),
      body: JSON.stringify({ mapPrivate: mapPrivate ? 1 : 0 }),
    });
    return res.ok;
  } catch (err) {
    console.error(err);
    return false;
  }
}

/**
 * 搜尋地名（Photon，免費且免 API key）。回傳前幾筆候選讓使用者挑。
 *
 * 走自家 Worker 轉手而不是瀏覽器直連：反向查詢送出去的是照片的實際座標，
 * 直連等於把「這台裝置查過哪些位置」交給第三方。正向查詢一起收進來只是為了
 * 兩條路一致（理由同 /api/tracks/match 轉手 Valhalla）。
 */
export async function searchPlace(query: string): Promise<{ name: string; lat: number; lng: number }[]> {
  if (!query.trim()) return [];
  try {
    const res = await fetch(`${API_BASE_URL}/geo/search?q=${encodeURIComponent(query)}`, {
      headers: getAuthHeaders(),
    });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.features || []).map((f: any) => {
      const p = f.properties || {};
      const parts = [p.name, p.city, p.state, p.country].filter(Boolean);
      return {
        name: parts.join(', '),
        lng: f.geometry?.coordinates?.[0],
        lat: f.geometry?.coordinates?.[1],
      };
    }).filter((r: any) => Number.isFinite(r.lat) && Number.isFinite(r.lng));
  } catch (err) {
    console.error(err);
    return [];
  }
}

/**
 * 反查一個座標叫什麼名字。給自帶 GPS 的照片用 —— 座標已經是最準的一份，
 * 缺的只是「這是哪裡」。回傳 null 代表附近沒有值得記的地標。
 */
export async function reverseGeocode(lat: number, lng: number): Promise<string | null> {
  try {
    const res = await fetch(`${API_BASE_URL}/geo/reverse?lat=${lat}&lng=${lng}`, {
      headers: getAuthHeaders(),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return pickPlaceName(data.features || []);
  } catch (err) {
    console.error(err);
    return null;
  }
}

/**
 * 從 Photon 反查結果裡挑出最像「打卡地點」的一筆。
 *
 * 最近的那筆常常是一條路或一棟無名住宅，那不是人會想寫在照片上的東西。
 * 所以先找有名字、而且分類是地標／景點／店家的；都沒有才退回行政區名。
 */
const PLACE_KEYS = ['tourism', 'historic', 'leisure', 'amenity', 'natural', 'railway', 'aeroway', 'shop'];

function pickPlaceName(features: any[]): string | null {
  for (const f of features) {
    const p = f?.properties || {};
    if (p.name && PLACE_KEYS.includes(p.osm_key)) {
      return [p.name, p.city || p.district, p.country].filter(Boolean).join(', ');
    }
  }
  for (const f of features) {
    const p = f?.properties || {};
    const area = p.city || p.district || p.county || p.state;
    if (area) return [area, p.country].filter(Boolean).join(', ');
  }
  return null;
}

/**
 * 只補地名，座標一個字都不動。
 * 走 assignGeoBatch 會把精確的 EXIF 座標換成地名的中心點，這裡刻意不那樣做。
 */
export async function setPlaceNames(
  items: { photoId: number; placeName: string }[],
): Promise<number> {
  if (items.length === 0) return 0;
  try {
    const res = await fetch(`${API_BASE_URL}/photos/geo/place-name`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({ items }),
    });
    if (!res.ok) return 0;
    const data = await res.json();
    return data.updated ?? 0;
  } catch (err) {
    console.error(err);
    return 0;
  }
}

/**
 * 寫入由 Google 時間軸比對出來的位置。
 * 只送出比對結果，原始的 Timeline.json 不會離開瀏覽器。
 *
 * `gapMinutes` 要一起送：後端拿它決定這一筆的權威高低 —— 差太多分鐘的命中
 * 只填得了還沒有座標的照片，蓋不掉使用者親手圈的行程段。
 * 回傳的 `loose` 就是被這樣降級的筆數。
 */
export async function applyTimelineMatches(
  matches: {
    photoId: number; lat: number; lng: number;
    placeName?: string; tzOffsetMinutes?: number; gapMinutes?: number;
  }[],
  overwriteExif = false,
): Promise<{ updated: number; invalid: number; loose?: number; skipped: number } | null> {
  try {
    const res = await fetch(`${API_BASE_URL}/photos/geo/from-timeline`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({ matches, overwriteExif }),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch (err) {
    console.error(err);
    return null;
  }
}

// ===== GPS 軌跡 =====

/** Drive 上的一個 GPX 檔，以及它跟資料庫的同步狀態 */
export interface DriveGpxFile {
  /**
   * TrackDay 的主鍵。不透明，不要拿去解析日期，也不要自己拼 ——
   * 多身分之後它是「使用者前綴 + Drive 檔名」，由後端組好（見 migrations/0009）。
   * ingest、留存原文、貼路結果三者一定要用同一個值。
   */
  dayKey: string;
  /** Drive 上的檔名。純粹給畫面顯示，不要拿去打 API */
  fileName: string;
  driveFileId: string;
  md5: string | null;
  modifiedTime: string | null;
  size: number | null;
  syncedPointCount: number;
  syncedAt: string | null;
  /** md5 跟已同步的不一樣（或根本沒同步過）才需要重抓 */
  needsSync: boolean;
  /**
   * 'manual' 代表這天的內容是人決定的 —— 軌跡點被手動編修過，或整個檔是
   * 手動上傳的。重灌會洗掉，所以同步時預設跳過。
   */
  ingestSource: string | null;
}

export interface TrackPoint {
  /** TrackPoint.id，手動編修時用來指定要刪哪些點 */
  id: number;
  day_key: string;
  t_utc: string;
  lat: number;
  lng: number;
  /** GPX 的 <src>（'gps' | 'network'），或 'stay' 表示這是濃縮後的停留點 */
  src: string | null;
  seg: number;
  /**
   * 停留秒數。停留是「進入 + 離開」兩個同座標的點，前者帶秒數、後者為 null。
   * 一般的移動點也是 null。
   */
  stay_sec?: number | null;
  /** 這條軌跡是誰的（TrackDay.user_id）。地圖上依此分色 */
  user_id?: number | null;
}

/**
 * 交通工具。只剩貼路在用 —— 依速度猜出來，決定送給 Valhalla 的 costing，
 * 並記在 R2 的貼路結果裡（見 MatchedTrack.segments[].vehicle）。
 * 手動指定的介面與 TrackSegment 那條路都已經拿掉。
 */
export type Vehicle = 'walk' | 'bike' | 'motorbike' | 'car' | 'bus' | 'train' | 'plane' | 'boat';

/**
 * 列出**我自己那個** Drive 資料夾裡的 GPX 檔。要登入。
 *
 * `code === 'track_folder_unbound'` 是「這個人還沒被綁資料夾」，不是故障 ——
 * 呼叫端要能分辨，才不會在每次進頁時對還沒設定好的成員報錯。
 */
export async function fetchDriveGpxFiles(): Promise<{ files: DriveGpxFile[]; error?: string; code?: string }> {
  try {
    const res = await fetch(`${API_BASE_URL}/tracks/drive/files`, { headers: getAuthHeaders() });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return { files: [], error: body?.error || `伺服器回應 ${res.status}`, code: body?.code };
    }
    return { files: await res.json() };
  } catch (err) {
    console.error(err);
    return { files: [], error: '無法連線到伺服器' };
  }
}

/** 取回單一 GPX 檔的原始內容，交給瀏覽器解析 */
export async function fetchDriveGpxText(fileId: string): Promise<string | null> {
  try {
    const res = await fetch(`${API_BASE_URL}/tracks/drive/file/${encodeURIComponent(fileId)}`, {
      headers: getAuthHeaders(),
    });
    if (!res.ok) return null;
    return await res.text();
  } catch (err) {
    console.error(err);
    return null;
  }
}

/**
 * 寫入一天份的軌跡點。
 * 同一個 dayKey 會整批換掉，所以重複同步不會長出重複的點。
 *
 * **回傳的 `dayKey` 才是實際寫進去的那一個。** 後端會依登入身分重新組一次
 * （多身分之後 key 帶使用者前綴，由後端產生而不信任前端送的），送進去的值
 * 不一定等於寫出來的值。接著要留存原文、要貼路，都得用回傳的這個。
 */
export async function ingestTrack(payload: {
  dayKey: string;
  driveFileId?: string;
  md5?: string | null;
  ingestSource?: string;
  tzOffsetMinutes?: number;
  points: {
    t: string; lat: number; lng: number; src: string | null;
    hdop: number | null; seg: number; staySec?: number | null;
  }[];
}): Promise<{ dayKey: string; inserted: number; skipped: number } | null> {
  try {
    const res = await fetch(`${API_BASE_URL}/tracks/ingest`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify(payload),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return {
      dayKey: typeof data?.dayKey === 'string' && data.dayKey ? data.dayKey : payload.dayKey,
      inserted: data?.inserted ?? 0,
      skipped: data?.skipped ?? 0,
    };
  } catch (err) {
    console.error(err);
    return null;
  }
}

/** 已同步的一天軌跡。`hasRaw` 為真才還原得回原始軌跡 */
export interface TrackDay {
  day_key: string;
  /** 這一天是誰的。舊資料一律是站長（uid 1） */
  user_id: number | null;
  /** 擁有者的顯示名稱，後端 JOIN 好的。帳號被刪掉時會是 null */
  user_name: string | null;
  ingest_source: 'gpslogger' | 'timeline' | 'manual' | string;
  drive_file_id: string | null;
  md5: string | null;
  point_count: number;
  tz_offset_minutes: number | null;
  synced_at: string | null;
  is_private: number;
  has_raw: number;
  /**
   * 這天的軌跡點實際落在哪一天（當地牆上日，'YYYY-MM-DD'）。
   *
   * day_key 是 Drive 檔名，解析不出日期（見上面的說明），要知道「哪幾天有足跡」
   * 只能用這兩欄。一份 GPX 幾乎都只涵蓋一天，跨夜時兩個值才會不一樣。
   * 沒有任何軌跡點的日子是 null。
   */
  first_local_day: string | null;
  last_local_day: string | null;
}

export async function fetchTrackDays(): Promise<TrackDay[]> {
  try {
    const res = await fetch(`${API_BASE_URL}/tracks/days`, { headers: getAuthHeaders() });
    if (!res.ok) return [];
    return await res.json();
  } catch (err) {
    console.error(err);
    return [];
  }
}

/**
 * 留存這一天的原始 GPX。
 * 必須在 ingestTrack 成功之後才呼叫 —— 後端是 UPDATE TrackDay，那一列還不存在的話會沒寫到。
 */
export async function saveTrackRaw(dayKey: string, xml: string): Promise<boolean> {
  try {
    const res = await fetch(`${API_BASE_URL}/tracks/raw/${encodeURIComponent(dayKey)}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/gpx+xml',
        'Authorization': getAuthHeaders().Authorization,
      },
      body: xml,
    });
    return res.ok;
  } catch (err) {
    console.error(err);
    return false;
  }
}

/** 取回留存的原始 GPX 原文。沒留存過回 null */
export async function fetchTrackRaw(dayKey: string): Promise<string | null> {
  try {
    const res = await fetch(`${API_BASE_URL}/tracks/raw/${encodeURIComponent(dayKey)}`, {
      headers: getAuthHeaders(),
    });
    if (!res.ok) return null;
    return await res.text();
  } catch (err) {
    console.error(err);
    return null;
  }
}

/**
 * 把一段軌跡送去貼路。經自家 Worker 轉手到 Valhalla ——
 * 前端直打會把使用者家裡的 IP 連同完整行蹤一起交出去。
 *
 * 回傳 Valhalla 的原始回應（`shape` + `matched_points`），交給
 * `buildMatchedTrack` 組裝。失敗回 null，呼叫端要能安靜退回原本的線。
 */
export async function matchTrackShape(
  shape: { lat: number; lon: number }[],
  costing: string,
): Promise<any | null> {
  try {
    const res = await fetch(`${API_BASE_URL}/tracks/match`, {
      method: 'POST',
      headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ shape, costing }),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch (err) {
    console.error(err);
    return null;
  }
}

/** 存下這一天貼路後的軌跡（R2，不進 D1） */
export async function saveTrackMatched(dayKey: string, data: unknown): Promise<boolean> {
  try {
    const res = await fetch(`${API_BASE_URL}/tracks/matched/${encodeURIComponent(dayKey)}`, {
      method: 'PUT',
      headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    return res.ok;
  } catch (err) {
    console.error(err);
    return false;
  }
}

/** 取回貼路後的軌跡。還沒貼過（404）回 null */
export async function fetchTrackMatched(dayKey: string): Promise<MatchedTrack | null> {
  try {
    const res = await fetch(`${API_BASE_URL}/tracks/matched/${encodeURIComponent(dayKey)}`, {
      headers: getAuthHeaders(),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch (err) {
    console.error(err);
    return null;
  }
}

/** 刪掉貼路結果。重貼之前先清掉，免得部分失敗時新舊混在一起 */
export async function deleteTrackMatched(dayKey: string): Promise<boolean> {
  try {
    const res = await fetch(`${API_BASE_URL}/tracks/matched/${encodeURIComponent(dayKey)}`, {
      method: 'DELETE',
      headers: getAuthHeaders(),
    });
    return res.ok;
  } catch (err) {
    console.error(err);
    return false;
  }
}

/**
 * 存在 R2 的貼路結果。刻意存成「一段一個物件」而不是攤平的點列 ——
 * 段與段之間是關機或沒訊號，接起來會多出一條沒走過的直線。
 */
export interface MatchedTrack {
  dayKey: string;
  /** 產生時間，之後要判斷新舊時用得到 */
  builtAt: string;
  /**
   * 產生這份結果時，來源 GPX 的 md5（TrackDay.md5）。
   * 下次貼路時比對，一樣就整天跳過 —— 每一趟都是一次第三方請求，
   * 沒必要為了沒變的資料重打。舊的結果沒有這欄，會被當成「要重跑」。
   */
  sourceMd5?: string;
  segments: {
    /** 這一天的第幾趟。趟與趟之間不連線，所以每趟都要有自己的編號 */
    seg: number;
    costing: string;
    /** 決定 costing 的交通工具，畫動畫圖示時用得到 */
    vehicle?: Vehicle;
    /** [lng, lat, 毫秒 epoch]，壓成陣列是為了讓檔案小一點 */
    points: [number, number, number][];
  }[];
}

/**
 * 取得軌跡點。未登入時只拿得到被標為公開的日子。
 *
 * `userIds` 是**顯示篩選**，不是隱私牆（家人本來就互相看得到）。它的意義在額度：
 * 後端有全域 20000 點上限，只看自己時多人的點不必一起讀進來。空陣列 = 不篩選。
 */
export async function fetchTracks(
  opts: { from?: string; to?: string; dayKey?: string; userIds?: number[] } = {},
): Promise<TrackPoint[]> {
  try {
    const qs = new URLSearchParams();
    if (opts.from) qs.set('from', opts.from);
    if (opts.to) qs.set('to', opts.to);
    if (opts.dayKey) qs.set('day_key', opts.dayKey);
    if (opts.userIds?.length) qs.set('user_id', opts.userIds.join(','));
    const res = await fetch(`${API_BASE_URL}/tracks?${qs.toString()}`, { headers: getAuthHeaders() });
    if (!res.ok) return [];
    return await res.json();
  } catch (err) {
    console.error(err);
    return [];
  }
}

/** 手動編修軌跡點：刪掉 deleteIds，再插入 insert（合併就是刪一批、插入質心上的兩個點） */
export interface TrackPointEdit {
  dayKey: string;
  deleteIds: number[];
  insert: {
    t: string;
    lat: number;
    lng: number;
    src: string | null;
    seg: number;
    staySec?: number | null;
  }[];
}

export async function editTrackPoints(edit: TrackPointEdit): Promise<boolean> {
  try {
    const res = await fetch(`${API_BASE_URL}/tracks/points/edit`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify(edit),
    });
    return res.ok;
  } catch (err) {
    console.error(err);
    return false;
  }
}


/* ---- Google 時間軸紀念層 ----
 *
 * 存在 R2 的月檔，完全不進 D1。所有讀取都需要登入 ——
 * 這是十二年不間斷的完整移動史，沒有把它公開的合理預設。
 */

/** 索引裡的一個月。前端據此決定要抓哪幾個月檔 */
export interface TimelineMonthMeta {
  monthKey: string;
  points: number;
  days: number;
}

export interface TimelineIndex {
  months: TimelineMonthMeta[];
  updatedAt?: string;
}

export async function fetchTimelineIndex(): Promise<TimelineIndex | null> {
  try {
    const res = await fetch(`${API_BASE_URL}/timeline/index`, { headers: getAuthHeaders() });
    if (!res.ok) return null;
    return await res.json();
  } catch (err) {
    console.error(err);
    return null;
  }
}

export async function saveTimelineIndex(months: TimelineMonthMeta[]): Promise<boolean> {
  try {
    const res = await fetch(`${API_BASE_URL}/timeline/index`, {
      method: 'PUT',
      headers: getAuthHeaders(),
      body: JSON.stringify({ months }),
    });
    return res.ok;
  } catch (err) {
    console.error(err);
    return false;
  }
}

/** 一個月的內容：當地日 → [UTC 秒, 緯度, 經度, 時區偏移分鐘][] */
export type TimelineMonthData = Record<string, [number, number, number, number][]>;

/** 沒有這個月（404）回 null，不是錯誤 —— 索引與月檔可能不同步 */
export async function fetchTimelineMonth(monthKey: string): Promise<TimelineMonthData | null> {
  try {
    const res = await fetch(`${API_BASE_URL}/timeline/month/${monthKey}`, {
      headers: getAuthHeaders(),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch (err) {
    console.error(err);
    return null;
  }
}

export async function saveTimelineMonth(monthKey: string, data: TimelineMonthData): Promise<boolean> {
  try {
    const res = await fetch(`${API_BASE_URL}/timeline/month/${monthKey}`, {
      method: 'PUT',
      headers: getAuthHeaders(),
      body: JSON.stringify(data),
    });
    return res.ok;
  } catch (err) {
    console.error(err);
    return false;
  }
}
