-- 0033：誰看過哪一張新照片 —— `PhotoSeen`
--
-- NEW 角標的規則（2026-09-29 使用者拍板）：
--   * 上傳一週內才算新；超過一週不管看過沒一律不顯示。
--   * **點開那一張（燈箱）才算看過**，逐張、逐人記。
--   * 自己傳的不對自己顯示 NEW（不必寫進這張表，查詢時看 uploaded_by）。
-- 只記一週內的照片（寫入端擋），cron 每天清掉 8 天前的列 —— 表永遠只有
-- 「最近一週 × 家裡幾個人」那麼大。訪客沒有 User 那一列，記在自己的 localStorage。
CREATE TABLE IF NOT EXISTS PhotoSeen (
  user_id INTEGER NOT NULL REFERENCES User(id) ON DELETE CASCADE,
  photo_id INTEGER NOT NULL REFERENCES Photo(id) ON DELETE CASCADE,
  seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, photo_id)
);
CREATE INDEX IF NOT EXISTS idx_photo_seen_at ON PhotoSeen(seen_at);
