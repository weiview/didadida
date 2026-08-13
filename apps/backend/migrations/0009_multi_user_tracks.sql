-- 多身分足跡：每個家庭成員各自上傳、各自顯示、可同框但顏色不同。
--
-- 在這之前軌跡是「站的資產」—— 只有一個 Drive 資料夾、一組 day_key，
-- 寫入一律要 can_manage_others。多人之後每個人有自己的一份。
--
-- ## 為什麼不改主鍵
--
-- TrackDay.day_key 就是 Drive 上的檔名，兩個人同一天都會產出 20260813.gpx，
-- 而 ingest 是「DELETE FROM TrackPoint WHERE day_key=? 再整批插入」——
-- 誰後同步誰就把對方那天洗掉。
--
-- 解法是**在 day_key 前面加使用者前綴**，不是把主鍵改成 (user_id, day_key)。
-- 後者要 rebuild TrackDay / TrackPoint / TrackSegment 三張表、搬所有資料，
-- 還要重組 R2 上的 tracks/<day_key>.gpx 與 .matched.json 兩套物件鍵。
-- 前綴之所以安全，是因為 day_key 從第一天就被規定是**不透明字串**
-- （見 schema.sql 的註解、以及 /api/tracks/days 特地用 first_local_day
-- 而不是去解析檔名）—— 沒有任何程式碼假設它長得像日期。
--
-- ## 前綴規則：uid 1 無前綴，其餘 'u<uid>:'
--
-- uid 1 是既有資料的擁有者。這是**資料歷史，不是權限判斷**，所以規則用 uid
-- 而不是 role='owner'。若連 uid 1 也加前綴，站上既有的 '20260813.gpx' 會跟
-- 之後同步出來的 'u1:20260813.gpx' 變成兩列重複軌跡；要避免就得搬 D1 三張表
-- 再 copy/delete 每一個 R2 物件。醜一點，換零資料搬移。

-- 這一天的軌跡是誰的。NULL 只會出現在 migration 執行的瞬間，下一行就補完。
--
-- 刻意**不加 ON DELETE CASCADE**：跟 Album.user_id 那個外鍵的教訓相反 ——
-- 那裡的 CASCADE 讓「刪帳號」順手把相簿和照片一起帶走，還留下 R2/Drive 孤兒
-- （見 0008 的註解與 /api/admin/users/:id/purge）。軌跡走同一條路：
-- 刪帳號時由 purge 明確決定要改掛站長還是連同 R2 原始檔一起清掉。
ALTER TABLE TrackDay ADD COLUMN user_id INTEGER REFERENCES User(id);

-- 既有的軌跡全是站長的。0008 已保證 id=1 那一列存在
UPDATE TrackDay SET user_id = 1 WHERE user_id IS NULL;

-- 「只看某個人的足跡」是地圖上最常按的篩選，全表掃不划算
CREATE INDEX IF NOT EXISTS idx_trackday_user ON TrackDay(user_id);

-- ↓ 這兩欄是 P1/P2 要用的，一起加省一次 migration（遠端每套一次都要人工介入）

-- 這個人的軌跡在地圖上的顏色，由他自己選（'#rrggbb'）。
-- NULL ＝ 還沒選過，前端用調色盤依序配一個
ALTER TABLE User ADD COLUMN track_color TEXT;

-- 這個人自己的 GPSLogger Drive 資料夾 id。
--
-- 每個人只能傳到**自己的** Drive：GPSLogger 的 scope 只有 drive.file，
-- 只看得到自己建立的檔案，資料夾也必須由它自己建（上游 issue #1173）。
-- 所以「全家都傳進站長的 Drive」在技術上不存在，除非共用 Google 帳號。
-- 成員把自己的資料夾分享給同一個 service account 信箱，這裡記 id。
-- NULL 且 uid=1 時退回既有的 GOOGLE_DRIVE_FOLDER_ID 環境變數。
ALTER TABLE User ADD COLUMN track_drive_folder_id TEXT;
