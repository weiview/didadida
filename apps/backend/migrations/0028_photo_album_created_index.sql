-- 首頁那排相簿卡片要知道「這本裡面有沒有一週內新增的照片」。
--
-- 沒有這個索引的話，`WHERE album_id = ? ORDER BY created_at DESC LIMIT 1` 只能靠
-- idx_photo_album_sort(album_id, sort_order, created_at DESC) —— created_at 排在第三欄，
-- 拿它排序等於把那本相簿的每一筆索引項目走過一遍。一本幾千張、首頁一次問十幾本，
-- 每開一次首頁就是上萬列讀取，而免費額度是這個站的最高宗旨。
--
-- 有了它就是「這本相簿最新的那一筆」＝一列索引 + 一列資料。
CREATE INDEX IF NOT EXISTS idx_photo_album_created ON Photo(album_id, created_at DESC);
