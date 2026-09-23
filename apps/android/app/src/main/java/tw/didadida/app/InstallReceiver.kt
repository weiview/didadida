package tw.didadida.app

import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.os.Build
import androidx.core.app.NotificationCompat
import tw.didadida.app.upload.UploadService

/**
 * `PackageInstaller` 的安裝結果（`Updater.commitSession` 的 PendingIntent）。
 *
 * ⚠️ 成功時通常收不到這一則 —— 行程在那之前就被系統殺掉換成新版了，
 *    「已更新」那一則由新版的 `UpdatedReceiver` 負責。
 * ⚠️ `STATUS_PENDING_USER_ACTION` 是正常流程：系統決定還是要問。
 *    在前景就直接端出確認畫面；在背景改發一則通知（Android 14 不准背景啟動 Activity）。
 */
class InstallReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)
        if (status == PackageInstaller.STATUS_PENDING_USER_ACTION) {
            @Suppress("DEPRECATION")
            val confirm = (if (Build.VERSION.SDK_INT >= 33)
                intent.getParcelableExtra(Intent.EXTRA_INTENT, Intent::class.java)
            else intent.getParcelableExtra(Intent.EXTRA_INTENT)) ?: return Updater.installFinished()
            confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            if (MainActivity.visible) {
                runCatching { context.startActivity(confirm) }
            } else {
                UploadService.ensureChannels(context)
                val pi = PendingIntent.getActivity(
                    context, 0, confirm,
                    PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
                )
                val n = NotificationCompat.Builder(context, Config.CHANNEL_NOTICE)
                    .setSmallIcon(android.R.drawable.stat_sys_download_done)
                    .setContentTitle("滴答滴答有新版本")
                    .setContentText("點這裡安裝")
                    .setAutoCancel(true)
                    .setContentIntent(pi)
                    .build()
                runCatching { context.getSystemService(NotificationManager::class.java).notify(NOTIFY_UPDATE, n) }
            }
        }
        // 其他狀態（失敗、被使用者取消）：放掉鎖，下次離開 App 再試
        Updater.installFinished()
    }

    companion object {
        const val NOTIFY_UPDATE = 3
    }
}
