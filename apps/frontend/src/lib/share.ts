import { nativeApp } from './nativeApp';

/**
 * 燈箱那顆「分享」：一條直接打開這張照片的連結。
 *
 * 連結就是站上本來就有的深連結 `/album?id=<相簿>&photo=<id>`（靜態匯出沒有
 * `/album/<id>` 那一層）。⚠️ 它**不是**公開連結 —— 收到的人照樣要過進站閘門
 * （訪客密碼或 Google 登入），登入完會回到這張（`googleLoginUrl` 記住了網址）。
 * Android 上裝了 App 的人點下去由 App 開（App Links，`/.well-known/assetlinks.json`）。
 *
 * 順序：App 裡走原生分享（WebView 沒有 navigator.share）→ 瀏覽器的 Web Share →
 * 複製到剪貼簿 → 都不行就把網址攤在 prompt 裡讓人自己複製。
 */
export function photoShareUrl(albumId: number | string, photoId: number | string): string {
  return `${window.location.origin}/album?id=${albumId}&photo=${photoId}`;
}

export type ShareOutcome = 'native' | 'shared' | 'copied' | 'cancelled' | 'prompted';

export async function sharePhotoLink(url: string, title: string): Promise<ShareOutcome> {
  const app = nativeApp();
  if (app?.share) {
    app.share(url, title);
    return 'native';
  }
  if (typeof navigator.share === 'function') {
    try {
      await navigator.share({ title, url });
      return 'shared';
    } catch (e) {
      // 使用者自己關掉分享面板，不算失敗、也不要再跳別的東西
      if (e instanceof DOMException && e.name === 'AbortError') return 'cancelled';
    }
  }
  try {
    await navigator.clipboard.writeText(url);
    return 'copied';
  } catch {
    window.prompt('複製這個連結分享出去：', url);
    return 'prompted';
  }
}
