package tw.didadida.app.upload

import android.app.NotificationManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/** 常駐的上傳失敗通知上那顆「知道了」 */
class NoticeDismissReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val id = intent.getIntExtra(EXTRA_ID, 0)
        if (id != 0) context.getSystemService(NotificationManager::class.java)?.cancel(id)
    }

    companion object {
        const val EXTRA_ID = "id"
    }
}
