-- 0013：照片留言 ＋ 未讀通知。
--
-- 燈箱右側那塊黑色區域本來只有 Story／標籤／EXIF，現在多一區留言：
-- 成員（Google 登入、在白名單上）可以留言與回覆，訪客（密碼進站）只能看、不能寫。
--
-- ## 為什麼訪客「寫不了」不是靠程式擋
--
-- Comment.user_id 是 NOT NULL 且指向 User。訪客身分**在 D1 裡根本沒有對應的列**，
-- 所以「訪客留言」這個狀態連表達都表達不出來。程式層的檢查是為了給出好的錯誤訊息，
-- 不是唯一的防線。
--
-- ## 三個開關，兩種粒度（沿用既有的模式，不另創一套）
--
--   can_comment        每人一欄。同 0010 的理由：站長要能單獨關掉某一個人
--   can_view_comments  每人一欄。同上
--   guest_can_view_comments   全站一個，放 AppSetting（不在這裡，那張表是 key/value）
--
-- 訪客的開關一律做成全站設定、預設關 —— 跟 guest_can_view_map 同一套。
-- 預設關的理由是隱私：訪客一旦看得到留言，就看得到家人的顯示名稱。
--
-- ## 回覆只有一層
--
-- parent_id 只允許指向 parent_id IS NULL 的留言（程式層檢查）。這就是 FB 的實際
-- 行為：要回某個人的回覆就 @ 他，不再往下縮排。無限巢狀在手機上第三層就沒地方擺了。

-- 可以留言。預設開 —— 這是家族相簿，不是要防誰
ALTER TABLE User ADD COLUMN can_comment INTEGER NOT NULL DEFAULT 1;

-- 看得到留言。預設開。關掉的人連留言區整塊都不會出現
ALTER TABLE User ADD COLUMN can_view_comments INTEGER NOT NULL DEFAULT 1;

/*
 * 通知讀到哪裡了。NULL ＝ 從來沒點開過通知清單，那就全部算未讀。
 *
 * **刻意只有一個時間戳，不做逐則已讀。** 逐則已讀要嘛每個人每則通知寫一列
 * （fan-out 寫入，這個站的規模不值得），要嘛在 CommentNotify 上加 read_at 然後
 * 每次點開就 UPDATE 一整批。一個時間戳換來的是「點開通知清單 = 一次 UPDATE」，
 * 代價是沒辦法只把其中一則標成已讀。家族站這個取捨划算。
 */
ALTER TABLE User ADD COLUMN notif_seen_at TEXT;

CREATE TABLE IF NOT EXISTS Comment (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  photo_id   INTEGER NOT NULL,
  -- 留言的人。CASCADE：帳號真的被 purge 掉時，他的留言跟著走
  -- （purge 那條路本來就是「把這個人抹掉」，留下無主留言只會更難解釋）
  user_id    INTEGER NOT NULL,
  -- NULL ＝ 主留言。有值 ＝ 回覆，而且那一則保證是主留言（只有一層）
  parent_id  INTEGER,
  /*
   * 內文。@ 某人在這裡是 `@[uid]` 這種標記，**存 id 不存名字** ——
   * 家人之後改顯示名稱，舊留言不會留著過期的舊名。渲染時前端拿
   * GET /api/users/mentionable 的清單換回名字。
   */
  body       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (photo_id)  REFERENCES Photo(id)   ON DELETE CASCADE,
  FOREIGN KEY (user_id)   REFERENCES User(id)    ON DELETE CASCADE,
  FOREIGN KEY (parent_id) REFERENCES Comment(id) ON DELETE CASCADE
);

-- 燈箱開一張照片就是這一條查詢，(photo_id, id) 讓它只走索引
CREATE INDEX IF NOT EXISTS idx_comment_photo ON Comment(photo_id, id);
-- 刪主留言時 SQLite 要照這個找出所有回覆
CREATE INDEX IF NOT EXISTS idx_comment_parent ON Comment(parent_id);

/*
 * 「這則留言要通知誰」。一則留言對同一個人**最多一列**（PK 擋掉重複）。
 *
 * reason 的優先序由高而低：mention > reply > photo > album。
 * 寫入時照這個順序 INSERT OR IGNORE，先寫的贏 —— 你同時是相簿主人、照片上傳者
 * 又剛好被 @ 的時候只會收到一則，而且文案說的是「提到了你」，不是比較弱的那個理由。
 *
 * 留言者本人不進這張表（自己講的話不用通知自己）。
 *
 * created_at 跟 Comment 那欄是重複的，這是刻意的：未讀數的查詢
 * （WHERE user_id = ? AND created_at > notif_seen_at）因此不必 JOIN 回 Comment，
 * 單一索引掃描就算得出來。那個數字每次進站都要算一次，值得這個重複。
 */
CREATE TABLE IF NOT EXISTS CommentNotify (
  comment_id INTEGER NOT NULL,
  user_id    INTEGER NOT NULL,
  -- 'mention' | 'reply' | 'photo' | 'album'
  reason     TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (comment_id, user_id),
  FOREIGN KEY (comment_id) REFERENCES Comment(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id)    REFERENCES User(id)    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_commentnotify_user ON CommentNotify(user_id, created_at);
