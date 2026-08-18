# didadida — 給 AI 助理的專案須知

個人／家族相簿網站 ＋ GPS 足跡地圖。Cloudflare 全家桶，**必須留在免費額度內**。
這份文件寫的是**現況**與**會咬人的地方**，不是教學也不是變更歷史。

> ⚠️ **免費額度是最高宗旨。** 任何可能產生 Cloudflare 費用的操作（跨區大量讀寫、
> 開新的付費資源、對 prod D1 做大 backfill）**先問過再做**。prod 與 dev 的 D1／R2
> 是完全切開的兩套，不要交叉。

---

## 技術棧與版圖

| 層 | 用什麼 | 名字 |
|---|---|---|
| API | Cloudflare Worker（單檔） | `didadida-api` / `didadida-api-dev` |
| DB | D1 (SQLite) | `didadida-db` / `didadida-db-dev` |
| 物件 | R2 | `didadida-photos` / `didadida-photos-dev` |
| 前端 | Next.js 14 `output: "export"` 純靜態 → Cloudflare Pages | `didadida-frontend` |
| 大圖備份 | Google Drive（站長帳號） | `didadida` / `dev.didadida` / `local.didadida` |

npm workspaces monorepo（`apps/*`、`packages/*`）；**`packages/` 目前不存在**。
wrangler 停在 3.114.17，**刻意不升 4.x**。

## 目錄

```
apps/backend/
  src/index.ts       ~4600 行，所有路由都在同一個 fetch handler 裡，一長串
                     if (method === … && pathname === …) 依序比對。沒有 router 套件。
  src/drive.ts       Google Drive（service account 讀 + 站長 refresh token 寫）
  src/geo.ts         EXIF 座標／時區正規化 —— 與 apps/frontend/src/lib/geo.ts 是兩份副本
  src/fts.ts         FTS5 全文檢索
  migrations/        ✅ schema 變更的權威位置（0003 起）
  wrangler.toml      prod ＋ [env.dev] 兩組 D1/R2/vars/triggers
apps/frontend/
  src/app/           App Router：/ (首頁)、/album、/map、/admin
  src/components/    FootprintMap.tsx 是最大的一支（maplibre-gl，dynamic import 禁 SSR）
  src/lib/api.ts     唯一的 API 客戶端
  functions/_middleware.ts   Pages Function：非台灣來源直接 403
database/
  schema.sql         歷史起點的基礎 schema ＋ 一堆 migrate_*.sql（**舊路徑，別再往這加**）
```

## 後端的請求流程

`src/index.ts` 沒有 router，一個 `fetch` 由上往下比對。順序是：

```
OPTIONS 直接回（快取一天）
  → 非 TW 來源 403
  → 進站閘門：白名單以外沒 token 一律 401 {"error":"locked"}
  → withEdgeCache（⚠️ 閘門一定要在它前面）
  → 一長串 if (method === … && pathname === …)
```

閘門白名單只有兩類，**不要隨手加第三類**：換 token 的入口
（`/api/verify-password`、`/api/verify-guest`、`/api/auth/me`、`/api/auth/google/*`），
以及圖片（`/api/photos/view/*`、`/api/photos/:id/full`）—— 圖片是 `<img src>`，
瀏覽器不會幫忙帶 Authorization，而 R2 的物件鍵要先拿到（鎖著的）相簿 JSON 才知道。
**新路由預設就是關的**，這是刻意的。

身分用 `currentActor(request, env)` 拿，它有 `WeakMap<Request>` 快取 ——
同一個請求裡問幾次都只查一次 D1，**不要自己再 `SELECT … FROM User`**，那是白花讀取額度。

### 已移除、不要再呼叫

| 沒了的 | 改用 |
|---|---|
| `GET /api/tracks/drive/shared-folders` | `POST /api/tracks/drive/sync-folders`（照信箱自動綁，不再人工挑） |
| `GET/PUT /api/tracks/segments` | 沒有替代品，逐段交通工具整個功能拿掉了 |
| `ADMIN_EMAILS` 環境變數 | D1 的 `User` 表 |
| `GOOGLE_PICKER_API_KEY` | Picker 那條路已移除，程式不再讀它 |

## 三個環境

| | 本機 | dev | prod |
|---|---|---|---|
| API | `wrangler dev` :8787（miniflare，不吃額度） | `didadida-api-dev.didadida.workers.dev` | `didadida-api.didadida.workers.dev` |
| 前端 | `next dev` :3000 | `dev.didadida-frontend.pages.dev` | `didadida-frontend.pages.dev` |
| D1/R2 | `apps/backend/.wrangler/state/` | `-dev` 那組 | 正式那組 |

⚠️ **兩個 Pages 網址長得幾乎一樣，登入狀態也各自獨立，極容易搞混。**
「我現在看的是哪個環境？」**先查 D1 不要信畫面** —— 兩個 D1 各 `SELECT … FROM Album`，
資料落在哪邊就是哪邊；再驗一次烤進 bundle 的 API URL。

## 開發

```bash
npm install                                   # 根目錄，workspaces 會一起裝
cd apps/backend  && npx wrangler dev --env dev --port 8787 --ip 127.0.0.1
cd apps/frontend && npm run dev               # :3000，讀 .env.development
```

本機 D1 建庫：
```bash
cd apps/backend
npx wrangler d1 execute didadida-db-dev --env dev --local --file=../../database/schema.sql -y
for f in migrations/*.sql; do npx wrangler d1 execute didadida-db-dev --env dev --local --file="$f" -y; done
```

**祕密不在 repo 裡**，要自己建 `apps/backend/.dev.vars`（gitignore，**永遠不要讀出內容或印出來**）。
需要的 key：見 `apps/backend/.dev.vars.example`。前端 `.env.development` 也不在 repo，
內容只有一行 `NEXT_PUBLIC_API_URL=http://127.0.0.1:8787/api`。

> `apps/frontend/.env.production` **有進 repo**（比 `.gitignore` 早加，ignore 對已追蹤檔無效）。
> 裡面只有公開的 prod API URL，不是外洩。

沒有任何測試套件。型別檢查用 `cd apps/backend && npm run typecheck`
（**有既有錯誤**：`index.ts` 的 TS2352／TS2345，以及 workers-types 與 @types/node 衝突的連帶錯誤，不是你改壞的）。

## 部署

**改完一律部署 dev ＋ prod 兩邊**，不用問。使用者只在遠端看狀態，只推 dev 等於他看不到。
順序固定 **migration → 後端 → 前端**，反過來會讓所有登入者的請求 500。

```bash
# 1. migration（有的話。三個 D1 各自套，先 local 驗過再上遠端）
cd apps/backend
npx wrangler d1 execute didadida-db-dev --remote --file migrations/00NN_xxx.sql
npx wrangler d1 execute didadida-db     --remote --file migrations/00NN_xxx.sql

# 2. 後端
npx wrangler deploy --env dev
npx wrangler deploy

# 3. 前端（dev 一定要覆蓋 API URL，.env.production 指的是 prod）
cd ../frontend && rm -rf .next out
NEXT_PUBLIC_API_URL="https://didadida-api-dev.didadida.workers.dev/api" npx next build
npx wrangler pages deploy out --project-name didadida-frontend --branch dev  --commit-dirty=true
rm -rf .next out && npx next build
npx wrangler pages deploy out --project-name didadida-frontend --branch main --commit-dirty=true
```

部署地雷：

- **Pages 是 direct-upload 專案，不加 `--branch main` 正式站不會動。** 沒有 git 自動部署。
- **build 前後都要驗烤進去的是哪個 API**：`grep -rl didadida-api-dev out/_next/static/chunks/`
  （dev build 應命中 1、prod build 應命中 0）。
- **`d1 migrations apply` 會互動確認**，非互動 shell 跑不動。用 `d1 execute --remote --file`
  再手動 `INSERT OR IGNORE INTO d1_migrations (name) VALUES ('00NN_xxx.sql')` 補記。
- **`d1_migrations` 那張表不可信** —— 它只記 apply 過的，`d1 execute --file` 不會寫它。
  判斷「到底套過沒」要看 `sqlite_master` 的實際欄位。
- **`next build` 會殺掉常駐的 `next dev`**（共用 `.next/`）。流程：停 dev server → 刪
  `.next`/`out` → build → deploy → 再刪 → 重開 dev。**刪 `.next` 跟開 dev server 不要寫在同一行。**
- smoke test **每條都要加 `?cb=<random>`**，遠端邊快取會回假 404。
  期待值：未帶 token 打 `/api/albums` → `401 {"error":"locked"}`；兩站 `/` 與 `/admin` → 200。
  `/admin?cb=…` 不要帶結尾斜線（`/admin/` 會 308）。
- 驗線上 JS 內容**不要 match 中文** —— `.js` 沒帶 charset，會被當 ISO-8859-1 解碼而必定 match 不到，
  看起來像沒部署成功。改成下載後比 `Get-FileHash`／`sha256sum`。
- **站門閘擋在路由判斷之前**，所以「某條路由刪掉了沒」用未帶 token 的請求驗不出來（一律 401 不是 404），
  只能看 Version ID。

### 遠端需要的 secret（`wrangler secret put … [--env dev]`）

`.dev.vars` 只餵 local，**不會同步到遠端**。兩個環境各自要有：

| secret | 沒設的後果 |
|---|---|
| `APP_PASSWORD` | JWT 簽章金鑰，缺了整個認證掛掉 |
| `GUEST_PASSWORD` | `/api/verify-guest` 回 503，除了 Google 登入沒人進得了站 |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Google 登入整條掛掉 |
| `GOOGLE_DRIVE_SA_KEY` | 燈箱取大圖、搬 trash、讀 GPSLogger 全掛 |
| `DRIVE_WRITER_REFRESH_TOKEN` | 選配。沒設不會壞，只是站長第一次 Google 登入前沒有 Drive 備份 |

⚠️ **`$v | wrangler secret put` 會多存一個換行**（管線加的，wrangler 不 trim），
曾經害 Google 回 `invalid_grant` 而畫面上顯示成「授權過期」。灌值時注意。

Google Cloud Console 的「已授權的重新導向 URI」要含**每個 worker 自己的 origin** ＋
`/api/auth/google/callback`（prod、dev、`http://127.0.0.1:8787` 三個）。

## 資料模型

`schema.sql` 是歷史起點，之後所有變更在 `apps/backend/migrations/`（目前到 0014）。
**新的 schema 變更一律加在那裡**，不要再往 `database/` 加。
`wrangler.toml` 沒設 `migrations_dir`，預設就是 wrangler.toml 旁邊的 `migrations/`。

現有表：`User`／`Album`／`Photo`／`PhotoFts`(FTS5, bigram)／`Tag`／`PhotoTag`／`Favorite`／
`TripSegment`／`TrackDay`／`TrackPoint`／`AppSetting`／`DriveTrash`／`Comment`／`CommentNotify`。
**沒有多餘的表**—— `ShareLink`（從沒實作的分享連結）與 `TrackSegment`（拿掉的逐段交通工具）
已由 0012 刪除，`database/schema.sql` 裡那兩塊 `CREATE TABLE` 也一併移除了。

新環境建庫是 `schema.sql` **再套完所有 migration**，**不要照 schema.sql 推論現況**。

- `Photo.taken_at`（UTC 瞬間）／`taken_at_local`（牆上時間）／`tz_offset_minutes`，
  不變量是 **`taken_at = taken_at_local − tz`**。
- `Photo` 除了基本欄位還有：`drive_file_id`／`drive_original_id`（Drive 上的 4K 與原始檔）、
  `thumb_url`／`thumb_sm_url`（R2 的 800／400 WebP）、`uploaded_by`（誰傳的，見「身分與權限」）、
  `file_hash`／`phash`（去重）、`shuffle_key`（隨機排序用的固定亂數）。
- `LOCAL_TIME_EXPR` = `COALESCE(p.taken_at_local, …)`，用到它的 SQL **必須把 Photo 別名為 `p`**。
- `geo_source` 權威由高而低：`manual` > `exif` > `track` > `timeline` > `segment` > `interpolated`。
- `TrackDay.day_key` 是**不透明字串**（多身分之後還帶使用者前綴），**不要拿去解析日期**。
- `Comment`／`CommentNotify` 見「留言」一節。
- **DROP TABLE 要由子表往父表**：`CommentNotify→Comment→Favorite→PhotoTag→TripSegment→
  Photo→Album→TrackPoint→TrackDay→Tag→DriveTrash→AppSetting→User`。開著外鍵時照字母序刪
  會 FK failed，而且是**跑到一半才炸**（`d1 execute --file` 是單一交易，會整包回滾）。

## 身分與權限

三層：**訪客**（輸入訪客密碼拿 guest token）／**成員**（Google 登入，白名單內）／**站長**。

- **白名單就是 D1 的 `User` 表**，沒有 `ADMIN_EMAILS` 之類的後路。清掉 `User` = 沒有人登得進去，站長也一樣。
- 站長在 `/admin` 加人、給權限、停權。移出白名單是**停權（`active=0`）不是刪列**。
- 真的要刪帳號時，`Album.user_id` 是 `NOT NULL + CASCADE`，**改掛站長一定要排在刪 `User` 之前**。
- 前端判斷是不是管理員**只能用 `useAdmin()`**（context，Provider 在 `layout.tsx`，走 `GET /api/auth/me`）。
  不要自己讀 localStorage —— localStorage 只有 `admin_token`（JWT）。
- 照片歸屬看 `Photo.uploaded_by`，`NULL` 時回頭看相簿主人。算數量時**不要寫 `COALESCE`**
  （包在函式裡吃不到索引），要拆成 `uploaded_by = ?` 與 `uploaded_by IS NULL AND a.user_id = ?` 兩段。
- `photo_count`（他的相簿裡總共幾張，含別人傳的）與 `uploaded_count`（他自己傳了幾張，
  含傳進別人相簿的）**意思完全不同**，別混。
- 足跡地圖有兩層各自獨立的開關：成員看 `User.can_view_map`（每人一欄，預設開，
  **不被 `can_manage_others` 短路**），訪客看 `AppSetting.guest_can_view_map`（全站一格，預設關）。
  後端所有 `/api/tracks/*`、`/api/timeline/*` 都走 `guardTrackAccess()`：**沒登入 401、沒權限 403，
  而且刻意不看訪客那個開關** —— 軌跡是「誰什麼時候在哪裡」的連續紀錄，比照片座標敏感，一律要成員身分。
  `/api/footprint`（照片座標）才是兩層都認的那一支。

## 留言

燈箱右側的留言區（`app/album/PhotoComments.tsx`）。表是 `Comment` ＋ `CommentNotify`。

- **訪客留不了言，而且那不是開關** —— `Comment.user_id NOT NULL → User`，訪客沒有那一列。
  站長後台只有「訪客能不能**看**」一格（`AppSetting.guest_can_view_comments`，預設關）。
- 成員各自兩欄：`User.can_comment`／`can_view_comments`（預設都開）。
  **這兩格不被 `can_manage_others` 短路**，各自獨立；只有站長永遠全開。
- 看不到留言的人，燈箱裡**整塊不出現**（元件自己回 `null`），不是端出來再說沒權限。
- **回覆只有一層**，後端擋（parent 必須是同一張照片上的主留言）。刪留言＝作者本人或站長，
  硬刪、回覆走 FK CASCADE，沒有墓碑。
- `@` 某人在內文裡存 `@[uid]`（改名後舊留言跟著更新）。**mention 一律由後端 `parseMentions()`
  解析**，不收前端傳的名單。顯示要用的名字跟著 `GET /api/photos/:id/comments` 的 `people` 回來
  —— 不要改叫前端去打 `/api/users/mentionable`，訪客打不到那一支。
  貼出去的留言裡**名字前面不加 @**，只有粗體＋重音色。
- ⚠️ **留言輸入框是 contenteditable 的 div，不是 textarea**，@ 到的人是一顆 `[data-uid]` 晶片。
  **那個 div 永遠不能有 React 子節點、也不能改回受控元件** —— React 一重畫子節點游標就回開頭。
  內容一律用原生 DOM API 動，動完叫 `syncDraft()`；`serializeEditor()` 把晶片讀成 `@[uid]`。
  晶片後面墊的是 U+00A0（一般空白在結尾會被摺疊），挑人要用 `mouseDown`（`click` 之前就失焦了），
  Enter 要先看 `isComposing`（注音組字中按 Enter 會送出半截留言）。
- 燈箱分 `.mainPane`（照片＋Story／標籤／地點／EXIF）與 `.commentsPane`（只有留言），
  桌機左右兩欄、手機往下堆。**桌機那段 media query 必須留在 `lightbox.module.css` 最後面**，
  寫前面會被後面的基礎樣式蓋掉。
- 通知：`CommentNotify(comment_id, user_id, reason)` ＋ `User.notif_seen_at` **一個時間戳，
  沒有逐則已讀**。未讀數搭 `/api/auth/me` 回來（紅點零額外請求）；fan-out 用 `INSERT OR IGNORE`
  打 PK，語句順序 mention→reply→photo→album，同一個人只收一則、理由取最貼切的那個。
- ⚠️ 留言那幾條路由**都不可以包 `withEdgeCache`** —— 回應裡有家人的顯示名稱。

## 儲存模型

- **R2 一張照片只有兩顆縮圖：800px ＋ 400px WebP。** 2000px 那顆已經拿掉。
- **大圖／原始檔在 Google Drive**，走站長帳號（後端存 refresh token），不管誰上傳都寫進同一個 Drive。
  燈箱拿不到 Drive 時退回 800px 並在角落標示。
- 三個環境寫進同一個 Drive，靠 `DRIVE_ROOT_FOLDER` 分資料夾名。
  ⚠️ `findOwnFolder` **照名字找**，Drive 裡留著同名舊資料夾會被直接接管。
- GPS 軌跡：家人把自己的 GPSLogger 資料夾分享給 service account，`/admin` 按「掃描並自動綁定」，
  後端用**資料夾擁有者信箱對 `User.email`** 自動綁（`POST /api/tracks/drive/sync-folders`）。
  對不到不會清掉現有綁定；對到 2 個以上不猜。

**大塊的東西一律進 R2，不進 D1**（超過 D1 單列上限就直接寫不進去，而且會拖慢每次列表查詢）：

| R2 key | 是什麼 |
|---|---|
| `tracks/<day_key>.gpx` | GPSLogger 的原始 GPX。`TrackDay.raw_key` 指過來，NULL＝沒留存＝沒有「還原原始軌跡」按鈕 |
| `tracks/<day_key>.matched.json` | Valhalla 貼路後的形狀（`POST /api/tracks/match`） |
| timeline index／month | **Google 時間軸＝唯讀紀念層**，`GET/PUT /api/timeline/index`、`/api/timeline/month/:m`。
  刻意只存 R2、**完全不進 D1**，也不參與 `geo_source` 那套權威排序 |

⚠️ Google 時間軸的原始檔**在瀏覽器裡解析完才上傳結果**（`lib/googleTimeline.ts`），原始檔不經過後端。

## 一進來就該知道的坑

1. **`geo.ts` 有兩份副本**（`apps/backend/src/` 與 `apps/frontend/src/lib/`），改一邊一定要同步另一邊。
   前端 LF 是權威 → 產生後端 CRLF 版。
2. **D1 綁定參數上限 100** —— 批次 `IN (?,?,…)` 一定要先切塊，否則一百多筆就 500。
3. **站門閘必須排在 `withEdgeCache` 之前**，否則訪客回應會進共用邊緣快取、匿名請求直接命中。
   座標與軌跡的隱私**必須在 SQL 裡過濾**，不能只靠回應後處理。
4. SQLite `geo_source != 'exif'` 在值為 NULL 時是 falsy → **一律用 null-safe 的 `IS NOT`**。
5. 路由靠 `pathname.split("/").length` 分辨，**新增巢狀路徑前先算長度**（`/api/photos/1/geo` 是 5，不撞 4）。
6. `core.autocrlf=true` 且無 `.gitattributes` → 行尾混用（`index.ts`/`api.ts`/`FootprintMap.tsx` 是 CRLF，
   `gpx.ts`/`map/page.tsx`/`schema.sql` 是 LF）。**純外觀，不要順手統一**，會炸出整檔 diff。
7. **非台灣來源會被擋成 403，而且有兩道**：前端 `functions/_middleware.ts`、後端 `index.ts`
   （看 `cf.country`，放行 `TW`/`XX`/`T1`）。從國外或雲端 runner 測會以為整站壞了。
   關掉一道沒用，兩道都要處理。
8. `lib/gpx.ts` 管線順序不可顛倒：`collapseStays`（60m／300s）→ `simplifyTrack`（Douglas-Peucker 5m，上限 8000 點）。
9. FootprintMap 的 emoji 一律 canvas → `addImage`，**不可進 `text-field`**（底圖 SDF 字型沒有 emoji 字符）。
10. `apps/backend/` 根目錄躺著幾十個 `check_*.sql` / `print_*.js` 之類的一次性查詢腳本，
    已被 `.gitignore` 擋掉、**不是架構的一部分**。

## 工作習慣

- **行為／設計問題先攤開取捨再動手**，不要順手就改程式。
- **不要過度設計**：手動路徑優先，自動推論只是加分項。
- **同一件事不要另外做一套 UI**，加選填 prop 擴充既有元件。
- commit message 用中文，Conventional Commits 前綴（`feat(admin):` / `fix(map):` / `chore:`）。
