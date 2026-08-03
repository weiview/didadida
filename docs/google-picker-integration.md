# Google Photos Picker API 整合筆記與避坑指南

本文件記錄了在實作「從 Google 相簿匯入」功能時遇到的兩個重大坑點，避免未來重構或修改時再次發生相同錯誤。

## 1. 跨網域安全隔離 (COOP) 導致的視窗失聯問題

**問題描述**：
當使用 `window.open` 開啟 Google Picker 授權與選取視窗（`https://photospicker.googleapis.com`）時，由於 Google 設定了極高的安全政策（Cross-Origin-Opener-Policy），瀏覽器會強制將該視窗分配到不同的瀏覽環境 (Browsing Context Group)。
這會導致我們的程式碼瞬間遺失對該視窗的參考，`popup.closed` 會立刻變成 `true`，且無法透過 `popup.close()` 關閉它。

**之前的錯誤解法**：
曾試圖使用 `window.open("")` 先開空視窗再轉址，結果直接觸發 COOP 斷線，導致後續輪詢 (polling) 機制在第一秒就因為 `popup?.closed === true` 而被意外中止。

**正確解法**：
1. **不要**依賴 `popup.closed` 來中斷 polling。請設定一個絕對時間（如 10 分鐘）作為 Timeout 條件，並持續輪詢後端，直到取得照片為止。
2. 開啟視窗時，應直接傳入 Picker URI：`window.open(session.pickerUri, "GooglePicker", ...)`。
3. 取得照片後，由於原 `popup` 可能因為被瀏覽器阻擋或 COOP 而失效，可嘗試以 `const finalPopup = popup || window.open("", "GooglePicker"); finalPopup?.close();` 來強制關閉。若依然無法關閉，這屬於正常現象，Google 原廠設計亦是請使用者手動關閉。

## 2. Picker API 照片結構變更 (mediaFile.baseUrl)

**問題描述**：
傳統 Google Photos Library API 取回的照片物件，`baseUrl` 是放在最外層的。
但在新版的 **Google Photos Picker API** 中，`baseUrl` 被包裝進了 `mediaFile` 裡面。

**錯誤寫法**：
```typescript
// 這會導致抓到 undefined，然後後端報 400 Bad Request
const url = item.baseUrl;
```

**正確寫法**：
```typescript
// 必須優先尋找 mediaFile 物件
const baseUrl = item.mediaFile?.baseUrl || item.baseUrl;
const filename = item.mediaFile?.filename || item.filename || item.id + ".jpg";
```

請在後續維護 `apps/frontend/src/app/album/page.tsx` 和 `apps/frontend/src/lib/api.ts` 時，務必留意這兩項細節。
