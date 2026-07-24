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
  exif?: string;
  created_at: string;
  tags?: Tag[];
  lat?: number | null;
  lng?: number | null;
  geo_source?: GeoSource;
  place_name?: string | null;
  /** 1 = 私密（預設）。非管理者取得的資料中，私密照片的座標一律為 null */
  geo_private?: number;
}

/** null 代表尚未定位。'timeline' 來自 Google 時間軸比對 */
export type GeoSource = 'exif' | 'timeline' | 'interpolated' | 'manual' | null;

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
  local_time: string;
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

export async function fetchAllPhotos(): Promise<Photo[]> {
  try {
    const res = await fetch(`${API_BASE_URL}/all-photos`);
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

export async function uploadPhoto(albumId: string, file: File, exifData?: any, takenAt?: string): Promise<boolean> {
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
    return res.ok;
  } catch (error) {
    console.error(error);
    return false;
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

/** 對前後有 EXIF 座標的照片之間做時間內插 */
export async function interpolateGeo(albumId?: number, maxGapHours = 24): Promise<number> {
  try {
    const res = await fetch(`${API_BASE_URL}/photos/geo/interpolate`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({ albumId, maxGapHours }),
    });
    if (!res.ok) return 0;
    const data = await res.json();
    return data.updated ?? 0;
  } catch (err) {
    console.error(err);
    return 0;
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

/** 搜尋地名（Photon，免費且免 API key）。回傳前幾筆候選讓使用者挑 */
export async function searchPlace(query: string): Promise<{ name: string; lat: number; lng: number }[]> {
  if (!query.trim()) return [];
  try {
    const res = await fetch(
      `https://photon.komoot.io/api/?q=${encodeURIComponent(query)}&limit=6`
    );
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
 * 寫入由 Google 時間軸比對出來的位置。
 * 只送出比對結果，原始的 Timeline.json 不會離開瀏覽器。
 */
export async function applyTimelineMatches(
  matches: { photoId: number; lat: number; lng: number; placeName?: string; tzOffsetMinutes?: number }[],
  overwriteExif = false,
): Promise<{ updated: number; invalid: number; skipped: number } | null> {
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
