/**
 * Android App（apps/android）注入的 JS 介面。網頁在一般瀏覽器裡跑的時候它不存在。
 *
 * App 是一層 WebView 包著這個站，**只有上傳那條管線是原生的**（前景服務，
 * 關掉畫面、切到別的 App 都照樣傳）。所以網頁這邊只有兩個接點：
 *   - 按「上傳照片」時改叫 `pickAndUpload()`，由原生去開檔案選擇器、接手整批上傳；
 *   - 原生傳完一批會丟 `didadida:native-upload-done`（detail: {albumId}），相簿頁接到就重抓。
 *
 * ⚠️ 上傳管線（ingestSources／uploadPhoto／lib/drive.ts／縮圖、phash、動態照片、影片 metadata）
 * 在 App 裡有一份 Kotlin 版。**改了這幾支要同步改 App 並發一版 APK**，見 CLAUDE.md「Android App」。
 */
interface DidadidaAppBridge {
  /** 開原生的檔案選擇器，選完交給前景服務上傳到這本相簿 */
  pickAndUpload(albumId: string, token: string): void;
  /** App 的版本名稱（versionName），網頁用不到，除錯時看得出是哪一版 */
  version?(): string;
}

declare global {
  interface Window { DidadidaApp?: DidadidaAppBridge }
}

export const NATIVE_UPLOAD_DONE = 'didadida:native-upload-done';

export function nativeApp(): DidadidaAppBridge | null {
  if (typeof window === 'undefined') return null;
  return window.DidadidaApp ?? null;
}
