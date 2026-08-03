-- GPS 軌跡：新增 TrackDay 與 TrackPoint
--
-- 先套 dev（didadida-db-dev），prod 待使用者同意再套。
--   本機：npx wrangler d1 execute didadida-db-dev --env dev --local --file=../../database/migrate_track.sql -y
--   遠端：npx wrangler d1 execute didadida-db-dev --env dev --remote --file=../../database/migrate_track.sql
--
-- 資料來源：手機 GPSLogger 一天一個 GPX 檔 → Google Drive → 我們用唯讀 service account 拉取。
-- Worker 只做 I/O，GPX 解析與抽稀都在瀏覽器跑（免費方案 cron 只有 10ms CPU，解析放不進去，
-- 因此也不需要排程，一顆手動「立即同步」按鈕即可）。

-- 一個「day_key」= Drive 上的一個檔案。同步狀態記在這裡，避免重複下載與解析。
CREATE TABLE IF NOT EXISTS TrackDay (
  -- 直接用 Drive 檔名當不透明主鍵（例如 '20260730.gpx'）。
  -- 刻意不解析成日期：檔名是「手機當地日期」但檔內時戳全是 UTC，
  -- 台北的一天在 UTC 是跨兩天的。day_key 只負責「重拉時該刪哪一批」，
  -- 排序與照片配對一律用 TrackPoint.t_utc。
  day_key TEXT PRIMARY KEY,
  -- 'gpslogger' | 'timeline' | 'manual'
  ingest_source TEXT NOT NULL,
  drive_file_id TEXT,
  -- Drive API 的 md5Checksum。用它判斷要不要重抓 ——
  -- 每次 auto-send 都會更新 modifiedTime，即使一整段時間靜止沒有新點，
  -- 只看 modifiedTime 會白抓白解析。
  md5 TEXT,
  point_count INTEGER NOT NULL DEFAULT 0,
  -- 這一天的手機所在時區，供顯示用；不參與任何運算
  tz_offset_minutes INTEGER,
  -- 軌跡自成一組隱私旗標，不繼承相簿的 map_private。預設私密。
  is_private INTEGER NOT NULL DEFAULT 1,
  synced_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 軌跡點。冪等重灌 = DELETE WHERE day_key=? 之後整批 insert。
CREATE TABLE IF NOT EXISTS TrackPoint (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  day_key TEXT NOT NULL,
  -- ISO8601 UTC。唯一的時間權威，排序與照片配對都用它
  t_utc TEXT NOT NULL,
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  -- GPX 的 <src>：'gps' | 'network'。GPX 沒有 accuracy 欄位，這是唯一的品質訊號 ——
  -- network 的點在靜止時可能跳約 140m。存下來，繪製時才決定要不要用
  -- （存了可以丟，沒記到救不回來；室內／地下只有 network 有資料）。
  src TEXT,
  hdop REAL,
  -- 第幾個 <trkseg>。一天可能有多段（每次停止記錄就會斷一段），
  -- 畫線時不同 seg 之間不可以連起來
  seg INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (day_key) REFERENCES TrackDay(day_key) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_trackpoint_day ON TrackPoint(day_key, t_utc);
CREATE INDEX IF NOT EXISTS idx_trackpoint_time ON TrackPoint(t_utc);
