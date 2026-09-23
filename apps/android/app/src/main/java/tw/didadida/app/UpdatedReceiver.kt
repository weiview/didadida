package tw.didadida.app

import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationCompat
import tw.didadida.app.upload.UploadService

/**
 * 更新裝好之後，系統對**新版**送的 `MY_PACKAGE_REPLACED`。
 * 靜默更新時使用者什麼都沒按，不講一聲的話他不會知道 App 剛換過一版。
 */
class UpdatedReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_MY_PACKAGE_REPLACED) return
        Updater.clearApks(context)
        UploadService.ensureChannels(context)
        val nm = context.getSystemService(NotificationManager::class.java)
        nm.cancel(InstallReceiver.NOTIFY_UPDATE)
        val pi = PendingIntent.getActivity(
            context, 0,
            Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val n = NotificationCompat.Builder(context, Config.CHANNEL_NOTICE)
            .setSmallIcon(android.R.drawable.stat_sys_download_done)
            .setContentTitle("滴答滴答已更新到 ${BuildConfig.VERSION_NAME}")
            .setContentText("點這裡看這一版改了什麼")
            .setStyle(NotificationCompat.BigTextStyle().bigText(context.getString(R.string.whats_new)))
            .setAutoCancel(true)
            .setContentIntent(pi)
            .build()
        runCatching { nm.notify(InstallReceiver.NOTIFY_UPDATE, n) }
    }
}
