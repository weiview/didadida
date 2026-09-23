package tw.didadida.app

import android.app.Activity
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import androidx.appcompat.app.AlertDialog
import okhttp3.Request
import org.json.JSONObject
import tw.didadida.app.upload.DupStore
import tw.didadida.app.upload.Net
import tw.didadida.app.upload.UploadService
import java.io.File
import java.util.concurrent.atomic.AtomicBoolean

/**
 * APK 自架在 Pages（`<站台>/app/`），沒有 Play 商店，所以自己檢查更新。
 *
 * `version-<flavor>.json` 由 `apps/android/publish-apk.ps1` 產生：
 * `{"versionCode": N, "versionName": "x.y.z", "apk": "didadida-<flavor>.apk"}`。
 * ⚠️ 檔名要帶 flavor：dev 與 prod 兩個 Pages 部署吃的是同一份 `public/`，
 * 只放一份 `version.json` 的話 dev 的 App 會被叫去裝 prod 的 APK（反之亦然）。
 *
 * **Android 12 以上是靜默更新**：發現新版就在背景下載，等使用者**離開 App**（`onStop`）
 * 才用 `PackageInstaller` ＋ `USER_ACTION_NOT_REQUIRED` 裝上去 —— App 自己更新自己，
 * 系統不必再問。裝完由新版的 `UpdatedReceiver` 跳一則「已更新」。
 * Android 11 以下沒有這條路，下載完在前景問一次，交給系統安裝畫面。
 *
 * ⚠️⚠️ **不可以在 App 開著的時候裝**：安裝會把行程整個殺掉，而且**不會自己重開**，
 *    使用者看到的是 App 當場消失。所以只在離開 App 時裝。
 * ⚠️⚠️ **上傳中、或還有重複照片沒問完時不可以裝**（`busy()`）：一樣是殺行程，
 *    那一批會斷在半路。等 `UploadService` 收工時它會再叫一次 `installIfReady()`。
 * ⚠️ 系統有權照樣要求確認（`STATUS_PENDING_USER_ACTION`）—— 那是正常流程不是錯誤，
 *    `InstallReceiver` 在前景就直接端出確認畫面，在背景就改發一則「點這裡安裝」的通知
 *    （Android 14 不准背景啟動 Activity）。
 *
 * 最多 1 小時問一次（`CHECK_EVERY_MS`）；「稍後」只是這一次不裝，下一次檢查還會再問。
 */
object Updater {
    private const val CHECK_EVERY_MS = 60 * 60 * 1000L
    private val running = AtomicBoolean(false)
    private val installing = AtomicBoolean(false)
    private val main = Handler(Looper.getMainLooper())

    private fun prefs(ctx: Context) = ctx.getSharedPreferences("updater", Context.MODE_PRIVATE)

    /** 這一台能不能不問就裝（Android 12+ 且已允許安裝未知的應用程式） */
    private fun silentCapable(ctx: Context) =
        Build.VERSION.SDK_INT >= 31 && ctx.packageManager.canRequestPackageInstalls()

    private fun busy() = UploadService.running || DupStore.sessions.isNotEmpty()

    private fun apkDir(ctx: Context): File =
        ctx.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS) ?: ctx.cacheDir

    /** 已經下載好、比手上新的那一份（沒有就 null） */
    private fun readyApk(ctx: Context): Pair<File, Int>? {
        val code = prefs(ctx).getInt("ready", 0)
        if (code <= BuildConfig.VERSION_CODE) return null
        val f = File(apkDir(ctx), "didadida-$code.apk")
        return if (f.isFile) f to code else null
    }

    fun check(activity: Activity, force: Boolean = false) {
        val app = activity.applicationContext
        val p = prefs(app)
        val now = System.currentTimeMillis()
        // 手上已經有下載好的新版：舊系統在這裡問一次；新系統等離開 App 時自己裝
        readyApk(app)?.let { (file, code) ->
            if (!silentCapable(app)) promptInstall(activity, file, code, p.getString("readyName", "").orEmpty())
            return
        }
        if (!force && now - p.getLong("last", 0) < CHECK_EVERY_MS) return
        if (!running.compareAndSet(false, true)) return
        Thread {
            try {
                val url = "${Config.SITE}/app/version-${BuildConfig.FLAVOR}.json?cb=$now"
                val json = Net.client.newCall(Request.Builder().url(url).build()).execute().use { res ->
                    if (!res.isSuccessful) null else res.body?.string()?.let { JSONObject(it) }
                } ?: return@Thread
                p.edit().putLong("last", now).apply()
                val code = json.optInt("versionCode", 0)
                val name = json.optString("versionName", "")
                val apk = json.optString("apk", "")
                if (code <= BuildConfig.VERSION_CODE || apk.isEmpty()) return@Thread

                // 第一次：還沒允許安裝未知的應用程式。這一步繞不過去，只能請使用者去開
                if (Build.VERSION.SDK_INT >= 26 && !app.packageManager.canRequestPackageInstalls()) {
                    main.post { askPermission(activity, name) }
                    return@Thread
                }
                val file = download(app, "${Config.SITE}/app/$apk?v=$code", code) ?: return@Thread
                p.edit().putInt("ready", code).putString("readyName", name).apply()
                main.post {
                    if (silentCapable(app)) {
                        // 使用者可能在下載的這段時間已經離開 App 了
                        if (!MainActivity.visible) installIfReady(app)
                    } else {
                        promptInstall(activity, file, code, name)
                    }
                }
            } catch (_: Exception) {
                // 沒網路、站台還沒放 version.json —— 下次再問，不必吵使用者
            } finally {
                running.set(false)
            }
        }.start()
    }

    /**
     * 離開 App（`MainActivity.onStop`）與上傳收工（`UploadService`）時叫。
     * 手上有下載好的新版、能靜默裝、而且沒有東西會被打斷，就裝。
     */
    fun installIfReady(ctx: Context) {
        val app = ctx.applicationContext
        if (!silentCapable(app) || MainActivity.visible || busy()) return
        val (file, code) = readyApk(app) ?: return
        if (!installing.compareAndSet(false, true)) return
        Thread {
            try {
                commitSession(app, file, code, silent = true)
            } catch (_: Exception) {
                installing.set(false)
            }
        }.start()
    }

    /** 安裝結果回來（`InstallReceiver`）之後放掉鎖，失敗的下次離開 App 再試 */
    internal fun installFinished() = installing.set(false)

    private fun download(app: Context, url: String, code: Int): File? {
        val dir = apkDir(app)
        val out = File(dir, "didadida-$code.apk")
        val ok = runCatching {
            Net.client.newCall(Request.Builder().url(url).build()).execute().use { res ->
                if (!res.isSuccessful) error("HTTP ${res.code}")
                val tmp = File(dir, out.name + ".part")
                res.body!!.byteStream().use { input -> tmp.outputStream().use { input.copyTo(it) } }
                if (!tmp.renameTo(out)) { out.delete(); tmp.renameTo(out) }
            }
            // ⚠️ 驗一次：套件名要是自己、版號要跟清單上寫的一樣。不對就當沒下載到 ——
            //    交給安裝器的話不是裝錯東西，就是在背景安靜地失敗、每次離開 App 都再試一次
            @Suppress("DEPRECATION")
            val info = app.packageManager.getPackageArchiveInfo(out.path, 0)
                ?: error("不是有效的 APK")
            @Suppress("DEPRECATION")
            val got = if (Build.VERSION.SDK_INT >= 28) info.longVersionCode.toInt() else info.versionCode
            if (info.packageName != app.packageName || got != code) error("版本不符")
            clearApks(app, keep = out.name)
        }.isSuccess
        if (!ok) out.delete()
        return if (ok) out else null
    }

    /** 舊版的安裝檔留著沒用；更新完成後（`UpdatedReceiver`）也叫一次把剛裝的那份清掉 */
    fun clearApks(ctx: Context, keep: String? = null) {
        val app = ctx.applicationContext
        apkDir(app).listFiles()
            ?.filter { (it.name.endsWith(".apk") || it.name.endsWith(".part")) && it.name != keep }
            ?.forEach { it.delete() }
        if (keep == null) prefs(app).edit().remove("ready").remove("readyName").apply()
    }

    private fun commitSession(app: Context, apk: File, code: Int, silent: Boolean) {
        val installer = app.packageManager.packageInstaller
        val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL).apply {
            setAppPackageName(app.packageName)
            if (Build.VERSION.SDK_INT >= 31 && silent) {
                setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED)
            }
        }
        val id = installer.createSession(params)
        installer.openSession(id).use { session ->
            session.openWrite("base.apk", 0, apk.length()).use { out ->
                apk.inputStream().use { it.copyTo(out) }
                session.fsync(out)
            }
            val pi = PendingIntent.getBroadcast(
                app, code,
                Intent(app, InstallReceiver::class.java).setPackage(app.packageName),
                // ⚠️ 一定要 MUTABLE：安裝結果是系統往這個 Intent 裡塞 extras 送回來的
                PendingIntent.FLAG_UPDATE_CURRENT or
                    (if (Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else 0),
            )
            session.commit(pi.intentSender)
        }
    }

    /* ---- 前景的對話框（舊系統，或還沒給安裝權限） ---- */

    private fun askPermission(activity: Activity, name: String) {
        if (activity.isFinishing || activity.isDestroyed || Build.VERSION.SDK_INT < 26) return
        AlertDialog.Builder(activity)
            .setTitle("有新版本 $name")
            .setMessage(
                "要讓滴答滴答自己更新，請先打開「允許安裝未知的應用程式」。" +
                    "開完回來就會自動下載，之後的更新都不必再按。",
            )
            .setPositiveButton("去打開") { _, _ ->
                prefs(activity).edit().remove("last").apply()   // 回來馬上再檢查一次
                activity.startActivity(
                    Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${activity.packageName}")),
                )
            }
            .setNegativeButton("稍後", null)
            .show()
    }

    private fun promptInstall(activity: Activity, apk: File, code: Int, name: String) {
        if (activity.isFinishing || activity.isDestroyed) return
        if (busy()) return   // 上傳中不問，收工後下次回前景再問
        AlertDialog.Builder(activity)
            .setTitle("新版本 $name 已下載好")
            .setMessage("目前是 ${BuildConfig.VERSION_NAME}。安裝時 App 會關掉，要現在安裝嗎？")
            .setPositiveButton("安裝") { _, _ ->
                val app = activity.applicationContext
                Thread { runCatching { commitSession(app, apk, code, silent = false) } }.start()
            }
            .setNegativeButton("稍後", null)
            .show()
    }
}
