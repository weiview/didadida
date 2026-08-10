-- Phase 3：刪照片時要搬走的 Drive 檔案佇列。
--
-- 為什麼不在刪除當下直接搬：Workers 一次請求的 subrequest 有上限（免費版 50），
-- 而搬一個 Drive 檔要兩次往返（讀 parents + PATCH）。刪一本上千張的相簿等於
-- 上千次搬移，不管併發與否都不可能在同一次請求裡做完。
--
-- 所以刪除時只寫下「這些 Drive 檔該進 trash」，D1 的 Photo 列照常刪掉；
-- 真正的搬移由 /api/admin/drain-drive-trash 分批處理。這樣即使搬移一直失敗，
-- 要搬什麼也不會遺失 —— Photo 列刪掉之後就沒有別的地方記得這些 id 了。

CREATE TABLE IF NOT EXISTS DriveTrash (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  drive_id   TEXT NOT NULL,
  -- 只是給人看的線索，搬移本身用不到
  photo_id   INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  -- 連續失敗幾次。太多次就別再耗 subrequest 額度，留給人工看
  attempts   INTEGER NOT NULL DEFAULT 0,
  last_error TEXT
);

-- 排空時固定拿「還沒放棄的、最舊的」那幾筆
CREATE INDEX IF NOT EXISTS idx_drivetrash_pending ON DriveTrash(attempts, id);
