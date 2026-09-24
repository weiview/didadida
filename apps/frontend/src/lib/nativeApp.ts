/**
 * Android App（apps/android）注入的 JS 介面。網頁在一般瀏覽器裡跑的時候它不存在。
 *
 * App 是一層 WebView 包著這個站，**只有上傳那條管線是原生的**（前景服務，
 * 關掉畫面、切到別的 App 都照樣傳）。所以網頁這邊只有兩個接點：
 *   - 按「上傳照片」時改叫 `pickAndUpload()`，由原生去開檔案選擇器、接手整批上傳；
 *   - 原生傳完一批會丟 `didadida:native-upload-done`（detail: {albumId}），相簿頁接到就重抓；
 *   - 傳的過程中丟 `didadida:native-upload-progress`（detail: {albumId, current, total, fileName, sent, size}），
 *     相簿頁拿它畫跟網頁上傳同一條進度列。照片沒有位元組進度，送的是階段百分比（`size === 100`）。
 *
 * ⚠️ 上傳管線（ingestSources／uploadPhoto／lib/drive.ts／縮圖、phash、動態照片、影片 metadata）
 * 在 App 裡有一份 Kotlin 版。**改了這幾支要同步改 App 並發一版 APK**，見 CLAUDE.md「Android App」。
 */
interface DidadidaAppBridge {
  /** 開原生的檔案選擇器，選完交給前景服務上傳到這本相簿 */
  pickAndUpload(albumId: string, token: string): void;
  /** App 的版本名稱（versionName），網頁用不到，除錯時看得出是哪一版 */
  version?(): string;
  /**
   * 成員登入確定之後交出進站票：App 拿它向 `/api/push/register` 登記推播，
   * 桌面小工具也用它抓精選。每次開頁都會叫，節流在 App 那一頭。
   * 選填 —— 1.0.3 之前的 App 沒有這一支。
   */
  setSession?(token: string): void;
  /** 登出：App 先用舊票把這支手機的推播撤掉，再清掉 */
  clearSession?(): void;
  /**
   * 帳號牌上那顆「檢查 App 更新」：App 當場問一次版本清單，結果用 Toast 講出來，
   * 有新版就下載並問要不要現在裝。選填 —— 1.0.6 之前的 App 沒有這一支（那顆按鈕就不端出來）。
   */
  checkUpdate?(): void;
}

declare global {
  interface Window { DidadidaApp?: DidadidaAppBridge }
}

export const NATIVE_UPLOAD_DONE = 'didadida:native-upload-done';
export const NATIVE_UPLOAD_PROGRESS = 'didadida:native-upload-progress';

export function nativeApp(): DidadidaAppBridge | null {
  if (typeof window === 'undefined') return null;
  return window.DidadidaApp ?? null;
}
