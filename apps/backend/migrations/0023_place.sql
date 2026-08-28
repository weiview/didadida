-- 0023: 打卡地點簿
--
-- 「指定地點」套用之後把那個地點記下來，讓其他相簿的照片直接選得到，
-- 不必每一次都重新搜尋、重新在地圖上找同一家店。
--
-- ⚠️ 名字就是身分（UNIQUE）—— 使用者拍板的規則是：選了某個地點會自動帶出
--    它的座標與名字，但如果這一次把釘子移到別的位置再套用，**那個地點的座標
--    就更新成最新這一次**。所以 upsert 一律 `ON CONFLICT(name) DO UPDATE`。
--    同名的連鎖店（7-11）會被併成一筆，要分開得自己取「7-11 中華店」。
--
-- ⚠️ 這張表**刻意不對 User 建外鍵**：它是全站共用的一份捷徑清單，跟誰存的無關，
--    也因此完全不必參與「刪帳號要由子表往父表」那條刪除順序。
--
-- 刪掉一列只是收掉捷徑 —— 照片自己的 lat／lng／place_name 完全不受影響。
CREATE TABLE IF NOT EXISTS Place (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  use_count INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- upsert 靠它認人，同時也是「同名只有一筆」的保證
CREATE UNIQUE INDEX IF NOT EXISTS idx_place_name ON Place(name);
-- 清單預設照「最近用過」排，走這條索引不必排序整張表
CREATE INDEX IF NOT EXISTS idx_place_last_used ON Place(last_used_at DESC);
