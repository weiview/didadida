-- GPS 軌跡第二版：停留點濃縮 + 每段交通工具
--
-- 先套 dev（didadida-db-dev），prod 待使用者同意再套。
--   本機：npx wrangler d1 execute didadida-db-dev --env dev --local --file=../../database/migrate_track_stay_vehicle.sql -y
--   遠端：npx wrangler d1 execute didadida-db-dev --env dev --remote --file=../../database/migrate_track_stay_vehicle.sql

-- 停留點：在大樓／室內時 GPS 會在幾十公尺內亂跳，那不是移動而是雜訊。
-- 匯入前先把「半徑 R 內連續待滿 T 分鐘」的一整串點收成質心上的兩個點
-- （進入時刻 + 離開時刻），stay_sec 記在前者上，代表在那裡待了多久。
--
-- 為什麼是兩個點而不是一個：只留一個的話，停留期間拍的照片在時間軸上會
-- 全部落到「下一個移動點」之後才出現。補一個離開時刻的同座標點就對得齊了，
-- 而且畫線時那一段長度為零，不影響路線外觀。
--
-- 為什麼在匯入時做而不是畫圖時做：省 D1 列數（一整晚在家可以從幾百點變兩點）。
-- 原始 GPX 一直留在 Drive，參數想改就用「強制重新匯入」重灌，不是不可逆的。
ALTER TABLE TrackPoint ADD COLUMN stay_sec INTEGER;

-- 每一段軌跡的交通工具。段的身分是 (day_key, seg)，跟 TrackPoint 一致。
-- 不放進 TrackPoint 是因為那會讓同一個值重複幾千列；也不放進 TrackDay，
-- 因為一天之內可以先走路再搭車。
--
-- 沒有這張表的列 = 沒指定，前端會依實際速度猜一個並標示為「自動」。
-- 手動指定永遠優先。
CREATE TABLE IF NOT EXISTS TrackSegment (
  day_key TEXT NOT NULL,
  seg INTEGER NOT NULL,
  -- 'walk' | 'bike' | 'motorbike' | 'car' | 'bus' | 'train' | 'plane' | 'boat'
  vehicle TEXT,
  PRIMARY KEY (day_key, seg),
  FOREIGN KEY (day_key) REFERENCES TrackDay(day_key) ON DELETE CASCADE
);
