// 這裡設定 Cloudflare Workers API 的預設位置
// 開發時通常在 http://127.0.0.1:8787
const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'http://127.0.0.1:8787/api';

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
  url?: string; // 由 R2 產生或組裝的 URL
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

  try {
    const res = await fetch(`${API_BASE_URL}/upload`, {
      method: 'POST',
      body: formData,
    });
    return res.ok;
  } catch (error) {
    console.error(error);
    return false;
  }
}
