package tw.didadida.app.upload

import android.content.Context
import android.net.Uri
import android.provider.OpenableColumns
import java.io.ByteArrayOutputStream
import java.io.FileInputStream

/**
 * 一個使用者挑的檔（content:// Uri）。
 *
 * ⚠️ 位元組一律**惰性讀**（同網頁的 `File.slice()`）：幾 GB 的影片整份讀進記憶體，
 *    前景服務照樣會被 OOM 掉。`read()` 每次重開一個 FileDescriptor 定位到那一段，
 *    Drive 的 resumable 重試因此能從任何位置接著傳。
 */
class MediaSource(
    private val context: Context,
    val uri: Uri,
    val name: String,
    val mime: String?,
    override val size: Long,
) : ByteSource {

    override fun read(offset: Long, len: Int): ByteArray {
        val want = minOf(len.toLong(), size - offset).coerceAtLeast(0L).toInt()
        if (want == 0) return ByteArray(0)
        val pfd = context.contentResolver.openFileDescriptor(uri, "r")
            ?: throw IllegalStateException("讀不到「$name」")
        pfd.use { fd ->
            FileInputStream(fd.fileDescriptor).use { input ->
                val ch = input.channel
                ch.position(offset)
                val buf = java.nio.ByteBuffer.allocate(want)
                while (buf.hasRemaining()) {
                    if (ch.read(buf) < 0) break
                }
                return if (buf.position() == want) buf.array() else buf.array().copyOf(buf.position())
            }
        }
    }

    /** 整份讀進來（只給 GIF 與小檔用 —— GIF 上限 25MB） */
    fun readAll(): ByteArray {
        val out = ByteArrayOutputStream(size.coerceIn(0, Int.MAX_VALUE.toLong()).toInt())
        context.contentResolver.openInputStream(uri)?.use { it.copyTo(out) }
            ?: throw IllegalStateException("讀不到「$name」")
        return out.toByteArray()
    }

    val isVideo: Boolean
        get() = mime?.startsWith("video/") == true ||
            (mime.isNullOrEmpty() && VIDEO_EXT.any { name.endsWith(it, ignoreCase = true) })

    /** Drive 上那份原始檔的 MIME。拿不到就交給 Drive 自己猜 */
    val driveMime: String get() = mime?.takeIf { it.isNotEmpty() } ?: "application/octet-stream"

    companion object {
        private val VIDEO_EXT = listOf(".mp4", ".mov", ".webm", ".m4v", ".3gp")

        /** 問 ContentResolver 拿檔名、大小、MIME。拿不到的欄位給安全的預設值 */
        fun of(context: Context, uri: Uri): MediaSource {
            var name: String? = null
            var size = -1L
            context.contentResolver.query(
                uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null,
            )?.use { c ->
                if (c.moveToFirst()) {
                    val ni = c.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                    val si = c.getColumnIndex(OpenableColumns.SIZE)
                    if (ni >= 0 && !c.isNull(ni)) name = c.getString(ni)
                    if (si >= 0 && !c.isNull(si)) size = c.getLong(si)
                }
            }
            if (size < 0) {
                size = runCatching {
                    context.contentResolver.openFileDescriptor(uri, "r")?.use { it.statSize }
                }.getOrNull() ?: 0L
            }
            val mime = context.contentResolver.getType(uri)
            return MediaSource(context, uri, name ?: uri.lastPathSegment ?: "file", mime, size)
        }
    }
}
