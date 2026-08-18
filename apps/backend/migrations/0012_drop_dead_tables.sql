-- 0012：刪掉兩張從來沒被用過的表。
--
-- ShareLink    分享連結。schema.sql 從第一天就建了它，但 index.ts 裡出現 0 次 ——
--              功能從來沒實作過。
-- TrackSegment 逐段交通工具。功能連同 GET/PUT /api/tracks/segments 一起拿掉之後，
--              程式裡只剩一句講 CASCADE 的註解提到它。
--
-- 留著的代價不是硬碟空間，是每次讀 schema 的人（含 AI）都會以為有這兩個功能，
-- 然後照著不存在的行為去推論。三個環境都確認過是 0 列，沒有資料要保。
--
-- 兩張都是葉節點（沒有任何表 REFERENCES 它們，只有它們指向 Album / TrackDay），
-- 所以不必管 DROP 的父子順序。

DROP TABLE IF EXISTS ShareLink;
DROP TABLE IF EXISTS TrackSegment;
