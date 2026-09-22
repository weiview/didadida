package tw.didadida.app.upload

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import tw.didadida.app.Config
import tw.didadida.app.DuplicateActivity
import tw.didadida.app.MainActivity
import tw.didadida.app.R
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicInteger

/**
 * 整條上傳管線跑在這裡：前景服務（dataSync），關掉畫面、切到別的 App 都照樣傳。
 *
 * ⚠️ **一次只跑一件事**（單執行緒）：一批上傳、一張重複照片的決定、一批的收尾全排在
 *    同一條佇列上 —— 同網頁 `dupJobsRef` 那條鏈的理由（同時開好幾條上傳會把記憶體與
 *    頻寬吃光，影片尤其），而且收尾一定排在那一批的每一張後面。
 * ⚠️ 失敗**不在半路彈任何東西**，收工一次講完（通知）—— 同 `IngestResult.failures`。
 */
class UploadService : Service() {

    private val worker = Executors.newSingleThreadExecutor()
    private val pending = AtomicInteger(0)
    private val main = Handler(Looper.getMainLooper())
    private lateinit var nm: NotificationManager
    @Volatile private var lastNotify = 0L

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        nm = getSystemService(NotificationManager::class.java)
        ensureChannels(this)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // ⚠️ startForegroundService 之後幾秒內一定要 startForeground，不然整個 App 會被系統殺掉
        startInForeground(progressNotification("上傳照片", "準備上傳…", 0, 0, true))
        if (intent == null) { maybeStop(); return START_NOT_STICKY }

        when (intent.action) {
            ACTION_UPLOAD -> {
                val albumId = intent.getLongExtra(EXTRA_ALBUM, 0)
                val token = intent.getStringExtra(EXTRA_TOKEN).orEmpty()
                @Suppress("DEPRECATION")
                val uris: List<Uri> = if (Build.VERSION.SDK_INT >= 33)
                    intent.getParcelableArrayListExtra(EXTRA_URIS, Uri::class.java).orEmpty()
                else intent.getParcelableArrayListExtra<Uri>(EXTRA_URIS).orEmpty()
                if (albumId > 0 && token.isNotEmpty() && uris.isNotEmpty()) {
                    enqueue { runBatch(albumId, token, uris) }
                }
            }
            ACTION_DUP -> {
                val key = intent.getIntExtra(EXTRA_SESSION, 0)
                val index = intent.getIntExtra(EXTRA_INDEX, -1)
                val replace = intent.getLongArrayExtra(EXTRA_REPLACE)?.toList().orEmpty()
                val skip = intent.getBooleanExtra(EXTRA_SKIP, false)
                if (!skip) enqueue { runDup(key, index, replace) }
            }
            ACTION_DUP_FINISH -> {
                val key = intent.getIntExtra(EXTRA_SESSION, 0)
                enqueue { finishDup(key) }
            }
        }
        if (pending.get() == 0) maybeStop()
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        worker.shutdown()
        super.onDestroy()
    }

    /* ---- 佇列 ---- */

    private fun enqueue(job: () -> Unit) {
        pending.incrementAndGet()
        worker.execute {
            try {
                job()
            } catch (e: Throwable) {
                notice("上傳發生錯誤", e.message ?: e.toString())
            } finally {
                if (pending.decrementAndGet() == 0) main.post { maybeStop() }
            }
        }
    }

    private fun maybeStop() {
        if (pending.get() > 0) return
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    /* ---- 一批 ---- */

    private fun runBatch(albumId: Long, token: String, uris: List<Uri>) {
        val api = Api(Config.API, token)
        val sources = uris.mapNotNull { runCatching { MediaSource.of(this, it) }.getOrNull() }
        val ingest = Ingest(this, api, albumId)
        ingest.tag = uris
        val unreadable = uris.size - sources.size
        if (unreadable > 0) ingest.failures.add("有 $unreadable 個檔案讀不到")

        ingest.run(sources) { index, total, name, sent, size ->
            val pct = if (size > 0) (sent * 100 / size).toInt().coerceIn(0, 100) else 0
            val text = if (size > 0 && sent > 0) "$name（$pct%）" else name
            showProgress("上傳中 $index/$total", text, total * 100, (index - 1) * 100 + pct)
        }
        runCatching { ingest.announce() }
        UploadEvents.uploadDone(albumId)

        if (ingest.dupes.isEmpty()) {
            report(ingest)
            releaseUris(uris)
            return
        }
        // 重複的那幾張交給使用者決定；報告等決定完再一起講（同網頁：重複視窗收工才 alert）
        val key = DupStore.add(ingest)
        if (!UploadEvents.showDuplicates()) {
            val pi = PendingIntent.getActivity(
                this, key,
                Intent(this, DuplicateActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
            )
            notice(
                "有 ${ingest.dupes.size} 張可能重複",
                "點這裡決定要保留、取代還是跳過", pi, NOTIFY_DUP,
            )
        }
    }

    private fun runDup(key: Int, index: Int, replace: List<Long>) {
        val ingest = DupStore.sessions[key] ?: return
        val dup = ingest.dupes.getOrNull(index) ?: return
        showProgress("處理重複的照片", dup.name, 0, 0)
        ingest.runDuplicate(dup, replace) { sent, size ->
            val pct = if (size > 0) (sent * 100 / size).toInt().coerceIn(0, 100) else 0
            showProgress("處理重複的照片", "${dup.name}（$pct%）", 100, pct)
        }
    }

    private fun finishDup(key: Int) {
        val ingest = DupStore.sessions.remove(key) ?: return
        nm.cancel(NOTIFY_DUP)
        runCatching { ingest.announce() }
        UploadEvents.uploadDone(ingest.albumId)
        report(ingest)
        @Suppress("UNCHECKED_CAST")
        (ingest.tag as? List<Uri>)?.let { releaseUris(it) }
    }

    /** 收工一次講完：失敗逐檔講原因、補了哪幾張、哪幾張 Drive 還缺 */
    private fun report(ingest: Ingest) {
        val lines = ArrayList<String>()
        if (ingest.createdTotal > 0) lines.add("新增 ${ingest.createdTotal} 張")
        if (ingest.backfilled.isNotEmpty()) {
            lines.add("已補齊 ${ingest.backfilled.size} 張的 Drive 備份：")
            ingest.backfilled.forEach { lines.add("・$it") }
        }
        if (ingest.driveMissing.isNotEmpty()) {
            lines.add("${ingest.driveMissing.size} 張已上傳，但 Google Drive 備份沒有完成：")
            ingest.driveMissing.forEach { lines.add("・$it") }
        }
        if (ingest.failures.isNotEmpty()) {
            lines.add("${ingest.failures.size} 個檔案上傳失敗：")
            ingest.failures.forEach { lines.add("・$it") }
        }
        val title = when {
            ingest.failures.isNotEmpty() -> "上傳完成，但有 ${ingest.failures.size} 個失敗"
            ingest.driveMissing.isNotEmpty() -> "上傳完成，Drive 備份有缺"
            else -> "上傳完成"
        }
        notice(title, if (lines.isEmpty()) "沒有新增任何照片" else lines.joinToString("\n"))
        ingest.failures.clear()
        ingest.backfilled.clear()
        ingest.driveMissing.clear()
    }

    private fun releaseUris(uris: List<Uri>) {
        for (u in uris) runCatching {
            contentResolver.releasePersistableUriPermission(u, Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
    }

    /* ---- 通知 ---- */

    private fun openAppIntent(): PendingIntent = PendingIntent.getActivity(
        this, 0,
        Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
        PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )

    private fun progressNotification(title: String, text: String, max: Int, value: Int, indeterminate: Boolean): Notification =
        NotificationCompat.Builder(this, Config.CHANNEL_UPLOAD)
            .setSmallIcon(android.R.drawable.stat_sys_upload)
            .setContentTitle(title)
            .setContentText(text)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .setProgress(max, value, indeterminate)
            .setContentIntent(openAppIntent())
            .build()

    private fun startInForeground(n: Notification) {
        ServiceCompat.startForeground(
            this, NOTIFY_PROGRESS, n,
            if (Build.VERSION.SDK_INT >= 29) ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC else 0,
        )
    }

    /** 進度一秒最多更新兩次 —— 通知更新太頻繁會被系統整個丟掉 */
    private fun showProgress(title: String, text: String, max: Int, value: Int) {
        val now = System.currentTimeMillis()
        if (now - lastNotify < 500 && value in 1 until max) return
        lastNotify = now
        nm.notify(NOTIFY_PROGRESS, progressNotification(title, text, max, value, max == 0))
    }

    private fun notice(title: String, text: String, pi: PendingIntent? = null, id: Int = noticeSeq.incrementAndGet()) {
        val n = NotificationCompat.Builder(this, Config.CHANNEL_NOTICE)
            .setSmallIcon(android.R.drawable.stat_sys_upload_done)
            .setContentTitle(title)
            .setContentText(text.lineSequence().first())
            .setStyle(NotificationCompat.BigTextStyle().bigText(text))
            .setAutoCancel(true)
            .setContentIntent(pi ?: openAppIntent())
            .build()
        runCatching { nm.notify(id, n) }
    }

    companion object {
        const val ACTION_UPLOAD = "tw.didadida.app.UPLOAD"
        const val ACTION_DUP = "tw.didadida.app.DUP"
        const val ACTION_DUP_FINISH = "tw.didadida.app.DUP_FINISH"
        const val EXTRA_ALBUM = "album"
        const val EXTRA_TOKEN = "token"
        const val EXTRA_URIS = "uris"
        const val EXTRA_SESSION = "session"
        const val EXTRA_INDEX = "index"
        const val EXTRA_REPLACE = "replace"
        const val EXTRA_SKIP = "skip"

        private const val NOTIFY_PROGRESS = 1
        private const val NOTIFY_DUP = 2
        private val noticeSeq = AtomicInteger(100)

        fun ensureChannels(context: Context) {
            val nm = context.getSystemService(NotificationManager::class.java)
            nm.createNotificationChannel(
                NotificationChannel(Config.CHANNEL_UPLOAD, context.getString(R.string.channel_upload), NotificationManager.IMPORTANCE_LOW),
            )
            nm.createNotificationChannel(
                NotificationChannel(Config.CHANNEL_NOTICE, context.getString(R.string.channel_notice), NotificationManager.IMPORTANCE_DEFAULT),
            )
        }

        fun upload(context: Context, albumId: Long, token: String, uris: ArrayList<Uri>) {
            context.startForegroundService(
                Intent(context, UploadService::class.java).setAction(ACTION_UPLOAD)
                    .putExtra(EXTRA_ALBUM, albumId)
                    .putExtra(EXTRA_TOKEN, token)
                    .putParcelableArrayListExtra(EXTRA_URIS, uris),
            )
        }

        /** 一張重複照片的決定：skip＝跳過；replace 空＝兩張都留；否則取代那幾列 */
        fun decideDup(context: Context, session: Int, index: Int, skip: Boolean, replace: LongArray) {
            if (skip) return   // 跳過什麼都不必做，也就不必叫醒服務
            context.startForegroundService(
                Intent(context, UploadService::class.java).setAction(ACTION_DUP)
                    .putExtra(EXTRA_SESSION, session)
                    .putExtra(EXTRA_INDEX, index)
                    .putExtra(EXTRA_REPLACE, replace),
            )
        }

        fun finishDups(context: Context, session: Int) {
            context.startForegroundService(
                Intent(context, UploadService::class.java).setAction(ACTION_DUP_FINISH)
                    .putExtra(EXTRA_SESSION, session),
            )
        }
    }
}

/**
 * 服務 → 畫面的單向通知（同一個行程，不必繞 broadcast）。
 * MainActivity 在前景時掛上監聽器；不在前景時 `showDuplicates()` 回 false，服務改發通知。
 */
object UploadEvents {
    interface Listener {
        fun onUploadDone(albumId: Long)
        fun onDuplicates()
    }

    @Volatile var listener: Listener? = null
    private val main = Handler(Looper.getMainLooper())

    fun uploadDone(albumId: Long) {
        val l = listener ?: return
        main.post { l.onUploadDone(albumId) }
    }

    fun showDuplicates(): Boolean {
        val l = listener ?: return false
        main.post { l.onDuplicates() }
        return true
    }
}
