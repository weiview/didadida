package tw.didadida.app

import android.app.WallpaperManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Rect
import android.os.Handler
import android.os.HandlerThread
import android.os.Looper
import android.os.SystemClock
import android.service.wallpaper.WallpaperService
import android.util.Log
import android.view.SurfaceHolder
import android.widget.Toast
import org.json.JSONObject
import tw.didadida.app.push.Push
import kotlin.math.max
import kotlin.math.min

/**
 * 動態桌布：全螢幕輪播「★ 本次精選」，亮螢幕還沒解鎖時就看得到（Pixel 上多半主畫面也一起套）。
 *
 *  - 清單與縮圖跟桌面小工具**共用同一份**（`FeaturedWidget.list`／`load`）：同一個 prefs 快取（3 小時）、
 *    同一個 `cacheDir/widget_thumbs/`。所以桌布換一輪不會再下載一次。
 *  - 畫質是 800px 那顆縮圖（使用者拍板，不接 Drive 4K），預設置中裁切滿版；
 *    小工具設定選了「完整顯示」（`FeaturedWidget.fit`，同一格 prefs）時整張縮進畫面、旁邊留黑。
 *  - ⚠️ **不開放的照片與影片一律跳過**（清單在 `FeaturedWidget.list` 就濾掉了）—— 鎖定畫面誰都看得到。
 *  - ⚠️ **看不見的時候一個像素都不畫**（`onVisibilityChanged(false)` 就把計時器全收掉）：
 *    螢幕關著還在重畫就是白白耗電。平常停在一張靜止的圖上，只有換圖那 `FADE_MS` 才逐格重畫。
 *  - 網路與解碼在自己的背景執行緒（`worker`），畫在主執行緒。
 *  - ⚠️⚠️ **每一個引擎各自記位置**（1.0.24）：主畫面與鎖定畫面分開套用時系統會開兩個引擎，
 *    以前兩個共用一格 `wallpaper_cur_id`，互相把對方的位置蓋掉 —— 一亮螢幕就跳到別張。
 *    現在位置活在引擎自己身上（`curId`），存檔的 key 照引擎套在哪裡分開（`slotKey()`），
 *    預覽畫面的引擎一律不存。
 */
class FeaturedWallpaper : WallpaperService() {

    override fun onCreateEngine(): Engine = FeaturedEngine()

    private inner class FeaturedEngine : Engine() {
        private val main = Handler(Looper.getMainLooper())
        private val workerThread = HandlerThread("featured-wallpaper").apply { start() }
        private val worker = Handler(workerThread.looper)

        private var visible = false
        private var width = 0
        private var height = 0

        // 以下只在主執行緒讀寫
        private var items: List<JSONObject>? = null
        private var session: String? = null
        private var index = 0
        /** 這個引擎畫面上那一張的 id（-1＝還沒有），位置一律照它找 */
        private var curId = -1L
        private var current: Bitmap? = null
        private var next: Bitmap? = null
        private var fadeStart = 0L
        private var message: String? = null
        private var loading = false

        private val paint = Paint(Paint.ANTI_ALIAS_FLAG or Paint.FILTER_BITMAP_FLAG)
        private val textPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            color = Color.argb(200, 255, 255, 255)
            textAlign = Paint.Align.CENTER
        }

        private val advance = Runnable { startNext() }
        private val frame = Runnable { draw() }

        override fun onVisibilityChanged(visible: Boolean) {
            this.visible = visible
            if (visible) {
                val s = Push.session(applicationContext)
                if (s != session || items == null) reload(s) else { draw(); scheduleAdvance() }
            } else {
                main.removeCallbacks(advance)
                main.removeCallbacks(frame)
                // 換到一半被關掉：直接當作換完了，下次亮起來不從半透明開始
                if (next != null) { current = next; next = null }
            }
        }

        override fun onSurfaceChanged(holder: SurfaceHolder, format: Int, width: Int, height: Int) {
            super.onSurfaceChanged(holder, format, width, height)
            this.width = width
            this.height = height
            textPaint.textSize = width / 22f
            draw()
        }

        override fun onSurfaceDestroyed(holder: SurfaceHolder) {
            visible = false
            main.removeCallbacksAndMessages(null)
            super.onSurfaceDestroyed(holder)
        }

        override fun onDestroy() {
            main.removeCallbacksAndMessages(null)
            workerThread.quitSafely()
            super.onDestroy()
        }

        /** 身分換了或第一次：重抓清單，從記下來的那一張開始 */
        private fun reload(s: String?) {
            session = s
            main.removeCallbacks(advance)
            if (s == null) {
                items = null; current = null; next = null
                message = "打開 App 登入後\n這裡會播放本次精選"
                draw()
                return
            }
            if (loading) return
            loading = true
            val ctx = applicationContext
            worker.post {
                val list = runCatching { FeaturedWidget.list(ctx, s) }.getOrNull()
                val i = if (list.isNullOrEmpty()) 0 else position(list)
                val bmp = list?.getOrNull(i)?.let { FeaturedWidget.load(ctx, it.optString("src"), 0) }
                main.post {
                    loading = false
                    when {
                        // 讀不到（沒網路、票過期）：手上那張留著，下次亮起來再試
                        list == null -> if (current == null) message = "暫時讀不到精選"
                        list.isEmpty() -> { items = list; current = null; message = "目前沒有精選" }
                        else -> {
                            items = list; index = i; curId = list[i].optLong("id")
                            current = bmp ?: current; message = null
                        }
                    }
                    if (list == null) items = null
                    draw()
                    scheduleAdvance()
                }
            }
        }

        private fun scheduleAdvance() {
            main.removeCallbacks(advance)
            val n = items?.size ?: 0
            if (visible && n > 1) main.postDelayed(advance, HOLD_MS)
        }

        /** 背景載下一張，載好了才開始淡入 —— 載不到就跳過那一張 */
        private fun startNext() {
            val list = items ?: return
            if (!visible || list.size < 2) return
            val ctx = applicationContext
            val s = session ?: return
            val target = (index + 1) % list.size
            worker.post {
                // 每一張都問一次清單（快取 3 小時，沒過期就不會打網路）。清單換了（精選增減、
                // 隨機重排）就照「現在這張的 id」在新清單裡找位置，不然同一個 index 指到別張 —— 會跳
                val fresh = runCatching { FeaturedWidget.list(ctx, s) }.getOrNull()?.takeIf { it.isNotEmpty() }
                val use = fresh ?: list
                val t = if (fresh == null) target else (position(fresh) + 1) % fresh.size
                val src = use.getOrNull(t)
                val bmp = src?.let { FeaturedWidget.load(ctx, it.optString("src"), 0) }
                main.post {
                    items = use
                    index = t
                    curId = src?.optLong("id") ?: -1L
                    slotKey()?.let { k ->
                        prefs(ctx).edit().putInt(KEY_INDEX + k, index).putLong(KEY_CUR_ID + k, curId).apply()
                    }
                    if (!visible) return@post
                    if (bmp == null) { scheduleAdvance(); return@post }
                    next = bmp
                    fadeStart = SystemClock.uptimeMillis()
                    draw()
                }
            }
        }

        /**
         * 這個引擎存檔用的 key 尾巴：主畫面、鎖定畫面各一格（Android 14 起才分得出來，
         * 之前只有一個引擎）。預覽畫面回 null —— 它不該動到正式那一份的位置。
         */
        private fun slotKey(): String? {
            if (isPreview) return null
            if (android.os.Build.VERSION.SDK_INT < 34) return ""
            val f = wallpaperFlags
            val lock = f and WallpaperManager.FLAG_LOCK != 0
            val home = f and WallpaperManager.FLAG_SYSTEM != 0
            return when {
                lock && !home -> ":lock"
                home && !lock -> ":home"
                else -> ""
            }
        }

        /** 這一張在這份清單裡的位置：先看引擎自己手上那張，剛建起來的引擎才回頭看存檔 */
        private fun position(list: List<JSONObject>): Int {
            val p = prefs(applicationContext)
            val k = slotKey()
            val id = if (curId >= 0) curId else if (k != null) p.getLong(KEY_CUR_ID + k, -1L) else -1L
            val i = list.indexOfFirst { it.optLong("id") == id }
            if (i >= 0) return i
            val start = if (curId >= 0) index else if (k != null) p.getInt(KEY_INDEX + k, 0) else 0
            return ((start % list.size) + list.size) % list.size
        }

        private fun draw() {
            if (width == 0 || height == 0) return
            val holder = surfaceHolder
            val canvas = try { holder.lockCanvas() } catch (e: Exception) { null } ?: return
            var fading = false
            var finished = false
            try {
                canvas.drawColor(Color.BLACK)
                val cur = current
                val nxt = next
                if (nxt != null) {
                    val t = ((SystemClock.uptimeMillis() - fadeStart).toFloat() / FADE_MS).coerceIn(0f, 1f)
                    // 完整顯示時兩張大小不一樣：舊的不淡出的話，它露在新照片外面那一圈會在淡入結束時突然消失
                    val curAlpha = if (FeaturedWidget.fit(applicationContext)) ((1f - t) * 255).toInt() else 255
                    cur?.let { drawCover(canvas, it, curAlpha) }
                    drawCover(canvas, nxt, (t * 255).toInt())
                    if (t >= 1f) { current = nxt; next = null; finished = true } else fading = true
                } else if (cur != null) {
                    drawCover(canvas, cur, 255)
                } else {
                    message?.let { drawMessage(canvas, it) }
                }
            } catch (e: Exception) {
                Log.w(TAG, "畫桌布失敗", e)
            } finally {
                runCatching { holder.unlockCanvasAndPost(canvas) }
            }
            if (!visible) return
            // 淡入剛結束才排下一張（hasCallbacks 要 API 29，minSdk 是 28）
            if (fading) main.postDelayed(frame, FRAME_MS) else if (finished) scheduleAdvance()
        }

        /**
         * 預設置中裁切填滿整個畫面；小工具設定選了「完整顯示」（`FeaturedWidget.fit`）時
         * 整張照片縮進畫面、置中，旁邊留黑。
         */
        private fun drawCover(canvas: Canvas, bmp: Bitmap, alpha: Int) {
            paint.alpha = alpha
            if (FeaturedWidget.fit(applicationContext)) {
                val scale = min(width.toFloat() / bmp.width, height.toFloat() / bmp.height)
                val dw = (bmp.width * scale).toInt()
                val dh = (bmp.height * scale).toInt()
                val dx = (width - dw) / 2
                val dy = (height - dh) / 2
                canvas.drawBitmap(bmp, null, Rect(dx, dy, dx + dw, dy + dh), paint)
                return
            }
            val scale = max(width.toFloat() / bmp.width, height.toFloat() / bmp.height)
            val sw = (width / scale).toInt()
            val sh = (height / scale).toInt()
            val sx = (bmp.width - sw) / 2
            val sy = (bmp.height - sh) / 2
            paint.alpha = alpha
            canvas.drawBitmap(bmp, Rect(sx, sy, sx + sw, sy + sh), Rect(0, 0, width, height), paint)
        }

        private fun drawMessage(canvas: Canvas, text: String) {
            val lines = text.split('\n')
            val lh = textPaint.textSize * 1.5f
            var y = height / 2f - lh * (lines.size - 1) / 2f
            for (line in lines) { canvas.drawText(line, width / 2f, y, textPaint); y += lh }
        }
    }

    companion object {
        private const val TAG = "FeaturedWallpaper"
        /** 後面接 `slotKey()`（""／":home"／":lock"）—— 每個引擎各一格 */
        private const val KEY_INDEX = "wallpaper_index"
        /** 現在畫面上那張的 id —— 位置照它找，index 只是找不到時的退路 */
        private const val KEY_CUR_ID = "wallpaper_cur_id"

        /** 換播放順序時把每個引擎存下來的位置都清掉（正在跑的引擎從手上那張接著播新順序） */
        fun resetPositions(ctx: Context) {
            val p = prefs(ctx)
            val e = p.edit()
            for (k in p.all.keys) if (k.startsWith(KEY_INDEX) || k.startsWith(KEY_CUR_ID)) e.remove(k)
            e.apply()
        }
        private const val HOLD_MS = 6_000L
        private const val FADE_MS = 1_200L
        private const val FRAME_MS = 33L

        private fun prefs(ctx: Context) = ctx.getSharedPreferences("app", Context.MODE_PRIVATE)

        /** 開系統的「設定動態桌布」畫面，直接停在這一張上（預覽 → 套用到主畫面／鎖定畫面） */
        fun open(ctx: Context) {
            val direct = Intent(WallpaperManager.ACTION_CHANGE_LIVE_WALLPAPER)
                .putExtra(WallpaperManager.EXTRA_LIVE_WALLPAPER_COMPONENT, ComponentName(ctx, FeaturedWallpaper::class.java))
            try {
                ctx.startActivity(direct)
            } catch (e: Exception) {
                // 有些桌面沒有那個畫面：退回動態桌布清單，讓他自己挑「本次精選」
                try {
                    ctx.startActivity(Intent(WallpaperManager.ACTION_LIVE_WALLPAPER_CHOOSER))
                } catch (e2: Exception) {
                    Toast.makeText(ctx, "這支手機打不開動態桌布設定", Toast.LENGTH_LONG).show()
                }
            }
        }
    }
}
