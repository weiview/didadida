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
  src/videoMeta.ts   mp4/mov 的 moov box —— 與 apps/frontend/src/lib/videoMeta.ts 是兩份副本
  src/fts.ts         FTS5 全文檢索
  migrations/        ✅ schema 變更的權威位置（0003 起）
  wrangler.toml      prod ＋ [env.dev] 兩組 D1/R2/vars/triggers
apps/frontend/
  src/app/           App Router：/ (首頁)、/album、/map、/admin
  src/components/    FootprintMap.tsx 是最大的一支（maplibre-gl，dynamic import 禁 SSR）
                     VideoPlayer.tsx 是燈箱裡的影片播放器（見「影片」）
  src/lib/videoUtils.ts      封面圖擷取、長度格式化、可收的影片型別
  src/lib/videoMeta.ts       影片的拍攝時間／座標（解 moov box），後端有一份副本
  src/lib/api.ts     唯一的 API 客戶端
  functions/_middleware.ts   Pages Function：允許清單以外的國家直接 403（TW/AU/NZ）
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
- **票有兩種粒度**（0020）：一般票 `<exp>.<HMAC>`，可管理全站內容的人拿到的是
  尾巴多一段 `.a` 的升級票。差別只在「不開放」那幾張（見「不開放的照片」）。
  粒度有進 HMAC 的 payload，所以自己加／拔 `.a` 驗不過。
  ⚠️ 升級票**七天內不會因為權限被撤而失效**（它刻意不查 D1）—— 已知，要修的話
  等於每一張大圖都多一次 D1 讀取。
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
- ⚠️⚠️ **`popup.closed` 會說謊，不要拿它判斷「使用者取消了」**（2026-08-27 拆掉）。
  Google 的選相片頁帶著 `Cross-Origin-Opener-Policy: same-origin`，popup 一導過去，
  瀏覽器就把它跟開它的那一頁切成兩個瀏覽環境群組，我們手上的 window 參考當場退化成
  **斷開的代理，而斷開的代理 `closed` 一律回 `true`** —— 視窗其實好端端開著。
  會不會斷取決於中間經過哪幾頁，所以症狀是**時好時壞**。
  曾經是「發現 closed 就記時間，20 秒（`PICKER_CANCEL_AFTER_CLOSE_MS`）內還沒 ready
  就當取消」：於是視窗一導到 Google 就被判定關閉，使用者從按下匯入起**只有 20 秒可以
  挑照片**，挑慢一點整批被丟掉；取消又刻意不彈東西，看起來就是「按了沒反應」。
  再前一版的「關窗 1.5 秒後問一次」是同一個坑的另一面。**現在完全不猜**：
  ready 就接手，不想匯了由使用者自己按 FAB 上那顆「選相片中... 按這裡取消」
  （`cancelGoogleSyncRef`），撐到 10 分鐘才自動收工。那顆按鈕是他唯一的出口，
  **不要為了「忙碌中不該能按」把它變回 disabled**。
- 挑照片的時候我們這一頁是被蓋住的，而**背景分頁的 `setInterval` 會被降頻到一分鐘一次**
  —— 選完回來要乾等快一分鐘。所以除了 2 秒那支輪詢，還掛了 `visibilitychange`／`focus`
  一回前景就補問一次（`/autoclose` 關掉 popup 之後焦點會自己回來，通常這一下就接上）。
  ⚠️ 兩支可能同時在飛，`await` 回來要**再確認一次 `photosProcessingStarted`**，
  不然同一批會匯進來兩次。離開頁面時 `cancelGoogleSyncRef` 也要收（計時器＋兩個監聽）。
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
| `CF_API_TOKEN` ＋ `CF_ACCOUNT_ID` | **只影響 `/admin` 用量條的四條 analytics**（今日 Workers 請求、R2 操作次數、D1 讀寫列數）顯示「未設定」，其餘照常。兩個是一組的，見「免費額度用量條」 |

⚠️ **`$v | wrangler secret put` 會多存一個換行**（管線加的，wrangler 不 trim），
曾經害 Google 回 `invalid_grant`。灌任何一個 secret 都一樣，值裡不要有尾巴。

Google Cloud Console 的「已授權的重新導向 URI」要含**每個 worker 自己的 origin** ＋
`/api/auth/google/callback`（prod、dev、`http://127.0.0.1:8787` 三個）。

## 資料模型

`schema.sql` 是歷史起點，之後所有變更在 `apps/backend/migrations/`（目前到 0023）。
**新的 schema 變更一律加在那裡**，不要再往 `database/` 加。
`wrangler.toml` 沒設 `migrations_dir`，預設就是 wrangler.toml 旁邊的 `migrations/`。

現有表：`User`／`Album`／`Photo`／`PhotoFts`(FTS5, bigram)／`Tag`／`PhotoTag`／`Favorite`／
`TripSegment`／`TrackDay`／`TrackPoint`／`AppSetting`／`DriveTrash`／`Comment`／`CommentNotify`／
`Place`（打卡地點簿，0023，見「指定地點」）。
**沒有多餘的表**—— `ShareLink`（從沒實作的分享連結）與 `TrackSegment`（拿掉的逐段交通工具）
已由 0012 刪除，`database/schema.sql` 裡那兩塊 `CREATE TABLE` 也一併移除了。

新環境建庫是 `schema.sql` **再套完所有 migration**，**不要照 schema.sql 推論現況**。

- `Photo.taken_at`（UTC 瞬間）／`taken_at_local`（牆上時間）／`tz_offset_minutes`，
  不變量是 **`taken_at = taken_at_local − tz`**。
- 批次改時間有**三支**，前端共用同一個 `FixTimeModal`（三個分頁；燈箱那個入口
  用 `initialMode="set"` ＋ `lockMode` 只端出「指定時間」那一頁）：
  `POST /api/photos/geo/shift-time`（平移：兩欄一起加減，tz 不動）、
  `POST /api/photos/geo/set-timezone`（改時區：瞬間不動，重算牆上時間）、
  `POST /api/photos/geo/set-time`（**指定**：牆上時間與時區都由使用者給）。
  ⚠️ 前兩支都以 **`AND taken_at IS NOT NULL`** 結尾 —— 修正需要一個基準。
  影片（封面圖是 canvas 畫的，不帶 EXIF）、掃描的老照片本來就是 NULL，
  **只有第三支補得了**，那也是它存在的唯一理由。三支一律寫 `time_source = manual`。
  換算共用 `parseExifDateTime`／`formatWallClock`／`utcFromLocal`，**不要在路由裡自己拼字串**
  —— 不變式只能有一個實作。`parseExifDateTime` **硬性要求秒數**。
  「指定時間」那一頁是**年／月／日／時／分／秒六個 select ＋ 時區 select**，
  不是 `<input type="datetime-local">`：秒數在 datetime-local 上要靠 `step` 才出得來、
  各家瀏覽器長得還不一樣，而掃描的老照片要調到 1970 年代時日曆一頁一頁翻不完。
  換月換年之後**日要夾回該月最後一天**（1/31 → 2 月），不然送出去的是一個不存在的日期。
  時區清單跟「改時區」那一頁**共用 `TZ_OPTIONS`**，兩邊顯示格式因此完全一致。
  前端會拿原始檔名（`VID_20260824_143000.mp4`）猜一個**預填值**，⚠️ **`PXL_` 開頭刻意不猜** ——
  Pixel 那串數字是 **UTC**，當牆上時間填進去會整整差一個時區，而且錯得很安靜。
  ⚠️⚠️ **那兩個正規表示式的 `\d` 曾經整批掉成 `d`**（`(d{4})`、`/^d{4}-d{2}-…/`），
  於是 `canSubmit` 永遠是 false、「指定時間」的**套用鈕從上線那天起就一直是灰的** ——
  功能看起來像「不見了」。改這一檔如果經過任何會處理跳脫字元的腳本，
  **改完一定要 grep 一次 `[^\\]d{`**。
- ⚠️⚠️ **`PUT /api/photos/:id` 只更新請求裡真的有帶的欄位，沒帶的一個都不能碰。**
  它曾經無條件覆寫 `description` ＋ `taken_at` ＋ `taken_at_local` ＋ `time_source` 四欄，
  而燈箱存 Story 只送 `{ description }` —— 於是**存一次 Story 就把拍攝時間整組清空**：
  「時間來源」變成一個「—」，那張照片還會因為沒有時間而跳到相簿最前面
  （見「相簿格線」），而且錯得很安靜。判斷用 `'x' in body` 而不是 `!= null`：
  Story 清空送的是 `""`，那是**有主張的**（要清掉），跟「這一趟根本沒提到它」是兩件事。
  2026-08-31 修，prod 上被清掉的那一列已照 EXIF 補回來。
- `Photo` 除了基本欄位還有：`drive_file_id`／`drive_original_id`（Drive 上的 4K 與原始檔）、
  `thumb_url`／`thumb_sm_url`（R2 的 800／400 WebP）、`uploaded_by`（誰傳的，見「身分與權限」）、
  `file_hash`／`phash`（去重）、`shuffle_key`（隨機排序用的固定亂數）。
- `LOCAL_TIME_EXPR` = `COALESCE(p.taken_at_local, …)`，用到它的 SQL **必須把 Photo 別名為 `p`**。
- `geo_source` 權威由高而低：`manual` > `exif` > `track` > `timeline` > `segment` > `interpolated`。
- `TrackDay.day_key` 是**不透明字串**（多身分之後還帶使用者前綴），**不要拿去解析日期**。
- `Comment`／`CommentNotify` 見「留言」一節；`Place` 見「指定地點」一節。
- **DROP TABLE 要由子表往父表**：`CommentNotify→Comment→Favorite→PhotoTag→TripSegment→
  Photo→Album→TrackPoint→TrackDay→Tag→DriveTrash→AppSetting→User`（`Place` 沒有外鍵，
  排哪裡都行）。開著外鍵時照字母序刪
  會 FK failed，而且是**跑到一半才炸**（`d1 execute --file` 是單一交易，會整包回滾）。

## 身分與權限

三層：**訪客**（輸入訪客密碼拿 guest token）／**成員**（Google 登入，白名單內）／**站長**。

- **白名單就是 D1 的 `User` 表**，沒有 `ADMIN_EMAILS` 之類的後路。清掉 `User` = 沒有人登得進去，站長也一樣。
- 站長在 `/admin` 加人、給權限、停權。移出白名單是**停權（`active=0`）不是刪列**。
- ⚠️ **`/admin` 認的是 `canManageOthers`，不是 `isOwner`**（2026-08-28 使用者拍板：
  「可管理全站內容」＝**共同站長**，後台每一格都給，含白名單與站台開關）。
  在那之前整頁鎖 `isOwner`，於是勾了那一格的人連進都進不來 —— 而後端的
  Drive 比對那兩支本來就對他開著，等於功能在、入口沒有。改的是四支路由的閘
  （`/api/admin/settings`、`/api/admin/users*`、`/api/tracks/drive/sync-folders`、
  代設頭像的 `/api/users/:id/avatar`）＋ `/admin` 那一頁 ＋ `AccountBadge` 上
  那顆唯一通往後台的連結。**後端只剩兩種身分做得到的事不同：沒有。**
  站長與共同站長的差別現在只在「動不動得了對方那一列」，見下面兩道閂。
- ⚠️⚠️ 白名單那條路只剩**兩道閂**，兩道都非有不可，而且 `PUT/DELETE /api/admin/users/:id`
  與 `POST /api/admin/users`（把移出白名單的人加回來也是 UPDATE，是同一條後門）
  **兩支都要寫**：
  ① **站長那一列動不得** —— 不然共同站長可以把站長降權、停權、改名。
  ② **自己那一列也動不得** —— 開放之前不需要這條（那時只有站長進得來，而站長被
  ① 擋著），現在他碰得到自己了：關掉自己的 `can_manage_others` 或 `active`
  就是當場自我上鎖，而唯一的復原辦法是請站長進來或直接開 D1 主控台。
  `/purge` 那一支本來就有 ②。前端白名單那一列跟著把**自己**連同站長一起 disable，
  並標一顆「你自己」的標籤 —— 端出來再吃 400 比不端出來難懂。
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

## 誰在線上：綠燈與「XXX 上線囉」

2026-08-28 加的。一支端點 `GET /api/presence` **同時做兩件事**：把我自己的
`last_seen_at` 推到現在（心跳），並回全站成員的 `last_seen_at`。分成兩支等於
每分鐘兩次請求，而它們本來就是同一個節奏。

- **`User.last_seen_at`（0022）跟 `last_login_at` 是兩件事，兩欄都留著。**
  `last_login_at` 只有真的重新認證那一次才寫，而進站 token 有效期 **7 天** ——
  於是天天在看照片的人在後台上永遠寫著一週前，看起來像壞掉。
  **後台顯示的是 `last_seen_at`**，NULL（還沒回來過的舊帳號）才退回 `last_login_at`。
  刻意**不 backfill**，沒有值就照實說「還沒登入過」。
- ⚠️ **不是 WebSocket。** 常連線在 Cloudflare 上要 Durable Objects，那是**另一個計費
  資源**，而免費額度是這個站的最高宗旨。輪詢 60 秒一次（`POLL_MS`），
  「上線中」的門檻 150 秒（`PRESENCE_ONLINE_MS`，＝兩次半）—— 掉一次心跳
  （切分頁被降頻、網路抖一下）不會讓人在別人畫面上閃成離線再閃回來。
- ⚠️ 心跳有 **40 秒的寫入節流**（`PRESENCE_WRITE_THROTTLE_S`，寫在 SQL 的 WHERE 裡，
  不是先讀再判斷）—— 這一條是為了**多分頁**：同一個人開三個分頁就是三份計時器，
  沒有它 D1 寫入直接乘三。值要小於前端的輪詢間隔，不然正常的單分頁心跳會被自己擋掉。
- ⚠️ **訪客整個不參與。** 訪客沒有 `User` 那一列（跟留言同一個道理），而且「家裡誰
  現在在線上」是**作息**，比照片座標敏感。後端在寫入**之前**就分岔掉，回
  `{users: [], self: null}` 且**零 D1 動作**；前端因此連計時器都不開。
  回空清單不是 403 —— 訪客本來就該進得了這個站。
- ⚠️ 這支**不可以包 `withEdgeCache`**：回應裡有每個家人的名字與作息，而且值本來
  就是每分鐘都在變的（快取它等於這個功能不會動）。回應 `Cache-Control: no-store`。
- 狀態在 `lib/presence.ts`（module 層 store ＋ `useSyncExternalStore`，同 `exifPref`／
  `restrictedReveal` 那一套）。**全站只有一份輪詢** —— `usePresence()` 只是看，
  開輪詢的是 `usePresencePoll()`，只掛在 `components/PresenceToasts.tsx` 那一個地方。
  ⚠️ 換值一定要「複本做好再換掉」，`useSyncExternalStore` 比的是參考。
- 「XXX 上線囉」**三條規則都是為了不吵人**：① 第一次抓回來不跳（`ready` 為 false，
  不然一進站就被五個人的提示蓋滿）；② 自己不跳；③ **上一份快照裡明確是離線的**
  才跳 —— 上一份根本沒有這個人（剛加白名單、或他的 `last_seen_at` 還是 NULL）
  不算「剛上線」，那只是我們第一次知道他。
  ⚠️ 輪詢失敗**保留上一份快照**，不要清空：清了會讓全站的燈一起變灰再變回來，
  而且下一次抓回來時所有人都會被當成「剛上線」跳一排提示。
- 燈有**兩個實作**，因為頭像本來就有兩支（留言區那顆吃 `lightbox.module.css`，
  尺寸與陰影跟著燈箱走；`components/Avatar.tsx` 是行內樣式的通用版）：
  後台白名單用 `Avatar` 的選填 prop `presence`（`"online"`／`"offline"`），
  留言區用 `PhotoComments.tsx` 裡那支的選填 prop `uid`。
  ⚠️ 兩支的約定一樣：**不知道就不要畫**（`undefined`／`!snap.ready` 整顆不畫，
  不是畫成灰的）—— 先灰再跳綠看起來像每個人都剛上線，而 AvatarPicker 的預覽、
  地圖上的大頭跟「誰在線上」完全無關，多一顆灰點只是雜訊。
  ⚠️ 一串留言可能有幾十顆頭像，它們**一律讀全站那份快照**（`usePresence()`），
  自己不開任何計時器。**停權的人不畫燈** —— 他登不進來永遠是灰的，
  而那一列旁邊已經有「已停權」的標籤了。
- ⚠️ 登出要 `resetPresence()`。不清的話下一個登入的人會先看到上一個人的名單。
- **畫面上那條「誰在線上」是 `components/OnlineBar.tsx`**（掛在 `layout.tsx`，
  帳號牌左邊那 48px 的縫）。收起來是最多 3 顆別人的頭像 ＋「n 人在線上」，
  點開才是完整名單（在線上的在前、離線的寫最後出現是多久以前）。
  ⚠️ **它不開輪詢**，只是 `usePresence()` 看 `<PresenceToasts />` 開的那一份 ——
  多掛這一條在每一頁**不會多打任何一次 API**。
  ⚠️ 收起來那排**刻意不畫自己**（自己就在旁邊那顆帳號牌上），沒有別人時畫一顆
  灰點 ＋「只有你在線上」—— 空著一條會讓人以為壞了。訪客與 `!ready` 一律不畫。
  ⚠️ `z-index: 925` **比帳號牌那層低**（它的點擊攔截層是 930）：那張卡打開時
  這條就不該還能按。
- `GET /api/presence` 除了 `last_seen_at` 也回 **`track_color` 與 `avatar`**
  （那條橫幅要拿它們畫圓頭像，共用 `components/Avatar.tsx`）。
  ⚠️ 多帶兩欄**不多花任何讀取額度**（D1 算的是讀了幾列不是幾欄）；前端那兩欄
  是**選填的**，邊快取裡還躺著舊回應時退回「名字首字 ＋ 預設色」。
- 「XXX 上線囉」一則留 **10 秒**（`TOAST_MS`）。本來 4 秒，使用者反映來不及看 ——
  提示在左下角，而人多半正在看照片。整疊本來就不吃點擊，賴久一點擋不到東西。

## 手勢：捏合改欄數、燈箱裡放大照片

兩件事都在手機上、都靠雙指，**而且互相會打架**，所以寫在一起。

- ⚠️⚠️ 觸控監聽器**一律自己 `addEventListener(..., { passive: false })`**。
  React 的 `onTouchMove` 是掛在 root 上的**被動**監聽器，在裡面 `preventDefault()`
  一點作用都沒有 —— 瀏覽器照樣捲頁面／接管手勢。
- **相簿格線與首頁：捏合改欄數**（`app/page.tsx` 1–5 欄、`app/album/page.tsx` 1–6 欄，
  document 層監聽）。
  ⚠️⚠️ **捏合曾經害整頁點不動**（2026-08-31 修）：卡片的 `pointerdown` 會起跑一個
  1 秒的長按計時器（長按＝舉起來可以拖曳排序），而**兩指捏合時瀏覽器把手勢接管走，
  發的是 `pointercancel` 不是 `pointerup`** —— 原本只有 pointerup／pointerleave
  在清計時器，於是一秒後 `longPressIndex` 被設起來，卡片的 onClick 看到它就
  `preventDefault()`，**從此每一本相簿／每一張照片都點不進去**（清掉它的
  `handleDragEnd` 永遠不會跑，因為根本沒有拖曳開始過）。三道一起補，缺一不可：
  ① 卡片加 `onPointerCancel`；② `handlePointerUpOrLeave` 除了計時器也把
  `longPressIndex` 放回去（**`dragItem.current === null` 時才放** —— 真的在拖的時候
  `draggable` 還靠它撐著）；③ 捏合起手就在 `handleTouchStart` 裡 `cancelLongPress()`。
  ⚠️ onClick 的守衛比的是 **`longPressIndex === index`** 不是 `!== null` ——
  萬一哪一張又卡住，只有它自己點不動，不會連累整頁。
- **燈箱：捏合放大照片**（`PhotoLightbox.tsx`，1～5 倍、以兩指中點為錨點、
  放大後單指拖著看、輕點兩下切換原尺寸／2.5 倍、換一張就歸零）。
  ⚠️ 位移**直接寫進 DOM 的 style，不走 React state** —— 一次捏合是幾十次
  touchmove，每一次都重畫整個燈箱（右邊還掛著留言、EXIF、標籤）會掉格。
  只有「現在有沒有放大」是 state：它要換掉 `touch-action` 並讓左右滑動讓開。
  ⚠️ 放大圖層（`.zoomLayer`）**只包照片本身** —— 那顆不開放的鎖、換頁箭頭、
  「顯示的是 800px 縮圖」那句話都留在外面，不然放大 5 倍時它們會跟著變五倍大。
  ⚠️ `transform-origin` 一定要是 `0 0`：夾住位移的算法是照「左上角為原點」推的，
  改成 center 會讓照片能被拖到整片離開畫面。
  ⚠️ `touch-action: none` **只在放大中才給** —— 一倍時要留給 `.content` 直向捲動
  （手機上照片底下還有 Story、標籤、留言）。
  ⚠️ 影片不參與（`<video>` 自己要吃拖時間軸那些手勢）。
- ⚠️⚠️ 兩者的交界：燈箱的 overlay 帶著 **`data-lightbox`**，格線那兩支 document 層
  的捏合處理器一律先 `closest('[data-lightbox]')` 讓開 —— 不讓的話在燈箱裡捏一下
  放大照片，**被蓋在後面的格線也跟著改欄數**。

## 手機的燈箱分三段：一進去只有照片

2026-08-31 加的（使用者的原話：「點進去燈箱後 希望是不要有任何其他 小故事 留言那些
文字，單純只有照片就好，再點一下照片 才會浮現 story 跟留言，以及查看更多的文字按鈕，
點了之後才會在出現更多其他資訊」）。狀態是 `PhotoLightbox` 裡的 `mobileStage`：

| 段 | 看得到什麼 | 怎麼過去 |
|---|---|---|
| 0 | 只有照片（撐滿整個畫面）＋關閉鈕＋上下一張的箭頭 | 一進來就是這裡 |
| 1 | ＋ Story ＋ 留言 ＋ 一顆「查看更多」 | 輕點照片一下 |
| 2 | ＋ 標籤／地點／照片資訊(EXIF) | 按「查看更多」 |

- ⚠️⚠️ **收起來的那幾塊是真的不 render，不是用 CSS 藏起來。** `PhotoComments`
  一掛上去就是一趟 `GET /api/photos/:id/comments`（D1 讀取）—— 藏起來的話每開一張
  照片照樣花那一趟，而使用者根本還沒說他要看留言。分段判斷因此在 JSX 裡
  （`showBasics`／`showMore`），CSS 只負責「收著的時候照片撐滿畫面」（`.soloImage`）
  跟那顆按鈕長什麼樣（`.moreBtn`）。
- ⚠️ **桌機完全不受影響**，每一個判斷都先看 `isMobile`（`matchMedia("(max-width: 768px)")`，
  跟 CSS 斷點同一個數字）。那邊是左右兩欄、照片跟留言本來就並排，收起來只會空一大塊。
  `useIsMobile()` 的**初值就直接問 matchMedia**，不是先給 false 再用 effect 補 ——
  燈箱只有點下去才會掛出來（靜態匯出的 HTML 裡沒有它，不會 hydration mismatch），
  先給 false 的話手機第一幀會把留言整片畫出來再收掉，請求也已經送出去了。
- ⚠️⚠️ **輕點一下要等過 `TAP_MS`（300ms）才動手** —— 輕點兩下是放大（見上一節），
  當場做的話每次放大都會先閃一下收合。第二下的 `touchstart` 會把那個計時器取消。
  另外兩個不算數的情況：**放大中**（`scale > 1`，那時候的一下是「我還在看細節」），
  以及**點在按鈕上**（換頁箭頭、左上角那顆鎖、「點一下暫時顯示」的遮罩都是 button，
  而原生監聽器掛在整個容器上，子節點的 touchend 照樣冒泡上來，
  React 那邊的 `stopPropagation` 攔不到）。
- ⚠️ **影片不參與收合**，跟它不參與捏合放大同一個理由：`<video>` 自己要吃點擊與
  拖時間軸，`VideoPlayer` 的外框也刻意把 touch 擋在燈箱外。拿「點一下」當開關等於
  搶走播放鍵，而影片一旦收起來就再也叫不出留言 —— 那是一條沒有出口的路。
  所以影片一律從第 1 段開始。
- 「查看更多」刻意是一顆**文字**按鈕（使用者的原話），不做成箭頭或把手 ——
  它底下接的是留言，多一個圖示反而看不出它管的是哪一段。展開後換成
  「收起其他資訊」：只能靠點照片收回去的話，等於要人記住一個沒寫出來的手勢。
- ⚠️ 換上一張／下一張**刻意不歸零**：想一路看照片的人不該每換一張就再點一次。
  歸零的只有「關掉燈箱再開」（元件重新掛載）。
- ⚠️ `.soloImage` 必須排在前面那個 `max-width: 768px`（`.imageContainer` 改 60vh）
  **後面**，同樣是一個 class 的權重，靠順序決勝；而檔案最後面那個
  `min-width: 769px` 的桌機區塊照舊**必須留在最後**。
- ⚠️⚠️ `.soloImage` 的高度**一定要是 `100vh` 這種絕對長度，不可以寫 `height: 100%`**
  （上線當天就踩到）。百分比是拿父層的高度算的，而 `.imageContainer` 的父層
  `.mainPane` 在手機上沒有指定高度（那是桌機兩欄那段才給的）—— 100% 解不出來就
  退回 auto，照片高度變成「內容有多高」，而它的內容 `.zoomLayer` 與 PhotoImage 的
  外框**又都是 height: 100%**，整條鏈一路塌成 0。症狀是**點進燈箱一片全黑、
  只剩關閉鈕**，而且只在手機上。

## 不開放的照片

`Photo.restricted`（0020，`INTEGER NOT NULL DEFAULT 0`）。1 ＝ **只有可管理全站內容的人
（站長與 `can_manage_others=1`）看得到**，其餘成員與訪客眼中那一格整個不存在。

- 切換走 `PUT /api/photos/restricted`（`{photoIds, restricted}`），**只認 `me.canManageOthers`，
  不是 `canTouchPhotos`** —— 標成不開放之後連標的人自己都看不到了，而「誰看得到」
  是全站層級的決定，跟「誰傳的」無關。前端有**兩顆長得一樣的開關**
  （都只在 `canManageOthers` 時端出來）：燈箱裡照片左上角那顆，以及**縮圖左上角
  那顆快速鎖**（相簿格線與首頁搜尋結果，共用 `album.module.css` 的 `.restrictLock`）。
  曾經只有右側資訊欄裡一整段（標題＋說明文字），跟 Story／標籤同一個層級，但這是
  每幾百張才動一次的管理動作，佔那麼大一塊會把照片本身往下推。
  ⚠️ 關著要淡到不搶注意力，**開著一定要整顆亮起來並且把「不開放」三個字寫出來**
  —— 它決定的是「誰看得到」，狀態不能靠猜。格線上那三個字由左下角既有的
  `.restrictedBadge` 負責，鎖本身只留一顆亮起來的圖示，不重複寫一次。
  ⚠️ 格線那顆**編輯模式下不端出來** —— 左上角那個位置已經是勾選框了，
  而且那個模式的每一下點擊都是在選照片／設封面。
- ⚠️⚠️ **按完那顆鎖不可以重抓（`loadData()`）。** 使用者的原話是「不要每次點了鎖圖
  就重新整理 這樣我要重新再找」—— 重抓一次捲軸就回頂端，一本幾千張的相簿要重新
  捲回剛剛那一格。改成把結果**就地併回手上那一列**（`applyRestrictedPatch()`）。
  三件後端在同一趟裡順手做掉的事，前端要跟著對齊，不然畫面跟資料對不上：
  ① **縮圖的 R2 鍵換掉了、舊物件當場刪除** —— 所以 `PUT /api/photos/restricted`
  的回應帶著 `photos: [{id, url, thumb_url, thumb_sm_url}]`（只有真的換過鍵的那幾張，
  取消不開放不換鍵所以是空的）。**不套用新網址那一格就是破圖**；
  ② 指到它的相簿封面被清成 NULL（首頁那份 `albums` state 也要跟著清）；
  ③ 遮罩開著的話它會立刻糊掉 —— 剛按完就消失在一片模糊裡很難理解，
  所以順手 `revealRestricted()` 掀開它（掀開狀態本來就只活在記憶體裡，重整蓋回去）。
  燈箱那顆走 `PhotoLightbox` 的選填 prop `onToggleRestricted`（沒給才退回 `onUpdate`）
  —— 那支元件同時給相簿頁與首頁用，兩邊各自把結果併回自己那份清單。
- **看得到的人可以再蓋一層模糊**：`AppSetting.restricted_blur`（k/v，**不需要 migration**，
  預設關，站長在 `/admin`「不開放的照片」那一格切）。開著的話不開放的那幾張在**縮圖與燈箱
  都先糊掉**，點那一張一下才暫時掀開。⚠️ **這不是權限，是螢幕隱私** —— 沒權限的人手上
  本來就沒有那幾列（SQL 濾掉了），所以跟下面那條「不要做馬賽克」不衝突：糊的是**已經
  看得到的人自己那一份畫面**，為的是捲相簿時旁邊剛好有人。
  - 值跟著 `GET /api/auth/me` 回來（零額外請求），而且**只發給 `canManageOthers`**，
    其他人一律 0 —— 不然每個訪客的 `/me` 都要多讀一列 AppSetting 換一個他用不到的旗標。
  - 遮罩純粹是前端 CSS `filter: blur()`，**位元組照樣是完整的**（配 `transform: scale()`
    蓋掉邊緣那圈沒糊到的），而且糊的是 `img`／`video` 本身不是外框 —— 糊外框的話角標、
    勾選框跟著看不清楚。
  - 掀開狀態在 `lib/restrictedReveal.ts`（module 層 store ＋ `useSyncExternalStore`）：
    格線、首頁搜尋、燈箱、補地點視窗**共用同一份**，不然在格線掀開進燈箱又糊回去。
    **只活在記憶體裡，重整就全部蓋回去**；刻意不寫 localStorage（存起來等於下次打開又
    整片攤著），也刻意不設自動收回的計時器（看到一半自己糊掉比沒有還難用）。
    ⚠️ 換值一定要「複本做好再換掉」，`useSyncExternalStore` 比的是參考。
  - ⚠️ 燈箱那層掀開用的遮罩（`.revealVeil`）**要壓在 `<video>` 上面**，不然糊著的影片
    照樣按得下去播。左上角那顆鎖則要壓在遮罩上面（`z-index` 比它大），糊著的時候
    還是要能取消不開放；上下一張的箭頭本來就更高，不受影響。
  - 補地點視窗（`PlaceCheckinModal`）**只糊、不給掀開的入口** —— 那裡是照時間地點挑照片，
    不是看照片。要看就回相簿掀開，掀開之後這裡自然跟著攤開。
- ⚠️ **路由要排在 `PUT /api/photos/:id` 前面**：`/api/photos/restricted` 切出來也是 4 段，
  排後面會被當成「id 叫 restricted 的照片」吃掉（跟 `/api/photos/reorder` 同一個理由）。
- 過濾**一律寫在 SQL 的 WHERE 裡**（`RESTRICTED_VISIBLE_COND`，Photo 要別名為 `p`），
  蓋住：`/api/albums` 的預覽圖、`/api/albums/:id/photos`、`/api/search`、`/api/footprint`、
  `/api/photos/geo-pending`、`/api/photos/drive-pending`。
  ⚠️ drive-pending 的**列表與 COUNT 要用同一個條件**，不然補傳進度永遠歸不了零。
  ⚠️⚠️ **首頁那排預覽圖（`preview_photos`）是唯一連「看得到的人」也一起濾掉的地方**
  —— 那一句 SQL 刻意不看 `canSeeRestricted`。相簿卡片滑鼠移過去會**自動輪播**，
  而它畫的是 **CSS 背景圖**（省掉「相簿數 × 預覽張數」次 Workers 請求，見坑 11），
  `restricted_blur` 那層糊的是 `img`／`video` 本身，**背景圖它蓋不到** —— 於是
  站長自己在首頁看到的會是沒有糊過的原圖在那裡輪播，旁邊剛好有人就穿幫了。
  規則是**不出現**，不是糊掉。（封面那一張本來就安全：標成不開放時後端會把指到它的
  `cover_photo_url` 清成 NULL，前端也擋掉把不開放的設成封面。漏的一直只有輪播這幾張。）
- 大圖／影片位元組（`/full`、`/video`）沒有身分可看，靠 **mt 的升級票**（見「後端的請求流程」），
  或真的帶 Authorization 進來。拿不到一律回 **404 不是 403** —— 403 等於承認那個編號上有東西。
- ⚠️⚠️ **`/full` 一定要先查 D1 再 `cache.match`，順序不能倒回去。** 反過來的話（舊版就是）
  照片在標成不開放**之前**只要有人開過燈箱，那份 4K 就以 immutable 一年躺在共用邊緣快取裡，
  之後的請求在快取那一行就回去了，`restricted` 的檢查根本沒機會跑 —— 而**邊緣快取沒辦法
  精準清掉**（`cache.delete` 只作用在當下那一個機房）。代價是每看一次大圖多一次 D1 主鍵讀取；
  換來的好處是**沒被標記的照片全站共用同一份快取**（舊版把 `adm` 掛進 key，管理員自己一份、
  其他人一份，Drive 取檔次數直接翻倍）。`adm=1` 現在只掛在不開放那幾張上，仍然必須
  **先 `delete("adm")` 再由後端自己 set** —— 照抄請求裡的 `?adm=1` 等於讓任何人指定要讀哪一份快取。
- ⚠️ **標成不開放時要換掉 R2 縮圖的物件鍵**（`rotateThumbKeys`）。`/api/photos/view/*`
  在進站閘門的白名單上，唯一的護欄是「網址猜不到」—— 而那個網址在標記**之前**早就
  隨相簿 JSON 發給每一個進得了站的人了。SQL 過濾只讓它從清單上消失，**發出去的網址還活著**。
  順序是 get → put → **寫 D1** → 刪舊物件（反過來寫失敗就等於照片指向已刪物件＝破圖）。
  一次最多 8 張（搬一顆是一次 R2 讀＋寫＋刪），回應把 `rotated` 講出來。
  ⚠️ 這**收不回已經下載到對方瀏覽器裡的位元組**，也清不掉舊網址在其他機房的快取殘影 ——
  能保證的是「新網址沒有人拿過、舊物件已經不存在」。**已經開著的分頁**也一樣 ——
  它手上那份清單是標記之前拿的，重新整理（或任何一次 `loadData()`）才會消失。
- 標成不開放時後端會**順手把指到它的 `Album.cover_photo_url` 清成 NULL** ——
  封面是存下來的網址，不清的話它會以封面的身分掛在首頁上給所有人看。前端也擋掉
  「把不開放的照片設成封面」。⚠️ 清封面要排在**換鍵之前**（比對的是舊的 `Photo.url`）。
- ⚠️ **不要做「馬賽克／點開才說沒權限」那種 UI**。使用者要的是看不到；端出一格點下去說
  沒權限，等於告訴所有人「這裡有一張你不能看的照片」。
- **留言與通知也一起擋**（2026-08-26 補）。條件一律**折進既有那句 SQL 的 EXISTS／JOIN**，
  不另外查一次 Photo —— 每開一次燈箱多一趟 D1 是這個站最不該花的額度：
  `GET /api/photos/:id/comments`（EXISTS 子句，回空清單不是 403）、
  `POST …/comments`（本來就撈了 Photo，多帶一個 `p.restricted`，404）、
  `GET /api/notifications`（本來就 JOIN Photo，加 `AND p.restricted = 0`）。
  ⚠️ `/api/auth/me` 的**未讀數要跟通知清單同一套條件**，不然紅點會停在一個點進去
  什麼都沒有的數字上（跟 drive-pending 的清單與 COUNT 同一個道理）。
- ⚠️ **訪客那份共用邊緣快取要用版本號作廢**（`AppSetting.content_epoch`，k/v 不需要
  migration）。`withEdgeCache` 只對訪客寫共用快取（成員一律 skip），而 **Cache API
  清不掉** —— `cache.delete` 只作用在當下那一個機房。所以不是去清舊的，是把 epoch
  併進 cache key（`__v`），**換一把 key 讓舊的再也沒有人問得到**。
  `PUT /api/photos/restricted` **兩個方向都要 `bumpContentEpoch()`**：取消不開放不推的話
  那張照片要等快取過期才回得來，站長會以為開關壞了。
  帶版本號的四支：`/api/albums`、`/api/albums/:id/photos`、`/api/search`、`/api/footprint`。
  epoch **刻意用 `getSetting` 不用 `getSettingCached`** —— 後者自己有 60 秒 isolate TTL，
  快取它等於把要解的問題往後搬 60 秒。代價是訪客每次清單請求多讀一列 AppSetting，
  **比縮短 edgeMaxAge 便宜**（清單一次要掃幾百到幾千列，多讀一列換到 300 秒的快取照舊）。
  那四支的 `browserMaxAge` 也一起降到 10 秒 —— 訪客自己瀏覽器那份快取，epoch 管不到。
- 前端**不必另外做「跳過這一張」** —— 相簿清單是伺服器過濾過的，`?photo=<id>` 深連結
  也是在那份清單裡找，找不到就什麼都不做。燈箱因此永遠不會落在不開放的那一格上。

## 足跡：一次跑過就記下來，不重跑

2026-09-02 修的。同步 Drive GPX、貼路、Google 時間軸三條路以前**每次進 `/map`
都從頭再跑一次**（使用者的原話：「每次登入都會重跑一次」）。三條各有各的原因，
但共通的規矩只有一條：**跑過的結果要留得下痕跡，而且「跑過但沒東西」也是一種結果。**

- ⚠️⚠️ **貼路貼不出東西也要留紀錄**（`saveTrackMatched(dayKey, {segments: [], emptyReason})`），
  **不可以 `deleteTrackMatched()`**。刪掉的話那一天在 R2 上跟「還沒貼過」一模一樣，
  每次進地圖都會被 `unmatchedKeys` 挑出來，重解析一整天的點、重打 Valhalla，
  而結果永遠還是空的。`emptyReason` 兩種：`no_trips`（整天沒有移動）、
  `no_match`（每一趟都是火車／飛機／船，不走道路）—— 兩種都是**檔案本身決定的**，
  重跑一百次一樣。
  ⚠️ **例外是請求真的失敗**（Valhalla 是志工維護的單機，掛掉是預期內的事）：
  那是暫時的，**維持沒有檔案**讓它下次再試。`runMatch` 裡因此有一個 `failed` 計數器，
  分辨「永久的空」與「這次沒打通」。把暫時的記成永久＝那一天再也不會有貼路軌跡。
  ⚠️ 真正該讓結果消失的時機只有一個：**那一天的點被重寫** —— 而
  `POST /api/tracks/ingest` 已經在後端自己刪了，前端不必也不該再刪一次。
  讀取端跟著改：只有 **`!data`（檔案不存在）** 才算 unmatched，`segments` 是空的不算。
- **Google 時間軸的月檔改用瀏覽器 HTTP 快取，不再每次重抓**。一個月的 JSON 動輒
  好幾 MB，而 `timelineCache` 是**每次掛載都重來**的 ref。作法是
  `GET /api/timeline/month/:m?v=<索引裡那個月的點數>` ＋
  `Cache-Control: private, max-age=31536000, immutable`：內容變了點數就變，
  **換一把網址讓舊的再也沒人問得到**（同 `content_epoch` 那招）。
  ⚠️ **索引本身一定要 `no-store`** —— 月檔的 immutable 完全靠索引裡那個點數是最新的。
  ⚠️ **`Vary: Authorization` 不是可有可無的**：那是 `private`（瀏覽器自己那份）快取，
  同一台電腦換一個人登入，沒有它就會讀到上一個人的足跡。
  ⚠️ 沒帶 `?v=` 的（舊前端、手動打）只給 60 秒。
- **開頁自動同步 Drive GPX 改成「代跑」**：可管理全站內容的人一進 `/map`，
  順手把**每個綁好資料夾的成員**也掃一遍。見下一節。

### 為什麼不用 cron：Worker 解不動 GPX

使用者要的是「有串接 GPX 資料夾的所有人**每天固定**自動匯入」，而不是「誰開地圖誰才有」。
最直覺的作法是後端 cron，**但那條路在免費額度裡做不到，實測過**：

- 免費版的 **scheduled handler 跟一般請求一樣只有 10ms CPU**（15 分鐘那個數字是
  牆上時間，不是 CPU）。
- Worker 沒有 `DOMParser`，只能 regex 掃。實測（Node，最快的一次）：
  2000 點 5.2ms／5000 點 9.4ms／1 萬點 19.4ms／2 萬點 35.1ms，**解析佔九成以上**
  （`collapseStays` ≤1.2ms、`simplifyTrack` ≤0.2ms）。一天的軌跡動輒上萬點，
  **一開跑就超時，而且是安靜地超時**。
- 順帶還會讓 `gpx.ts` 變成前後端各一份（第四個兩份副本的檔）。

**不要再往 Worker 搬 GPX 解析。** 解析留在瀏覽器（那裡的 CPU 不用錢），
缺的只有一步「列**別人**的資料夾」：

- `GET /api/tracks/drive/files?user_id=<uid>` ＝代跑。只有 `canManageOthers` 給過，
  對方要 `active=1`（停權的人軌跡本來就不上地圖）。回來的 dayKey 已經帶著
  **被同步那個人**的前綴 —— ⚠️ 寫成站長自己的話全家的軌跡會整批落到站長名下
  （顏色、圖例、合體判定全錯）。
- **寫入那三支一個都不用改**：`POST /api/tracks/ingest`、`PUT /api/tracks/raw/:dayKey`、
  `PUT /api/tracks/matched/:dayKey` 本來就對 `canManageOthers` 開著（`canTouchTrackDay`）。
- `GET /api/track-members` 多回一個 **`has_track_folder`** 布林，代跑靠它決定要掃誰。
  ⚠️ 多帶一欄不多花讀取額度（D1 算的是讀了幾列不是幾欄），而 `/map` 本來就會打這一支
  —— 所以**不另外開一支路由**。回布林不回資料夾 id：那是 Drive 的內部識別碼，
  前端沒有任何功能需要它。
- 前端（`app/map/page.tsx`）四道界線：**一個一個跑，不並行**（`syncChain` 那條
  promise 鏈，自己那份、代跑的每個人、自動貼路全排在同一條上 —— Drive 與 Valhalla
  都禁不起同時開好幾條，而 `matching` 是 state，設下去要等下一次 render 才擋得住人）；
  **每個人各自的冷卻時間戳**（`didadida:lastAutoSync:u<uid>`，共用一個的話站長自己
  剛跑過就會把全家都當成跑過）；**失敗不寫時間戳**；**永遠不 force**（force 會洗掉
  手動編修過的日子，那是別人的資料）。
  ⚠️ `has_track_folder` 是 `undefined`（邊快取裡躺著舊版後端的回應）時**當作沒綁**，
  不然會對每個成員各打一趟 Drive 只為了換回一個 503。

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

## 足跡動畫的車與大頭

2026-09-02 換掉的。以前那台車是 `lib/car.ts` 用 canvas 一筆一筆畫的（車身塗成
那個人的軌跡顏色、輪子會轉）。現在是**使用者給的兩張去背插畫**，頭坐在圖上
那三個**沒有頭的身體**的脖子上。

- 圖在 `apps/frontend/public/`：`car-solo.webp`（一個人）與 `car-family.webp`
  （合體），兩張都是 840×540。⚠️ 使用者原圖上那三顆綠點**在打包前就修掉了**，
  那是給人看座位用的參考記號，不是圖的一部分。
  `SEATS` 存的是**正規化座標**（0–1）不是像素 —— 換一張同構圖的插畫只要改那三個小數。
- ⚠️⚠️ **`SEATS` 標的是「脖子上緣」＝下巴要落在哪裡，不是頭的中心**
  （2026-09-02 改的）。原本存的是那三顆綠點，而綠點是照插畫本來那顆正常大小的頭
  標的中心 —— 頭放大好幾倍之後以中心對齊，下巴會插到車底盤、整個身體被頭吃掉。
  **頭的大小會一直被調，脖子不會。** 所以 `rider-heads` 那層是
  **`'icon-anchor': 'bottom'`**（順帶：錨在底部時 `icon-size` 怎麼縮放下巴都在同一點，
  合體那三顆大小不同的頭才坐得住）。
  ⚠️ 貼圖的底部**不是下巴** —— 中間隔著 `HEAD_PAD` ＋ avatar contain-fit 留的白，
  所以 `putSeat` 還要往下推 `HEAD_CSS_H * scale * HEAD_BOTTOM_PAD + NECK_OVERLAP`
  （使用者要的是「下方稍微覆蓋到 1～2 px 脖子」）。車頂那一排是照「頭的中心」
  寫的，換錨點之後**要補半顆頭**回去。
- **座位語意是固定的**：站長（爹地）開車、`AppSetting.seat_passenger_uid` 指到的那位
  （媽咪）坐副駕、後座是寶寶。⚠️⚠️ 但**那是「排序」不是「保留席」** ——
  站長沒去的那一趟，副駕會遞補去開車（`rank()` 排序後 `slice`），
  畫面上一台沒有駕駛的車看起來就是壞掉。沒被指定的人 `seat` 是 `undefined`，排在後面補位。
- ⚠️ **只要是合體軌跡，後座就一定有寶寶**（使用者拍板）—— 他不是一個成員，
  不參與人數與排序，`putSeat('rear', …)` 是無條件畫的。沒設頭像就畫小外星人。
- **一個人的時候用 `car-solo`，兩個人以上一律 `car-family`**（寶寶本來就在後座，
  所以沒有「爹地＋媽咪」那張）。四個人以上位子不夠，多出來的頭排在車頂上方一列
  （`HEAD_CROWD_SCALE`／`HEAD_STEP`）—— 至少「今天幾個人在一起」還看得出來。
- **頭是刻意畫得很大的**（使用者的原話是「大頭狗開車」）。頭大到會互相蓋住，
  所以**畫的順序就是疊放順序**（`rider-heads` 那層設 `'symbol-z-order': 'source'`）。
  ⚠️⚠️ **頭的最高準則是「不能離開脖子」，擠不下就把車放大**
  （2026-09-03 使用者拍板）。三個脖子橫向只隔 ~44 ＋ ~20 CSS px，而一顆座位頭就
  ~72 px —— 在「一個人那台車」的尺寸上，「黏在脖子上」與「不互相遮擋」不可能
  同時成立。**唯一的解是把脖子的間距撐開**，也就是合體時整台車連座位一起放大
  （`CONVOY_CAR_SCALE`，一個人那台維持 1）。
  ⚠️ 那個倍數是**從 `SEATS` 現算的不是寫死的**（`HEAD_GAP_RATIO × 兩顆頭寬的平均
  ÷ 兩個脖子的間距`，取最大的那一段）—— 換插畫、調 `SEAT_HEAD_SCALE`／
  `BABY_HEAD_SCALE` 都會自動跟著變。以現在的值是 **~2.45 倍（150 → ~367 CSS px 寬）**，
  瓶頸是駕駛到後座那 ~20 px。
  ⚠️⚠️ **只放大車，頭不跟著放大** —— 頭一起放大等於原地踏步，遮擋一模一樣。
  代價是「大頭狗」那個比例在合體時本來就沒那麼誇張，而且合體／散開的那一瞬間
  車會跳一階大小（在那之前兩張插畫刻意一樣大）。這是使用者選的那一邊。
  ⚠️ 座位的位移（`seatOffset`）也要乘 `carScale`，車頂那一排的高度也是；
  但頭自己那張貼圖的透明邊 `sink` **不乘** —— 那跟車多大無關。
  ⚠️ 車的貼圖為此烤成 **`CAR_PIXEL_RATIO = 3`**（`CAR_W` 450 ／ `SPRITE_H` 289 ／
  `BOB` 6 ／ `GROUND` 15，畫面尺寸完全沒變），放大兩倍多才不會糊。
  **要改車的顯示大小請動 `CAR_PIXEL_RATIO`，不要動 `CAR_W`** —— 後者一改，
  那三個數字都得等比重算。
  ⚠️ **寶寶最後才 push**（`symbol-z-order: 'source'` ＝後畫的在上面），
  所以他永遠不會被別人的頭蓋掉 —— 那正是使用者點名的那一顆。
  ⚠️⚠️ **要更誇張一律去縮車，不要再放大 `HEAD_SIZE`。**
  頭的來源只有 256px，`HEAD_BOX` 超過它就是把小圖放大、邊緣糊掉。
  現在是一個人那台車 150 CSS px 寬、一顆頭 116 —— 2026-09-02 兩輪調過來的
  （260／88 →「車子太大了」→ 180／116 →「車子再小一點 但頭像大小先不動」→ 150／116）。
  ⚠️ 縮車連帶要調車頂那一列的 `HEAD_STEP`／`HEAD_CROWD_SCALE`。
  ⚠️ **`BABY_LIFT` 已經移除**（2026-09-02 使用者：「寶寶頭像位置太高 沒有貼到後座
  身體的脖子上」）。它本來是為了「不被駕駛的頭擋掉」把寶寶整顆往上抬 18px，
  代價就是他浮在脖子上面。遮擋現在由放大車＋畫的順序解決，
  **不要再用抬高或橫向挪開來閃避遮擋** —— 那兩招都是拿「貼不到脖子」換的。
- ⚠️⚠️ **停著的時候也要補一次 `triggerRepaint()`**（`car.ts` 的 `makeSettler`）。
  `StyleImageInterface.render()` 寫進 `this.data` 的內容要等**下一次**重繪才真的
  畫得出來 —— 動畫在跑時每一格都有下一次，停著就沒有了，於是外星人那顆頭
  （`data` 初值是全透明的空陣列）**在還沒按播放前整個不出現，畫面上只有一台空車**。
  補要**只補一次**（旗標 `settled`），每次都補就變成常駐 rAF、整張地圖一直重繪。
- ⚠️ **頭的 geometry 不是那個人真正的位置** —— 它是把車投影成像素（`map.project`）、
  在座位上排好再投影回來（`map.unproject`）。所以點下去要開 Google 地圖時
  **絕對不能拿 geometry 當座標**，真的那一份另外掛在 properties 的 `lng`／`lat` 上。
  ⚠️⚠️ 也因為是**螢幕座標推回經緯度**，那份 geometry 只在算它的那個縮放級別上對齊。
  播放中每一格都重算所以會自己修正，**暫停的時候不會** —— 於是縮放或拖動地圖，
  頭就跟車分家了（2026-09-02 使用者：「中途暫停 放大的時候 頭像會跟車子分離」）。
  修法是一支 `map.on('move')` 監聽器推 `viewTick` 逼那支效果重跑，
  ⚠️ **而且只在 `!playingRef.current` 時推** —— 播放中那一圈本來就在重畫，
  而鏡頭跟拍每一格都會發 `move`，跟著推是純粹白做。
- 車身是固定的紅色插畫，輪子也不轉了（那是畫上去的），改成整台車輕輕上下浮動
  （`carBob`）＋一片靜止的地面陰影。
- ⚠️⚠️ **頭外面那一圈不上軌跡色**（2026-09-02 使用者：「大頭不要有顏色的框框」）。
  留著的白邊（`HALO`）純粹是可讀性 —— 底圖 positron 幾乎是白的，深色頭髮的頭
  不描一圈會糊進路網。代價是**合體時頭上看不出誰是誰**，那件事線的顏色與圖例
  本來就在講。連帶：貼圖 id 裡不再有顏色（不然同一張頭像會照人數做出好幾張
  一模一樣的），外星人那顆全站只有一張，`NEUTRAL_RING` 整個移除。
  ⚠️ 拿掉顏色圈時 `HEAD_PAD` **刻意維持 18** —— 它一變 `HEAD_BOX` 就變、頭跟著
  變大，而 `HEAD_BOTTOM_PAD`（下巴往下推多少）是照它算的。

### 頭像朝哪一邊（`avatar_facing`，0025）

⚠️⚠️ **車頭會跟著行進方向左右鏡射（`flip`），頭像不會** —— 它就是一張使用者上傳的圖。
於是一張側臉朝左的頭像，在往東走的那一半路上變成「坐在車上看車尾」
（2026-09-02 使用者：「頭像的方向 不一定跟車頭方向一致, 會導致看起來很怪」）。

- 存的是**這張圖本來朝哪一邊**，鏡不鏡射由前端當場算：
  `const mirror = (facing === 'left') !== flip;`（`flip` 為真＝車頭朝左）。
  正臉的頭像兩個值都對，所以預設值 `'left'` 不必猜得準。
- 欄位是 `User.avatar_facing TEXT NOT NULL DEFAULT 'left'`（0025）；
  **寶寶沒有 `User` 那一列**，他的記在 `AppSetting.baby_avatar_facing`（k/v，不需要 migration），
  跟 `baby_avatar` 同一個規矩、同樣跟著 `GET /api/auth/me` 回來（零額外請求）。
- ⚠️ **maplibre 沒有辦法把一張 icon 左右翻過來**（沒有負的 `icon-size`，也沒有 mirror 屬性）。
  所以鏡射版是**另外烤一張貼圖**：`bakeHead(src, mirror)` 先過一次
  `mirrorSource()`，image id 尾巴加 `':m'`。一個人最多兩張，貼圖快取扛得住。
  ⚠️ GIF 頭像每一格都要照樣鏡射（`bakeHead` 那一層本來就每格都跑，改在它裡面就自動涵蓋）。
- 改的地方是 **`AvatarPicker` 的兩顆選填 prop**（`facing`／`onFacingChange`），
  不是另做一套 UI —— 三個呼叫端（`/admin` 的白名單、`/admin` 的寶寶、帳號牌上的自己）
  因此一起有了。⚠️ **`onFacingChange` 沒給就整組不端出來**：帳號牌那邊看
  `canViewMap`，看不到地圖的人沒有那台車，多一組設定只是雜訊。
- 路由兩支：`PUT /api/users/:id/avatar/facing`（本人或 `canManageOthers`）與
  `PUT /api/admin/baby-avatar/facing`（`canManageOthers`）。值跟著
  `/api/auth/me`（`user.avatar_facing`／`baby_avatar_facing`）、
  `/api/track-members`（`avatar_facing`）與 `/api/admin/settings` 回來 ——
  ⚠️ 多帶一欄**不多花讀取額度**（D1 算的是讀了幾列不是幾欄），所以不另外開查詢路由。
- ⚠️ 前端一律 `=== 'right' ? 'right' : 'left'` 收斂：舊列、壞值、以及邊快取裡
  躺著舊版後端回應時那一欄是 `undefined`，都要落在 `'left'` 上。

### 頭像支援 GIF 動圖

⚠️⚠️ **`prepareAvatar()` 對 GIF 直接 return，一個像素都不碰。** 底下那一整套
（裁透明邊界／圓形遮罩／重編）都要經過 canvas，而 **canvas 只畫得出第一格** ——
送進去出來就是一張靜止圖，而且錯得很安靜（使用者看到的是自己那張圖，只是不會動）。
代價是動圖不會被裁邊也不會被裁圓，那件事在 `AvatarPicker` 當場講出來。

- 後端 `avatarExt()` 收 `image/webp`／`image/png`／`image/gif`，`AVATAR_NAME_RE`
  跟著放寬。⚠️ **GIF 另外一個上限 `AVATAR_GIF_MAX_BYTES`（2MB，一般的是 512KB）**
  —— R2 儲存是免費額度裡真的會被吃掉的那一格。
- **留言區那顆頭像不必做任何事**：它本來就是 `<img>`，瀏覽器自己會播。
- **地圖上那顆要自己解**（`lib/gifDecode.ts`，手刻的 GIF89a 解碼，`decodeGif` 上限 24 格）
  —— maplibre 吃的是 `StyleImageInterface`，不是一個會自己動的 DOM 元素。
  ⚠️ **每一格都要先跟外圈描邊烤在一起**（`bakeHead`）再交給 maplibre：
  每一幀重畫描邊等於每秒幾十次 canvas 合成，而那一圈是固定的。
  ⚠️ 沒在播的時候不要叫 `triggerRepaint()`，不然整張地圖會一直重繪。

## 搜尋：檔名本來就搜得到

**不要再為「搜檔名」做第二支路由或第二個索引。** `Photo.title` 存的就是上傳當下的
客戶端檔名，而且**寫進去之後沒有任何一條路徑改得動它**（站上沒有「重新命名照片」
這件事），它本來就是 `PhotoFts` 的第一個欄位。

- 首頁那個搜尋框走 `/api/search` → FTS5。`bigram()` 把英數字的連續段整段當成一個
  token，所以 `IMG_20240815_123456.jpg` 進索引是「img 20240815 123456 jpg」，
  把同一串貼進搜尋框跑同一支切分函式，四個 token 一一對上 —— 底線、句點、副檔名
  都不必管。⚠️ 但比對是**從 token 的開頭**開始（只有最後一個 token 帶 `*` 前綴），
  所以**檔名中間的一段比不到**：`05502` 找不到 `DON05502.jpg`。要整段亂比只能
  `LIKE '%…%'`，那是一次全表掃描，**不做**。
- 相簿頁那個搜尋框是**純前端 `includes()`**（`displayPhotos` 的 filter，比 title 與
  description），所以反而沒有上面那個限制，中間一段也比得到。
- 兩個輸入框的 placeholder 都要把**「檔名」**講出來 —— 功能一直都在，但寫著
  「搜尋照片 Story...」的時候沒有人會想到可以貼檔名進去，看起來就像沒有這個功能。
- 典型用途：從 `/admin`「缺 Drive 備份的檔案」那份清單複製一個檔名，貼進來看是哪一張
  （更直接的路是那一列右邊的「看照片 ↗」，見「補傳清單」）。

## 指定地點：座標＋名稱都要有，套用完存進地點簿

寫入只有一條路：`AssignPlaceModal` → `POST /api/photos/geo/batch`。
補地點視窗（`PlaceCheckinModal`）自己**不寫座標**，挑完照片一樣交回這一支
——「多做一套 UI」的反面教材不要再犯。

- ⚠️⚠️ **行程段是「規則」，套用它是使用者按下去的動作，不是打開視窗的副作用**
  （2026-09-02 使用者要求改的）。兩件事很容易被寫成看起來像同一件，但它們沒有連在一起：
  - `AssignPlaceModal` 那顆**「同時建立行程段」只管建立規則**（後端只在
    `body.createSegment === true` 時 `INSERT INTO TripSegment`），**預設是打勾的**。
  - 套用是另一支 `POST /api/photos/geo/apply-segments`，把**所有既有規則**套到
    `lat IS NULL` 的照片上（標 `geo_source='segment'`，多條命中取最晚建立的）。
  - ⚠️ 以前 `PlaceCheckinModal` **一打開就無條件跑一次**，畫面上只留下一句
    「已依既有行程段自動補上 n 張」的**事後報告**。使用者的原話是那些勾選項
    「沒有作用」—— 他不勾「同時建立行程段」，照片照樣被補上位置，因為補他的是
    **以前建的規則**，跟這一次勾不勾完全無關。現在是視窗上那顆**「🧭 用行程段補位置」**，
    打開什麼都不做。**不要為了「省一次點擊」把它改回自動跑。**
  - ⚠️ `applyTripSegments()` 回的是 `{updated, reason}` 不是一個數字：`updated: 0` 有兩個
    完全不同的意思（**站上根本沒有行程段** vs. **有規則但沒有照片落在範圍裡**），
    前者還要順帶講出規則是怎麼建的，混成一句「補上 0 張」等於沒講，那顆按鈕看起來就是壞的。
  - ⚠️ 那顆按鈕動的是**整本相簿**，底下「自動補地名」動的是**選取的那幾張** ——
    作用範圍相反，說明一定要寫在按鈕旁邊。
- ⚠️ **座標與名稱兩個都要有才套得下去**（2026-08-28）。以前沒取名字就拿座標
  頂上（`25.03396, 121.56447`），相簿裡於是留下一串認不出是哪裡的數字；而地點簿
  是**照名字認人**的，沒名字就存不進去。前端 `blockReason` 擋著並**把缺的那一格
  寫在按鈕旁邊**（灰掉的按鈕按下去沒反應，這支元件為了同一個理由已經拆過一顆
  多餘的「使用這個位置」），後端那道 400 才是真的關 —— 直接打 API 繞得過前端。
- **地點簿 `Place`（0023）：套用完就把那個地點記下來，讓別本相簿的照片選得到。**
  - **全站共用一份**（使用者拍板）。家族相簿裡同一個地點本來就會被不同人拍到。
  - ⚠️ **名字就是身分**（`name` UNIQUE）。使用者拍板的規則：選一個存過的地點會
    自動帶出它的座標與名字；**如果這次把釘子移到別的位置再套用，那個地點的座標
    就更新成最新這一次** —— 所以 upsert 一律 `ON CONFLICT(name) DO UPDATE`。
    同名的連鎖店（7-11）會被併成一筆，要分開得自己取「7-11 中華店」。
  - ⚠️ 寫入**不看 `changed`**：整批都因為自帶 GPS 被跳過時，使用者一樣是親手挑了
    這個地點，捷徑照樣該留下。而且**包在 try 裡** —— 地點簿是「下次比較好按」的
    加分項，它掛掉不該讓已經寫進去的座標整支路由 500（照片改好了、畫面卻說失敗）。
  - `GET /api/places` **整份回去**（上限 300 筆），前端在記憶體裡過濾，
    不另外做過濾框也不逐字打 API。
    訪客拿不到（`currentActor` 對訪客回 null）—— 那是「家人去過哪些地方」的清單。
    **不包 `withEdgeCache`**，每套用一次就變。
  - `DELETE /api/places/:id` **刻意不限站長**：清單每套用一次就自己長一列，
    打錯字的那筆得有人收得掉。刪的只是**捷徑**，照片自己的
    `lat`／`lng`／`place_name` 與已建好的 `TripSegment` 完全不動 —— 確認視窗要講出來。
  - ⚠️ **地點簿掛在「打卡地點名稱」那一格，是個 combobox（可以打字，也可以下拉挑）**
    —— 2026-08-28 使用者拍板搬過來的，在那之前它是搜尋框底下另一塊清單。
    理由：地點簿**認的就是名字**，而挑一個存過的地點＝「名稱與座標一次填好」，
    本來就是名稱欄要回答的事；掛在搜尋框那邊等於同一件事有兩個入口。
    輸入框右邊那顆「用過的 ▾」是**一個字都還沒打時，地點簿唯一的線索**，不要拿掉。
    - 選一個下去會**同時**寫回名稱欄與旁邊那個「搜尋地點或貼上座標」欄（座標），
      因為那一格就是這個站拿來改座標的地方 —— 想微調位置直接改那串數字或在地圖上
      重點一下，**再套用就會更新地點簿裡那一筆的座標**（名字是身分那條規則）。
      ⚠️ 寫回搜尋框的是**原值不是 `toFixed`**：四捨五入再解析回來，會讓每一次
      「只是選了一下又套用」都把地點簿裡的座標推移幾公分。
    - 名字對得上、釘子卻被移到別處時**要先講出來**（`movesPlace`，寫在按鈕上方）：
      那份清單是全站共用的，「只是想借個名字」的人不該安靜地改掉別人標好的位置。
      ⚠️ 比對名字要**一模一樣含大小寫** —— `Place.name` 那個 UNIQUE 索引沒有
      COLLATE NOCASE，放寬會講出一句「座標會被更新」然後實際多存一筆。
    - 下拉收合聽的是 **`mousedown` 不是 `click`**：清單那幾列自己吃 click，
      等到 click 才收會先把清單收掉，於是點下去什麼都沒選到。
    - 已經有自己給的名字（打的、或從地點簿挑的）時，在地圖上點就**不再反查地名**
      —— 反正結果會被丟掉，而那是一次外部 API 請求。
  - OSM 的地名搜尋結果照舊在搜尋框底下，跟地點簿是兩個各自獨立的清單。
- **兩個輸入框在地圖底下並排一行**（2026-08-31 使用者要求）：左邊「打卡地點名稱」、
  右邊「搜尋地點或貼上座標」。在那之前搜尋欄自己佔滿一整行、還擺在地圖**上面**，
  兩格都塞不滿那個寬度，卻把地圖與底下的「套用地點」一路往下推。
  - ⚠️ **手機靠 `flex-wrap` 自己折，刻意不多寫一個 media query**
    （`.fieldRow`／`.field`，基準寬 `flex: 1 1 240px`）—— 窄螢幕放不下兩格就自動
    變成上下兩排。多一個斷點就是多一個要跟 CSS 對齊的數字。
    `.field` 一定要 `min-width: 0`，不然輸入框的預設寬度會把它撐開、擠成一行卻不折。
  - ⚠️ **名稱擺左邊**：它是必填的那一格，而且「從用過的挑一個」是最短的那條路
    （名稱與座標一次填好）。手機折行之後它也就排在前面。
  - ⚠️ **地名搜尋結果改成絕對定位的下拉**（`.menu`，跟地點簿那個同一套）——
    以前它是接在輸入框底下、把整頁往下推的一塊，並排之後那一塊會把這一格撐高、
    旁邊的名稱格跟著被拉開。連帶**要補一條「點到外面就清掉 `hits`」**
    （`searchBoxRef`），同樣聽 **`mousedown` 不是 `click`**。
  - ⚠️ 兩格的說明都是輸入框**底下**的小字（`.fieldNote`），不掛在 label 上 ——
    掛上去會讓其中一邊的 label 變兩行，兩格的輸入框上緣就對不齊了。
- ⚠️⚠️ **指定地點之後，`/api/footprint` 的 `local_time` 會是 null。**
  那一欄是 `LOCAL_TIME_EXPR` 從 `taken_at_local`／`taken_at` 算出來的，兩欄都空就整個
  是 NULL —— 而這支路由本來每一點都來自 EXIF 或軌跡（一定有時間），所以前端的型別
  一路寫成 `string`。影片與掃描的老照片只有座標沒有時間，於是「有了第一張這種照片」
  的那一刻起 `/map` 整頁被錯誤邊界接成一頁 **Application error**
  （`points.map(p => p.local_time.slice(0,10))`，2026-08-28 修）。
  型別已經改成 `string | null`，**用到它一律先擋一次**。
  症狀只在 prod 出現，因為 dev 的 D1 裡沒有這種照片。

## 相簿格線：排序、右邊那條時間軸、重複的那幾張

三件事在同一支 `app/album/page.tsx` 裡，而且**互相牽著**：時間軸是排序的縮影，
所以排序一換，軌上的東西也得跟著換。

- **預設排序是拍攝時間（新到舊），`DEFAULT_SORT`**，不是 `sort_order`。
  `sort_order` 記的是「上傳進來的先後」，跟照片什麼時候拍的無關 ——
  同一趟旅行分三次傳就散成三段。
- ⚠️ **沒有拍攝時間的排在最前面，`takenMs()` 拿不到值時不要退回 `created_at`。**
  那一疊是影片（封面圖是 canvas 畫的，沒有 EXIF）與掃描的老照片，
  要人手動指定時間（「拍攝時間」→「指定時間」）才排得進去。
  混在中間就等於永遠不會有人發現它們還沒補。都沒時間的彼此照上傳時間排。
- **拖曳排序只在「自訂排序」那個模式下有效**（`sortBy === "custom"`），
  預設改掉之後想調版面得先切過去。篩選徽章比的是 `DEFAULT_SORT` 不是 `"custom"`。
- **右邊那條時間軸就是格線順序的縮影** —— `timelineGroup` 把 `displayPhotos`
  由上往下走一遍，年月換了就插一個節點。所以：
  - ⚠️ **節點的日期欄位必須跟正在用的排序依據同一個**（`timelineDateOf()`）。
    以前一律取 `taken_at || created_at`：按上傳日期排的時候軌上寫的卻是拍攝月份，
    兩者對不起來，看起來就是**年月一路跳來跳去**。捲動時那顆氣泡也吃同一支。
  - **自訂排序時整條軌收起來**（回空陣列）。`sort_order` 跟時間無關，硬畫出來
    一樣是跳的，而且點下去會把人送到一個跟標籤對不上的位置。
  - 沒有時間的那一疊給一個 `無日期` 節點（它們就在最上面），點一下正好過去補時間。
- **在燈箱裡改完資料，關掉之後要停在那張照片上**（2026-08-31 修）。三件事一起：
  - ⚠️⚠️ 重抓一律走 **`loadData({ silent: true })`**。`loading` 一翻上去
    `{loading ? 載入中 : 格線}` 那一段就把整片格線 unmount，**頁面高度當場塌成 0，
    瀏覽器把捲軸收回頂端** —— 資料回來重畫完也回不去了。手上已經有一份畫得出來的
    清單，沒有任何理由先清空它。首頁那支 `runQuery` 同樣有 `silent`。
  - ⚠️ 燈箱認的是 **`viewingIdRef`（照片 id），不是 `selectedPhotoIndex`**。
    補完拍攝時間那一張會從「沒時間」那一疊掉進中間，順序一換、索引原地不動就
    **指到另一張照片**。一支效果在換上下一張時記 id（相依只有 index，清單變動時
    刻意不跟），另一支在 `displayPhotos` 換掉時照 id 把索引挪回去，找不到就收燈箱。
  - 關燈箱時 `scrollBackTo()` 捲回那張照片**現在**的位置：不在畫面裡才捲、
    捲到中間、**瞬間不是 smooth**（平滑捲過八百張要好幾秒）。index 超出
    `visibleCount` 要先補（無限捲動一次只放 24 張），再 `setTimeout(50)` 等它畫出來。
- **重複的那幾張：按完立刻跳下一張，事情排到背景做。**
  `resolveDuplicate()` 只負責把 `runDuplicateJob()` 接到 `dupJobsRef` 那條鏈上，
  然後 `advanceDuplicate()`。以前是 `await` 完才換下一張 —— 一張要等上傳 →
  Drive 4K → Drive 原始檔，一批撞到二十張就是按一次等一次。
  - ⚠️ **是一條鏈，不是各自 fire-and-forget。** 同時開二十份上傳會把記憶體與頻寬
    吃光（影片尤其）。排隊做跟以前的行為一模一樣，只是不擋人。
  - ⚠️ **背景裡不可以 `alert()`** —— 會蓋在使用者正在挑的下一張上面。
    失敗一律進 `dupFailuresRef`，收工一次講完（同 `IngestResult.failures` 的規矩）。
  - ⚠️ `finishDuplicateQueue()` **一定要 `await dupJobsRef.current` 才 `loadData()`**，
    不然最後幾張還在傳，重抓回來的清單裡沒有它們＝「選了等於沒選」。
  - 視窗那邊因此**沒有 `busy` 了**，改成一行 `backgroundNote`（背景還有幾張）；
    最後一張按完視窗收起來，換成頁面上那條「背景處理重複的照片 (n/m)」。

## 留言

燈箱右側的留言區（`app/album/PhotoComments.tsx`）。表是 `Comment` ＋ `CommentNotify`。

- **訪客留不了言，而且那不是開關** —— `Comment.user_id NOT NULL → User`，訪客沒有那一列。
  站長後台只有「訪客能不能**看**」一格（`AppSetting.guest_can_view_comments`，預設關）。
- 成員各自兩欄：`User.can_comment`／`can_view_comments`（預設都開）。
  **這兩格不被 `can_manage_others` 短路**，各自獨立；只有站長永遠全開。
- 看不到留言的人，燈箱裡**整塊不出現**（元件自己回 `null`），不是端出來再說沒權限。
- **回覆只有一層**，後端擋（parent 必須是同一張照片上的主留言）。刪留言＝**作者本人，或可
  管理全站內容的人**（2026-08-28 從只有站長放寬，跟後台同一個決定，見「身分與權限」）——
  GET 回的 `can_delete` 與 DELETE 的閘**必須同一個條件**，
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

- `Photo.media_type`（`'photo'`／`'video'`／`'gif'`，DEFAULT `'photo'`）與 `duration_ms`（0019）、`gif_key`（0021）。
  預設值就是為了**不對 prod 幾千列做 backfill UPDATE**。
- ⚠️ **影片的 Drive file id 記在 `drive_original_id`，`drive_file_id` 永遠是 NULL。**
  照片那兩欄的意思是「衍生的 4K」與「相機原始檔」，而影片沒有衍生版 —— 傳上去的
  就是原始檔。這樣 `recordPhotoDrive`、`DriveTrash` 刪除、記錄路由全部零修改沿用。
  代價是「`drive_file_id` 是不是 NULL」對影片不代表「沒備份」，已知會咬人的有兩處，
  都處理過了：`/api/photos/drive-pending`（**按 `media_type` 分開判斷**，見「補傳清單」——
  不是把影片整類排除掉，那會讓 Drive 失敗的影片永遠沒人看得到）、
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
- ⚠️⚠️ **`VideoPlayer` 的 `<video>` 要 `width/height: 100%` ＋ `object-fit: contain`，
  不可以寫 `width/height: auto`**（2026-09-01 修）。auto 的意思是「照固有尺寸長」，
  而 metadata 還沒回來之前 `<video>` 的固有尺寸來自 **poster**（R2 那張 800px 縮圖）
  —— 於是一開始只有 800px 寬，按下播放、真正的影片尺寸解出來才被 `max-width`
  夾成滿版，**畫面當場跳大一階**，看起來像換了一個播放器。撐滿整格之後
  尺寸從頭到尾是同一個，跟照片那條（`.image` 的 contain）一致。
- 前端 `<video>` **不要加 `crossOrigin`**：不加是 no-cors，跟 `<img>` 一樣免預檢；
  加了 Range 會多一次預檢，而我們也沒有要讀回應內容。`preload="metadata"` 不是 `auto`
  —— 幾 GB 的檔不能一進燈箱就自動下載。
- 燈箱裡拖時間軸時，`VideoPlayer` 的外框**擋掉 touch 事件冒泡**，不然手機上會被
  燈箱當成「滑到下一張」。
- **訪客看不到影片**這件事目前沒有另外的開關 —— 整站進站閘門本來就擋著。
- **燈箱那塊資訊面板影片也要端**（2026-08-28 改；在那之前 `!isVideo(photo)` 整塊擋掉）。
  相機／鏡頭／光圈對影片確實永遠是空的（封面圖是瀏覽器 canvas 畫的），
  所以那幾格改成一句「影片沒有相機參數」，**但面板本身要在** ——
  裡面的「拍攝時間」與「時間來源」對影片才是最要緊的兩格。開關的字跟著換成
  「顯示影片資訊」。
- **拍攝時間與座標從影片檔自己的 `moov` box 讀**（2026-08-31 加，`lib/videoMeta.ts`）。
  在那之前站上的每一支影片都是 `taken_at` NULL —— 不是「影片沒有 EXIF」，是**我們一直
  沒讀**：封面圖是 canvas 畫的不帶任何 metadata，而我們只從 `<video>` 元素問長度與寬高。
  mp4／mov 把這些放在 `moov` 裡（`mvhd` 的建立時間、`udta/©xyz` 的 ISO 6709 座標、
  Apple 的 `meta/keys/ilst`）。詳見「影片的 metadata」一節。
- **影片的拍攝時間讀不到時仍是 NULL，要由使用者自己指定**：
  燈箱資訊面板裡「時間來源」那一格右邊那顆小按鈕（沒有時間時寫「指定時間」，
  有的話寫「修改」），或相簿裡選起來 →「拍攝時間」→「指定時間」分頁，
  都走 `POST /api/photos/geo/set-time`（見「資料模型」那三支）。
  ⚠️ **影片與 GIF 的時間永遠改得動**（`canEditTime` 的例外，2026-08-31）——
  照片是「本來就有時間就鎖住」，但影片那個時間是我們從 moov ／檔名**推**出來的，
  跟相機 EXIF 不是同一個等級的事實，鎖起來等於推錯了就永遠錯著。
  ⚠️ 燈箱那個入口開著的時候**左右鍵、Esc、滾輪要整組讓開** —— 視窗裡全是
  `<select>`，而 select 不是 INPUT／TEXTAREA，燈箱既有那道「在輸入框裡不換照片」
  的防護攔不住它：在年份選單上按左右鍵會一邊改年份一邊把燈箱換到下一張。
  ⚠️ 平移與改時區那兩支**對影片沒有作用**（`taken_at IS NOT NULL`）。
  沒給時間的影片在相簿格線不受影響（那支照 `sort_order`），但**會沉到搜尋結果最底**
  （`ORDER BY p.taken_at DESC`，NULL 在 DESC 排最後）。
- 轉檔／第二種畫質（P4）**使用者明確延後**，先看實際讀取速度再決定。

## 影片的 metadata：解 moov box

2026-08-31 加的。`lib/videoMeta.ts`，**同 `geo.ts` 的兩份副本規矩**
（`apps/frontend/src/lib/` 是權威 LF ／ `apps/backend/src/` 是 CRLF 複本，改一邊要同步）。
兩份都要是因為**位元組在兩個不同的地方**：上傳時原始影片直傳 Drive、從不經過 Worker，
所以在瀏覽器解（`File.slice()` 惰性讀）；回寫既有影片時位元組只有 Drive 那邊有，
所以在 Worker 解（Drive 的 Range 請求）。

- ⚠️ **「影片沒有 metadata」是誤解，「時間是推出來的」也只對了一半。** mp4／mov 的 moov
  裡真的記著：建立時間（`mvhd`）、座標（`udta/©xyz` 的 ISO 6709）、機身與型號
  （`©mak`／`©mod`、Apple 的 `com.apple.quicktime.make`／`.model`）、軟體、解析度與旋轉
  （`trak/tkhd` 的 16.16 定點長寬 ＋ 變換矩陣）、長度、影格率（`stts`）、視訊／音訊編碼
  （`stsd` 的 fourcc）。**唯一真的用推的是「時區」**（見下一條）—— 其餘都是檔案自己寫的。
- **讀到的東西整批存進 `Photo.exif` 的 `_video` 底下**（`videoMetaToExif()`／`videoMetaBlock()`，
  **不需要 migration**，那一欄本來就是 TEXT 而影片一直是空的）。`normalizeGeo()` 只認白名單
  裡那幾個鍵，所以 `_video` 對它是惰性的。燈箱那塊面板因此對影片端出
  **「影片的 Metadata」**（欄位跟照片的 EXIF 一一對應，沒對照到的原始標籤照樣一條條列）。
  ⚠️ `uploadPhoto()` 的 exif 白名單**必須含 `'_video'`** —— 那個白名單是**丟掉沒列到的鍵**，
  漏了它新上傳的影片就跟存量的一樣是空的，而且錯得很安靜（時間與座標照樣進得去，
  因為那幾個鍵在白名單上）。
- **這一檔本身不做任何時間換算**，只把檔案裡有什麼挖出來湊成一份 **EXIF 形狀**的物件
  交給 `normalizeGeo()`。全站的不變式（`taken_at = taken_at_local − tz`）只能有一份實作。
  於是 `mvhd` 的 UTC 瞬間扮演 `GPSTimeStamp`、牆上時間扮演 `DateTimeOriginal`，
  `deriveTzOffset()` 那招原封不動沿用。
- ⚠️⚠️ **`mvhd.creation_time` 沒有時區。** 規格說是 UTC，實際上一大票 Android 機身寫的是
  **當地時間** —— 猜錯就是整整 8 小時，而且錯得很安靜（同 `PXL_` 檔名刻意不猜那個坑）。
  所以時間分**四層，優先序不能對調**：
  ① 檔案自己寫明時區（Apple 的 `com.apple.quicktime.creationdate` `…+0800`）→ `offset_tag`；
  ② 有 mvhd 瞬間 ＋ 另一個牆上時間來源（沒帶時區的 `©day`，或 `VID_20260824_143000.mp4`
  這類檔名）→ **兩者相減就是時區** → `gps_utc`；
  ③ 只有 mvhd → 照規格當 UTC 瞬間 → `file_time`；
  ④ 只有牆上時間 → 配站台預設 +8 → `assumed`。什麼都沒有就維持 NULL。
  ⚠️ ②相減出來**剛好是 0** 代表 mvhd 寫的其實是當地時間，這時候退回④，
  **不要真的存一個 UTC+0 進去**。⚠️ `PXL_` 開頭的檔名是 **UTC**，不參與②的相減
  （它落在③剛好是對的）。⚠️ 容許 10 分鐘殘差（`DERIVE_RESIDUAL_MAX_MIN`）——
  mvhd 記的常是**錄影結束**、檔名記的是**開始**，一支 3 分鐘的影片兩者就差 3 分鐘。
- ⚠️ `meta` 這個 box **在 ISO BMFF 是 FullBox、在 QuickTime 不是**（差 4 個位元組）。
  硬套其中一種會有一半的檔解不開，所以用 `looksLikeBox()` 探下一個位置像不像 box 頭。
- ⚠️ 走 box 時 **`size === 1` 是 64 位元長度（檔頭 16 位元組）、`size === 0` 是「一路到檔尾」**，
  兩個都要接。截斷是常態不是錯誤（moov 太大時只讀開頭），最後一個 box 超出手上這塊時
  照樣回報 —— 否則 mvhd 明明在最前面卻解不到。
- **讀取次數是刻意壓的**：先讀 128KB 檔頭（`HEAD_CHUNK`，faststart 的手機影片 moov 整個
  就在裡面 ＝ **1 次**），moov 在檔尾的靠 `mdat` 自己的 size **直接跳過去**，不逐段試。
  在 Worker 裡每一次 `read` 就是一個 Drive subrequest（免費版單次上限 50）。
- `readVideoExifFromFile()`（上傳路徑）**絕不往外丟例外** —— 讀不到 metadata 只是
  「這支影片沒有時間」，跟上傳成不成功無關，丟出去會讓整批停在這裡。
- **上傳路徑**在 `ingestSources()` 的 `isVideoFile()` 那一岔，接在 `captureVideoPoster`
  後面把 `exifData`／`taken_at` 一起交給 `uploadPhoto`。⚠️ 重複視窗那條也要帶
  （`PendingDuplicate` 多存 `exifData`／`takenAt`），不然「選取代」進來的影片沒有時間。
  Google 相簿匯入**不必另外做** —— 它跟本機選檔在 `source.load()` 之後就合流了。
- `guessWallClockFromName()` 也住在這一檔，`FixTimeModal` 是它的另一個呼叫端
  （**不要再各留一份副本**）。⚠️⚠️ 裡面那兩個正規表示式的 `\d` 曾經整批掉成 `d`，
  改完要 grep 一次 `[^\\]d{`（見「資料模型」）。

### 回寫既有影片：`POST /api/admin/video-meta`

存量影片（2026-08-31 之前傳的）一律沒有時間、也沒有 `_video`，入口在
**`/admin`「影片的 Metadata」**那一格（`app/admin/VideoMetaCard.tsx`，`AdminSection` 的
id 仍是 `video-meta`，換掉會弄丟 localStorage 那個開合狀態）。

- 認 `canManageOthers`（它會改到全站每一個人的影片）。沒有 `GOOGLE_DRIVE_SA_KEY` 回 503。
- ⚠️ **一趟只做幾支（`VIDEO_META_DEFAULT_LIMIT` 6，上限 10），由前端推 `cursor` 迴圈**
  —— 跟「比對全部相簿」那顆完全同一個做法（subrequest 預算）。收工看 `done`，
  另外掛 `MAX_ROUNDS` 當保險絲。
- ⚠️⚠️ **這是覆蓋，不是補空格**（2026-09-01 使用者拍板改的；在那之前兩句 UPDATE 各帶著
  `taken_at IS NULL`／`lat IS NULL`，於是**每一格都已經有值的站台永遠回報 0**，
  上線當天就被回報成「功能壞了」）。檔案自己記著的才是事實，**手動填的時間一律讓位**。
  三道閂缺一不可：
  ① **只蓋「檔案裡真的有值」的那幾格** —— `takenAtUtc` 是 null 就什麼都不做，
  **絕不把手動填過的時間清成 NULL**（那是把資料弄丟，不是回寫）；
  ② **座標唯一的例外是 `geo_source = 'manual'`**（`geoOverwriteGuard('exif')` 照舊）——
  那是使用者親手標的打卡地點，旁邊掛著一個 `place_name`，蓋掉座標地名就變成假話。
  時間沒有這個問題（時間沒有名字），所以時間照覆蓋。跳過的那幾支要回報
  `kept_manual_geo`，不然看起來像漏掉了；
  ③ **值一樣就不下 UPDATE** —— 跑第二次不該產生任何 D1 寫入，`updated` 也才講得出
  「這一趟真的改了幾支」。座標比對要用容差（`near()`，1e-5 約一公尺），存進 D1 是 REAL，
  字面比對必定處處不同。
- ⚠️ **`compare = true`（「重讀比對」）一個位元組都不寫。** 覆蓋不可逆（原本手動填的沒有
  備份），所以動手之前要看得到差在哪。⚠️ 刻意**不做「比對完順手改掉」**：那兩顆按鈕
  要做的事完全不同，合成一顆就沒有預覽了。
- ⚠️ **一支影片壞掉不能停掉整批** —— 逐支 try／catch 收進 `item.error`，最後在畫面上列出來。
- ⚠️ 檔案大小是從第一次回應的 **`Content-Range` 表頭**解出來的，刻意不多打一次
  `files.get?fields=size`（那是一個白花的 subrequest）。
- ⚠️ **Drive 不理 Range 而回 200 時要當場 `cancel()` body**（`Content-Length` 超過 4MB）——
  不然幾 GB 的影片會整份灌進 128MB 的 Worker。
- ⚠️ 有寫進東西就 `bumpContentEpoch()`：`taken_at` 一改，相簿的排序就變了。
- ⚠️ **`mvhd` 是唯一時間來源（`how === 'instant'`）的影片有風險**：Android 機身常把
  當地時間寫進 mvhd，照規格當 UTC 解就整整差 8 小時 —— 而覆蓋會拿它蓋掉正確的手動值。
  這正是「重讀比對」存在的理由，回寫之前先按那顆。
- `remaining_before`（進度條的分母）那句 COUNT **跟分頁那句 WHERE 是同一個條件**，
  不然數字永遠歸不了零（同 drive-pending 的清單與 COUNT）。

## GIF

2026-08-28 加的。**使用者拍板：不轉影片，動畫本體直接塞 R2**（`media_type='gif'`
＋ `Photo.gif_key`，0021）。於是 GIF 是站上**唯一位元組真的躺在 R2 的媒體** ——
照片只有兩顆縮圖、影片只有一張封面。

- **為什麼不走影片那條**：`<video>` 播不了 `image/gif`，走那條就得轉檔；而轉檔在
  瀏覽器（ffmpeg.wasm 要的 COOP/COEP 會同時弄壞 Google Picker、Drive 上傳與地圖圖磚）
  與 Worker（10ms CPU）兩邊都做不到。**不要再重開這個討論。**
- **上傳跟照片同一條路**（`ingestSources` 沒有另外的分支，只有三個差異）：
  ① 縮圖照舊由 `resizeImageFile()` 產 —— canvas 只畫得出**第一格**，而第一格正好
  就是我們要的靜態縮圖；② 動畫本體跟著**同一趟** `uploadPhoto` 送上去
  （FormData 多一個 `gif` 欄位 ＋ `media_type=gif`），由後端整份 `BUCKET.put` 進 R2。
  ⚠️ **不要拆成兩趟** —— 中間失敗就留下一列點開不會動的 GIF，還得另外做一支補動畫的路由；
  ③ Drive 只放**原始檔那一份**（`pushPhotoToDrive(..., { fourK: false })`），
  「4K WebP」對 GIF 是把第一格放大成一張靜態圖，存了沒有用途。
- ⚠️ **GIF 的 Drive 失敗是可以吞的，跟影片相反。** 動畫本體已經在 R2，相簿裡那一格
  是完整的 —— 所以照舊記進 `pendingDriveBatch`，**不做 `deletePhoto()` 回滾**。
- ⚠️ `pushPhotoToDrive` 的回傳裡 **`fourK: 'skipped'` 不是失敗**。算「還缺哪一半」
  一律寫 `res.fourK === 'failed'`，**不可以寫 `!== 'ok'`** —— 那會讓下一次補傳
  拿 GIF 去跑 `encode4kWebp`。三處都要（`ingestSources`、`runDuplicateJob`、
  橫幅那顆「補傳這批」）。
- 大小上限 **25MB**（`GIF_MAX_BYTES`，後端 `index.ts` 與前端 `lib/imageUtils.ts`
  **同一個數字，要改兩邊一起改**）。前端在選檔後就講得出原因（省一趟白傳），
  後端那道才是真的關 —— 少了它，直接打 `/api/upload` 就能把任意位元組塞進 R2。
  理由：R2 的儲存是免費額度裡真的會被吃掉的那一格，而後端收檔走 `request.formData()`、
  整份會進 Worker 記憶體（上限 128MB）。再長的動畫本來就該錄成影片。
- **播放就是 `<img>`**（燈箱走照片那條，`photoFullSrc()` → `/api/photos/:id/full`）。
  那條路由查到 `gif_key` 就直接把 R2 物件串出去，一年 immutable。
  ⚠️ **刻意不把 `view/<key>` 的網址發給前端當大圖來源** —— `/api/photos/view/*`
  在進站閘門的白名單上、唯一的護欄是「網址猜不到」，而動畫本體跟大圖同一個等級，
  該由 `/full` 那段「先查 D1 再決定給不給」（不開放的判斷）擋著。
- ⚠️ **`drive_file_id` 對 GIF 永遠是 NULL**（同影片）。所以：燈箱那句
  「Drive 沒接上，顯示 800px 縮圖」要**先用 `isGif()` 擋掉**（不擋的話每張 GIF
  都會掛上一句假話，而使用者眼前那張正在動的就是完整原檔）；`drive-pending`
  與對帳的 `slotsOf()` 都用 `IN ('video','gif')` 判斷「只有原始檔一份」。
- ⚠️ **標成不開放時 `gif_key` 要跟著換鍵**（`rotateThumbKeys` 已含）——
  `SELECT p.*` 會把這一欄帶進相簿 JSON，也就是標記**之前**那把鍵早就發出去了，
  而 `/api/photos/view/<key>` 不看身分。跟兩顆縮圖完全同一個理由。
  刪照片時 `r2KeysForPhoto()` 也要含它，漏掉留下的不是幾十 KB 的孤兒縮圖，
  而是一整份最大 25MB 的動畫。
- 格線上是**靜止的第一格** ＋ 一顆 `GIF` 角標（沿用影片那顆 `.videoBadge`）。
  燈箱的 `pendingLabel` 寫「動畫載入中…」，不然使用者會以為這張 GIF 壞了不會動。
- GIF 沒有 EXIF，拍攝時間一律 NULL —— 跟影片一樣要人自己「指定時間」
  （見「資料模型」那三支），在那之前它會排在相簿最前面。

## Android 的動態照片：存位置，不存位元組

2026-08-31 加的。一張 `.jpg` 的**尾巴上黏著一段 mp4**（一兩秒）。站上把它當
一張普通照片收（`media_type` 仍然是 `'photo'`），只多記一個整數
`Photo.motion_offset`（0024）＝那段 mp4 從第幾個位元組開始。

- ⚠️⚠️ **不要把那段影片抽出來另外存一份。** 原始檔整份早就在 Drive 上了
  （直傳的），動態那一段跟著在裡面 —— 抽出來進 R2 等於同樣的位元組收兩次錢，
  而 R2 儲存是免費額度裡真的會被吃掉的那一格（見「GIF」）。一支動態照片的
  影片是 1～4MB，兩千張就好幾 GB。**播放是現切**：`GET /api/photos/:id/motion`
  對 Drive 發一個 Range 請求，把 `[start, EOF]` 那一段串出去。
- **`motion_offset` 有三個值，NULL 不是 0**：`NULL` ＝還沒掃過（既有的每一列）、
  `0` ＝掃過了不是動態照片、`>0` ＝起點。⚠️ 這個分野**就是 `/api/admin/motion-scan`
  的續掃書籤**，所以 0024 刻意沒有 `DEFAULT 0` —— 有的話整批既有照片會變成
  「掃過了、沒有動畫」，那是一句假話而且再也掃不回來。
- **解析在 `lib/motionPhoto.ts`**（同 `geo.ts`／`videoMeta.ts` 的**兩份副本**規矩：
  前端 LF 權威 → 後端 CRLF 複本）。兩種格式都是「長度從檔尾往回算」：
  ① **MicroVideo**（舊的 `MVIMG_*.jpg`）`GCamera:MicroVideoOffset="N"`，
  ⚠️ 名字叫 Offset 值卻是**影片長度**；② **Motion Photo v1**（Pixel 的 `*.MP.jpg`、
  近年三星）XMP 的 `Container:Directory` 裡 `Semantic="MotionPhoto"` 那一項的
  `Length` ＋ `Padding`。兩種都是 `起點 = 檔案大小 − 長度 − padding`。
  ⚠️ 三星更早期那種（尾巴接 `MotionPhoto_Data` 標記）**刻意不支援** ——
  它的 XMP 裡沒有長度，只能從檔尾整片掃字串，在 Worker 就是一次幾 MB 的 Drive 讀取。
  ⚠️ **不解 JPEG 的段結構**：要的只是幾個 ASCII 字串，而 `Semantic="MotionPhoto"`
  不會憑空出現在 APP1 以外的地方，直接把檔頭當文字搜還不會被 Extended XMP 卡住。
  ⚠️⚠️ 那幾個樣式**一律寫成 regex 字面值，不要塞進字串再 `new RegExp`** ——
  字串裡的 `\d`／`\s`／`\w` 經過任何一層處理跳脫字元的東西就會安靜地掉成
  `d`／`s`／`w`，樣式照樣編譯得過、只是永遠比不中（同「資料模型」那顆指定時間的按鈕）。
- ⚠️ 算出來的位置要**驗一次**（那裡是不是 `....ftyp`），差幾個位元組就在附近 4KB
  掃一次 `ftyp`，找不到當成不是動態照片 —— 硬給一個位置只會讓燈箱端出一支播不了的影片。
  **一般照片只花一次讀取**（檔頭裡沒有那段 XMP 就直接回 0），驗證那一次只有真的
  疑似動態照片才會發生，所以整批掃描的成本是「每張一次」不是兩三次。
- **上傳時就在瀏覽器算好**（`ingestSources()` 的照片那一岔，`readMotionOffsetFromFile`）
  —— 位元組本來就在使用者手上（`File.slice()` 惰性讀檔頭那 128KB），
  一送上 Drive 之後就只剩「Worker 回頭讀一次 Drive」那條貴的路。
  ⚠️ **不是動態照片也要送 0**，不送的話那一列留在 NULL，之後掃描還會回 Drive
  讀一次我們剛剛才讀過的檔頭。⚠️ `PendingDuplicate` **要跟著存**
  （同 `exifData`／`takenAt` 那個坑）—— 不帶的話從重複視窗「照樣上傳」進來的
  動態照片會少掉動畫。⚠️ `readMotionOffsetFromFile` **絕不往外丟例外**。
- **`GET /api/photos/:id/motion`**：在進站閘門的簽章網址表上（`isSignedMediaPath`，
  跟 `/full`／`/video` 同一個理由，`<video src>` 不會帶 Authorization）。
  ⚠️ **Range 要換算座標系**：前端送的 `bytes=a-b` 是**影片內**的位置，
  對 Drive 要問 `bytes=(start+a)-(start+b)`，回來的 `Content-Range` 再減掉 `start`、
  分母換成 `total − start`。`bytes=-N`（從尾巴數）原樣轉發 —— 影片的結尾就是檔案的結尾。
  ⚠️⚠️ **Drive 不理 Range 而回 200 時要當場 502，不可以照樣串出去** ——
  那份位元組的前面是整張 JPEG，前端會拿到一支播不了的影片。
  ⚠️ 同 `/video`：**不進 `caches.default`**（一個網址只存一份完整回應，
  把某人的 206 存成「這個網址的答案」會餵給下一個人錯的位元組），回 `Cache-Control: private`。
  不開放的照片一律回 **404 不是 403**。
- **燈箱裡是一層蓋在照片上的 `<video>` ＋ 一顆停止鈕**（`.motionVideo`／`.motionBtn`）：
  ⚠️⚠️ **進燈箱就自己播，而且一直重播**（2026-09-01 使用者拍板改的，
  在那之前是「點了才載」）。**代價是真的**：那段影片 1～4MB，每開一張動態
  照片就是一趟 Drive 取檔，不是使用者真的想看才花。交換到的是「一點進來就在動」
  —— 那本來就是這種照片存在的理由。**只有動態照片走這條**（`hasMotionClip`），
  普通照片一毛錢也不多花；格線上也絕對不播（一頁二十四格＝二十四趟）。
  ⚠️ **重播中間隔 0.5 秒（`MOTION_REPLAY_GAP_MS`），不是 `loop` 屬性** ——
  一兩秒的東西接成無縫循環看起來像一團抽損的畫面，停一下才看得出來它在重播。
  它是一支 `setTimeout`，**換照片、按停止、關燈箱三處都要收**，不然上一張的
  計時器會在下一張身上叫 `play()`；`<video>` 也要 `key={photo.id}` 才會重建。
  ⚠️ 那一層**排在 `.zoomLayer` 外面**（放進去的話捏合放大 5 倍
  會跟著變五倍大），`z-index` **低於 `.revealVeil`（3150）** 好讓不開放又糊著的
  照樣糊著；⚠️ `muted` 是必要的不是偏好 —— 沒有它瀏覽器根本不准自動播放，
  而現在整個功能就是自動播放；**不要加 `crossOrigin`**（同影片）。
  那顆按鈕是 `<button>`，手機那套「輕點照片一下」的收合才會讓開它。
- 格線上是**靜止的照片** ＋ 一顆「▶ 動態」角標（沿用 `.videoBadge`）——
  ⚠️ 格線刻意**不播**，一頁二十四格就是二十四次 Drive 取檔。
- **存量補掃：`/admin`「Android 動態照片」那一格**（`POST /api/admin/motion-scan`，
  認 `canManageOthers`）。⚠️ 同「影片的拍攝時間與座標」：**一趟只做十張，
  由前端推 `cursor` 迴圈**（subrequest 預算），另掛 `MAX_ROUNDS` 保險絲。
  ⚠️ 讀不到的那幾張**刻意不寫 D1**（留在 NULL），下次按會重試 —— Drive 抖一下
  就把一張動態照片永久記成「沒有動畫」太可惜了；畫面上要講出「再按一次會重試」。
  ⚠️ 掃出東西就 `bumpContentEpoch()`：`SELECT p.*` 會把這一欄帶進相簿 JSON，
  訪客那份共用邊緣快取不換 key 的話角標不會出現。

## 旋轉：只轉 R2 的兩顆縮圖

2026-08-31 加的。入口在**編輯模式底部那排動作鈕**（`🔄 旋轉`，跟 📍 指定地點／🕒 修正時間
並排，可以一次選很多張），視窗是 `components/RotatePhotosModal.tsx`。

- ⚠️⚠️ **根因是 EXIF 的 `Orientation` 被套用了兩次，不是使用者拍歪。**
  `resizeImageFile()` 把原圖畫進 canvas（瀏覽器載 `<img>` 時**已經照 EXIF 轉正了**，
  `image-orientation: from-image` 是預設值），然後把原始的 EXIF **原封不動**寫回去 ——
  於是那份 2000px JPEG 上留著一句「請再轉 90 度」。`generateThumbnails()` 用 `<img>`
  載它產 R2 縮圖時**又轉了一次**，格線／首頁／地圖全部歪掉；而燈箱的大圖走
  `encode4kWebp(rawFile)` 吃的是原始檔、只轉一次，是正的。「只有網站縮圖轉向不對」
  就是這麼來的。**已修**：`piexif.dump` 之前把 `0th`／`1st` 的 `Orientation` 改寫成 1。
  這只救得了之後上傳的，**已經歪掉的那些要靠這個功能轉回來**。
- **只轉 R2 那兩顆縮圖**（使用者拍板）。Drive 上那份 4K 與原始檔不動 —— 它們本來就是
  正的，而重編一份 4K 再上傳等於把整條上傳流程再跑一次。
- **位元組全在瀏覽器裡處理**（`rotatePhotoThumbs()`，`lib/api.ts`）：`fetch` 現有的 800px →
  canvas 轉向 → 重編 800／400 → `POST /api/photos/:id/thumbs`。Worker 沒有影像解碼器，
  也沒有 10ms CPU 以外的預算，這件事在後端做不到。
  ⚠️ 一定要 `fetch` 位元組再走 objectURL，**不能直接把網址塞給 `<img>`** —— 那是跨來源的圖，
  canvas 會被汙染，`toBlob` 當場丟例外。
  ⚠️ 90／270 度要把畫布的長寬**對調**，不然轉完會被切掉兩邊。
- ⚠️⚠️ **後端一定要換一組新的物件鍵，不可以就地覆寫。** `/api/photos/view/*` 回的是
  `immutable` 一年的快取（那條路由的護欄就是「內容不會被就地改寫」），覆寫舊鍵的話
  瀏覽器與邊緣快取會一直拿舊的那張躺著的圖 —— 使用者按了旋轉卻什麼都沒變。
  順序同 `rotateThumbKeys`：put 新的 → **寫 D1** → 刪舊物件（try/catch）→ `bumpContentEpoch()`。
- ⚠️ 換鍵連帶三件事：① `file_name` 跟 `url` 指同一顆物件，一起換；
  ② `Album.cover_photo_url` 存的是**網址**，指到它的要改成新網址（不是清成 NULL，
  使用者只是把照片轉正）；③ 沒收到 400px 那顆時 `thumb_sm_url` 要**清成 NULL**，
  留著舊值的話首頁輪播與地圖標記還是那張躺著的圖。
- ⚠️ **`file_hash` 刻意不重算** —— 它記的是「上傳當下那份 800px 的位元組」，重複偵測與
  「重傳自動補 Drive」都靠它。改掉的話同一個原始檔再拖進來反而對不上。
- ⚠️ **影片與 GIF 一律不轉**，而且要在按之前就講出來（不是按了才逐張失敗）：影片在 R2 上
  只有一張封面（轉了播放照樣是躺著的），GIF 的動畫本體整份在 R2、燈箱走 `/full`，
  只轉縮圖會讓格線跟燈箱對不起來。後端那道 400 才是真的關。
- ⚠️ **成功之後不重抓（不呼叫 `loadData()`）**，就地把新網址併回手上那一列 ——
  同「不開放」那顆快速鎖的理由（重抓一次捲軸就回頂端）。不套用新網址那一格就是破圖。
- 批次是**一張一張跑**（不是 `Promise.all`），失敗逐張收集、收工一次講完 ——
  同 `IngestResult.failures` 與重複照片那條佇列的規矩。

## 儲存模型

- **R2 一張照片只有兩顆縮圖：800px ＋ 400px WebP。** 2000px 那顆已經拿掉。
- **收得進來的格式：JPEG／PNG／WebP／HEIC／HEIF ＋ GIF ＋ mp4／mov／webm。**
- **GIF 是第三種存法（0021）：動畫本體整份進 R2，不轉影片。** 見「GIF」一節。
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

## 兩邊對不對得起來：Drive 備份對帳

「站上一張照片 → Drive 上一份 4K ＋ 一份原始檔」（**影片只有原始檔一份**）。
上傳與刪除都在瀏覽器／Worker 的半路上，每一步都可能單獨失敗，而失敗是**安靜的** ——
這一整套就是把安靜的走鐘變成看得見的數字，以及自動收尾。

- **引擎**：`runDriveAudit()`／`auditDriveAlbum()`（`index.ts`），狀態整包塞在
  `AppSetting.drive_audit` 的一列 JSON 裡（k/v，**不需要 migration**）。
  cron 每 10 分鐘**一次一本**，掃完一輪 `cursor` 歸零並記 `finished_at`，
  之後閒置 24 小時（`DRIVE_AUDIT_IDLE_MS`）—— 閒著的 tick 只花一次 D1 讀取。
- ⚠️⚠️ **對帳比的是「檔名對不對得上」，不是只有 Drive id。**
  命名規則就是對應關係：`<photoId>_<檔名>_4k.webp`（4K）與 `<photoId>_<原始檔名>`
  （原始檔／影片）。`auditDriveAlbum()` 照檔名開頭那個 id 把資料夾分組，再看結尾
  分成兩格，然後跟 D1 那兩欄逐格比。判定順序是**三段，不能只留最後一段**：
  ① 記著的 id 就在資料夾裡（`onDrive`，**比 id 不比檔名** —— 命名規則之前傳的舊檔
  認不出檔名，硬要檔名對得上的話每張老照片都會白花一次 probe 再回報成「被搬走」）；
  ② 檔名對得上但 D1 沒記著（或記著過期的 id）→ **把 id 寫回去**，計進 `linked`；
  ③ 兩樣都沒有 → 才是缺件／不見了。
  ⚠️ ② 是這一段存在的理由：`recordDriveIds` 是上傳的最後一趟，它失敗時檔案**早就
  在 Drive 上了**。只比 id 的話那一列會同時變成**一筆假的「缺 4K」**（於是出現在補傳
  清單上，使用者再傳一份）**和一個假孤兒**（於是好好的備份被搬進 `trash/`）——
  兩件互相矛盾的事同時發生。
  ⚠️ ② **不受 `truncated` 影響**：清單沒看完只讓我們不敢說「沒有」，不會讓看到的
  東西變假。寫回去一輪最多 `DRIVE_AUDIT_MAX_LINKS`（200）筆，`WHERE` 帶上「原本是
  什麼」（`IS NULL` 或 `= 舊值`），免得蓋掉這中間上傳寫進去的值。
  ⚠️ 檔名不符規則的算 `foreign`，但**已經有人指著的不算** —— 那是命名規則之前的舊檔。
- ⚠️ **cron 一定是「先排待搬佇列，佇列真的空了才對帳」**，不可以並排。
  搬 20 個檔＝40 個 subrequest，免費版單次上限 50；撞上的表現是「後面幾個請求安靜地失敗」，
  於是對帳會**憑空生出一堆假的「不見了」**。
- **孤兒（Drive 上有、沒有任何一列指著）自動搬進 `trash/`**，走既有的 `DriveTrash` 佇列
  （＝仍然不呼叫 `files.delete`）。動手前有**三道閘，順序是刻意的**（便宜的先擋，
  最貴的那次 D1 查詢留到最後）：
  ① 檔名要符合我們自己的 `^(\d+)_` 規則，不符合的算 `foreign`，**一律不碰**；
  ② Drive 的 `createdTime` 至少 24 小時前 —— 剛傳完、還來不及回報 id 的檔長得跟孤兒一模一樣；
  ③ 拿檔名裡那個**照片 id 查主鍵**確認沒人指著它。
  ⚠️ **不要改成 `WHERE drive_file_id IN (…)`** —— 那兩欄沒有索引，每問一次就整張 Photo 掃一遍。
- **「不在資料夾清單裡」不等於「不見了」**：可能只是被搬去別的資料夾（相簿改名、有人手動整理）。
  所以要用 `probeDriveFile()` 再問一次本人，404／已在垃圾桶才把 D1 那一欄清成 NULL
  （清掉之後它就會出現在補傳清單上）。只是搬走的算 `moved`，**不動它**。
  一次最多追問 `DRIVE_AUDIT_MAX_PROBES`（8）個，剩下的下一輪再說。
- ⚠️ `listFolderFiles()` **一定要翻頁**，而且 `truncated: true` 的意思是「**沒看完**」不是
  「就這些」—— 半份清單去判「不見了」與「孤兒」會清掉好資料，所以 truncated 時**兩段整個跳過**。
- **後台**：`/admin`「**Drive 比對**」那一格（`GET/POST /api/admin/drive-audit`，認
  `canManageOthers`；2026-08-28 與「缺 Drive 備份的檔案」合併，見「`/admin` 的版面」）。
  一顆「比對全部相簿」、看報告，以及**重試放棄的搬移**
  —— `DriveTrash` 試三次就放棄（`attempts >= 3`），在這之前站上**沒有任何地方看得到它們**，
  「Drive 刪除失敗」跳完就再也沒有下文。那顆按鈕把 `attempts` 歸零讓它們回佇列。
- 報告除了「缺幾張」也講 **`ok`（該有的備份全都在的張數）** —— 使用者問的是
  「哪些要補**哪些不用**」，只給缺件數等於只答了一半。⚠️ `ok` 要**等追問完才算**
  （`finish()` 裡把 `bad` 那本帳換算成張數）：probe 會把「不見了」翻案成「只是被搬走」，
  在逐格的迴圈裡就下結論會少算。

### 單獨對一本：逐張明細，以及「多餘的」有兩種

`POST /api/admin/drive-audit {album_id}` ＝ **只對這一本，而且帶回逐張明細**。
`/admin` 那一格的下拉選單（清單跟著 GET 回來，一句 `SELECT id, name FROM Album`
—— 刻意不打 `/api/albums`，那一支每本都要撈封面與預覽圖）。

- 走的是**同一支 `auditDriveAlbum`**，只是 `detail=true`。三段判定只能有一份實作，
  分兩份寫遲早走鐘。
- ⚠️ **這一趟完全不碰 `AppSetting`**：不推游標、不累加 `totals`、不塞進 `reports`。
  它是使用者站在某一本前面問的一次性問題，算進「整輪掃描」只會讓那份報告的數字
  被重複計算。修資料的副作用照舊發生（接回漏記的 id、清掉真的沒了的、排孤兒進佇列）。
- ⚠️ **明細只在 `detail=true` 時產生，而且只收「有事情發生」的那幾格**（`items`：
  missing／linked／cleared／gone／moved）。兩份都在的不列 —— 一本幾千張全列出來
  沒有人看得完，而且那一份 JSON 會是好幾 MB。三份明細各夾在
  `DRIVE_AUDIT_MAX_DETAIL`（300），超出的用 `*_more` 講出來。
- **「多餘的」有兩種，處理方式刻意不同**：
  - **Drive 上多出來的檔**（孤兒、重複補傳留下的同名第二份）→ **自動排進 `trash/`**，
    三道閘照舊。搬進垃圾桶是可逆的，所以敢自動做。明細 `extras` 現在把每一個
    「不動它」的理由也講出來（`foreign`／`too_new`／`in_use`／`queued_before`／`over_limit`）
    —— 以前只有一個 `orphans_queued` 數字，數字對不起來時完全查不下去。
  - **站上（D1）多出來的列** → ⚠️⚠️ **只列出來，絕不自動刪**（`findDuplicateRows`）。
    刪一列 `Photo` ＝ 相簿裡少一格，**連同它的標籤、留言、Story、手動修過的座標與時間**，
    而且它的 Drive 檔會被排進 `trash/`。哪一列該留只有人判斷得了（舊的那列往往
    帶著標籤與留言），程式猜錯沒有退路。
- 重複的兩種訊號**強度不一樣，不要混成一種**：
  - `same_hash`：`file_hash` 一樣＝位元組層級同一個檔。⚠️ hash 算的是**上傳進來的
    那份位元組**（縮到 2000px 的照片／canvas 畫的影片封面），不是相機原始檔 ——
    所以換一台機器、換一個瀏覽器重傳 hash 不見得一樣。**抓到的都是真的，
    抓不到不代表沒有。**
  - `same_name`：只有 `title` 一樣（`title` 存的就是原始檔名）。**Google 相簿匯入
    那一條只有這個訊號** —— Picker 給的是 Google 轉檔後的位元組，hash 一定對不上。
    但**不同相機的 `IMG_0001.jpg` 也會撞名**，所以這一類 UI 上要寫「不一定是同一張，
    請自己看一眼」，不能寫成斷定。整組已經被同一個 hash 認領走的不重複列。
  - 兩種都是**純記憶體運算**，用的是對帳本來就撈出來的那些列，**不多打任何一次 D1**
    （為此那句 `SELECT` 多帶了 `title`／`file_name`／`file_hash`／`created_at` ——
    D1 算的是讀了幾列不是幾欄）。

### 刪除的順序：D1 先收乾淨，R2 留到最後

刪照片、刪相簿、清帳號內容三條路都是同一個順序：
**Drive 登記待搬 → 收 D1（PhotoTag／封面／Photo／FTS）→ 最後才 `BUCKET.delete`，而且包在 try/catch 裡**。

⚠️ R2 排在前面的話，它丟一次暫時性的錯誤就會讓整支路由 500，而那些列還在 ——
使用者眼中是「刪不掉」，重新整理卻看到**點開是破圖**的照片（位元組沒了、列還在）。
反過來最壞只是 R2 留下幾顆沒人指著的縮圖（幾十 KB，而且有 log），便宜太多。
⚠️ `queueDriveTrash()` **務必排在 `DELETE FROM Photo` 之前** —— 列一刪，那兩個 drive id 就沒有任何地方記得了。

### 重傳同一個檔＝自動補缺的那一半，不跳重複視窗

「網站上有這張、Drive 上缺一半」是很常見的半套狀態（上傳當下 Drive 斷線、或是傳上去了
但 `recordDriveIds` 那一趟沒回來）。使用者最直覺的補救就是**把同一個檔再拖進來一次**。

- 後端重複偵測那支（`POST /api/upload`）除了「長得像」之外，每一筆還要回
  **`media_type`／`same_file`／`has_4k`／`has_original`**（欄位名跟
  `/api/photos/drive-pending` 一致；**影片的 `has_4k` 一律 true**，它沒有 4K 這一份）。
- 前端 `ingestSources` 的 `incompleteTwin()`：命中的那一列缺東西就**直接補既有那一列**
  （`pushPhotoToDrive(drive, twin.id, rawFile, need)`／影片走 `pushVideoToDrive`），
  **不新增任何一列、不寫 R2**。⚠️ 補的是既有的 id，所以標籤、留言、Story、手動修過的
  座標與時間全都留著 —— 視窗那兩條路都做不到這件事（「全部保留」多一列＋兩顆 R2 物件
  而缺的照樣缺；「取代」補得起來但換了新 id，上面那些全沒了）。
- ⚠️ **只認 `same_file`（hash 一樣＝位元組層級同一個檔），不認 `same_time`。**
  時間相同只說明 EXIF 快門秒數一樣，連拍很容易撞在同一秒 —— 拿 A 的原始檔去填 B 的
  欄位，之後燈箱點開的大圖就是別張照片，而且錯得很安靜。
- ⚠️ 也**只認剛好命中一列**，而且**媒體種類要一致**（影片封面跟某張照片 hash 相同時，
  拿影片檔去補照片的原始檔欄位完全是錯的）。其餘一律照舊跳視窗。
- ⚠️ **視窗現在只在「真的重複」時跳** —— 網站有縮圖、Drive 4K ＋原始檔都齊。
- ⚠️ 補完**要講出來**（`IngestResult.backfilled`，收工跟 `failures` 一起 alert）。
  相簿裡什麼都沒多出來，不講的話使用者只會覺得「我重傳了，結果什麼都沒發生」。
  Drive 沒接上時記進 `pendingDriveBatch`（影片沒有這條退路，直接算失敗）。
- ⚠️ `lib/api.ts` 解那幾個旗標時**一定要補預設值**（`same_file` 當 false、兩份當已經有）：
  邊快取裡還躺著舊版後端的回應時它們是 `undefined`，而 `!undefined` 是 true。

### 重複偵測：特徵碼優先，對上就不再往下比

`POST /api/upload` 那句 SQL 一次撈兩種命中（`file_hash = ?` 或 `taken_at = ?`），
但**兩個依據不是平起平坐的**：

- ⚠️⚠️ **特徵碼（`file_hash`）對得上就到此為止，時間相同的那幾列一律不端出去。**
  hash 一樣＝位元組層級同一個檔，答案已經確定；而「拍攝時間一樣」在連拍時
  一次命中好幾列是常態。混在一起端出去有兩個壞處：使用者要在五張長得都像的
  縮圖裡挑，而**自動補那段整個失效** —— 前端 `incompleteTwin()` 要求
  「剛好命中一列」，多出來的同秒連拍會讓它放棄，於是「網站有、Drive 缺一半」
  補不起來。實作是撈回來再 `filter`（hash 有命中就只留那幾列），
  ⚠️ 配套要加 **`ORDER BY (file_hash = ?) DESC`** —— `LIMIT 5` 不能讓一串
  同秒的連拍把真正對得上的那一列擠掉。`reason` 跟著只看 hash 有沒有命中。
- **視窗只在兩種情況下跳**：① 特徵碼一樣、而且 Drive 兩份都齊（真的重複）；
  ② 特徵碼對不上、只有拍攝時間一樣（疑似）。缺備份的那些走上面那段直接補。
- 視窗（`GoogleSyncConflictModal`，本機上傳與 Google 匯入共用）三件事：
  - **一定要顯示檔名**（新的那張用 `File.name`，舊的用 `Photo.title`）——
    縮到 100px 的兩張縮圖長得幾乎一樣，檔名才是使用者當場判斷得了的線索。
  - **縮圖右上角一顆 🔍 可以放大看**（`same_time` 那種光看縮圖判斷不了）。
    ⚠️ 放大**不能綁在整格的點擊上** —— 右邊那幾格的點擊早就是「選它來被取代」，
    搶過來原本的操作就沒得按了；那顆按鈕要 `stopPropagation`。
    左邊「準備匯入的新照片」沒有選取語意，整張點下去就是放大。
  - ⚠️ 放大載的是 **800px 那顆**（後端多回一個 `thumb_lg`），
    **刻意不接 `/full`** —— 每點一次就是一趟 Drive 取檔，而 800px 已經夠分辨。
    也刻意不接既有的 `PhotoLightbox`：那支要的是一列真的 `Photo`（留言、EXIF、
    上下一張都掛在上面），而左邊那張新照片在站上根本還不存在。
- 標題那句話**跟著 `reason` 換**：`same_file` 寫「確定是同一個檔」、
  `same_time` 寫「可能是同一張」並提醒連拍會撞在同一秒。確定與疑似要使用者
  做的事完全不同，寫成同一句「找到多個可能重複的版本」等於沒講。

### 補傳清單（`/api/photos/drive-pending`）

**這份清單在 `/admin`「Drive 比對」那一格裡，而且是唯讀的**
（`app/admin/DrivePendingCard.tsx` 匯出的 `DrivePendingList`，2026-08-28 搬過去、
同日併進 `DriveCompareCard`）。它只回答三個問題：**哪個檔、誰傳的、在哪一本**。

⚠️⚠️ **沒有「補傳」按鈕，也不要再加回來。** 補的方法是**把同一個原始檔再拖進那本相簿
一次** —— 上傳流程的重複偵測會認出位元組一樣（`same_file`），直接補既有那一列缺的
那一半（`incompleteTwin()`，見上一節），不新增任何一列、不寫 R2，標籤／留言／Story／
手動修過的座標與時間全都留著。以前那個 `DriveBackfillModal`（重選檔案的視窗，
連同相簿頁 FAB 上那顆「補傳 Drive」）**已經刪掉**：它做的事就是上傳，
而上傳那條路本來就做得更好。相簿頁只剩黃色橫幅那顆「補傳這批（n 張）」——
那是**還握在記憶體裡的 `pendingDriveBatch`**（不必重選檔案），手上沒東西時整顆不端出來，
改成講「把同一批檔案再拖進來一次」。

⚠️ 這支路由要 **`canManageOthers`**（不是隨便一個成員）—— 回應裡帶著全站每一個檔案
是誰傳的。唯一的呼叫端就是 `/admin` 那一格。

⚠️ **誰傳的／哪一本不是用 JOIN 撈的**：一頁最多 500 列，三個 `LEFT JOIN` 等於把讀取
量乘上去，而 `WHERE id IN (…)` 會撞上 D1 綁定參數上限 100。作法是另外兩句
`SELECT id, name, user_id FROM Album` 與 `SELECT id, name FROM User` 整張撈回來
（兩張都是幾十列的小表）在記憶體裡對。`uploader_name` 後端已經套過
「`uploaded_by` 為 NULL 就看相簿主人」那條規則，前端不必再判斷一次。

⚠️ **影片與照片的「有沒有備份」是兩個不同的問題，不能寫成同一句。** 現在是：

```sql
   (media_type = 'video' AND drive_original_id IS NULL)
OR (media_type != 'video' AND (drive_file_id IS NULL OR drive_original_id IS NULL))
```

以前是 `drive_file_id IS NULL AND media_type = 'photo'`，兩邊都漏：
① **影片整類被排除** —— 上傳時 Drive 失敗的影片永遠不會出現在補傳清單上，
使用者手上只剩一張封面圖，而站上沒有任何地方講得出這件事（當初排除是對的，
因為影片的 `drive_file_id` 永遠是 NULL 會賴著補不完、而且補傳會拿它跑 `encode4kWebp`
—— 正解是分開判斷，不是整類丟掉）；② **照片只看 4K** ——「4K 上去了、原始檔失敗」
那些一輩子看不到。列表與 COUNT **共用同一個字串**，不然「剩幾張」永遠歸不了零。

⚠️ 清單上**點檔名就複製那一個**（`copyName`），刻意**沒有「複製全部」** ——
實際的動作永遠是「拿一個檔名去硬碟的搜尋框找一個檔」，整份貼進搜尋框找不到東西。
剪貼簿被擋掉（權限、非安全來源）要 `window.prompt` 把字攤開來讓人自己選，
只 console.error 又是一次「按了沒反應」。

一列右邊另外一顆**「看照片 ↗」**在新分頁開 `/album?id=<album_id>&photo=<id>` ——
回答的是另一個問題：「這個檔名到底是**哪一張**」。要人自己複製檔名去首頁搜尋
是繞遠路，這裡明明就握著 id。**另開分頁**是因為看完還要回來看清單的下一列。

- `album_id` 是 `/api/photos/drive-pending` 為此多回的一欄。⚠️ 多帶一欄
  **不多花任何讀取額度**，D1 算的是讀了幾列不是幾欄。
- ⚠️ 前端要防它是 `undefined`（邊快取裡還躺著舊版後端的回應），
  不要組出 `/album/undefined`。
- ⚠️ 那一列因此是 `div` 包一顆 `button`（檔名／複製）＋一個 `a`（看照片），
  **不是整列一顆 button** —— button 裡面不能再放 button／a。
- ⚠️⚠️ **相簿頁是 `/album?id=<相簿>`，不是 `/album/<相簿>`。** 前端是 `output: "export"` 的
  純靜態站，`src/app/album/` 底下沒有 `[id]` 這一層 —— 多打一段路徑就是實實在在的 404。
  三張後台卡片（補傳清單、影片的 Metadata、Android 動態照片）都各自踩過一次，
  **新增任何連到某一張照片的連結前先看一眼這一條**。
- 清單刻意**不列縮圖**：一次幾百張就是幾百次 Workers 請求。要看是哪一張是
  使用者一次點一張的動作，不是一開頁就全部載進來。
- ⚠️ 那一格**不在進頁時自動抓**（要按「看清單」），跟 Drive 對帳那一格同一個規矩 ——
  `/admin` 平常是來加人、改權限的。
- `media_type`／`has_4k`／`has_original` 現在只用來寫出「缺哪一份」那句話
  （影片是「影片缺原始檔」，照片分成「兩份都缺」／「只缺 4K」／「只缺原始檔」）。

### 上傳這條路的重試與半套

- `withDriveRetry()`（`frontend/src/lib/drive.ts`）：**5xx／429／網路層丟出來的**才重試，
  3 次、1s→2s 指數退避。**4xx 一律不重試**（403 是權限、404 是資料夾被搬走，試一百次一樣）。
  蓋住 `uploadToDrive`、resumable 的開工作階段那一趟（分塊 PUT 本來就有自己的重試）。
- `recordDriveIds()`：**把 file id 記回 D1 這一步比上傳本身更不能掉。** 檔案已經在 Drive 上了，
  這一趟沒回來就變成一個沒有任何一列指著的孤兒（站上看起來「沒備份」→ 使用者去補傳 →
  Drive 上再多一份）。`recordPhotoDrive` 因此回的是 `{ok, retryable}` 不是 boolean。
- `pushPhotoToDrive` 回 `DrivePushResult`（`ok`／`fourK`／`original`／`reason`），
  ⚠️ **半套不算成功** —— 以前「兩份裡有一份上去了」就回 `true`，於是那張照片再也不會
  出現在任何補傳清單上，使用者以為備份好了。呼叫端（`ingestSources`、`resolveDuplicate`、
  橫幅那顆「補傳這批」）**都要看回傳值**，並把「還缺哪一半」記進
  `pendingDriveBatch` 的 `need`。
- 影片 `pushVideoToDrive` 記不回 D1 **要往外丟**（不是回 false）：呼叫端才會把剛建的那一列收掉。
  ⚠️ 那個回滾 `deletePhoto()` **自己也會失敗，要驗回傳值** —— 沒收掉就是相簿裡留下一格
  點開只有靜止畫面的東西，而使用者以為「跳過了」。

## `/admin` 的版面

2026-08-28 整過一次。原則：**這一頁平常是來加人、改權限的**，其他東西不該擋路。

- **每一格都收得起來**（`app/admin/AdminSection.tsx`）。⚠️ 它是「按鈕 ＋ 條件式
  render」，**不是 `<details>`** —— 收起來的內容要真的 unmount，不然那些卡片的
  state、計時器與尚未收工的請求都還活著。開合記在
  `localStorage['admin_section_open:<id>']`，但**第一次 render 一律用 `defaultOpen`**
  （`output: "export"` 是靜態 HTML，讀 localStorage 會 hydration mismatch），
  掛載後才套回存下來的值。
- **「加入白名單」併進「白名單」那一格**：一個 `.detailHead`「加入新成員」＋表單，
  接著「目前的名單（n）」＋列表。加人跟看名單本來就是同一件事，分兩格只是讓
  名單被推到更下面。白名單那格 `defaultOpen`，其餘預設收起來。
- **「Drive 備份對帳」＋「缺 Drive 備份的檔案」＝「Drive 比對」**
  （`app/admin/DriveCompareCard.tsx`）。上面兩格問的是同一個問題的兩半，
  分開放的時候使用者得自己在兩份數字之間對照。
  - **一顆「比對全部相簿」**。⚠️⚠️ **那是前端的迴圈，不是一次請求** ——
    後端把 `albums` 夾在 1–5，因為 **Workers 免費版單次呼叫上限 50 個 subrequest**，
    一本就要好幾趟 Drive。前端 5 本一輪連續打，畫一條進度條。
    ⚠️ 收工條件**只能看 `finished_at`**，不能看 `cursor === 0` —— 那個值同時代表
    「還沒開始」與「剛剛跑完」。另外掛 `MAX_ROUNDS`（400）當保險絲。
    ⚠️ 跑完要再 `GET` 一次：`POST` 的回應**不含** `trash`／`albums` 那兩段。
  - **兩份清單**：① 缺 Drive 備份的檔（`DrivePendingList`，比對完用 `reloadToken`
    自動重抓；⚠️ 初值 0 刻意**不觸發**，維持「不在進頁時自動抓」那條規矩）；
    ② **被搬進 `trash/` 的檔**（名字／哪一本／「去 Drive 看 ↗」）。
    ⚠️ 第二份清單非有不可：`DriveTrash` 那張表**搬成功就刪列**，事後沒有任何地方
    查得到搬走的是什麼。所以檔名在對帳當下就收進 `AppSetting.drive_audit` 那列 JSON
    （`DriveAuditState.trashed`，上限 200 ＋ `trashed_more`，**不需要 migration**）。
  - 「單獨比對一本」＋逐張明細＋逐本結果收進一個 `<details>`。使用者要的是
    「內容簡化」，不是把功能砍掉。

## 一進來就該知道的坑

1. **`geo.ts` 與 `videoMeta.ts` 各有兩份副本**（`apps/backend/src/` 與 `apps/frontend/src/lib/`），
   改一邊一定要同步另一邊。前端 LF 是權威 → 產生後端 CRLF 版。
2. **D1 綁定參數上限 100** —— 批次 `IN (?,?,…)` 一定要先切塊，否則一百多筆就 500。
3. **站門閘必須排在 `withEdgeCache` 之前**，否則訪客回應會進共用邊緣快取、匿名請求直接命中。
   座標與軌跡的隱私**必須在 SQL 裡過濾**，不能只靠回應後處理。
4. SQLite `geo_source != 'exif'` 在值為 NULL 時是 falsy → **一律用 null-safe 的 `IS NOT`**。
5. 路由靠 `pathname.split("/").length` 分辨，**新增巢狀路徑前先算長度**（`/api/photos/1/geo` 是 5，不撞 4）。
6. `core.autocrlf=true` 且無 `.gitattributes` → 行尾混用（`index.ts`/`api.ts`/`FootprintMap.tsx` 是 CRLF，
   `gpx.ts`/`map/page.tsx`/`schema.sql` 是 LF）。**純外觀，不要順手統一**，會炸出整檔 diff。
7. **允許清單以外的國家會被擋成 403，而且有兩道**：前端 `functions/_middleware.ts`
   （看 `cf-ipcountry` 表頭）、後端 `index.ts`（看 `request.cf.country`）。
   兩邊各有一份 **`ALLOWED_COUNTRIES`**，內容必須一模一樣 —— **只改一邊等於沒改**。
   目前是 `TW`／`AU`／`NZ` ＋ `XX`（Cloudflare 判不出來，含本機開發）／`T1`（Tor）。
   ⚠️ 2026-09-01 從「只有台灣」放寬到含澳洲：家人住在澳洲，在那之前整個站對他是一片 403。
   這一層本來就只是縱深防禦，真正的護欄是進站閘門（沒有 token 一律 401）——
   所以要再開新的國家，照著加就好，不必為此另外做什麼。
   從別的國家或雲端 runner 測會以為整站壞了。
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
12. **燈箱的 EXIF 開關是「站台層級的偏好」，不是那一張照片的 state**
    （`lib/exifPref.ts`，module 層 store ＋ `useSyncExternalStore` ＋ localStorage）。
    以前是 `useState(false)`：換一張就收回去、關掉燈箱再開也收回去，想一路看
    相機參數得一張按一次，看起來像開關壞了。使用者要的是「打開之後整本相簿都是
    展開的」。⚠️ 它跟 `restrictedReveal` 的取捨**刻意相反** —— 那個是遮眼睛用的
    所以只活在記憶體裡，這個是顯示偏好，重整後回到收起來只會讓人再按一次。
    刻意**不進 D1**：多一欄就是每次 `/api/auth/me` 多讀一列，而這件事不需要跨裝置。
    ⚠️ 那塊面板現在的第一、二格是**拍攝時間**與**時間來源**（2026-08-28 從獨立區塊
    收進來，見「影片」）。時間改不改得動看
    `canEditTime = isAdmin && (!displayDate || photo.time_source === 'manual')`：
    **相機給的時間是事實，鎖著**；沒有時間的（影片、掃描的老照片）才給那顆
    「指定時間」，已經是 `manual` 的留著可以再改（打錯字的話這是唯一改得回來的地方）。
    ⚠️ 判斷用 `displayDate` 不是 `photo.taken_at` —— EXIF 有時間但 D1 沒存到的舊資料，
    畫面上看得到時間，那也算「本來就有」。`time_source` **沒有 `exif` 這個值**
    （只有 manual／offset_tag／gps_utc／file_time／assumed），所以「有沒有時間」
    才是那個判斷式。
13. **上傳的收尾一定要寫在 `finally` 裡**（`handleFileChange`／Google 匯入那條都是）。
    漏掉的話一個沒預料到的錯誤會同時做兩件事：`uploading`／`syncingGoogle` 永遠停在 true
    （FAB 從此只剩一行「上傳中...」），而且 `<input type="file">` 的 `value` 沒清掉 ——
    **再選同一批檔案瀏覽器不認為值變了，`change` 事件根本不會來**。使用者眼中就是
    「按了、選了，什麼都沒發生」，Console 只有一行 unhandled rejection。
    ⚠️ 失敗也**一律逐檔講原因**（`IngestResult.failures`，跟 Google 匯入的 `skipped` 同一個規矩）：
    「部分或全部照片上傳失敗，請稍後再試」對 HEIC 是句假話，再試一百次都一樣。
    `uploadPhoto` 的 `{status:'error'}` 因此帶著 `reason`。
    Drive 失敗**不算這張失敗**（照片已經在 R2 了），要記進 `pendingDriveBatch` 讓補傳看得到它。
14. **maplibre 的 `attributionControl: { compact: true }` 不等於「一開始是收著的」** ——
    它第一次拿到出處文字時會同時掛上 `maplibregl-compact` 與 `maplibregl-compact-show`，
    也就是**攤開**，要等使用者拖一下地圖才收。所以兩張地圖（`FootprintMap`／`PlacePickerMap`）
    建好之後都要叫一次 `lib/mapAttribution.ts` 的 `collapseAttribution(map)`：出處文字是圖磚
    來源載進來才填的，**`load` 與第一次 `idle` 各補收一次**，只在建立當下收一次擋不住。

## 免費額度用量條

`/admin`「免費額度用量」那一格（`app/admin/UsageCard.tsx`，`AdminSection` id 是 `usage`）。
**滿條＝免費額度用完**（使用者的原話）。七成變黃、九成變紅。
後端是 `GET /api/admin/usage` 與 `POST /api/admin/usage/r2-scan`，兩支都認 `canManageOthers`
（回應裡是整個 Cloudflare 帳號的用量）。

- **額度數字只有一份權威**：後端的 `USAGE_LIMITS`。前端只負責畫條，Cloudflare 調額度就改那一處。
  目前七格：R2 儲存 10GB／class A 每月 1M／class B 每月 10M／D1 儲存 5GB／
  D1 每日讀 5M 列・寫 100k 列／Workers 每日 100k 次。儲存類用十進位（1e9），帳單就是這樣算的。
- **數字有兩個來源，刻意都留著**：
  - **自己算得出來的**（零設定）：R2 儲存量掃一遍 bucket 加總；
    **D1 的資料庫大小就掛在任何一句查詢的 `meta.size_after` 上** ——
    所以 `readR2Scan()` 刻意用 `.all()` 不是 `.first()`（`.first()` 不回 meta），
    一句查詢同時把掃描狀態跟資料庫大小都拿回來，不為了大小多打一次。
  - **Cloudflare GraphQL Analytics**（要 `CF_API_TOKEN`）：今日 Workers 請求數、
    R2 class A／B 次數、D1 讀寫列數。這幾格**沒有第二條路**，Worker 量不出自己
    今天被打了幾次。⚠️ 沒設 token 時那幾條顯示「未設定」＋**畫面上要寫出怎麼補**
    （帳號層級、Account Analytics: Read，`wrangler secret put CF_API_TOKEN [--env dev]`）——
    只寫「未設定」是一條查不下去的死巷。
    ⚠️⚠️ **`CF_ACCOUNT_ID` 跟 token 是一組的，兩個都要灌**（值在 `npx wrangler whoami`）。
    本來以為 `cfAccountId()` 問得出來，但**列帳號要的是 `Account Settings: Read`**，
    而用量條只需要 Analytics —— 只給 Analytics 的 token 打 `viewer { accounts }`
    會回 **not authorized for that account**（2026-09-01 實測；`accounts` 那個欄位
    也**不吃 `limit` 參數**，寫了是語法錯誤）。所以那段自動探測只是退路，
    它的錯誤訊息一定要直接寫出「請灌 CF_ACCOUNT_ID」。
- ⚠️⚠️ **Analytics 那四段各自一次請求、各自 try**，刻意不合成同一份 GraphQL 文件 ——
  合起來的話任何一個欄位名對不上就整份查詢失敗，四條條一起變空白而且看不出是哪一段害的。
  錯誤逐條回到前端（`metrics[].error` ＋ `analytics.errors`）。
- ⚠️ **時間窗一律用 UTC 算**：Workers 與 D1 的每日額度照 UTC 換日、R2 操作次數以自然月計。
  用本地時間切窗會在台灣時間早上八點前後整個對不上。
- ⚠️ **R2 的操作分級要自己對**（GraphQL 只給 `actionType` 字串）：`R2_CLASS_A`／`R2_CLASS_B`
  ／`R2_FREE_OPS`（刪除是免費的）。對不上的**不要默默丟掉**，收進 `other` 並在畫面上講出來。
- ⚠️ **掃 R2 是前端的迴圈，不是一次請求**（同「比對全部相簿」、影片回讀、動態照片補掃）：
  一頁 1000 顆就是一個 subrequest，而免費版單次呼叫上限 50 個。後端一趟掃 8 頁
  （`R2_SCAN_PAGES_PER_CALL`）並把游標與累計值整包存進 **`AppSetting.usage_r2`**
  （k/v，**不需要 migration**），前端推到 `done`，另掛 `MAX_ROUNDS`（200）當保險絲。
  「重新掃描 R2」第一趟送 `reset: true` —— 那顆按鈕的意思是「從頭再算一次」，
  接著上次的游標會漏掉新物件。
- ⚠️ **掃描那份只有這個環境的一顆 bucket，帳單看的是整個帳號**（prod ＋ dev 加起來）。
  所以 analytics 有值時 `r2_storage` 以它為準，掃描那份退成 `<details>` 裡的參考
  （順便照物件鍵前綴分類：縮圖 800／400、GIF 動畫、頭像、GPS 軌跡、Google 時間軸）。
- ⚠️ **量不到跟「用了零」要分開講** —— 兩種條都是空的。量不到的畫成斜線底
  （`.usageUnknown`）並在底下寫出原因，不然使用者會以為這一格真的沒用到額度。
- ⚠️ 兩支路由**不可以包 `withEdgeCache`**（值一直在變，而且是整個帳號的用量），
  回 `Cache-Control: no-store`；那一格也**不在進頁時自動抓**（要按按鈕），
  同 Drive 比對那格的規矩。

## 工作習慣

- **行為／設計問題先攤開取捨再動手**，不要順手就改程式。
- **不要過度設計**：手動路徑優先，自動推論只是加分項。
- **同一件事不要另外做一套 UI**，加選填 prop 擴充既有元件。
- commit message 用中文，Conventional Commits 前綴（`feat(admin):` / `fix(map):` / `chore:`）。
