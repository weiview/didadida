-- Phase 3：少量的執行期設定。目前只放 Drive 資料夾 id。
--
-- 為什麼不用 wrangler secret / vars：這兩個 id 不是人填的，是**網頁在第一次上傳時
-- 自己建資料夾後產生的**。瀏覽器端只有 drive.file scope，看不見使用者手動建的
-- 資料夾（per-file 授權），所以資料夾一定要由 app 自己建、自己擁有，id 也就只能
-- 在執行期才知道。要人把它複製貼進 wrangler secret 等於把自動化的部分又變回手動。
--
-- 刻意做成通用的 key/value 而不是專用欄位：這張表預期只會有個位數的列，
-- 為兩個 id 開兩個具名欄位，之後每加一項設定就要一次 migration。

CREATE TABLE IF NOT EXISTS AppSetting (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 目前用到的 key：
--   drive_photos_folder_id  照片主檔的 `didadida/`
--   drive_trash_folder_id   `didadida/trash/`，刪除的檔案搬進這裡
