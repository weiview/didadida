-- 0032：Android App 的推播（FCM）—— `PushDevice` 表 ＋ `User.online_pushed_at`
--
-- ## PushDevice：一支手機一列
-- `token` 是 FCM 發給那支 App 安裝的註冊 token，本身就是身分（PK）。
-- 同一支手機換人登入時 token 不變 —— 所以註冊是 upsert，**擁有者跟著最後
-- 登入的那個人走**，不然前一個人的通知會跳在下一個人的手機上。
-- FCM 回 UNREGISTERED 的那一列由後端當場刪掉（App 被移除、資料被清掉）。
-- 一個家幾支手機而已，不需要定期清理。
--
-- ## User.online_pushed_at：「XXX 上線囉」推播的節流
-- 上線判定跟網頁那則提示同一套（離開超過 150 秒再回來），但推播會把手機
-- 叫起來，所以同一個人**30 分鐘內最多推一次**。值由 /api/presence 那句
-- 條件式 UPDATE 寫，`meta.changes === 1` 才推 —— 不必先讀舊值。
-- 沒有 DEFAULT：NULL＝從來沒推過。
CREATE TABLE IF NOT EXISTS PushDevice (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES User(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_push_device_user ON PushDevice(user_id);

ALTER TABLE User ADD COLUMN online_pushed_at TEXT;
