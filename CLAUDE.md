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
                     VideoPlayer.tsx 是燈箱裡的影片播放器（見「影片」）
  src/lib/videoUtils.ts      封面圖擷取、長度格式化、可收的影片型別
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
以及**護欄是「網址猜不到」的圖片**（`/api/photos/view/*` 的 R2 物件鍵帶時間戳＋亂數、
`/api/users/avatar/*` 的檔名帶亂數）—— 圖片是 `<img src>`，瀏覽器不會幫忙帶
Authorization，而 R2 的物件鍵要先拿到（鎖著的）相簿 JSON 才知道。
**新路由預設就是關的**，這是刻意的。

閘門另外認一條路：**媒體的簽章網址**。`isSignedMediaPath()` 那張表上的 GET
可以用 `?mt=<簽章>` 代替 Authorization。目前是 `/api/photos/:id/full` 與
`/api/photos/:id/video` 兩條（`<img src>`／`<video src>` 都不會帶 Authorization）。

- ⚠️ `/api/photos/:id/full` **不在白名單上**（2026-08-24 移走）。它吃的是
  AUTOINCREMENT 的流水號，「猜不到」那個護欄對它從來沒成立過 —— 任何台灣 IP 不帶
  token 從 1 數上去就能抓完整站的 Drive 4K。**不要為了「圖片要放行」把它加回去。**
- `mt` 是 `mintMediaToken()` 發的 `<到期秒>.<HMAC>`（金鑰同 `APP_PASSWORD`，效期同
  進站 token 的 7 天），跟著 `GET /api/auth/me` 回來（零額外請求），
  前端存在 `localStorage.media_token`，由 `photoFullSrc()`／`photoVideoSrc()` 掛上網址。
- **`mt` 不是身分**，只證明「這個網址是站上發出來的」。拿它打 `/api/albums` 一樣 401；
  要知道「是誰」的路由照樣得走 `currentActor()`。
- **不是每張照片各簽一組**：相簿內容那支路由不分頁，5000 張的相簿逐張簽等於一次請求
  跑 5000 趟 `crypto.subtle.sign`，遠超單次 10ms CPU。`/full` 回的是圖片位元組、
  內容不隨身分變化，所以「證明你進得了站」就是剛好的粒度。
- ⚠️ `/full` 的 **cache key 一定要把 `mt` 拿掉**（`searchParams.delete("mt")`）。
  留著的話每個人、每次登入都是一份獨立的邊緣快取，Drive 取檔次數直接乘上人數。

身分用 `currentActor(request, env)` 拿，它有 `WeakMap<Request>` 快取 ——
同一個請求裡問幾次都只查一次 D1，**不要自己再 `SELECT … FROM User`**，那是白花讀取額度。

### 已移除、不要再呼叫

| 沒了的 | 改用 |
|---|---|
| `GET /api/tracks/drive/shared-folders` | `POST /api/tracks/drive/sync-folders`（照信箱自動綁，不再人工挑） |
| `GET/PUT /api/tracks/segments` | 沒有替代品，逐段交通工具整個功能拿掉了 |
| `ADMIN_EMAILS` 環境變數 | D1 的 `User` 表 |
| `GOOGLE_PICKER_API_KEY` | Picker 那條路已移除，程式不再讀它 |
| `GET /api/google/albums`、`/api/google/albums/:id/photos` | 沒有替代品，Picker 之外沒有列相簿這件事 |
| `POST /api/google/sync-photo`、`/api/google/resolve-conflict` | `POST /api/google/media` 拿位元組，之後走一般上傳（`/api/upload` ＋ 前端 `pushPhotoToDrive`） |
| `X-Google-Token` 請求標頭 | 沒了。Google token 由後端自己換（見「Google 相簿匯入」） |

### Google 相簿匯入

**匯入用的是登入者自己的 Google 身分，站上只授權一次**（就是登入那一次）。

- 憑據是 `User.google_refresh_token`（0017），在 `/api/auth/google/callback` 收下。
  Google **只在走過同意畫面那一次**給 refresh token，所以回呼發現「這個人一份都沒有」
  時會自己補跳一次 `prompt=consent`（`state.retried` 只補一次，不會迴圈）。
- `mintUserGoogleToken()` 當場換短效 token，isolate 內 `Map<uid>` 快取到過期前 60 秒
  —— Picker 是每 2 秒輪詢，沒快取等於每輪都多一趟 D1 ＋ 一趟 Google。
  `invalid_grant` 就地把欄位清成 NULL（自癒，下次登入才補得回來）。
- 三支端點都走 `googleUserAuth()`：`POST /api/google/picker/sessions`、
  `GET /api/google/picker/sessions/:id/photos`、`POST /api/google/media`。
  拿不到 token 一律回 **409 `{"error":"google_reauth"}` 不是 401** ——
  401 在這個站是進站閘門的意思，前端會誤判成整個 session 死了而把人踢走。
  前端 `GoogleReauthError` 接住它，在原地顯示紅色橫幅＋「用 Google 重新登入」。
- `POST /api/google/media` 是**位元組代理**：Picker 的 `baseUrl` 要帶 Authorization，
  而 `lh3.googleusercontent.com` 不回 CORS 預檢，瀏覽器自己抓不到。
  ⚠️ **一定要驗主機名**（只放行 `*.googleusercontent.com` ＋ https），不驗就是一台
  任人指定目標的 SSRF 代理。回應 `Cache-Control: no-store`，不包 `withEdgeCache`。
  ⚠️ **下載參數照片是 `=d`、影片是 `=dv`**（後端照前端送的 `video` 旗標加）。
  給錯不會報錯 —— 影片吃到 `=d` 回的是一張 JPEG 封面圖，於是相簿裡多一張靜止的圖。
- **影片也能從 Google 相簿匯入**（2026-08-24 修好，在那之前前端只放行 `image/*`，
  整批都是影片時會安靜地什麼都不做）。判斷影片看 `mediaFile.mimeType` 或 `item.type`，
  之後跟本機選檔完全同一條路（`ingestSources` 的 `isVideoFile()` 分岔：擷封面 →
  `/api/upload` → `pushVideoToDrive`）。⚠️ 三件事要知道：
  ① **拿到的是 Google 轉檔後的版本，不是相機原始檔** —— Picker API 沒有第二條路，
  要原始檔只能本機選檔上傳；② `videoMetadata.processingStatus` 是 `PROCESSING`／`FAILED`
  時先擋掉並講清楚（**不要寫成「不是 READY 就擋」**，列舉裡還有一個 UNSPECIFIED）；
  ③ 匯入的影片會**整個變成一個 Blob 進瀏覽器**（本機上傳是 `File.slice()` 惰性讀），
  幾 GB 的檔請用本機上傳那條。被擋掉的項目一律**收集起來最後 alert 一次**，
  不要只 console.warn —— 那正是「按了沒反應」的來源。
- ⚠️ **「視窗關了」不等於「取消」**：`pickerUri` 後面接的 `/autoclose` 就是要 Google
  選完之後自己關窗，而 `mediaItemsSet` 可能**幾秒之後**才翻成 true（影片更慢）。
  所以關窗偵測那支 400ms 哨兵**只記時間、不做判斷**，判斷全留給 2 秒那支輪詢：
  關窗後仍不 ready 就繼續問到 `PICKER_CANCEL_AFTER_CLOSE_MS`（20 秒）才當取消。
  曾經是「關窗 1.5 秒後問一次，不 ready 就整個收掉」—— 選完的東西被當成取消丟掉，
  而且取消刻意不彈東西，於是使用者眼中是**按完全沒反應、Console 一個字都沒有**。
- 這條路上**每一個失敗都要留下痕跡**：後端 session 狀態／mediaItems 取回失敗回 **502
  `picker_status_failed`／`picker_items_failed`**（以前吞掉 → 前端看起來像「還沒選完」
  而空轉到十分鐘逾時）、mediaItems **要翻頁**（一頁 100 筆，選超過 100 張會安靜地少）、
  前端輪詢失敗記在 `lastPollError` 收工時講出來、`ready` 但零項目要 alert。
- **照片本身完全走本機上傳那一條**（前端 `ingestSources()`：縮 2000px → `/api/upload`
  產 800／400 進 R2 → `pushPhotoToDrive` 送 4K ＋原始檔進 Drive）。
  舊的 `sync-photo` 把原始檔整份塞進 R2、不產縮圖、也不上 Drive，跟儲存模型相反。
  重複偵測、補地點、Drive 待補清單也因此自動跟著有了。
- ⚠️ **瀏覽器端不再存任何 Google token**。`localStorage` 只有站上自己的兩張：
  `admin_token`（進站 JWT）與 `media_token`（大圖／影片的簽章，見「後端的請求流程」）。

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

⚠️ **0008 與 0009 會噴 `duplicate column name`（`role`／`user_id`），那是正常的** ——
`schema.sql` 已經含著那兩欄。`d1 execute --file` 是單一交易，那兩支整包回滾，
但最終 schema 仍與遠端 dev 一致（表、欄位、索引都比對過）。**建完是空的**，
白名單沒人就登不進去，記得補一列站長：`INSERT INTO User (id,name,email,role,can_manage_others,active)`。

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

⚠️ **`$v | wrangler secret put` 會多存一個換行**（管線加的，wrangler 不 trim），
曾經害 Google 回 `invalid_grant`。灌任何一個 secret 都一樣，值裡不要有尾巴。

Google Cloud Console 的「已授權的重新導向 URI」要含**每個 worker 自己的 origin** ＋
`/api/auth/google/callback`（prod、dev、`http://127.0.0.1:8787` 三個）。

## 資料模型

`schema.sql` 是歷史起點，之後所有變更在 `apps/backend/migrations/`（目前到 0019）。
**新的 schema 變更一律加在那裡**，不要再往 `database/` 加。
`wrangler.toml` 沒設 `migrations_dir`，預設就是 wrangler.toml 旁邊的 `migrations/`。

現有表：`User`／`Album`／`Photo`／`PhotoFts`(FTS5, bigram)／`Tag`／`PhotoTag`／`Favorite`／
`TripSegment`／`TrackDay`／`TrackPoint`／`AppSetting`／`DriveTrash`／`Comment`／`CommentNotify`。
**沒有多餘的表**—— `ShareLink`（從沒實作的分享連結）與 `TrackSegment`（拿掉的逐段交通工具）
已由 0012 刪除，`database/schema.sql` 裡那兩塊 `CREATE TABLE` 也一併移除了。

新環境建庫是 `schema.sql` **再套完所有 migration**，**不要照 schema.sql 推論現況**。

- `Photo.taken_at`（UTC 瞬間）／`taken_at_local`（牆上時間）／`tz_offset_minutes`，
  不變量是 **`taken_at = taken_at_local − tz`**。
- 批次改時間有**三支**，前端共用同一個 `FixTimeModal`（三個分頁）：
  `POST /api/photos/geo/shift-time`（平移：兩欄一起加減，tz 不動）、
  `POST /api/photos/geo/set-timezone`（改時區：瞬間不動，重算牆上時間）、
  `POST /api/photos/geo/set-time`（**指定**：牆上時間與時區都由使用者給）。
  ⚠️ 前兩支都以 **`AND taken_at IS NOT NULL`** 結尾 —— 修正需要一個基準。
  影片（封面圖是 canvas 畫的，不帶 EXIF）、掃描的老照片本來就是 NULL，
  **只有第三支補得了**，那也是它存在的唯一理由。三支一律寫 `time_source = manual`。
  換算共用 `parseExifDateTime`／`formatWallClock`／`utcFromLocal`，**不要在路由裡自己拼字串**
  —— 不變式只能有一個實作。`parseExifDateTime` **硬性要求秒數**，所以前端 `datetime-local`
  沒填秒數時要自己補 `:00`，否則被當成無效字串退 400。
  前端會拿原始檔名（`VID_20260824_143000.mp4`）猜一個**預填值**，⚠️ **`PXL_` 開頭刻意不猜** ——
  Pixel 那串數字是 **UTC**，當牆上時間填進去會整整差一個時區，而且錯得很安靜。
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
  不要自己讀 localStorage —— 那裡只有 `admin_token`（進站 JWT）與 `media_token`（圖片簽章），
  兩張都不說「我是誰」。
- 照片歸屬看 `Photo.uploaded_by`，`NULL` 時回頭看相簿主人。算數量時**不要寫 `COALESCE`**
  （包在函式裡吃不到索引），要拆成 `uploaded_by = ?` 與 `uploaded_by IS NULL AND a.user_id = ?` 兩段。
- `photo_count`（他的相簿裡總共幾張，含別人傳的）與 `uploaded_count`（他自己傳了幾張，
  含傳進別人相簿的）**意思完全不同**，別混。
- 足跡地圖有兩層各自獨立的開關：成員看 `User.can_view_map`（每人一欄，預設開，
  **不被 `can_manage_others` 短路**），訪客看 `AppSetting.guest_can_view_map`（全站一格，預設關）。
  後端所有 `/api/tracks/*`、`/api/timeline/*` 都走 `guardTrackAccess()`：**沒登入 401、沒權限 403，
  而且刻意不看訪客那個開關** —— 軌跡是「誰什麼時候在哪裡」的連續紀錄，比照片座標敏感，一律要成員身分。
  `/api/footprint`（照片座標）才是兩層都認的那一支。
- **看得到地圖 ≠ 寫得進去**：`User.can_use_tools`（0016，每人一欄，同樣不吃
  `can_manage_others` 的短路）管的是「動不動得了足跡」—— Google 時間軸匯入、
  同步 Drive、上傳 GPX、貼路、改點。後端 `guardTrackTools()` 擋住那 **10 支寫入路由**
  （`/api/tracks/drive/files`、`drive/file/*`、`raw/*` PUT、`match`、`matched/*` PUT+DELETE、
  `ingest`、`points/edit`、`/api/timeline/index` PUT、`/api/timeline/month/*` PUT），
  **唯讀那幾支刻意不擋**。前端 `/map` 那塊工具區整塊不出現，進頁面的自動同步與
  自動貼路也不跑 —— 端出來再每顆按鈕 403 比不端出來難懂。
  ⚠️ 欄位 **DEFAULT 1**（不動到現有成員），但 **`/admin` 新增使用者時預設不勾** ——
  「新加入的預設不給」是靠 `POST /api/admin/users` 明寫 0，不是靠欄位預設值。
- **沒有 `can_use_tools` 的人整個不出現在地圖上**：名字、成員篩選列、圖例、軌跡線、
  動畫上的車全都沒有，**他自己看也一樣**（同一張地圖兩個人看到不同結果很難解釋）。
  過濾寫在 SQL 裡，共用片段 `TRACK_MEMBER_COND`（`u` 是 User 的別名，
  `d.user_id IS NULL` 是 0009 之前的舊列＝站長的，要放行），蓋住
  `/api/track-members`、`/api/tracks`、`/api/tracks/days` 三支。
  前端連 Google 時間軸紀念層也一起收（`/map` 不抓 index、開關不出現）——
  那是他自己的另一半足跡，留著就是一條沒有名字的線。
  **資料完全不動，權限開回來下一次進頁就全部復原。**

## 足跡動畫：一起出遊的判定

「合體成同一台車」是**兩層規則**，不是一條，兩層都在 `FootprintMap.tsx` 裡、**全在瀏覽器算**
（貼路結果本來就在前端手上，改門檻不會多打任何一次 API，也不吃 Cloudflare 額度）。

- **出遊層**（`buildTrips` → `buildJointTrips`）：判定單位是**一條路程**，不是一趟。三步：
  ① 兩人的趟在時間上重疊 ≥`TRIP_MIN_OVERLAP_MS` 就算一次「相遇」；
  ② 相鄰兩次相遇的空隙 ≤`OUTING_GAP_MS`（3 小時）就**串成同一條路程**；
  ③ 整條路程的所有趟**加總算一次重疊率**（`overlapAcross`，25m 等距重取樣 `TRIP_SAMPLE_M`、
  落在對方線 50m 內、時間差 ≤5 分鐘、**分母取較短的那個**＝兩個方向取大的）。
  過門檻就把整條路程的時間跨度標成同遊區間 —— 中間下車逛街、停在餐廳那段**不會**掉出來。
  ⚠️ 為什麼不是「一趟算一次」：去程一趟、回程一趟，中間停 2 小時的話兩趟各自算，
  只要有一趟被雜訊拉到門檻以下就當場拆隊。⚠️ 也不是「整天算一次」：晚上各自跑的
  大量里程會把整天的比例拉到門檻以下，白天真的同車那段反而不合體。
- **時刻層**（`buildConvoys`）：同遊區間裡**預設合體**，只有「離開對方那條貼路線 >150m
  且撐過 2 分鐘」才拆，回到 100m 內立刻復合。區間外才走原本的 80m／120s／180s。
  ⚠️ **兩套並存不是二選一** —— 80m 那套管的是停留（在家、在餐廳）時的靠近，
  而停留早就被 `extractTrips` 從貼路軌跡裡剃掉了，拿掉會退步。
- **資料空隙期間凍結判定**（`sampleAt` 回的 `solid`）：兩個取樣點間隔超過
  `HEAD_SOLID_GAP_MS`（3 分鐘）時中間那段位置是內插出來的，**移動是假的**。
  任一方的頭踩在這種空隙上，拆隊與復合的計時器**都不累積**，隊形維持原狀。
  沒有這道閂的話，logger 斷訊十分鐘再回來，畫面上那一下瞬間位移會被當成「他轉進別條街」。
- 為什麼不能只靠 80m：時速 60 跑 80 公尺只要 4.8 秒。兩支 logger 取樣間隔不同（1s vs 60s）
  再各自內插，**同一台車上的兩個人在時間軸上能差好幾百公尺**。放大半徑到 300m 又會
  在夜市、住宅區把沒同行的人硬湊成一台。趟層的距離量的是「離對方那條**路線**多遠」，
  一前一後差一公里、停下來加油、落後一個路口，距離都還是 0。
- 門檻是站長可調的：`AppSetting.convoy_overlap_pct`（預設 70，範圍 30–100，**不需要 migration**）。
  `/admin` 一根拉桿，**放手才 PUT**（range 的 onChange 一次拖曳會噴幾十下 = 幾十次 D1 寫入）。
  值跟著 `GET /api/auth/me` 回來（同 `can_view_map` 那套，零額外請求），
  超出範圍後端回 **400 不是靜靜存起來** —— 不然站長會以為拉桿沒作用。
- **合體那幾段的線畫成流動的彩虹**（`convoySpans`／`splitLineBySpans`／`convoyGradient`）：
  範圍就是**時刻層那份隊形表**，跟畫面上那顆合體圖示完全同步 —— 中間真的分開的那一段，
  車拆成兩顆、線也斷回各自的顏色。那一段兩個人各自顏色的線**整個挖掉只留一條彩虹**
  （⚠️ 交界那一點兩邊都要放，不然會露出一小截空白），而且**只畫組裡索引最小的那個人**
  的線 —— 兩條幾乎重合的漸層會互相干擾、相位也對不起來。
  ⚠️ `line-gradient` 要求來源 `lineMetrics: true`，而且會**整個蓋掉 `line-color`**，
  所以非得自成一層 `convoy-track` 不可（塞回 `matched-track` 會讓所有人的線都變彩虹）。
  流動是**常駐 rAF**（跟播不播無關），節流 ≈20fps、**沒有合體線就整個不開**，
  `prefers-reduced-motion` 時停在靜止的彩虹上。切線在瀏覽器算，不多打任何一次 API。

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

## 影片

2026-08-24 加的。**影片與照片在相簿裡是同一格**：同一張 `Photo` 表、同一個排序、
同樣能設封面／加標籤／留言／刪除。差別只在內容放哪、怎麼播。

- `Photo.media_type`（`'photo'`／`'video'`，DEFAULT `'photo'`）與 `duration_ms`（0019）。
  預設值就是為了**不對 prod 幾千列做 backfill UPDATE**。
- ⚠️ **影片的 Drive file id 記在 `drive_original_id`，`drive_file_id` 永遠是 NULL。**
  照片那兩欄的意思是「衍生的 4K」與「相機原始檔」，而影片沒有衍生版 —— 傳上去的
  就是原始檔。這樣 `recordPhotoDrive`、`DriveTrash` 刪除、記錄路由全部零修改沿用。
  代價是「`drive_file_id` 是不是 NULL」對影片不代表「沒備份」，已知會咬人的有兩處，
  都處理過了：`/api/photos/drive-pending`（列表與 COUNT 都加了 `AND media_type = 'photo'`，
  不然每支影片都會永遠卡在補傳清單裡，而補傳會對影片跑 `encode4kWebp`）、
  以及燈箱那句「Drive 沒接上，顯示 800px 縮圖」（先用 `isVideo()` 分岔掉）。
- **上傳走瀏覽器直傳 Drive 的 resumable 分塊**（`uploadToDriveResumable`，8MB 一塊，
  必須是 256KB 的整數倍）。⚠️ **不要改成經過 Worker** —— Worker 請求體上限 100MB，
  幾 GB 的檔直接爆。分塊 PUT **不帶 Authorization**（工作階段網址本身就授權過了），
  所以傳一小時也不怕 access token 過期。`File.slice()` 是惰性的，不會把整個檔讀進記憶體。
- 封面圖在**瀏覽器**擷（`lib/videoUtils.ts` `captureVideoPoster`）：`<video>` 載入 →
  seek 到第 1 秒（很多相機第一格是全黑）→ canvas → WebP → 走**一般照片那條上傳路**
  （`/api/upload` ＋ `media_type=video`）。於是重複偵測、FTS、`uploaded_by`、R2 兩顆
  縮圖全部自動跟著有。
- ⚠️ **影片的 Drive 失敗語意跟照片相反**：照片吞得起（R2 上有 800px 可看），
  影片吞不起（R2 只有封面）。所以 `pushVideoToDrive` **失敗往外丟**，呼叫端
  `deletePhoto()` 把剛建的那一列收掉 —— 使用者看到「失敗」，不是相簿裡多一格
  點開只有靜止畫面的東西。`ingestSources` 與 `resolveDuplicate` 兩處都要。
  ⚠️ 影片**不可以進 `pendingDriveBatch`**，那條會對它跑 `pushPhotoToDrive` → `encode4kWebp`。
- 播放走 `GET /api/photos/:id/video`（`fetchDriveMediaRange`），跟 `/full` 的三個刻意差異：
  ① **轉發 `Range`**，206／416 原樣帶回來 —— `<video>` 拖時間軸靠的就是它；
  ② ⚠️ **不進 `caches.default`** —— Cache API 一個網址只存一份完整回應，把某人的 206
  存成「這個網址的答案」會餵給下一個人錯誤的位元組。回應是 `Cache-Control: private`；
  ③ **沒有退路** —— 照片拿不到 Drive 還能 302 回 R2 的 800px，影片在 R2 只有封面。
  位元組是**串流**出去的（回傳上游的 `body`），不落地、不進 Worker 記憶體。
- 前端 `<video>` **不要加 `crossOrigin`**：不加是 no-cors，跟 `<img>` 一樣免預檢；
  加了 Range 會多一次預檢，而我們也沒有要讀回應內容。`preload="metadata"` 不是 `auto`
  —— 幾 GB 的檔不能一進燈箱就自動下載。
- 燈箱裡拖時間軸時，`VideoPlayer` 的外框**擋掉 touch 事件冒泡**，不然手機上會被
  燈箱當成「滑到下一張」。
- **訪客看不到影片**這件事目前沒有另外的開關 —— 整站進站閘門本來就擋著。
- **影片的拍攝時間是 NULL，要由使用者自己指定**（封面圖是 canvas 畫的，沒有 EXIF）：
  相簿裡選起來 →「拍攝時間」→「指定時間」分頁，走 `POST /api/photos/geo/set-time`
  （見「資料模型」那三支）。⚠️ 平移與改時區那兩支**對影片沒有作用**（`taken_at IS NOT NULL`）。
  沒給時間的影片在相簿格線不受影響（那支照 `sort_order`），但**會沉到搜尋結果最底**
  （`ORDER BY p.taken_at DESC`，NULL 在 DESC 排最後）。
- 轉檔／第二種畫質（P4）**使用者明確延後**，先看實際讀取速度再決定。

## 儲存模型

- **R2 一張照片只有兩顆縮圖：800px ＋ 400px WebP。** 2000px 那顆已經拿掉。
- **大圖／原始檔在 Google Drive**，不管誰上傳都寫進**站長**同一個 Drive
  （`drive.file` 是 per-file 授權，寫入者只能有一個）。憑據就是站長那一列的
  **`User.google_refresh_token`**（0017）—— 跟「Google 相簿匯入」用的同一張，
  登入 scope 本來就含 `drive.file`。站上沒有「連結 Drive」這個動作，站長每次
  Google 登入都會刷新它；失效就地清成 NULL，下次登入回呼自動補跳同意收回來。
  燈箱拿不到 Drive 時退回 800px 並在角落標示。
  ⚠️ **不要再另外存一份**（曾經有 `AppSetting.drive_writer_refresh_token` ＋
  `DRIVE_WRITER_REFRESH_TOKEN` secret，2026-08-21 移除）：多出來的那份沒人刷新，
  壞掉還會**擋住自癒** —— 判斷「登入要不要跳同意畫面」看的是「有沒有值」，
  值早就失效也算數，於是「請站長重新登入」變成一句做不到的指示。真的卡死過。
  ⚠️ 同意畫面**早就是正式發布狀態，沒有「測試中 7 天到期」這回事**，
  `invalid_grant` 不要往那個方向查。
- **影片：原始檔整份在 Drive，R2 只有一張封面圖。** 沒有轉檔、沒有第二種畫質，
  播放就是把 Drive 的位元組經 Worker 轉出來（見「影片」）。
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
11. 顯示照片一律走 `components/PhotoImage.tsx`（轉圈圈→placeholder→淡入），**不要再寫裸的
    `<img>`**。燈箱傳 `placeholderSrc={photoThumbSrc(photo,'md')}` 讓快取裡那張先頂著。
    `.layer` 刻意不設 `object-fit`，由呼叫端的 class 決定（格線 `cover`、燈箱 `contain`）——
    兩邊都是單一 class，寫進共用檔會變成看 CSS module 打包順序。
    ⚠️ **首頁相簿封面是 CSS 背景圖，不要改成 `<img>` 套 PhotoImage** ——
    背景圖＋延後掛載（`mountedCount`）省掉的是「相簿數 × 預覽張數」次 Workers 請求。
    那裡用離線 `new Image()` 探載入狀態，配 `PhotoSpinner`。

## 工作習慣

- **行為／設計問題先攤開取捨再動手**，不要順手就改程式。
- **不要過度設計**：手動路徑優先，自動推論只是加分項。
- **同一件事不要另外做一套 UI**，加選填 prop 擴充既有元件。
- commit message 用中文，Conventional Commits 前綴（`feat(admin):` / `fix(map):` / `chore:`）。
