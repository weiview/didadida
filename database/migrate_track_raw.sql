-- GPS 軌跡第三版：保留原始 GPX，讓手動編修可以還原
--
-- 先套 dev（didadida-db-dev），prod 待使用者同意再套。
--   本機：npx wrangler d1 execute didadida-db-dev --env dev --local --file=../../database/migrate_track_raw.sql -y
--   遠端：npx wrangler d1 execute didadida-db-dev --env dev --remote --file=../../database/migrate_track_raw.sql

-- 同步時把 Drive 上那一份 GPX 原文也收進 R2，key 記在這裡。
--
-- 為什麼存 R2 而不是 D1：一天份的 GPX 動輒好幾 MB，超過 D1 的單列上限就直接
-- 寫不進去；而且原文塞進 TrackDay 之後，每次列出軌跡日都會拖著整包 XML。
-- R2 本來就是放 blob 的地方（照片已經在用同一個 bucket）。
--
-- 為什麼要留：TrackPoint 存的是濃縮＋抽稀之後的結果，而且手動編修會就地覆蓋，
-- 兩者都不可逆。Drive 上的檔案是使用者的，隨時可能被清掉，不能當作備份。
-- 有了這一份，「恢復原始軌跡」才是一個真的做得到的操作。
--
-- NULL = 這一天是在這個功能之前同步的，或來自 Google 時間軸（本來就沒有 GPX）。
ALTER TABLE TrackDay ADD COLUMN raw_key TEXT;
