-- 多使用者與權限。
--
-- 在這之前站上只有一個寫死的 User(id=1, 'Admin')，誰能當管理員完全由
-- ADMIN_EMAILS 這個環境變數決定 —— 要加一個人就得改 secret 再重新部署，
-- 而且站上完全不知道「這本相簿是誰建的」。
--
-- 現在白名單搬進 D1（就是 User 表），身分寫進 JWT，內容記得住主人。
--
-- 兩層權限，沒有第三層（使用者的原話：「預設是只能新增或刪除自己的相簿或相片，
-- 也可以讓他可以新增或刪除其他人的相簿或相片」）：
--   role='owner'          站長。永遠全開，而且只有他看得到後台設定頁。
--   can_manage_others=1   一般成員 + 可以動別人的相簿與照片。
--   can_manage_others=0   一般成員，只能動自己的（預設）。

-- 'owner' | 'member'。站長不只是「權限全開」，他還是唯一能改白名單的人，
-- 所以不能只用 can_manage_others 表達
ALTER TABLE User ADD COLUMN role TEXT NOT NULL DEFAULT 'member';

-- 可以新增／刪除／修改**別人**的相簿與照片
ALTER TABLE User ADD COLUMN can_manage_others INTEGER NOT NULL DEFAULT 0;

-- 0 ＝ 移出白名單，登不進來。
--
-- **移出白名單刻意不刪 User 列**：Album.user_id 是 ON DELETE CASCADE 的外鍵，
-- 刪掉列會連他建過的相簿與照片一起消失。取消一個人的存取權跟刪掉他的回憶
-- 是兩件事，不該由同一個動作順手完成。
ALTER TABLE User ADD COLUMN active INTEGER NOT NULL DEFAULT 1;

-- 純粹給後台看「這個帳號還在用嗎」，程式邏輯不讀它
ALTER TABLE User ADD COLUMN last_login_at TEXT;

/*
 * 既有的 User(id=1) 是 POST /api/albums 順手塞的佔位帳號
 * （'Admin' / 'admin@didadida.com'），而站上每一本相簿的 user_id 都是 1。
 * 把它改寫成站長本人，既有內容就自動歸到站長名下，不必動 Album。
 *
 * 信箱寫死在這裡是刻意的：這是「這個站是誰的」，不是設定值。
 * 換人接手就改這一行然後重跑（或直接改 D1）。
 */
UPDATE User
   SET email = 'ht021694@hotmail.com',
       name = COALESCE(NULLIF(name, 'Admin'), '站長'),
       role = 'owner',
       can_manage_others = 1,
       active = 1
 WHERE id = 1;

-- 空資料庫（還沒建過任何相簿）也要有站長，不然第一次 Google 登入會被白名單擋掉
INSERT OR IGNORE INTO User (id, name, email, role, can_manage_others, active)
VALUES (1, '站長', 'ht021694@hotmail.com', 'owner', 1, 1);

/*
 * 照片記上傳者。
 *
 * NULL ＝ 這一層不表態，回頭看相簿的 user_id（0008 之前的照片全是這種）。
 * 有值就代表「這張是誰傳的」—— 判斷「是不是自己的照片」時，上傳者與
 * 相簿主人**任一相符就算數**：把照片放進別人的相簿之後自己反而動不了，
 * 或是相簿主人管不到自己相簿裡的照片，兩種都不合直覺。
 */
ALTER TABLE Photo ADD COLUMN uploaded_by INTEGER;

