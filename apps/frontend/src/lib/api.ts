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
  sort_order: number;
  taken_at?: string;
  exif?: string;
  created_at: string;
  tags?: Tag[];
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

export async function uploadPhoto(albumId: string, file: File, exifData?: any, takenAt?: string): Promise<boolean> {
  const formData = new FormData();
  formData.append('file', file);
  formData.append('album_id', albumId);
  if (exifData) {
    try {
      const allowedKeys = ['Make', 'Model', 'DateTimeOriginal', 'Software', 'Orientation', 'GPSLatitude', 'GPSLongitude', 'GPSAltitude', 'ExposureTime', 'FNumber', 'ISO', 'FocalLength', 'LensModel'];
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
