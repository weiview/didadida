package tw.didadida.app

import android.app.Activity
import android.content.Context
import android.util.Log
import androidx.appcompat.app.AlertDialog

/**
 * 更新後第一次打開 App：跳一次「已更新到 x.y.z」＋這一版改了什麼（`R.string.whats_new`）。
 *
 *  - 每一版只跳一次：看過的版號記在 prefs `app` 的 `whats_new_seen`。
 *  - ⚠️ **全新安裝不跳**（`firstInstallTime == lastUpdateTime`）—— 第一次裝的人沒有「改了什麼」可言，
 *    只把版號記下來。從 1.0.4 以前升上來的人沒有這個鍵，靠安裝時間分辨才跳得出來。
 *  - 內容寫在 strings.xml 裡、跟著 APK 走，不放進 `version-*.json` —— 裝好的那一版自己知道自己改了什麼，
 *    不必再多打一次網路。
 *  - 靜默更新時 `UpdatedReceiver` 發的那則通知也是同一段文字。
 */
object WhatsNew {
    private const val KEY = "whats_new_seen"

    fun maybeShow(activity: Activity) {
        val prefs = activity.getSharedPreferences("app", Context.MODE_PRIVATE)
        val code = BuildConfig.VERSION_CODE
        if (prefs.getInt(KEY, 0) >= code) return
        prefs.edit().putInt(KEY, code).apply()

        val updated = try {
            val info = activity.packageManager.getPackageInfo(activity.packageName, 0)
            info.firstInstallTime != info.lastUpdateTime
        } catch (e: Exception) {
            Log.w("WhatsNew", "讀不到安裝時間", e)
            false
        }
        if (!updated) return

        AlertDialog.Builder(activity)
            .setTitle("已更新到 ${BuildConfig.VERSION_NAME}")
            .setMessage(activity.getString(R.string.whats_new))
            .setPositiveButton("知道了", null)
            .show()
    }
}
