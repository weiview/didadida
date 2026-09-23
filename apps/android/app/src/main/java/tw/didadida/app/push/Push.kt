package tw.didadida.app.push

import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.util.Log
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.google.firebase.messaging.FirebaseMessaging
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import tw.didadida.app.BuildConfig
import tw.didadida.app.Config
import tw.didadida.app.FeaturedWidget
import tw.didadida.app.R
import tw.didadida.app.upload.Net
import kotlin.concurrent.thread

/**
 * 推播（FCM）這一頭：初始化、把這支手機的 token 登記到站上、登出時收回來。
 *
 * **站上的進站票（`admin_token`）由網頁交給我們**（`window.DidadidaApp.setSession`，
 * 見前端 `lib/nativeApp.ts`）—— 登記 token 要帶著「我是誰」，而那張票只活在
 * WebView 的 localStorage 裡。桌面小工具（`FeaturedWidget`）也吃同一張。
 *
 * ⚠️ 登記有節流：`setSession` 每次開頁都會被叫，而同一支手機、同一個人、同一個
 *    FCM token 一天登記一次就夠了（後端那一列的 `updated_at` 本來也就一天才刷一次）。
 *    換人登入（票換了）或 FCM 換了 token 時才立刻再登記。
 * ⚠️ `BuildConfig.FCM_APP_ID` 是空的（沒有 firebase.properties）時整組什麼都不做 ——
 *    App 照常運作，只是沒有推播。
 */
object Push {
    private const val TAG = "Push"
    private const val PREFS = "app"
    const val KEY_SESSION = "session_token"
    private const val KEY_REG = "push_registered"      // "<fcm token>|<票的 hash>"
    private const val KEY_REG_AT = "push_registered_at"
    private const val REREGISTER_MS = 24L * 3600 * 1000

    fun enabled(): Boolean = BuildConfig.FCM_APP_ID.isNotEmpty()

    fun init(ctx: Context) {
        ensureChannels(ctx)
        if (!enabled() || FirebaseApp.getApps(ctx).isNotEmpty()) return
        runCatching {
            FirebaseApp.initializeApp(
                ctx,
                FirebaseOptions.Builder()
                    .setApiKey(BuildConfig.FCM_API_KEY)
                    .setApplicationId(BuildConfig.FCM_APP_ID)
                    .setProjectId(BuildConfig.FCM_PROJECT_ID)
                    .setGcmSenderId(BuildConfig.FCM_SENDER_ID)
                    .build(),
            )
        }.onFailure { Log.e(TAG, "Firebase 初始化失敗", it) }
    }

    fun ensureChannels(ctx: Context) {
        val nm = ctx.getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(
            NotificationChannel(Config.CHANNEL_PUSH_ONLINE, ctx.getString(R.string.channel_push_online), NotificationManager.IMPORTANCE_DEFAULT),
        )
        nm.createNotificationChannel(
            NotificationChannel(Config.CHANNEL_PUSH_UPLOAD, ctx.getString(R.string.channel_push_upload), NotificationManager.IMPORTANCE_DEFAULT),
        )
    }

    private fun prefs(ctx: Context) = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun session(ctx: Context): String? = prefs(ctx).getString(KEY_SESSION, null)?.takeIf { it.isNotBlank() }

    /** 網頁確定「有人登入了」時叫（每次開頁都會叫，節流在 `register` 裡） */
    fun setSession(ctx: Context, token: String) {
        val app = ctx.applicationContext
        if (token.isBlank()) return
        val changed = session(app) != token
        prefs(app).edit().putString(KEY_SESSION, token).apply()
        refreshToken(app)
        if (changed) FeaturedWidget.refresh(app)
    }

    /** 登出：先用舊票把這支手機從站上撤掉（不然前一個人的通知會繼續跳），再清掉 */
    fun clearSession(ctx: Context) {
        val app = ctx.applicationContext
        val old = session(app)
        val fcm = prefs(app).getString(KEY_REG, null)?.substringBefore('|')
        prefs(app).edit().remove(KEY_SESSION).remove(KEY_REG).remove(KEY_REG_AT).apply()
        FeaturedWidget.refresh(app)
        if (old == null || fcm.isNullOrEmpty()) return
        thread(name = "push-unregister") { call(old, "DELETE", fcm) }
    }

    /** 問 Firebase 現在的 token 再登記（節流過） */
    private fun refreshToken(app: Context) {
        if (!enabled() || FirebaseApp.getApps(app).isEmpty()) return
        runCatching {
            FirebaseMessaging.getInstance().token
                .addOnSuccessListener { t -> if (!t.isNullOrEmpty()) register(app, t, force = false) }
                .addOnFailureListener { Log.w(TAG, "拿不到 FCM token", it) }
        }
    }

    /** FCM 換 token（`onNewToken`）或 `refreshToken` 拿到值時叫 */
    fun register(ctx: Context, fcmToken: String, force: Boolean) {
        val app = ctx.applicationContext
        val session = session(app) ?: return   // 還沒人登入：等 setSession 再說
        val sig = fcmToken + "|" + session.hashCode()
        val p = prefs(app)
        val fresh = p.getString(KEY_REG, null) == sig &&
            System.currentTimeMillis() - p.getLong(KEY_REG_AT, 0) < REREGISTER_MS
        if (fresh && !force) return
        thread(name = "push-register") {
            when (call(session, "POST", fcmToken)) {
                200 -> p.edit().putString(KEY_REG, sig).putLong(KEY_REG_AT, System.currentTimeMillis()).apply()
                // 票過期了：留著只會每次開頁白打一次。等網頁下一次 setSession 給新的
                401 -> p.edit().remove(KEY_SESSION).apply()
            }
        }
    }

    /** 回 HTTP 狀態碼，網路錯誤回 0 */
    private fun call(session: String, method: String, fcmToken: String): Int = try {
        val body = JSONObject().put("token", fcmToken).toString()
            .toRequestBody("application/json".toMediaType())
        val req = Request.Builder()
            .url(Config.API + "/push/register")
            .header("Authorization", "Bearer $session")
            .method(method, body)
            .build()
        Net.client.newCall(req).execute().use { it.code }
    } catch (e: Exception) {
        Log.w(TAG, "push/register $method 失敗", e)
        0
    }
}
