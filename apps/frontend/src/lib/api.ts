// 這裡設定 Cloudflare Workers API 的預設位置
const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'http://127.0.0.1:8787/api';

function getAuthHeaders() {
  const token = typeof window !== 'undefined' ? localStorage.getItem('admin_token') : '';
  return {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`
  };
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
}

export interface Tag {
  id: number;
  name: string;
}

export interface Photo {
  id: number;
  title: string;
  description?: string;
  file_name: string;
  album_id: number;
  url: string;
  thumb_url?: string;
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
      localStorage.setItem('admin_token', data.token);
      return { success: true };
    }
    return { success: false, message: data.error || "密碼錯誤" };
  } catch (error: any) {
    console.error(error);
    return { success: false, message: `連線錯誤: ${error.message}` };
  }
}

/**
 * 確認 localStorage 裡的 token 還有效（沒過期、簽章對）。
 *
 * 這是「是不是管理員」的唯一依據。以前是把明文密碼存在 localStorage 再重打一次
 * verify-password，那個密碼同時是 JWT 的簽章金鑰，不該留在瀏覽器裡；而只檢查
 * token 這個 key 存不存在也不行 —— 過期後 key 還在，編輯介面會繼續出現然後每一
 * 個按鈕都被後端 401 擋掉。
 */
export async function checkAuth(): Promise<boolean> {
  if (typeof window === 'undefined') return false;
  // 舊版把明文密碼存在這個 key。清掉已經留在使用者瀏覽器裡的那一份，
  // 否則它會一直躺在那裡。等所有裝置都開過一次站之後這行就可以刪了。
  localStorage.removeItem('admin_password');
  if (!localStorage.getItem('admin_token')) return false;
  try {
    const res = await fetch(`${API_BASE_URL}/auth/me`, { headers: getAuthHeaders() });
    if (res.ok) return true;
    // 401 = 過期或無效。留著只會讓下次進站又錯判一遍
    if (res.status === 401) localStorage.removeItem('admin_token');
    return false;
  } catch (error) {
    // 連不上就當作沒登入 —— 寧可少顯示編輯介面，也不要顯示一堆會失敗的按鈕
    console.error(error);
    return false;
  }
}

export async function fetchAlbums(): Promise<Album[]> {
  try {
    const res = await fetch(`${API_BASE_URL}/albums`);
    if (!res.ok) throw new Error('Failed to fetch albums');
    return res.json();
  } catch (error) {
    console.error(error);
    return [];
  }
}

export async function fetchPhotos(albumId: string | number): Promise<Photo[]> {
  try {
    const res = await fetch(`${API_BASE_URL}/albums/${albumId}/photos`);
    if (!res.ok) throw new Error('Failed to fetch photos');
    return res.json();
  } catch (error) {
    console.error(error);
    return [];
  }
}

/**
 * 全站照片。帶上 token —— 這條路由本身是公開的，但沒帶驗證的話後端會套用
 * applyGeoPrivacy，私密相簿的照片一律回傳 lat = null。時間軸匯入視窗就是靠
 * 「lat 是不是 null」判斷哪些照片還沒有座標，看不到自己的私密照片座標的話，
 * 那些照片會永遠被當成「還沒定位」，寫完也不會從待處理清單裡消失。
 * 未登入時 token 是空字串，後端驗不過，行為與原本的匿名請求相同。
 */
export async function fetchAllPhotos(): Promise<Photo[]> {
  try {
    const res = await fetch(`${API_BASE_URL}/all-photos`, { headers: getAuthHeaders() });
    if (!res.ok) throw new Error('Failed to fetch all photos');
    return res.json();
  } catch (error) {
    console.error(error);
    return [];
  }
}

async function generateThumbnail(file: File): Promise<Blob | null> {
  if (!file.type.startsWith('image/')) return null;
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        const MAX_WIDTH = 400;
        const MAX_HEIGHT = 400;
        let width = img.width;
        let height = img.height;

        if (width > height) {
          if (width > MAX_WIDTH) {
            height *= MAX_WIDTH / width;
            width = MAX_WIDTH;
          }
        } else {
          if (height > MAX_HEIGHT) {
            width *= MAX_HEIGHT / height;
            height = MAX_HEIGHT;
          }
        }
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.imageSmoothingEnabled = true;
          ctx.imageSmoothingQuality = 'high';
          ctx.drawImage(img, 0, 0, width, height);
          canvas.toBlob((blob) => resolve(blob), 'image/jpeg', 1.0);
        } else {
          resolve(null);
        }
      };
      img.onerror = () => resolve(null);
      img.src = e.target?.result as string;
    };
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(file);
  });
}

/** 上傳成功後回傳的那一筆，null 代表失敗 */
export interface UploadedPhoto {
  id: number;
  /** EXIF 有帶座標才有值。null 代表這張需要事後補位置 */
  lat: number | null;
  lng: number | null;
}

export async function uploadPhoto(albumId: string, file: File, exifData?: any, takenAt?: string): Promise<UploadedPhoto | null> {
  const formData = new FormData();
  formData.append('file', file);
  formData.append('album_id', albumId);
  
  // Generate and append thumbnail
  try {
    const thumbBlob = await generateThumbnail(file);
    if (thumbBlob) {
      formData.append('thumb', thumbBlob, `thumb_${file.name}`);
    }
  } catch (err) {
    console.warn("Failed to generate thumbnail", err);
  }

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
    const token = localStorage.getItem('admin_token') || '';
    const res = await fetch(`${API_BASE_URL}/upload`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}` },
      body: formData,
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (typeof data?.id !== 'number') return null;
    return {
      id: data.id,
      lat: typeof data.lat === 'number' ? data.lat : null,
      lng: typeof data.lng === 'number' ? data.lng : null,
    };
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
    const res = await fetch(`${API_BASE_URL}/tags`);
    if (!res.ok) throw new Error('Failed to fetch tags');
    return await res.json();
  } catch (error) {
    console.error(error);
    return [];
  }
}

function getGoogleAuthHeaders() {
  const token = typeof window !== 'undefined' ? localStorage.getItem('google_access_token') : '';
  const adminToken = typeof window !== 'undefined' ? localStorage.getItem('admin_token') : '';
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
}): Promise<{ success: boolean; updated: number; skippedExif: number; segmentId: number | null } | null> {
  try {
    const res = await fetch(`${API_BASE_URL}/photos/geo/batch`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify(params),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch (err) {
    console.error(err);
    return null;
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
  /** 就是 Drive 上的檔名，同時當作 TrackDay 的主鍵。不透明，不要拿去解析日期 */
  dayKey: string;
  driveFileId: string;
  md5: string | null;
  modifiedTime: string | null;
  size: number | null;
  syncedPointCount: number;
  syncedAt: string | null;
  /** md5 跟已同步的不一樣（或根本沒同步過）才需要重抓 */
  needsSync: boolean;
  /** 'manual' 代表這天的軌跡點被手動編修過，重灌會洗掉，同步時預設跳過 */
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
}

/**
 * 交通工具。只剩貼路在用 —— 依速度猜出來，決定送給 Valhalla 的 costing，
 * 並記在 R2 的貼路結果裡（見 MatchedTrack.segments[].vehicle）。
 * 手動指定的介面與 TrackSegment 那條路都已經拿掉。
 */
export type Vehicle = 'walk' | 'bike' | 'motorbike' | 'car' | 'bus' | 'train' | 'plane' | 'boat';

/** 列出 Drive 資料夾裡的 GPX 檔。僅管理者可用 */
export async function fetchDriveGpxFiles(): Promise<{ files: DriveGpxFile[]; error?: string }> {
  try {
    const res = await fetch(`${API_BASE_URL}/tracks/drive/files`, { headers: getAuthHeaders() });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return { files: [], error: body?.error || `伺服器回應 ${res.status}` };
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
}): Promise<{ inserted: number; skipped: number } | null> {
  try {
    const res = await fetch(`${API_BASE_URL}/tracks/ingest`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify(payload),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return { inserted: data?.inserted ?? 0, skipped: data?.skipped ?? 0 };
  } catch (err) {
    console.error(err);
    return null;
  }
}

/** 已同步的一天軌跡。`hasRaw` 為真才還原得回原始軌跡 */
export interface TrackDay {
  day_key: string;
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

/** 取得軌跡點。未登入時只拿得到被標為公開的日子 */
export async function fetchTracks(opts: { from?: string; to?: string; dayKey?: string } = {}): Promise<TrackPoint[]> {
  try {
    const qs = new URLSearchParams();
    if (opts.from) qs.set('from', opts.from);
    if (opts.to) qs.set('to', opts.to);
    if (opts.dayKey) qs.set('day_key', opts.dayKey);
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
