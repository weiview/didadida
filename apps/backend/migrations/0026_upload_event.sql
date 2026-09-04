-- 有人上傳照片或影片時的全站通知。
--
-- ⚠️ **一批一列，不是一張一列。** 通知的重點是「家裡多了新東西」，
--    而一次上傳動輒幾百張 —— 逐張寫等於幾百次 D1 寫入，而免費額度是這個站的
--    最高宗旨。前端在一批收工時打一次 POST /api/uploads/announce，這裡就一列。
--
-- ⚠️ **也刻意不 fan-out 給每個人**（CommentNotify 那套是 PK 打在
--    (comment_id, user_id) 上的逐人列）。這裡的通知對全站成員長得一模一樣，
--    「誰讀過了」照舊靠 User.notif_seen_at 那一個時間戳比 created_at，
--    所以一列就夠。五個人 × 一批 = 還是一列。
--
-- ⚠️ 訪客整個不參與：他沒有 User 那一列，也拿不到 /api/notifications。
--
-- 量：一批一列，一年幾百列。清單查詢 LIMIT 30、心跳那支 LIMIT 1（PK 倒著讀），
-- 兩支都只讀得到個位數的列，不需要定期清理。
--
-- ⚠️ DROP TABLE 的順序：這張表指著 User 與 Album，要排在那兩張**前面**刪。
CREATE TABLE IF NOT EXISTS UploadEvent (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  -- 誰傳的。停權不影響（他傳過的東西還在），刪帳號才跟著消失
  user_id INTEGER NOT NULL,
  -- 傳進哪一本。相簿被刪掉之後通知還在，只是點不進去（同留言通知的作法）
  album_id INTEGER,
  photos INTEGER NOT NULL DEFAULT 0,
  videos INTEGER NOT NULL DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES User(id) ON DELETE CASCADE,
  FOREIGN KEY (album_id) REFERENCES Album(id) ON DELETE SET NULL
);

-- 清單是「最新的 30 則」，心跳那支是「最新的 1 則」，兩支都照時間倒著讀
CREATE INDEX IF NOT EXISTS idx_upload_event_created ON UploadEvent(created_at DESC, id DESC);
