-- 足跡地圖：座標與時區欄位
-- 座標拉成一等公民欄位，不埋在 Photo.exif JSON 裡 —— JSON 無法建索引、無法做範圍查詢

ALTER TABLE Photo ADD COLUMN lat REAL;
ALTER TABLE Photo ADD COLUMN lng REAL;
-- 座標來源：'exif'(照片自帶，最可信，永不被區段覆蓋) | 'interpolated'(前後內插) | 'manual'(區段套用)
ALTER TABLE Photo ADD COLUMN geo_source TEXT;
-- 反查後快取的地名，避免每次渲染都打外部 API
ALTER TABLE Photo ADD COLUMN place_name TEXT;
-- 單張照片層級隱私，預設私密(1)：家裡等敏感地點即使地圖公開也排除
ALTER TABLE Photo ADD COLUMN geo_private INTEGER NOT NULL DEFAULT 1;

-- 時區：既有的 taken_at 維持「UTC 瞬間」的角色(排序/去重用)，不改名以免動到現有查詢；
-- 另存牆上時間供顯示與行程段比對，因為使用者說「3/1 我在京都」指的是當地時間
ALTER TABLE Photo ADD COLUMN taken_at_local TEXT;
ALTER TABLE Photo ADD COLUMN tz_offset_minutes INTEGER;

CREATE INDEX IF NOT EXISTS idx_photo_geo ON Photo(lat, lng);
CREATE INDEX IF NOT EXISTS idx_photo_taken_at ON Photo(taken_at);
CREATE INDEX IF NOT EXISTS idx_photo_taken_at_local ON Photo(taken_at_local);

-- 相簿層級隱私，預設私密(1)：整個足跡地圖對外隱藏
ALTER TABLE Album ADD COLUMN map_private INTEGER NOT NULL DEFAULT 1;

-- 行程段：使用者批次指定的「這段時間我在這裡」規則。
-- 與照片層級的 lat/lng 分開存 —— 照片上的是事實(親手指定)，這裡是規則(供日後新增的照片自動套用)
CREATE TABLE IF NOT EXISTS TripSegment (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  album_id INTEGER,
  label TEXT NOT NULL,
  -- 牆上時間，格式與 Photo.taken_at_local 一致才能直接比對
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
