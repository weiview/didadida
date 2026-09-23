package tw.didadida.app

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.util.Log
import android.view.View
import android.widget.RemoteViews
import okhttp3.Request
import org.json.JSONArray
import org.json.JSONObject
import tw.didadida.app.push.Push
import tw.didadida.app.upload.Net
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread

/**
 * 桌面小工具：輪播「★ 本次精選」（`GET /api/featured`），點一張開那張照片。
 *
 *  - 系統每 30 分鐘叫一次（`updatePeriodMillis` 的下限就是 30 分鐘），**每叫一次換下一張**。
 *    點小工具右上角那顆 ⟳ 也換下一張（`ACTION_NEXT`）。
 *  - 清單在 prefs 裡快取 `LIST_TTL_MS`（3 小時）—— 精選幾天才動一次，換一張不需要
 *    每次都問一次 API；換的只有「抓哪一顆縮圖」。
 *  - 圖用的是 800px 那顆（`thumb_url`）：縮圖那條路由（photos/view）在進站閘門白名單上，不必帶票。
 *
 * ⚠️ 票（`admin_token`）是網頁交給 `Push.setSession` 的同一張 —— 沒登入過 App、或登出了，
 *    小工具就只寫「打開 App 登入後顯示精選」。
 * ⚠️ **不開放的照片一律跳過**：桌面是任何人都看得到的地方，那正是 `restricted_blur`
 *    想防的「旁邊剛好有人」。
 * ⚠️ 網路在 `goAsync()` 的背景執行緒上跑（onReceive 在主執行緒，而且只有 10 秒可用），
 *    所以另外一個逾時很短的 client —— 共用那個的讀取逾時是 5 分鐘（給 Drive 分塊用的）。
 */
class FeaturedWidget : AppWidgetProvider() {

    override fun onUpdate(ctx: Context, mgr: AppWidgetManager, ids: IntArray) {
        refreshAsync(ctx, advance = true)
    }

    override fun onReceive(ctx: Context, intent: Intent) {
        if (intent.action == ACTION_NEXT) { refreshAsync(ctx, advance = true); return }
        super.onReceive(ctx, intent)
    }

    private fun refreshAsync(ctx: Context, advance: Boolean) {
        val pending = goAsync()
        thread(name = "featured-widget") {
            try { render(ctx.applicationContext, advance) }
            catch (e: Exception) { Log.w(TAG, "小工具更新失敗", e) }
            finally { pending.finish() }
        }
    }

    companion object {
        private const val TAG = "FeaturedWidget"
        private const val ACTION_NEXT = "tw.didadida.app.FEATURED_NEXT"
        private const val KEY_LIST = "widget_featured"
        private const val KEY_LIST_AT = "widget_featured_at"
        private const val KEY_LIST_SESSION = "widget_featured_session"
        private const val KEY_INDEX = "widget_featured_index"
        private const val LIST_TTL_MS = 3L * 3600 * 1000
        private const val MAX_PX = 720   // RemoteViews 的點陣圖有大小上限，也沒有必要比小工具本身大

        private val http by lazy {
            Net.client.newBuilder()
                .connectTimeout(4, TimeUnit.SECONDS)
                .readTimeout(4, TimeUnit.SECONDS)
                .build()
        }

        /** 登入身分換了（`Push.setSession`／`clearSession`）時叫：清單作廢、當場重畫 */
        fun refresh(ctx: Context) {
            val app = ctx.applicationContext
            if (ids(app).isEmpty()) return
            thread(name = "featured-widget") {
                runCatching { render(app, advance = false) }.onFailure { Log.w(TAG, "小工具更新失敗", it) }
            }
        }

        private fun ids(ctx: Context): IntArray =
            AppWidgetManager.getInstance(ctx).getAppWidgetIds(ComponentName(ctx, FeaturedWidget::class.java))

        private fun prefs(ctx: Context) = ctx.getSharedPreferences("app", Context.MODE_PRIVATE)

        private fun render(ctx: Context, advance: Boolean) {
            val ids = ids(ctx)
            if (ids.isEmpty()) return
            val mgr = AppWidgetManager.getInstance(ctx)
            val session = Push.session(ctx)
            if (session == null) {
                mgr.updateAppWidget(ids, message(ctx, "打開 App 登入後\n這裡會輪播本次精選"))
                return
            }
            val items = list(ctx, session)
            if (items == null) {
                // 讀不到（沒網路、票過期）：畫面上那一張留著，不要換成錯誤訊息
                return
            }
            if (items.isEmpty()) {
                mgr.updateAppWidget(ids, message(ctx, "目前沒有精選"))
                return
            }
            val p = prefs(ctx)
            var index = p.getInt(KEY_INDEX, 0) + if (advance) 1 else 0
            index = ((index % items.size) + items.size) % items.size
            p.edit().putInt(KEY_INDEX, index).apply()

            val item = items[index]
            val bmp = download(item.optString("src"))
            val views = RemoteViews(ctx.packageName, R.layout.widget_featured)
            if (bmp != null) {
                views.setImageViewBitmap(R.id.widget_image, bmp)
                views.setViewVisibility(R.id.widget_message, View.GONE)
            } else {
                views.setImageViewResource(R.id.widget_image, android.R.color.transparent)
                views.setViewVisibility(R.id.widget_message, View.VISIBLE)
                views.setTextViewText(R.id.widget_message, "圖片載入失敗")
            }
            val caption = item.optString("album_name").ifBlank { item.optString("title") }
            views.setTextViewText(R.id.widget_caption, "★ " + caption + "  ${index + 1}/${items.size}")

            val open = Intent(ctx, MainActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
                .putExtra(MainActivity.EXTRA_OPEN_PATH, "/album?id=${item.optLong("album_id")}&photo=${item.optLong("id")}")
            views.setOnClickPendingIntent(
                R.id.widget_image,
                PendingIntent.getActivity(ctx, 0, open, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE),
            )
            views.setOnClickPendingIntent(
                R.id.widget_next,
                PendingIntent.getBroadcast(
                    ctx, 1,
                    Intent(ctx, FeaturedWidget::class.java).setAction(ACTION_NEXT),
                    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
                ),
            )
            mgr.updateAppWidget(ids, views)
        }

        private fun message(ctx: Context, text: String): RemoteViews {
            val v = RemoteViews(ctx.packageName, R.layout.widget_featured)
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

        /** 快取過的清單（沒過期、而且是同一張票拿的）；否則打一次 API。失敗回 null */
        private fun list(ctx: Context, session: String): List<JSONObject>? {
            val p = prefs(ctx)
            val sig = session.hashCode().toString()
            val cached = p.getString(KEY_LIST, null)
            if (cached != null && p.getString(KEY_LIST_SESSION, null) == sig &&
                System.currentTimeMillis() - p.getLong(KEY_LIST_AT, 0) < LIST_TTL_MS
            ) return parse(JSONArray(cached))

            val arr = try {
                val req = Request.Builder().url(Config.API + "/featured")
                    .header("Authorization", "Bearer $session").build()
                http.newCall(req).execute().use { res ->
                    if (!res.isSuccessful) return if (cached != null && p.getString(KEY_LIST_SESSION, null) == sig) parse(JSONArray(cached)) else null
                    JSONObject(res.body?.string() ?: return null).optJSONArray("items") ?: JSONArray()
                }
            } catch (e: Exception) {
                Log.w(TAG, "讀精選失敗", e)
                return if (cached != null && p.getString(KEY_LIST_SESSION, null) == sig) parse(JSONArray(cached)) else null
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
            return parse(slim)
        }

        private fun parse(arr: JSONArray): List<JSONObject> =
            (0 until arr.length()).mapNotNull { arr.optJSONObject(it) }

        private fun download(url: String): Bitmap? {
            if (!url.startsWith("https://")) return null
            return try {
                http.newCall(Request.Builder().url(url).build()).execute().use { res ->
                    if (!res.isSuccessful) return null
                    val bytes = res.body?.bytes() ?: return null
                    val bmp = BitmapFactory.decodeByteArray(bytes, 0, bytes.size) ?: return null
                    val scale = MAX_PX.toFloat() / maxOf(bmp.width, bmp.height)
                    if (scale >= 1f) bmp
                    else Bitmap.createScaledBitmap(bmp, (bmp.width * scale).toInt(), (bmp.height * scale).toInt(), true)
                }
            } catch (e: Exception) {
                Log.w(TAG, "下載縮圖失敗", e)
                null
            }
        }
    }
}
