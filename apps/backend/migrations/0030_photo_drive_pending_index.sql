-- 0030：「我傳的照片還缺 Drive 備份」用的部分索引
--
-- ## 為什麼要
-- 每個成員每次進站打 `/api/auth/me` 時，順手數一次「他自己傳的、Drive 還缺一半的」
-- 有幾張（紅字小窗靠它決定跳不跳）。既有的 idx_photo_uploaded_by 會讓這一句
-- **讀過他傳過的每一張照片**（幾千列 × 每個人的每次進站），而真的缺備份的
-- 通常是零到幾張。
--
-- ## 部分索引
-- 只有缺備份的那幾列進索引，所以讀到的列數就是缺件的張數。
-- ⚠️ WHERE 必須跟 index.ts 的 `DRIVE_PENDING_COND` **一字不差**（SQLite 只在查詢的
--    WHERE 含著一模一樣的式子時才會用部分索引）。改那個常數就要另加一支 migration
--    重建這個索引，不然查詢會安靜地退回全掃。
-- 補齊備份（drive id 寫回去）時那一列自己會離開索引，不需要清理。
CREATE INDEX IF NOT EXISTS idx_photo_drive_pending_uploader ON Photo(uploaded_by)
  WHERE ((media_type IN ('video','gif') AND drive_original_id IS NULL)
      OR (media_type NOT IN ('video','gif') AND (drive_file_id IS NULL OR drive_original_id IS NULL)));
