package tw.didadida.app

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import java.time.LocalDate
import java.time.ZoneId
import java.time.temporal.ChronoUnit

/**
 * 桌面圖示的三張臉：有來看是笑臉，隔了一整天沒來生氣，再隔一天哭哭。
 *
 * 以**當地日期**算（每天 00:00 換日）：最後一次看 App 是 D 日的話，
 * D、D+1 笑臉，D+2 生氣，D+3 起哭哭。例：週一 23:00 看過 → 週二還是笑臉、
 * 週三 00:00 生氣、週四 00:00 哭哭。
 *
 * Android 沒有換圖示的 API，只能在 manifest 放三個 activity-alias 輪流啟用。
 * ⚠️ 換的那一下，有些桌面（尤其三星）會把桌面上的捷徑拿掉，要從應用程式清單再拖一次
 *    —— 使用者知道也接受了。
 * ⚠️ **App 開著的時候不換**：停用「當初用來開 App 的那個 alias」在某些桌面會把整個
 *    task 收掉。所以 [touch] 只記日期，真的換圖示在 [onLeave]（MainActivity.onStop）。
 */
object MoodIcon {
    private const val KEY_LAST_SEEN = "mood_last_seen_day"
    private val ALIASES = listOf("LauncherSmile", "LauncherAngry", "LauncherCry")

    private fun prefs(ctx: Context) = ctx.getSharedPreferences("app", Context.MODE_PRIVATE)
    private fun today() = LocalDate.now(ZoneId.systemDefault())

    /** 使用者正在看 App（onResume／onStop 都叫：開著跨過午夜也算今天有來）。 */
    fun touch(ctx: Context) {
        prefs(ctx).edit().putLong(KEY_LAST_SEEN, today().toEpochDay()).apply()
    }

    /** 離開 App：剛剛有來看，換回笑臉。 */
    fun onLeave(ctx: Context) {
        touch(ctx)
        apply(ctx)
    }

    /** Application 起來時：舊版升上來還沒有紀錄的話，當作今天有來，再排好午夜的鬧鐘。 */
    fun init(ctx: Context) {
        if (!prefs(ctx).contains(KEY_LAST_SEEN)) touch(ctx)
        schedule(ctx)
    }

    /** 0 笑、1 生氣、2 哭哭。 */
    private fun mood(ctx: Context): Int {
        val last = prefs(ctx).getLong(KEY_LAST_SEEN, today().toEpochDay())
        val days = today().toEpochDay() - last
        return when {
            days <= 1 -> 0
            days == 2L -> 1
            else -> 2
        }
    }

    /** 啟用該有的那一張、停用另外兩張；已經是對的就一個字都不動（每次換都可能讓桌面捷徑消失）。 */
    fun apply(ctx: Context) {
        val pm = ctx.packageManager
        val want = mood(ctx)
        fun comp(i: Int) = ComponentName(ctx, "tw.didadida.app.${ALIASES[i]}")
        fun enabled(i: Int): Boolean = when (pm.getComponentEnabledSetting(comp(i))) {
            PackageManager.COMPONENT_ENABLED_STATE_ENABLED -> true
            PackageManager.COMPONENT_ENABLED_STATE_DISABLED -> false
            else -> i == 0 // DEFAULT ＝ manifest 裡寫的：只有笑臉是開的
        }
        if (ALIASES.indices.all { enabled(it) == (it == want) }) return
        // 先開要的那張再關其他的：中間不能有一刻桌面上一個入口都沒有
        pm.setComponentEnabledSetting(
            comp(want), PackageManager.COMPONENT_ENABLED_STATE_ENABLED, PackageManager.DONT_KILL_APP,
        )
        for (i in ALIASES.indices) if (i != want) {
            pm.setComponentEnabledSetting(
                comp(i), PackageManager.COMPONENT_ENABLED_STATE_DISABLED, PackageManager.DONT_KILL_APP,
            )
        }
    }

    /**
     * 排下一個當地 00:00。不精確的鬧鐘（不需要 SCHEDULE_EXACT_ALARM 權限），
     * 休眠中可能晚個幾分鐘才換臉，無所謂。
     */
    fun schedule(ctx: Context) {
        val am = ctx.getSystemService(AlarmManager::class.java) ?: return
        val zone = ZoneId.systemDefault()
        val at = today().plusDays(1).atStartOfDay(zone).toInstant().toEpochMilli() + 5_000
        val pi = PendingIntent.getBroadcast(
            ctx, 0,
            Intent(ctx, Receiver::class.java).setAction(ACTION_MIDNIGHT),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        am.setAndAllowWhileIdle(AlarmManager.RTC, at, pi)
    }

    private const val ACTION_MIDNIGHT = "tw.didadida.app.MOOD_MIDNIGHT"

    /** 午夜鬧鐘、開機、換時區：重算一次臉，再排下一個午夜。 */
    class Receiver : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            // App 正開著就不換（見類別說明），離開時 onLeave 會補上
            if (!MainActivity.visible) apply(context)
            schedule(context)
        }
    }
}
