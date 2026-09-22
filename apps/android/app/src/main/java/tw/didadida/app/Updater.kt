package tw.didadida.app

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.widget.Toast
import androidx.appcompat.app.AlertDialog
import androidx.core.content.FileProvider
import okhttp3.Request
import org.json.JSONObject
import tw.didadida.app.upload.Net
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
 * ⚠️ 最多 6 小時問一次（`CHECK_EVERY_MS`）：每次回前景都問的話，一天就是幾十次 Pages 請求。
 * ⚠️ 使用者按「稍後」那一版不再追問（`skipped`），直到下一版出來。
 */
object Updater {
    private const val CHECK_EVERY_MS = 6 * 60 * 60 * 1000L
    private val running = AtomicBoolean(false)
    private val main = Handler(Looper.getMainLooper())

    fun check(activity: Activity, force: Boolean = false) {
        val prefs = activity.getSharedPreferences("updater", Context.MODE_PRIVATE)
        val now = System.currentTimeMillis()
        if (!force && now - prefs.getLong("last", 0) < CHECK_EVERY_MS) return
        if (!running.compareAndSet(false, true)) return
        Thread {
            try {
                val url = "${Config.SITE}/app/version-${BuildConfig.FLAVOR}.json?cb=$now"
                val json = Net.client.newCall(Request.Builder().url(url).build()).execute().use { res ->
                    if (!res.isSuccessful) null else res.body?.string()?.let { JSONObject(it) }
                } ?: return@Thread
                prefs.edit().putLong("last", now).apply()
                val code = json.optInt("versionCode", 0)
                val name = json.optString("versionName", "")
                val apk = json.optString("apk", "")
                if (code <= BuildConfig.VERSION_CODE || apk.isEmpty()) return@Thread
                if (!force && prefs.getInt("skipped", 0) == code) return@Thread
                main.post {
                    if (activity.isFinishing || activity.isDestroyed) return@post
                    AlertDialog.Builder(activity)
                        .setTitle("有新版本 $name")
                        .setMessage("目前是 ${BuildConfig.VERSION_NAME}。要現在下載並安裝嗎？")
                        .setPositiveButton("更新") { _, _ -> download(activity, "${Config.SITE}/app/$apk?v=$code", code) }
                        .setNegativeButton("稍後") { _, _ -> prefs.edit().putInt("skipped", code).apply() }
                        .show()
                }
            } catch (_: Exception) {
                // 沒網路、站台還沒放 version.json —— 下次再問，不必吵使用者
            } finally {
                running.set(false)
            }
        }.start()
    }

    private fun download(activity: Activity, url: String, code: Int) {
        Toast.makeText(activity, "下載新版本中…", Toast.LENGTH_SHORT).show()
        val app = activity.applicationContext
        Thread {
            val dir = app.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS) ?: app.cacheDir
            val out = File(dir, "didadida-$code.apk")
            val ok = runCatching {
                Net.client.newCall(Request.Builder().url(url).build()).execute().use { res ->
                    if (!res.isSuccessful) error("HTTP ${res.code}")
                    val tmp = File(dir, out.name + ".part")
                    res.body!!.byteStream().use { input -> tmp.outputStream().use { input.copyTo(it) } }
                    if (!tmp.renameTo(out)) { out.delete(); tmp.renameTo(out) }
                }
                // 舊版的安裝檔留著沒用，順手清掉
                dir.listFiles()?.filter { it.name.endsWith(".apk") && it.name != out.name }?.forEach { it.delete() }
            }.isSuccess
            main.post {
                if (!ok) {
                    Toast.makeText(app, "下載失敗，請稍後再試", Toast.LENGTH_LONG).show()
                    return@post
                }
                install(activity, out)
            }
        }.start()
    }

    private fun install(activity: Activity, apk: File) {
        if (Build.VERSION.SDK_INT >= 26 && !activity.packageManager.canRequestPackageInstalls()) {
            // 第一次要使用者自己打開「允許安裝未知的應用程式」，開完回來再按一次更新
            Toast.makeText(activity, "請允許滴答滴答安裝更新，回來後再按一次「更新」", Toast.LENGTH_LONG).show()
            activity.getSharedPreferences("updater", Context.MODE_PRIVATE).edit().remove("last").apply()
            activity.startActivity(
                Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${activity.packageName}")),
            )
            return
        }
        val uri = FileProvider.getUriForFile(activity, "${activity.packageName}.files", apk)
        activity.startActivity(
            Intent(Intent.ACTION_VIEW)
                .setDataAndType(uri, "application/vnd.android.package-archive")
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK),
        )
    }
}
