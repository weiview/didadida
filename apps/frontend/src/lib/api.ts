// 這裡設定 Cloudflare Workers API 的預設位置
const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'http://127.0.0.1:8787/api';

function getAuthHeaders() {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json'
  };
  if (typeof window !== 'undefined') {
    const pwd = localStorage.getItem('admin_password');
    if (pwd) {
      headers['Authorization'] = `Bearer ${pwd}`;
    }
  }
  return headers;
}

export interface Album {
  id: number;
  name: string;
  description?: string;
  created_at: string;
}

export interface Photo {
  id: number;
  title: string;
  file_name: string;
  description?: string;
  album_id: number;
  taken_at?: string;
  created_at: string;
  url?: string;
}

export async function verifyLogin(password: string): Promise<boolean> {
  try {
    const res = await fetch(`${API_BASE_URL}/verify-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    return res.ok;
  } catch (error) {
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

export async function uploadPhoto(albumId: string | number, file: File): Promise<boolean> {
  const formData = new FormData();
  formData.append('file', file);
  formData.append('album_id', String(albumId));

  const headers: Record<string, string> = {};
  if (typeof window !== 'undefined') {
    const pwd = localStorage.getItem('admin_password');
    if (pwd) {
      headers['Authorization'] = `Bearer ${pwd}`;
    }
  }

  try {
    const res = await fetch(`${API_BASE_URL}/upload`, {
      method: 'POST',
      headers,
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
