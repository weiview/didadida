-- User Table
CREATE TABLE IF NOT EXISTS User (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
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
  sort_order INTEGER DEFAULT 0,
  exif TEXT,
  file_hash TEXT,
  phash TEXT,
  lat REAL,
  lng REAL,
  -- 'exif' | 'interpolated' | 'manual'
  geo_source TEXT,
  place_name TEXT,
  geo_private INTEGER NOT NULL DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  url TEXT,
  thumb_url TEXT,
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

-- ShareLink Table
CREATE TABLE IF NOT EXISTS ShareLink (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  album_id INTEGER NOT NULL,
  token TEXT UNIQUE NOT NULL,
  expires_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (album_id) REFERENCES Album(id) ON DELETE CASCADE
);

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
