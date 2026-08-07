-- 把 album 欄位從 PhotoFts 拿掉。
--
-- 0003 把相簿名一起塞進照片的 FTS 文件，本意是讓打字搜尋一次命中相簿名。
-- 問題是 PUT /api/albums/:id 可以改相簿名字，改一次就得把整本相簿每一張照片的
-- FTS 列重寫。5000 張的相簿 = 一次改名寫 10000 列，直接吃掉當日 100K 寫入額度的
-- 十分之一，而且 Workers 單次 10ms CPU 也跑不完。
--
-- 相簿名改成搜尋時直接比對 Album 表。Album 頂多幾百列，掃過去的成本可以忽略，
-- 而且完全不需要同步。
--
-- tags 則保留在 FTS 裡：它是逐張照片的資料，加減標籤只影響那一張的 FTS 列。
-- ⚠️ 之後若新增「標籤改名」的路由，必須把帶該標籤的所有照片重新同步，
--    否則索引裡會留著舊名字。屆時應該比照 album 的處理方式把 tags 也拆出去。

DROP TABLE IF EXISTS PhotoFts;

CREATE VIRTUAL TABLE PhotoFts USING fts5(
  title,
  description,
  tags,
  place,
  tokenize = 'unicode61'
);
