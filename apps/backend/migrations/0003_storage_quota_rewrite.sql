-- Phase 0：儲存與免費額度改寫的 schema 基礎
-- 對應計畫見記憶檔 storage-quota-rewrite-plan.md
--
-- 這支 migration 只加欄位、索引與 FTS 表，不改任何既有資料的語意。
-- 既有照片的 drive_file_id / drive_original_id / thumb_sm_url 一律留 NULL，
-- 讀取端一律用 COALESCE 退回舊欄位，所以套用後行為完全不變。

-- ---------------------------------------------------------------------------
-- 1. Drive 對應與新的縮圖尺寸
-- ---------------------------------------------------------------------------
-- drive_file_id      : Drive 上的 4K WebP 衍生檔，燈箱大圖的來源
-- drive_original_id  : Drive 上的原始檔，純備份，不對外服務
-- thumb_sm_url       : R2 的 400px WebP，給相簿卡片輪播與地圖標記用
--                      （thumb_url 之後改放 800px，給相簿格線用）
ALTER TABLE Photo ADD COLUMN drive_file_id TEXT;
ALTER TABLE Photo ADD COLUMN drive_original_id TEXT;
ALTER TABLE Photo ADD COLUMN thumb_sm_url TEXT;

-- ---------------------------------------------------------------------------
-- 2. 全域隨機預覽
-- ---------------------------------------------------------------------------
-- 首頁相簿卡片要從整本相簿隨機挑 5 張。ORDER BY RANDOM() 會讓索引失效變成
-- 整本掃描（5000 張相簿 = 讀 5000 列），OFFSET 隨機也要一列一列走過去。
-- 改成每張照片給一個隨機鍵，查詢變成 index seek，只讀 5 列：
--   WHERE album_id = ? AND shuffle_key >= ? ORDER BY shuffle_key LIMIT 5
--
-- 範圍刻意壓在 0..2^31-1 而不是 random() 的完整 int64 —— JS 的 number 存不下
-- 64 位元整數，後端要產同範圍的隨機種子去比對，超出安全整數就會對不準。
--
-- 不能拿 sort_order 來用：它只有手動排序過的相簿才是密集的 0,1,2,…，
-- 沒排序過的整本都是 0。
ALTER TABLE Photo ADD COLUMN shuffle_key INTEGER;
UPDATE Photo SET shuffle_key = abs(random()) % 2147483647 WHERE shuffle_key IS NULL;
CREATE INDEX IF NOT EXISTS idx_photo_album_shuffle ON Photo(album_id, shuffle_key);

-- ---------------------------------------------------------------------------
-- 3. 標籤反向查詢
-- ---------------------------------------------------------------------------
-- PhotoTag 的 PK 是 (photo_id, tag_id)，只能由照片查標籤。
-- 「找出帶某標籤的所有照片」目前是整張表掃描。
CREATE INDEX IF NOT EXISTS idx_phototag_tag ON PhotoTag(tag_id, photo_id);

-- ---------------------------------------------------------------------------
-- 4. 地圖足跡
-- ---------------------------------------------------------------------------
-- 既有的 idx_photo_geo(lat, lng) 沒被用到 —— /api/footprint 的條件是
-- lat IS NOT NULL，選擇性不足，EXPLAIN 出來是 SCAN p。
-- 改用 partial index：索引本身只含有座標的列，且照 taken_at 排好。
CREATE INDEX IF NOT EXISTS idx_photo_geo_nn ON Photo(taken_at)
  WHERE lat IS NOT NULL AND lng IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 5. 全文檢索
-- ---------------------------------------------------------------------------
-- rowid 直接對齊 Photo.id，所以不需要額外的對照表。
--
-- 刻意「不」用 contentless（content=''）：那種表不支援用 rowid 做 UPDATE/DELETE，
-- 而改標題、改標籤、刪照片都需要。多存一份文字的代價很小，title/description 都很短。
--
-- tokenize 用 unicode61（以空白斷詞）。中文靠寫入前的 bigram 前處理來切：
-- 「京都之旅」會存成「京都 都之 之旅」，查詢字串跑同一個函式，這樣兩個字的
-- 中文詞也搜得到。trigram tokenizer 雖然設定簡單，但查詢至少要 3 個字，
-- 「京都」「東京」這類兩字詞會搜不到，中文不適用。
--
-- 各欄內容：
--   title / description : Photo 同名欄位
--   tags                : 該照片所有 Tag.name 串接
--   place               : Photo.place_name
--   album               : 所屬 Album.name
-- 把 tags 併進來的用意是：打字搜尋一次命中標題、描述、標籤、地點、相簿名，
-- 完全不用碰 PhotoTag。點標籤按鈕的精確篩選才走 idx_phototag_tag。
CREATE VIRTUAL TABLE IF NOT EXISTS PhotoFts USING fts5(
  title,
  description,
  tags,
  place,
  album,
  tokenize = 'unicode61'
);
