package tw.didadida.app

import android.app.AlarmManager
import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.res.Configuration
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.BlurMaskFilter
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.PorterDuff
import android.graphics.PorterDuffXfermode
import android.graphics.Rect
import android.graphics.RectF
import android.os.Build
import android.os.Bundle
import android.util.Log
import android.view.View
import android.widget.RemoteViews
import okhttp3.Request
import org.json.JSONArray
import org.json.JSONObject
import tw.didadida.app.push.Push
import tw.didadida.app.upload.Net
import java.io.File
import java.security.MessageDigest
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread
import kotlin.math.max
import kotlin.math.min

/**
 * 桌面小工具：輪播「★ 本次精選」（`GET /api/featured`），點一張開那張照片。
 *
 * 兩種換圖方式（prefs `widget_interval`，`WidgetConfigActivity` 調）：
 *  - **1／5／10／15 分鐘**：AlarmManager 定時叫 `ACTION_TICK` 換下一張。
 *    `updatePeriodMillis` 的下限是 30 分鐘，比它短只能自己排鬧鐘。鬧鐘是**不喚醒**的
 *    （`RTC`）—— 螢幕關著沒人看，不必為了換圖把手機叫醒。
 *  - **連續漸變（0）**：一次把幾張（最多 `FLIP_MAX`）塞進 ViewFlipper，由桌面那一端
 *    自己計時、淡入淡出，App 不必醒著。系統每 30 分鐘叫一次 `onUpdate` 換下一批。
 *    ⚠️ RemoteViews 的點陣圖總量有上限（約螢幕像素 × 4 × 1.5），所以張數照小工具的
 *    尺寸算（`flipCount`），塞不下兩張就退回一次一張。
 *
 * 外觀：照片**置中裁切滿版**，圓角、柔邊、背景、照片透明度全部**烤進那張點陣圖**
 * （`compose`）—— RemoteViews 沒辦法替 ImageView 加圓角或模糊邊。所以每一個小工具
 * 照**它自己的尺寸**各畫一份（`getAppWidgetOptions`），使用者拉大拉小時
 * （`onAppWidgetOptionsChanged`）重畫一次。
 *
 *  - 清單在 prefs 裡快取 `LIST_TTL_MS`（3 小時）—— 精選幾天才動一次。
 *  - 縮圖抓的是 800px 那顆（`thumb_url`，縮圖路由在進站閘門白名單上，不必帶票），
 *    **存一份在 `cacheDir/widget_thumbs/`**：一分鐘換一張的話不快取就是一分鐘下載一次。
 *    清單從網路重抓時，順手刪掉已經不在清單上的那幾顆。
 *
 * ⚠️ 票（`admin_token`）是網頁交給 `Push.setSession` 的同一張 —— 沒登入過 App、或登出了，
 *    小工具就只寫「打開 App 登入後顯示精選」。
 * ⚠️ **不開放的照片一律跳過**：桌面是任何人都看得到的地方。
 * ⚠️ 網路在 `goAsync()` 的背景執行緒上跑（onReceive 在主執行緒，而且只有 10 秒可用），
 *    所以另外一個逾時很短的 client —— 共用那個的讀取逾時是 5 分鐘（給 Drive 分塊用的）。
 */
class FeaturedWidget : AppWidgetProvider() {

    override fun onUpdate(ctx: Context, mgr: AppWidgetManager, ids: IntArray) {
        // 定時模式下換圖是鬧鐘的事，這裡只補畫（開機、剛放上桌面）並確認鬧鐘還在
        refreshAsync(ctx, advance = interval(ctx) == 0, reschedule = false)
    }

    override fun onAppWidgetOptionsChanged(ctx: Context, mgr: AppWidgetManager, id: Int, options: Bundle) {
        // 使用者拉了尺寸：照新的大小重畫，換圖的倒數不動
        refreshAsync(ctx, advance = false, reschedule = false)
    }

    override fun onDisabled(ctx: Context) {
        cancelAlarm(ctx)
        prefs(ctx).edit().putBoolean(KEY_FLIPPING, false).apply()
    }

    override fun onReceive(ctx: Context, intent: Intent) {
        when (intent.action) {
            ACTION_NEXT -> {
                if (prefs(ctx).getBoolean(KEY_FLIPPING, false)) {
                    // 連續漸變：那一批已經在桌面上了，翻下一頁就好，不重畫
                    val v = RemoteViews(ctx.packageName, R.layout.widget_featured_flip)
                    v.showNext(R.id.widget_flipper)
                    runCatching { AppWidgetManager.getInstance(ctx).partiallyUpdateAppWidget(ids(ctx), v) }
                } else {
                    refreshAsync(ctx, advance = true, reschedule = true)
                }
                return
            }
            ACTION_TICK -> { refreshAsync(ctx, advance = true, reschedule = true); return }
        }
        super.onReceive(ctx, intent)
    }

    private fun refreshAsync(ctx: Context, advance: Boolean, reschedule: Boolean) {
        val pending = goAsync()
        thread(name = "featured-widget") {
            try { render(ctx.applicationContext, advance, reschedule) }
            catch (e: Exception) { Log.w(TAG, "小工具更新失敗", e) }
            finally { pending.finish() }
        }
    }

    /** 烤進點陣圖的外觀，一次讀齊 */
    private class Look(val bgAlpha: Int, val imgAlpha: Int, val corner: Int, val feather: Int)

    companion object {
        private const val TAG = "FeaturedWidget"
        private const val ACTION_NEXT = "tw.didadida.app.FEATURED_NEXT"
        private const val ACTION_TICK = "tw.didadida.app.FEATURED_TICK"
        private const val KEY_LIST = "widget_featured"
        private const val KEY_LIST_AT = "widget_featured_at"
        private const val KEY_LIST_SESSION = "widget_featured_session"
        private const val KEY_INDEX = "widget_featured_index"
        private const val KEY_FLIPPING = "widget_flipping"
        private const val KEY_FLIP_N = "widget_flip_n"
        private const val KEY_INTERVAL = "widget_interval"
        private const val KEY_BG_ALPHA = "widget_bg_alpha"
        private const val KEY_IMG_ALPHA = "widget_img_alpha"
        private const val KEY_CORNER = "widget_corner"
        private const val KEY_FEATHER = "widget_feather"
        private const val LIST_TTL_MS = 3L * 3600 * 1000
        private const val STATIC_MAX_PX = 720   // 一次一張：長邊上限
        private const val FLIP_MAX_PX = 480     // 連續漸變一次好幾張，每張小一點才塞得下
        private const val FLIP_MAX = 6
        private const val RC_TICK = 2
        private const val RC_PAGE = 100

        /** 設定頁的選項（分鐘，0＝連續漸變） */
        val INTERVALS = intArrayOf(0, 1, 5, 10, 15)

        private val lock = Any()

        private val http by lazy {
            Net.client.newBuilder()
                .connectTimeout(4, TimeUnit.SECONDS)
                .readTimeout(4, TimeUnit.SECONDS)
                .build()
        }

        /** 登入身分換了、設定改了時叫：照現在的設定重畫，定時模式從現在起重新倒數 */
        fun refresh(ctx: Context) {
            val app = ctx.applicationContext
            if (ids(app).isEmpty()) return
            thread(name = "featured-widget") {
                runCatching { render(app, advance = false, reschedule = true) }
                    .onFailure { Log.w(TAG, "小工具更新失敗", it) }
            }
        }

        fun interval(ctx: Context) = prefs(ctx).getInt(KEY_INTERVAL, 5).takeIf { it in INTERVALS } ?: 5
        fun backgroundAlpha(ctx: Context) = prefs(ctx).getInt(KEY_BG_ALPHA, 0).coerceIn(0, 255)
        fun imageAlpha(ctx: Context) = prefs(ctx).getInt(KEY_IMG_ALPHA, 255).coerceIn(0, 255)
        fun corner(ctx: Context) = prefs(ctx).getInt(KEY_CORNER, 30).coerceIn(0, 100)
        fun feather(ctx: Context) = prefs(ctx).getInt(KEY_FEATHER, 40).coerceIn(0, 100)

        fun setInterval(ctx: Context, minutes: Int) = put(ctx, KEY_INTERVAL, minutes)
        fun setBackgroundAlpha(ctx: Context, alpha: Int) = put(ctx, KEY_BG_ALPHA, alpha.coerceIn(0, 255))
        fun setImageAlpha(ctx: Context, alpha: Int) = put(ctx, KEY_IMG_ALPHA, alpha.coerceIn(0, 255))
        fun setCorner(ctx: Context, pct: Int) = put(ctx, KEY_CORNER, pct.coerceIn(0, 100))
        fun setFeather(ctx: Context, pct: Int) = put(ctx, KEY_FEATHER, pct.coerceIn(0, 100))

        private fun put(ctx: Context, key: String, v: Int) = prefs(ctx).edit().putInt(key, v).apply()

        private fun ids(ctx: Context): IntArray =
            AppWidgetManager.getInstance(ctx).getAppWidgetIds(ComponentName(ctx, FeaturedWidget::class.java))

        private fun prefs(ctx: Context) = ctx.getSharedPreferences("app", Context.MODE_PRIVATE)

        private fun look(ctx: Context) = Look(backgroundAlpha(ctx), imageAlpha(ctx), corner(ctx), feather(ctx))

        // ── 鬧鐘 ────────────────────────────────────────────────

        private fun tickIntent(ctx: Context, flags: Int): PendingIntent? = PendingIntent.getBroadcast(
            ctx, RC_TICK,
            Intent(ctx, FeaturedWidget::class.java).setAction(ACTION_TICK),
            PendingIntent.FLAG_IMMUTABLE or flags,
        )

        private fun cancelAlarm(ctx: Context) {
            val pi = tickIntent(ctx, PendingIntent.FLAG_NO_CREATE) ?: return
            ctx.getSystemService(AlarmManager::class.java)?.cancel(pi)
            pi.cancel()
        }

        /**
         * 排下一次換圖。`force` 為 false 時已經排著的就不動（onUpdate、改尺寸不該重設倒數）。
         * 能排精確的就排精確的 —— 不精確的鬧鐘在 Android 上可以晚好幾分鐘，
         * 「一分鐘換一張」就名不副實了。
         */
        private fun schedule(ctx: Context, minutes: Int, force: Boolean) {
            if (!force && tickIntent(ctx, PendingIntent.FLAG_NO_CREATE) != null) return
            val am = ctx.getSystemService(AlarmManager::class.java) ?: return
            val pi = tickIntent(ctx, PendingIntent.FLAG_UPDATE_CURRENT) ?: return
            val at = System.currentTimeMillis() + minutes * 60_000L
            val exact = Build.VERSION.SDK_INT < Build.VERSION_CODES.S || am.canScheduleExactAlarms()
            try {
                if (exact) am.setExact(AlarmManager.RTC, at, pi)
                else am.setAndAllowWhileIdle(AlarmManager.RTC, at, pi)
            } catch (e: SecurityException) {
                am.setAndAllowWhileIdle(AlarmManager.RTC, at, pi)
            }
        }

        // ── 畫 ──────────────────────────────────────────────────

        private fun render(ctx: Context, advance: Boolean, reschedule: Boolean) = synchronized(lock) {
            val ids = ids(ctx)
            if (ids.isEmpty()) { cancelAlarm(ctx); return@synchronized }
            val mgr = AppWidgetManager.getInstance(ctx)
            val p = prefs(ctx)
            val minutes = interval(ctx)
            val session = Push.session(ctx)
            if (session == null) {
                cancelAlarm(ctx)
                p.edit().putBoolean(KEY_FLIPPING, false).apply()
                mgr.updateAppWidget(ids, message(ctx, "打開 App 登入後\n這裡會輪播本次精選"))
                return@synchronized
            }
            if (minutes > 0) schedule(ctx, minutes, reschedule) else cancelAlarm(ctx)

            // 讀不到（沒網路、票過期）：畫面上那一張留著，不要換成錯誤訊息
            val items = list(ctx, session) ?: return@synchronized
            if (items.isEmpty()) {
                p.edit().putBoolean(KEY_FLIPPING, false).apply()
                mgr.updateAppWidget(ids, message(ctx, "目前沒有精選"))
                return@synchronized
            }

            val wasFlipping = p.getBoolean(KEY_FLIPPING, false)
            val step = if (minutes == 0 && wasFlipping) p.getInt(KEY_FLIP_N, 1).coerceAtLeast(1) else 1
            var index = p.getInt(KEY_INDEX, 0) + if (advance) step else 0
            index = ((index % items.size) + items.size) % items.size

            val look = look(ctx)
            val bitmaps = HashMap<String, Bitmap?>()
            fun photo(i: Int): Bitmap? {
                val src = items[i].optString("src")
                return bitmaps.getOrPut(src) { load(ctx, src) }
            }

            var flipping = false
            var flipN = 1
            for (id in ids) {
                val views = if (minutes == 0 && items.size > 1) {
                    val (w, h) = sizePx(ctx, mgr, id, FLIP_MAX_PX)
                    val n = flipCount(ctx, w, h, items.size)
                    if (n >= 2) {
                        flipping = true; flipN = n
                        flipViews(ctx, items, index, n, w, h, look, ::photo)
                    } else null
                } else null
                mgr.updateAppWidget(id, views ?: run {
                    val (w, h) = sizePx(ctx, mgr, id, STATIC_MAX_PX)
                    staticViews(ctx, items, index, w, h, look, photo(index))
                })
            }
            p.edit().putInt(KEY_INDEX, index).putBoolean(KEY_FLIPPING, flipping).putInt(KEY_FLIP_N, flipN).apply()
        }

        private fun staticViews(
            ctx: Context, items: List<JSONObject>, index: Int, w: Int, h: Int, look: Look, src: Bitmap?,
        ): RemoteViews {
            val views = RemoteViews(ctx.packageName, R.layout.widget_featured)
            val item = items[index]
            if (src != null) {
                views.setImageViewBitmap(R.id.widget_image, compose(src, w, h, look))
                views.setViewVisibility(R.id.widget_bg, View.GONE)
                views.setViewVisibility(R.id.widget_message, View.GONE)
            } else {
                views.setImageViewResource(R.id.widget_image, android.R.color.transparent)
                views.setViewVisibility(R.id.widget_bg, View.VISIBLE)
                views.setViewVisibility(R.id.widget_message, View.VISIBLE)
                views.setTextViewText(R.id.widget_message, "圖片載入失敗")
            }
            views.setTextViewText(R.id.widget_caption, caption(item, index, items.size))
            views.setOnClickPendingIntent(R.id.widget_image, openIntent(ctx, item, 0))
            views.setOnClickPendingIntent(R.id.widget_next, nextIntent(ctx))
            return views
        }

        private fun flipViews(
            ctx: Context, items: List<JSONObject>, start: Int, n: Int, w: Int, h: Int, look: Look,
            photo: (Int) -> Bitmap?,
        ): RemoteViews {
            val views = RemoteViews(ctx.packageName, R.layout.widget_featured_flip)
            views.removeAllViews(R.id.widget_flipper)
            for (k in 0 until n) {
                val i = (start + k) % items.size
                val item = items[i]
                val page = RemoteViews(ctx.packageName, R.layout.widget_featured_page)
                val src = photo(i)
                if (src != null) page.setImageViewBitmap(R.id.page_image, compose(src, w, h, look))
                else page.setImageViewResource(R.id.page_image, android.R.color.transparent)
                page.setTextViewText(R.id.page_caption, caption(item, i, items.size))
                page.setOnClickPendingIntent(R.id.page_image, openIntent(ctx, item, RC_PAGE + k))
                views.addView(R.id.widget_flipper, page)
            }
            views.setOnClickPendingIntent(R.id.widget_next, nextIntent(ctx))
            return views
        }

        private fun caption(item: JSONObject, i: Int, n: Int): String {
            val name = item.optString("album_name").ifBlank { item.optString("title") }
            return "★ $name  ${i + 1}/$n"
        }

        private fun openIntent(ctx: Context, item: JSONObject, requestCode: Int): PendingIntent {
            val open = Intent(ctx, MainActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
                .putExtra(MainActivity.EXTRA_OPEN_PATH, "/album?id=${item.optLong("album_id")}&photo=${item.optLong("id")}")
            return PendingIntent.getActivity(
                ctx, requestCode, open, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )
        }

        private fun nextIntent(ctx: Context): PendingIntent = PendingIntent.getBroadcast(
            ctx, 1,
            Intent(ctx, FeaturedWidget::class.java).setAction(ACTION_NEXT),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

        private fun message(ctx: Context, text: String): RemoteViews {
            val v = RemoteViews(ctx.packageName, R.layout.widget_featured)
            v.setViewVisibility(R.id.widget_bg, View.VISIBLE)
            v.setImageViewResource(R.id.widget_image, android.R.color.transparent)
            v.setViewVisibility(R.id.widget_message, View.VISIBLE)
            v.setTextViewText(R.id.widget_message, text)
            v.setTextViewText(R.id.widget_caption, "★ 本次精選")
            v.setOnClickPendingIntent(
                R.id.widget_image,
                PendingIntent.getActivity(
                    ctx, 0,
                    Intent(ctx, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
                ),
            )
            return v
        }

        /**
         * 這一個小工具在桌面上實際多大（像素，長邊夾在 `cap`）。
         * 直向時寬取 MIN_WIDTH、高取 MAX_HEIGHT，橫向反過來 —— 這是 Android 文件給的對應。
         */
        private fun sizePx(ctx: Context, mgr: AppWidgetManager, id: Int, cap: Int): Pair<Int, Int> {
            val o = mgr.getAppWidgetOptions(id)
            val portrait = ctx.resources.configuration.orientation != Configuration.ORIENTATION_LANDSCAPE
            var wDp = o.getInt(if (portrait) AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH else AppWidgetManager.OPTION_APPWIDGET_MAX_WIDTH)
            var hDp = o.getInt(if (portrait) AppWidgetManager.OPTION_APPWIDGET_MAX_HEIGHT else AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT)
            if (wDp <= 0 || hDp <= 0) { wDp = 180; hDp = 180 }
            val d = ctx.resources.displayMetrics.density
            var w = wDp * d
            var h = hDp * d
            val s = cap / max(w, h)
            if (s < 1f) { w *= s; h *= s }
            return Pair(max(1, w.toInt()), max(1, h.toInt()))
        }

        /** 連續漸變一次塞幾張：RemoteViews 點陣圖上限（螢幕 × 4 × 1.5）只用六成，留給系統餘裕 */
        private fun flipCount(ctx: Context, w: Int, h: Int, available: Int): Int {
            val dm = ctx.resources.displayMetrics
            val budget = dm.widthPixels.toLong() * dm.heightPixels * 4 * 3 / 2 * 6 / 10
            val each = w.toLong() * h * 4
            return min(min(FLIP_MAX, available).toLong(), budget / each).toInt()
        }

        /**
         * 置中裁切滿版 → 套照片透明度 → 用一張圓角（＋模糊邊）的遮罩挖出形狀 → 底下墊背景。
         * 柔邊＝遮罩先往內縮一點再模糊，讓邊緣從不透明漸漸淡到透明，而不是硬切。
         */
        private fun compose(src: Bitmap, w: Int, h: Int, look: Look): Bitmap {
            val out = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
            val c = Canvas(out)
            val scale = max(w.toFloat() / src.width, h.toFloat() / src.height)
            val sw = (w / scale).toInt().coerceIn(1, src.width)
            val sh = (h / scale).toInt().coerceIn(1, src.height)
            val sx = (src.width - sw) / 2
            val sy = (src.height - sh) / 2
            c.drawBitmap(
                src, Rect(sx, sy, sx + sw, sy + sh), RectF(0f, 0f, w.toFloat(), h.toFloat()),
                Paint(Paint.FILTER_BITMAP_FLAG or Paint.ANTI_ALIAS_FLAG).apply { alpha = look.imgAlpha },
            )

            val short = min(w, h).toFloat()
            val feather = look.feather / 100f * short * 0.08f
            val inset = if (feather >= 1f) feather * 1.3f else 0f
            val rect = RectF(inset, inset, w - inset, h - inset)
            val radius = (look.corner / 100f * short / 2f).coerceAtMost(min(rect.width(), rect.height()) / 2f)
            fun shapePaint() = Paint(Paint.ANTI_ALIAS_FLAG).apply {
                if (feather >= 1f) maskFilter = BlurMaskFilter(feather, BlurMaskFilter.Blur.NORMAL)
            }

            val mask = Bitmap.createBitmap(w, h, Bitmap.Config.ALPHA_8)
            Canvas(mask).drawRoundRect(rect, radius, radius, shapePaint())
            c.drawBitmap(mask, 0f, 0f, Paint().apply { xfermode = PorterDuffXfermode(PorterDuff.Mode.DST_IN) })
            mask.recycle()

            if (look.bgAlpha > 0) {
                c.drawRoundRect(rect, radius, radius, shapePaint().apply {
                    color = (look.bgAlpha shl 24) or 0x222222
                    xfermode = PorterDuffXfermode(PorterDuff.Mode.DST_OVER)
                })
            }
            return out
        }

        // ── 清單與縮圖 ──────────────────────────────────────────

        /** 快取過的清單（沒過期、而且是同一張票拿的）；否則打一次 API。失敗回 null */
        private fun list(ctx: Context, session: String): List<JSONObject>? {
            val p = prefs(ctx)
            val sig = session.hashCode().toString()
            val cached = p.getString(KEY_LIST, null)
            val sameSession = cached != null && p.getString(KEY_LIST_SESSION, null) == sig
            if (sameSession && System.currentTimeMillis() - p.getLong(KEY_LIST_AT, 0) < LIST_TTL_MS) {
                return parse(JSONArray(cached))
            }

            val arr = try {
                val req = Request.Builder().url(Config.API + "/featured")
                    .header("Authorization", "Bearer $session").build()
                http.newCall(req).execute().use { res ->
                    if (!res.isSuccessful) return if (sameSession) parse(JSONArray(cached)) else null
                    JSONObject(res.body?.string() ?: return null).optJSONArray("items") ?: JSONArray()
                }
            } catch (e: Exception) {
                Log.w(TAG, "讀精選失敗", e)
                return if (sameSession) parse(JSONArray(cached)) else null
            }
            // 只留要用的幾欄，並在這裡就把不開放的濾掉、挑好縮圖網址
            val slim = JSONArray()
            for (i in 0 until arr.length()) {
                val o = arr.optJSONObject(i) ?: continue
                if (o.optInt("restricted") == 1) continue
                val src = listOf("thumb_url", "url", "thumb_sm_url")
                    .map { if (o.isNull(it)) "" else o.optString(it) }
                    .firstOrNull { it.startsWith("https://") } ?: continue
                slim.put(
                    JSONObject()
                        .put("id", o.optLong("id"))
                        .put("album_id", o.optLong("album_id"))
                        .put("title", o.optString("title"))
                        .put("album_name", if (o.isNull("album_name")) "" else o.optString("album_name"))
                        .put("src", src),
                )
            }
            p.edit().putString(KEY_LIST, slim.toString()).putLong(KEY_LIST_AT, System.currentTimeMillis())
                .putString(KEY_LIST_SESSION, sig).apply()
            val items = parse(slim)
            pruneThumbs(ctx, items.map { thumbName(it.optString("src")) }.toSet())
            return items
        }

        private fun parse(arr: JSONArray): List<JSONObject> =
            (0 until arr.length()).mapNotNull { arr.optJSONObject(it) }

        private fun thumbDir(ctx: Context) = File(ctx.cacheDir, "widget_thumbs").apply { mkdirs() }

        private fun thumbName(url: String): String =
            MessageDigest.getInstance("SHA-1").digest(url.toByteArray()).joinToString("") { "%02x".format(it) }

        private fun pruneThumbs(ctx: Context, keep: Set<String>) {
            thumbDir(ctx).listFiles()?.forEach { if (it.name !in keep) it.delete() }
        }

        /** 先看磁碟上那一份，沒有才下載（下載完存起來）。解碼時縮到長邊不超過 `STATIC_MAX_PX` 附近 */
        private fun load(ctx: Context, url: String): Bitmap? {
            if (!url.startsWith("https://")) return null
            val file = File(thumbDir(ctx), thumbName(url))
            if (!file.exists() || file.length() == 0L) {
                try {
                    http.newCall(Request.Builder().url(url).build()).execute().use { res ->
                        if (!res.isSuccessful) return null
                        val bytes = res.body?.bytes() ?: return null
                        val tmp = File(file.path + ".tmp")
                        tmp.writeBytes(bytes)
                        tmp.renameTo(file)
                    }
                } catch (e: Exception) {
                    Log.w(TAG, "下載縮圖失敗", e)
                    return null
                }
            }
            return try {
                val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
                BitmapFactory.decodeFile(file.path, bounds)
                var sample = 1
                while (max(bounds.outWidth, bounds.outHeight) / (sample * 2) >= STATIC_MAX_PX) sample *= 2
                BitmapFactory.decodeFile(file.path, BitmapFactory.Options().apply { inSampleSize = sample })
                    ?: run { file.delete(); null }
            } catch (e: Exception) {
                Log.w(TAG, "解碼縮圖失敗", e)
                null
            }
        }
    }
}
