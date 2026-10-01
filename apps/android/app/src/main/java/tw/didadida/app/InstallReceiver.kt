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
        if (status != PackageInstaller.STATUS_PENDING_USER_ACTION &&
            status != PackageInstaller.STATUS_SUCCESS &&
            status != PackageInstaller.STATUS_FAILURE_ABORTED   // 使用者自己按了取消，不必再講一次
        ) {
            val reason = when (status) {
                PackageInstaller.STATUS_FAILURE_STORAGE -> "手機儲存空間不足"
                PackageInstaller.STATUS_FAILURE_INVALID -> "安裝檔損壞，稍後會重新下載"
                PackageInstaller.STATUS_FAILURE_CONFLICT -> "與已安裝的版本衝突（簽章不同），請解除安裝後重裝"
                PackageInstaller.STATUS_FAILURE_INCOMPATIBLE -> "這台手機不相容"
                PackageInstaller.STATUS_FAILURE_BLOCKED -> "被系統擋下，請確認「允許安裝未知的應用程式」"
                else -> intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE)?.takeIf { it.isNotBlank() }
                    ?: "原因不明，請稍後再試"
            }
            Updater.reportInstallFailure(
                context,
                code = intent.getIntExtra(EXTRA_CODE, 0),
                silent = intent.getBooleanExtra(EXTRA_SILENT, false),
                reason = reason,
                dropApk = status == PackageInstaller.STATUS_FAILURE_INVALID,
            )
        }
        // 放掉鎖，下次離開 App 再試
        Updater.installFinished()
    }

    companion object {
        const val NOTIFY_UPDATE = 3
        const val EXTRA_CODE = "tw.didadida.app.INSTALL_CODE"
        const val EXTRA_SILENT = "tw.didadida.app.INSTALL_SILENT"

        fun notifyFailure(context: Context, msg: String) {
            UploadService.ensureChannels(context)
            val pi = PendingIntent.getActivity(
                context, 0,
                Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
            )
            val n = NotificationCompat.Builder(context, Config.CHANNEL_NOTICE)
                .setSmallIcon(android.R.drawable.stat_notify_error)
                .setContentTitle("滴答滴答更新失敗")
                .setContentText(msg)
                .setStyle(NotificationCompat.BigTextStyle().bigText(msg))
                .setAutoCancel(true)
                .setContentIntent(pi)
                .build()
            runCatching { context.getSystemService(NotificationManager::class.java).notify(NOTIFY_UPDATE, n) }
        }
    }
}
