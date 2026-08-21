-- 0018：拿掉 AppSetting 裡那份重複的 Drive 寫入憑證。
--
-- ## 為什麼
--
-- Drive 的寫入身分本來有三個來源：`AppSetting.drive_writer_refresh_token`、
-- 環境 secret `DRIVE_WRITER_REFRESH_TOKEN`，以及 0017 之後每個人自己的
-- `User.google_refresh_token`。站長那三份**是同一個東西**（同一個 Google 帳號、
-- 同一組 client、登入 scope 本來就含 drive.file），只是分別存了三個地方。
--
-- 多出來的那兩份沒有任何人會刷新，而且壞掉時會**擋住自癒**：
-- 「登入要不要跳同意畫面」與「這次登入的 refresh token 要不要收下來」兩個判斷
-- 看的都是「有沒有值」，不看值有沒有效。secret 只要還在（哪怕 Google 早就回
-- invalid_grant）站長就再也跳不出同意畫面 —— 於是畫面上那句「請站長重新登入
-- 一次，後端會自己把授權收回來」變成一句做不到的指示。2026-08-21 真的卡死過：
-- 兩個遠端環境的 D1 那份都已被自癒邏輯刪掉、剩下的 secret 是死的，站長怎麼
-- 重新登入都補不回來，Google 相簿匯入的照片全部只有 R2 沒有 Drive 備份。
--
-- 現在只剩一份：站長那一列的 `User.google_refresh_token`（見 driveWriterOwner）。
-- 那一份站長每次 Google 登入都會刷新，失效時 mintUserGoogleToken() 就地清成
-- NULL，下次登入的回呼發現他沒有就自動補跳同意畫面收回來。
--
-- ## 這支在做什麼
--
-- 只是清掉留在 D1 的殘列 —— 程式已經完全不讀這三個鍵了，所以是純粹的整理。
-- 兩個遠端環境跑起來多半是 0 rows（早就被自癒邏輯刪過），本機的舊庫才會有。
-- 環境 secret 另外用 `wrangler secret delete DRIVE_WRITER_REFRESH_TOKEN` 刪，
-- 那個不歸 migration 管。

DELETE FROM AppSetting
 WHERE key IN ('drive_writer_refresh_token', 'drive_writer_email', 'drive_writer_linked_at');
