# 專案踩坑與經驗紀錄 (Lessons Learned)

這份文件記錄了在開發 DidaDida 專案時遇到的重大問題與解決方案，供未來開發時參考，避免重蹈覆轍。

## 1. Next.js 環境變數覆蓋問題 (.env.local vs .env.production)
* **問題描述**：在進行正式環境打包部署 (`npm run build`) 時，前端發出去的 API 請求一直指向 `http://127.0.0.1:8787`，導致手機端或外部網路瀏覽時發生 `Failed to fetch` 的嚴重錯誤。
* **根本原因**：Next.js 的環境變數載入順序中，`.env.local` 的權重**高於** `.env.production`。如果專案中存在 `.env.local` 且裡面設定了 `NEXT_PUBLIC_API_URL=http://127.0.0.1:8787/api`，即使執行生產環境打包，依然會被覆寫為本地端網址。
* **造成後果**：
  * 開發者在自己的電腦上測試時「看起來一切正常」，因為電腦本地端剛好有啟動測試伺服器。
  * 對外發布後，一般使用者的手機/電腦因為沒有運行本地伺服器，會全數連線失敗。
  * 導致開發者誤判為是電信網路阻擋 (DNS/CORS) 的問題，浪費大量時間排查。
* **防範規範**：
  * 絕對**不要**在 Next.js 專案中使用 `.env.local` 來存放「僅限開發環境」的變數。
  * 本地開發環境變數請嚴格使用 `.env.development`，這樣在執行 `npm run build` (production 模式) 時，Next.js 就不會載入它，而是正確載入 `.env.production`。

## 2. Cloudflare D1 與 R2 的「開發」與「正式」環境混淆
* **問題描述**：使用 `npx wrangler d1 execute` 刪除正式環境資料庫時，網站前端依然顯示舊資料。
* **根本原因**：前端因為上述 `.env.local` 的原因連線到了本地開發環境的資料庫；同時，若未清楚切分 `wrangler.toml` 的 `env.dev` 與正式環境，很容易導致開發與正式資料庫互相污染。
* **防範規範**：
  * 清理資料時，必須嚴格確認前端連線的 API 來源是否真的是正式環境 (查看 Network Tab)。

## 3. JWT 驗證與前端狀態覆寫問題
* **問題描述**：登入成功後，所有需要授權的 API (如新增相簿、刪除) 全數回傳 `401 Unauthorized`。
* **根本原因**：前端的 `api.ts` 正確拿到了伺服器回傳的 Token 並存入 `localStorage.setItem('admin_token', data.token)`，但是 UI 層的 `page.tsx` 在收到成功回傳後，又執行了 `localStorage.setItem('admin_token', 'true')`，導致合法的 JWT 被字串 `"true"` 覆蓋破壞。
* **防範規範**：
  * 狀態管理與 LocalStorage 的寫入應該統一交由 API 層 (如 `api.ts`) 處理，UI 組件不應直接操作 Token，以免發生覆寫。
