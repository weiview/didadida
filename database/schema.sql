-- User Table
--
-- 同時就是「可以用 Google 登入當管理員」的白名單（見 migrations/0008）。
-- 移出白名單是把 active 設成 0，**不是刪列** —— Album.user_id 的外鍵是
-- ON DELETE CASCADE，刪列會連他建過的相簿一起帶走。
CREATE TABLE IF NOT EXISTS User (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  -- 'owner'（站長，權限全開且是唯一能改白名單的人）| 'member'
  role TEXT NOT NULL DEFAULT 'member',
  -- 可以動**別人**的相簿與照片。0 就只動得了自己的
  can_manage_others INTEGER NOT NULL DEFAULT 0,
  -- 0 ＝ 已移出白名單，登不進來
  active INTEGER NOT NULL DEFAULT 1,
  last_login_at TEXT,
  -- 這個人的軌跡在地圖上的顏色（'#rrggbb'），自己選。NULL ＝ 還沒選過
  track_color TEXT,
  -- 這個人自己的 GPSLogger Drive 資料夾 id（見 migrations/0009）
  track_drive_folder_id TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Album Table
CREATE TABLE IF NOT EXISTS Album (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT,
  user_id INTEGER NOT NULL,
  sort_order INTEGER DEFAULT 0,
  cover_photo_url TEXT,
  cover_text TEXT,
  -- 足跡地圖對外隱藏與否，預設私密
  map_private INTEGER NOT NULL DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES User(id) ON DELETE CASCADE
);

-- Photo Table
CREATE TABLE IF NOT EXISTS Photo (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  file_name TEXT NOT NULL,
  description TEXT,
  album_id INTEGER NOT NULL,
  -- UTC 瞬間，用於排序與去重
  taken_at DATETIME,
  -- 牆上時間，用於顯示與行程段比對
  taken_at_local TEXT,
  tz_offset_minutes INTEGER,
  -- taken_at 是怎麼算出來的，決定它能不能拿去比對 GPS 軌跡
  -- 'manual' | 'offset_tag' | 'gps_utc' | 'file_time' | 'assumed'
  time_source TEXT,
  sort_order INTEGER DEFAULT 0,
  exif TEXT,
  file_hash TEXT,
  phash TEXT,
  lat REAL,
  lng REAL,
  -- 權威由高而低：'manual' | 'exif' | 'track' | 'timeline' | 'segment' | 'interpolated'
  geo_source TEXT,
  place_name TEXT,
  -- 「這一張特別不要出現在地圖上」。預設 0 ＝ 跟著相簿的 map_private 走，
  -- 相簿層級才是公開與否的閘門（見 migrate_geo_private_default.sql）
  geo_private INTEGER NOT NULL DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  url TEXT,
  thumb_url TEXT,
  -- 誰傳的。NULL ＝ 這一層不表態，回頭看相簿的 user_id（見 migrations/0008）
  uploaded_by INTEGER,
  FOREIGN KEY (album_id) REFERENCES Album(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_photo_file_hash ON Photo(file_hash);
CREATE INDEX IF NOT EXISTS idx_photo_phash ON Photo(phash);
CREATE INDEX IF NOT EXISTS idx_photo_album_sort ON Photo(album_id, sort_order, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_photo_geo ON Photo(lat, lng);
CREATE INDEX IF NOT EXISTS idx_photo_taken_at ON Photo(taken_at);
CREATE INDEX IF NOT EXISTS idx_photo_taken_at_local ON Photo(taken_at_local);

-- TripSegment Table：使用者批次指定的「這段時間我在這裡」規則
CREATE TABLE IF NOT EXISTS TripSegment (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  album_id INTEGER,
  label TEXT NOT NULL,
  start_local TEXT NOT NULL,
  end_local TEXT NOT NULL,
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  place_name TEXT,
  tz_offset_minutes INTEGER,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (album_id) REFERENCES Album(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_tripsegment_album ON TripSegment(album_id);
CREATE INDEX IF NOT EXISTS idx_tripsegment_time ON TripSegment(start_local, end_local);

-- TrackDay Table：一個 day_key = Drive 上的一個 GPX 檔，記同步狀態
-- day_key 是不透明字串（就是檔名加上使用者前綴），只負責「重拉時該刪哪一批」；
-- 檔名是手機當地日期但檔內時戳是 UTC，兩者不可混為一談
--
-- 多人之後 day_key = 'u<uid>:<檔名>'（uid 1 無前綴，見 migrations/0009）：
-- 兩個人同一天都會產出 20260813.gpx，不加前綴會互相洗掉
CREATE TABLE IF NOT EXISTS TrackDay (
  day_key TEXT PRIMARY KEY,
  -- 這一天的軌跡是誰的。刻意不加 ON DELETE CASCADE，見 migrations/0009
  user_id INTEGER REFERENCES User(id),
  -- 'gpslogger' | 'timeline' | 'manual'
  ingest_source TEXT NOT NULL,
  drive_file_id TEXT,
  -- Drive 的 md5Checksum，用來跳過內容沒變的檔案
  md5 TEXT,
  -- 原始 GPX 在 R2 的 key。留著才能在手動編修之後還原成剛匯入的樣子。
  -- NULL = 這功能之前同步的，或來自 Google 時間軸（本來就沒有 GPX）
  raw_key TEXT,
  point_count INTEGER NOT NULL DEFAULT 0,
  tz_offset_minutes INTEGER,
  -- 「就算沒有任何公開相簿，這一天也要公開」。預設 1 ＝ 不主動公開，
  -- 但只要有公開相簿的行程時間窗蓋到，那一段軌跡仍然看得到
  -- （見後端的 publicTripWindows）
  is_private INTEGER NOT NULL DEFAULT 1,
  synced_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- TrackPoint Table：軌跡點。t_utc 是唯一的時間權威
CREATE TABLE IF NOT EXISTS TrackPoint (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  day_key TEXT NOT NULL,
  t_utc TEXT NOT NULL,
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  -- GPX 的 <src>：'gps' | 'network'。GPX 沒有 accuracy，這是唯一的品質訊號
  src TEXT,
  hdop REAL,
  -- 第幾個 <trkseg>，不同 seg 之間畫線時不可連起來
  seg INTEGER NOT NULL DEFAULT 0,
  -- 停留點：室內 GPS 亂跳的一整串點被收成質心上的兩個點（進入／離開），
  -- 這裡記在前者上，代表待了幾秒。NULL = 一般的移動點
  stay_sec INTEGER,
  FOREIGN KEY (day_key) REFERENCES TrackDay(day_key) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_trackpoint_day ON TrackPoint(day_key, t_utc);
CREATE INDEX IF NOT EXISTS idx_trackpoint_time ON TrackPoint(t_utc);
CREATE INDEX IF NOT EXISTS idx_trackday_user ON TrackDay(user_id);

-- （TrackSegment 逐段交通工具已由 migration 0012 刪除，這裡不再建）

-- Tag Table
CREATE TABLE IF NOT EXISTS Tag (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL
);

-- PhotoTag Table (Many-to-Many)
CREATE TABLE IF NOT EXISTS PhotoTag (
  photo_id INTEGER NOT NULL,
  tag_id INTEGER NOT NULL,
  PRIMARY KEY (photo_id, tag_id),
  FOREIGN KEY (photo_id) REFERENCES Photo(id) ON DELETE CASCADE,
  FOREIGN KEY (tag_id) REFERENCES Tag(id) ON DELETE CASCADE
);

-- （ShareLink 分享連結從沒實作過，已由 migration 0012 刪除，這裡不再建）

-- Favorite Table
CREATE TABLE IF NOT EXISTS Favorite (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  photo_id INTEGER NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES User(id) ON DELETE CASCADE,
  FOREIGN KEY (photo_id) REFERENCES Photo(id) ON DELETE CASCADE,
  UNIQUE(user_id, photo_id)
);
