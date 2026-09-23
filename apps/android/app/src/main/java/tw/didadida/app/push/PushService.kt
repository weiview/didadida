package tw.didadida.app.push

import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Intent
import androidx.core.app.NotificationCompat
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import tw.didadida.app.Config
import tw.didadida.app.MainActivity

/**
 * 收推播、畫通知。後端送的一律是 data-only（見 `apps/backend/src/fcm.ts`），
 * 所以不管 App 在前景、背景還是根本沒開，都走到這裡由我們決定要不要跳。
 *
 *  - `kind=online`：「XXX 上線囉」
 *  - `kind=upload`：「XXX 傳了 n 張照片到「相簿」」，點下去開那本相簿
 *
 * ⚠️ **App 開在前景時不跳** —— 網頁左下角那一疊本來就會跳同一則
 *    （`PresenceToasts`，搭 `/api/presence` 的順風車），兩邊一起跳就是同一件事講兩遍。
 */
class PushService : FirebaseMessagingService() {

    override fun onNewToken(token: String) {
        Push.register(this, token, force = true)
    }

    override fun onMessageReceived(message: RemoteMessage) {
        if (MainActivity.visible) return
        // 登出了（或從來沒登入）：後端那一列本來該被撤掉，萬一撤失敗了也不要跳
        if (Push.session(this) == null) return
        val d = message.data
        val name = d["actor_name"].orEmpty().ifBlank { "有人" }
        when (d["kind"]) {
            "online" -> notify(
                id = ("online:$name").hashCode(),   // 同一個人再上線一次就蓋掉上一則
                channel = Config.CHANNEL_PUSH_ONLINE,
                title = "$name 上線囉",
                text = null,
                path = null,
            )
            "upload" -> {
                val photos = d["photos"]?.toIntOrNull() ?: 0
                val videos = d["videos"]?.toIntOrNull() ?: 0
                val what = listOfNotNull(
                    photos.takeIf { it > 0 }?.let { "$it 張照片" },
                    videos.takeIf { it > 0 }?.let { "$it 支影片" },
                ).joinToString("、").ifEmpty { "新東西" }
                val album = d["album_name"].orEmpty()
                val albumId = d["album_id"].orEmpty()
                notify(
                    id = (System.currentTimeMillis() and 0x7fffffff).toInt(),
                    channel = Config.CHANNEL_PUSH_UPLOAD,
                    title = "$name 傳了$what",
                    text = if (album.isNotEmpty()) "到「$album」" else null,
                    path = if (albumId.isNotEmpty()) "/album?id=$albumId" else null,
                )
            }
        }
    }

    private fun notify(id: Int, channel: String, title: String, text: String?, path: String?) {
        val open = Intent(this, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        if (path != null) open.putExtra(MainActivity.EXTRA_OPEN_PATH, path)
        val pi = PendingIntent.getActivity(
            this, id, open, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val n = NotificationCompat.Builder(this, channel)
            .setSmallIcon(if (channel == Config.CHANNEL_PUSH_UPLOAD) android.R.drawable.ic_menu_gallery else android.R.drawable.presence_online)
            .setContentTitle(title)
            .apply { if (text != null) setContentText(text) }
            .setAutoCancel(true)
            .setContentIntent(pi)
            .build()
        runCatching { getSystemService(NotificationManager::class.java).notify(id, n) }
    }
}
