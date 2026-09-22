package tw.didadida.app.upload

import android.content.Context
import android.graphics.BitmapFactory
import android.net.Uri

/**
 * 一批上傳。**這一檔是 `app/album/page.tsx` 的 `ingestSources()` ＋ `runDuplicateJob()`
 * ＋ `lib/drive.ts` 的 `pushPhotoToDrive()`／`pushVideoToDrive()` 的複本。**
 *
 * ⚠️⚠️ 網頁那條上傳管線一改，這一檔要跟著改（見 CLAUDE.md「Android App」）。
 *    判斷的順序、失敗訊息的字串、哪些情況算「新增」哪些不算，一個都不能自己發明 ——
 *    兩邊不一致的話，同一個人從手機跟從電腦傳同一批，站上會長出兩種不同的結果。
 *
 * 跟網頁刻意不同的只有兩件：
 *   ① 沒有「補傳這批」那顆按鈕（手上的檔案在服務結束後就放掉了）—— Drive 沒補齊的
 *      收進 `driveMissing`，收工一起講；站上那扇「你傳的檔案還沒備份完整」小窗會
 *      在下一次上線時列出它們（`DRIVE_PENDING_COND`）。
 *   ② 重複的那幾張交給 `DuplicateActivity` 逐張決定（網頁是 GoogleSyncConflictModal）。
 */
class Ingest(
    private val context: Context,
    private val api: Api,
    val albumId: Long,
) {
    /** 一張做到哪了：第幾個、總共幾個、檔名、（影片的）已送出位元組 */
    fun interface Progress {
        fun update(index: Int, total: Int, name: String, sent: Long, size: Long)
    }

    val failures = ArrayList<String>()
    val backfilled = ArrayList<String>()
    val driveMissing = ArrayList<String>()
    val dupes = ArrayList<PendingDup>()
    var newPhotos = 0
        private set
    var newVideos = 0
        private set
    /** 這一整趟（含重複視窗那幾張）一共新增了幾格，收工報告用。announce 會把上面兩個歸零，這個不會 */
    var createdTotal = 0
        private set
    /** 服務自己掛的東西（這一批的 URI，收工時釋放讀取權） */
    var tag: Any? = null

    /* ---- Drive：整批只 bootstrap 一次 ---- */

    private val drive = Drive(api)
    private var folderId: String? = null
    private var driveTried = false
    private var driveError: String? = null

    /**
     * 這一本相簿在 Drive 上的資料夾。**失敗只試一次** —— 同一批的下一張再試
     * 也是同一個結果，而每一趟都是好幾次 Drive 請求。拿不到回 null，原因在 `driveError`。
     */
    private fun folder(): String? {
        if (!driveTried) {
            driveTried = true
            folderId = try {
                drive.ensureAlbumFolder(albumId)
            } catch (e: Exception) {
                driveError = errText(e)
                null
            }
        }
        return folderId
    }

    private fun errText(e: Throwable): String =
        e.message?.takeIf { it.isNotBlank() } ?: e.javaClass.simpleName

    private fun needLabel(fourK: Boolean, original: Boolean): String =
        listOfNotNull(if (fourK) "4K" else null, if (original) "原始檔" else null).joinToString(" ＋ ")

    /**
     * 撞到重複時，能不能直接補既有那一列（網頁的 `incompleteTwin()`）。
     * ⚠️ 只認 `same_file`、只認剛好一列、媒體種類要一致 —— 理由見 CLAUDE.md
     *    「重傳同一個檔＝自動補缺的那一半」。
     */
    private fun incompleteTwin(existing: List<Api.ExistingPhoto>, kind: String): Api.ExistingPhoto? {
        val same = existing.filter { it.sameFile }
        if (same.size != 1) return null
        val t = same[0]
        if (t.mediaType != kind) return null
        if (t.has4k && t.hasOriginal) return null
        return t
    }

    /* ---- 一批 ---- */

    fun run(sources: List<MediaSource>, progress: Progress) {
        val total = sources.size
        for ((i, source) in sources.withIndex()) {
            progress.update(i + 1, total, source.name, 0, 0)
            try {
                if (source.isVideo) {
                    ingestVideo(source) { sent, size -> progress.update(i + 1, total, source.name, sent, size) }
                } else {
                    ingestImage(source)
                }
            } catch (e: OutOfMemoryError) {
                failures.add("${source.name}：檔案太大，手機記憶體不足")
            } catch (e: Exception) {
                failures.add("${source.name}：${errText(e)}")
            }
        }
    }

    /** 收尾：一批只通知一次。補備份與重複視窗跳過的不算（站上沒有多一格新的） */
    fun announce() {
        createdTotal += newPhotos + newVideos
        if (newPhotos + newVideos > 0) api.announceUpload(albumId, newPhotos, newVideos)
        // 重複視窗那幾張決定完會再收一次尾，不歸零的話同一批會被通知兩遍
        newPhotos = 0
        newVideos = 0
    }

    /* ---- 影片 ---- */

    private fun ingestVideo(source: MediaSource, onSent: (Long, Long) -> Unit) {
        val poster = VideoMeta.poster(context, source.uri, source.name)
        val thumbs = try { Media.thumbs(poster.bitmap) } finally { poster.bitmap.recycle() }
        val vmeta = VideoMeta.exifFromSource(source, source.name)
        val durationMs = poster.durationMs.takeIf { it > 0 } ?: vmeta.durationMs
        val takenAt = Geo.normalizeGeo(vmeta.exif, vmeta.fallbackIso).takenAtUtc

        val result = api.upload(
            albumId, source.name, thumbs.md, thumbs.sm, vmeta.exif?.toString(), takenAt,
            null, "video", durationMs, 0L, null, false,
        )
        when (result) {
            is Api.UploadResult.Duplicate -> {
                val twin = incompleteTwin(result.existing, "video")
                if (twin != null) {
                    if (folder() == null) {
                        failures.add("${source.name}：此影片已存在，但無法連線至 Google Drive，原始檔無法補齊")
                    } else {
                        try {
                            pushVideo(twin.id, source, onSent)
                            backfilled.add("${source.name}：已補上 Google Drive 的影片原始檔")
                        } catch (e: Exception) {
                            failures.add("${source.name}：影片原始檔補齊失敗（${errText(e)}）")
                        }
                    }
                    return
                }
                dupes.add(
                    PendingDup(
                        uri = source.uri, name = source.name, mime = source.mime, size = source.size,
                        reason = result.reason, existing = result.existing,
                        thumbMd = thumbs.md, thumbSm = thumbs.sm, phash = null,
                        exifJson = vmeta.exif?.toString(), takenAt = takenAt,
                        mediaType = "video", durationMs = durationMs, motionOffset = 0L,
                    )
                )
            }
            is Api.UploadResult.Created -> createdVideo(result.id, source, onSent)
            is Api.UploadResult.Failed -> failures.add("${source.name}：${result.reason}")
        }
    }

    /** 影片那一列建好了：送 Drive，失敗就把那一列收掉（R2 上只有封面）。回傳成不成功 */
    private fun createdVideo(id: Long, source: MediaSource, onSent: (Long, Long) -> Unit): Boolean {
        try {
            if (folder() == null) throw IllegalStateException("無法連線至 Google Drive，影片無法儲存")
            pushVideo(id, source, onSent)
            newVideos++   // ⚠️ 數在 Drive 成功之後：失敗是要回滾整列的
            return true
        } catch (e: Exception) {
            val rolled = api.deletePhoto(id)
            failures.add(
                if (rolled) "${source.name}：影片上傳 Google Drive 失敗（${errText(e)}）"
                else "${source.name}：影片上傳 Google Drive 失敗，且未能移除已建立的項目，請手動刪除（${errText(e)}）"
            )
            return false
        }
    }

    /** `pushVideoToDrive`：記不回 D1 要往外丟，呼叫端才會把那一列收掉 */
    private fun pushVideo(id: Long, source: MediaSource, onSent: (Long, Long) -> Unit) {
        val fid = folder() ?: throw IllegalStateException(driveError ?: "無法連線至 Google Drive")
        val originalId = drive.uploadResumable("${id}_${source.name}", fid, source, source.driveMime, onSent)
        if (!api.recordPhotoDrive(id, null, originalId).ok) {
            throw IllegalStateException("影片已上傳至 Google Drive，但未能記錄至網站，請將同一個檔案再上傳一次以補齊")
        }
    }

    /* ---- 照片與 GIF ---- */

    private fun ingestImage(source: MediaSource) {
        val gif = Media.isGif(source.mime, source.name)
        if (gif && source.size > Media.GIF_MAX_BYTES) {
            failures.add(
                "${source.name}：GIF 檔案過大（${Math.round(source.size / 1024.0 / 1024.0)}MB），" +
                    "上限 ${Media.GIF_MAX_BYTES / 1024 / 1024}MB，較長的動畫請改以影片格式上傳"
            )
            return
        }

        // 縮圖（長邊 2000 → 800／400）。GIF 的 ImageDecoder 解出來就是第一格
        val bmp = Media.decode(context, source.uri, 2000)
        val thumbs = try { Media.thumbs(bmp) } finally { bmp.recycle() }
        val phash = phashOf(thumbs)
        val exif = Media.exifJson(context, source.uri)
        val takenAt = Geo.normalizeGeo(exif).takenAtUtc
        // ⚠️ 不是動態照片也要送 0（不送的話那一列留在 NULL，後台補掃會再讀一次 Drive）
        val motionOffset = if (gif) 0L else MotionPhoto.read(source, source.mime, source.name)
        val gifBytes = if (gif) source.readAll() else null
        val kind = if (gif) "gif" else "photo"

        val result = api.upload(
            albumId, source.name, thumbs.md, thumbs.sm, exif?.toString(), takenAt,
            phash, kind, null, motionOffset, gifBytes, false,
        )
        when (result) {
            is Api.UploadResult.Created -> {
                newPhotos++
                pushOrRecord(result.id, source, fourK = !gif)
            }
            is Api.UploadResult.Duplicate -> {
                val twin = incompleteTwin(result.existing, kind)
                if (twin != null) {
                    val need4k = !twin.has4k && !gif
                    val needOrig = !twin.hasOriginal
                    val label = needLabel(need4k, needOrig)
                    if (folder() == null) {
                        driveMissing.add("${source.name}：Google Drive 缺少 $label（${driveError ?: "無法連線"}）")
                        backfilled.add("${source.name}：此檔案已存在，Google Drive 缺少 $label，已加入待補清單")
                        return
                    }
                    val res = try {
                        pushPhoto(twin.id, source, need4k, needOrig)
                    } catch (e: Exception) {
                        PushResult(false, "failed", "failed", errText(e))
                    }
                    if (res.ok) {
                        backfilled.add("${source.name}：已補上 Google Drive 的 $label")
                    } else {
                        driveMissing.add(
                            "${source.name}：Google Drive 缺少 " +
                                needLabel(res.fourK == "failed", res.original == "failed").ifEmpty { label }
                        )
                        failures.add("${source.name}：補齊 Google Drive 備份失敗（${res.reason ?: "Drive 上傳失敗"}）")
                    }
                    return
                }
                dupes.add(
                    PendingDup(
                        uri = source.uri, name = source.name, mime = source.mime, size = source.size,
                        reason = result.reason, existing = result.existing,
                        thumbMd = thumbs.md, thumbSm = thumbs.sm, phash = phash,
                        exifJson = exif?.toString(), takenAt = takenAt,
                        mediaType = kind, durationMs = null, motionOffset = motionOffset,
                    )
                )
            }
            is Api.UploadResult.Failed -> failures.add("${source.name}：${result.reason}")
        }
    }

    /** 照片的雜湊算的是 **400px 那顆**（同網頁 uploadPhoto 與後台的掃描） */
    private fun phashOf(t: Media.Thumbs): String? {
        val bytes = t.sm ?: t.md
        val b = BitmapFactory.decodeByteArray(bytes, 0, bytes.size) ?: return null
        return try { Phash.of(b) } finally { b.recycle() }
    }

    /** 照片已經在 R2 了：送 Drive，失敗**只是少一份備份**，記進 `driveMissing` */
    private fun pushOrRecord(id: Long, source: MediaSource, fourK: Boolean) {
        if (folder() == null) {
            driveMissing.add("${source.name}：Google Drive 備份未完成（${driveError ?: "無法連線"}）")
            return
        }
        val res = try {
            pushPhoto(id, source, fourK, true)
        } catch (e: Exception) {
            PushResult(false, "failed", "failed", errText(e))
        }
        if (!res.ok) driveMissing.add("${source.name}：Google Drive 備份未完成（${res.reason}）")
    }

    data class PushResult(val ok: Boolean, val fourK: String, val original: String, val reason: String?)

    /** `pushPhotoToDrive`。⚠️ 半套不算成功 */
    private fun pushPhoto(id: Long, source: MediaSource, want4k: Boolean, wantOriginal: Boolean): PushResult {
        val fid = folder() ?: return PushResult(false, "failed", "failed", driveError ?: "無法連線至 Google Drive")
        val base = source.name.replace(Regex("""\.[^/.]+$"""), "")
        val reasons = ArrayList<String>()

        var fourKId: String? = null
        var fourK = if (want4k) "failed" else "skipped"
        if (want4k) {
            try {
                val webp = Media.encode4kWebp(context, source.uri)
                if (webp != null) {
                    fourKId = drive.uploadMultipart("${id}_${base}_4k.webp", fid, webp, "image/webp")
                    fourK = "ok"
                } else {
                    reasons.add("此格式無法產生 4K WebP")
                }
            } catch (e: Exception) {
                reasons.add("4K：${errText(e)}")
            }
        }

        var originalId: String? = null
        var original = if (wantOriginal) "failed" else "skipped"
        if (wantOriginal) {
            try {
                originalId = if (source.size in 1..SMALL_FILE) {
                    drive.uploadMultipart("${id}_${source.name}", fid, source.readAll(), source.driveMime)
                } else {
                    drive.uploadResumable("${id}_${source.name}", fid, source, source.driveMime)
                }
                original = "ok"
            } catch (e: Exception) {
                reasons.add("原始檔：${errText(e)}")
            }
        }

        if (fourKId != null || originalId != null) {
            if (!api.recordPhotoDrive(id, fourKId, originalId).ok) {
                return PushResult(
                    false, "failed", "failed",
                    "已上傳至 Google Drive，但未能記錄至網站，請將同一個檔案再上傳一次以補齊",
                )
            }
        }
        val ok = fourK != "failed" && original != "failed"
        return PushResult(
            ok, fourK, original,
            if (ok) null else reasons.joinToString("；").ifEmpty { "Google Drive 上傳失敗" },
        )
    }

    /* ---- 重複的那幾張：使用者決定之後（網頁的 runDuplicateJob） ---- */

    /** @param replaceIds 空的＝全部保留；有值＝上傳新的之後刪掉這幾列 */
    fun runDuplicate(dup: PendingDup, replaceIds: List<Long>, onSent: (Long, Long) -> Unit) {
        val source = MediaSource(context, dup.uri, dup.name, dup.mime, dup.size)
        try {
            val gifBytes = if (dup.mediaType == "gif") source.readAll() else null
            val result = api.upload(
                albumId, dup.name, dup.thumbMd, dup.thumbSm, dup.exifJson, dup.takenAt,
                dup.phash, dup.mediaType, dup.durationMs, dup.motionOffset, gifBytes, true,
            )
            val id = when (result) {
                is Api.UploadResult.Created -> result.id
                is Api.UploadResult.Duplicate -> { failures.add("${dup.name}：伺服器仍判定為重複"); return }
                is Api.UploadResult.Failed -> { failures.add("${dup.name}：${result.reason}"); return }
            }
            if (dup.mediaType == "video") {
                if (!createdVideo(id, source, onSent)) return   // 回滾了，舊的不能刪
            } else {
                newPhotos++
                pushOrRecord(id, source, fourK = dup.mediaType != "gif")
            }
            if (replaceIds.isNotEmpty()) {
                val failed = replaceIds.count { !api.deletePhoto(it) }
                if (failed > 0) failures.add("${dup.name}：新照片已上傳，但有 $failed 張舊照片未刪除")
            }
        } catch (e: Exception) {
            failures.add("${dup.name}：${errText(e)}")
        }
    }

    companion object {
        /** 原始檔小於這個大小一趟 multipart 送完，大的走 resumable 分塊 */
        private const val SMALL_FILE = 5L * 1024 * 1024
    }
}

/** 撞到重複、等使用者決定的那一張。縮圖與雜湊都算好了，決定之後不必再解一次圖 */
class PendingDup(
    val uri: Uri,
    val name: String,
    val mime: String?,
    val size: Long,
    val reason: String,
    val existing: List<Api.ExistingPhoto>,
    val thumbMd: ByteArray,
    val thumbSm: ByteArray?,
    val phash: String?,
    val exifJson: String?,
    val takenAt: String?,
    val mediaType: String,
    val durationMs: Long?,
    val motionOffset: Long,
)

/**
 * 還在等使用者決定重複照片的那幾批，在服務與 `DuplicateActivity` 之間傳遞用。
 * 同一個行程裡的單例 —— 縮圖是位元組陣列，塞進 Intent 會撞上 Binder 的 1MB 上限。
 * ⚠️ 行程被殺掉就沒了：那些檔案本來就還沒上傳，使用者重新選一次即可。
 * 一批一個 `Ingest`（它自己的 `dupes` 就是那一批的清單），key 由小到大＝先來的先問。
 */
object DupStore {
    private val seq = java.util.concurrent.atomic.AtomicInteger(0)
    val sessions = java.util.concurrent.ConcurrentSkipListMap<Int, Ingest>()

    /**
     * 使用者已經逐張決定完、只等服務收工的那幾批。
     * ⚠️ 收工（`finishDup`）排在服務的佇列後面，前面還有好幾張在傳時要等很久 ——
     * 這段時間裡它還在 `sessions`，不另外記的話 MainActivity 一回前景就又把視窗端出來。
     */
    private val closed = java.util.concurrent.ConcurrentHashMap.newKeySet<Int>()

    fun add(ingest: Ingest): Int = seq.incrementAndGet().also { sessions[it] = ingest }

    /** 下一批還沒問完的（跳過已經決定完、等收工的） */
    fun first(): Map.Entry<Int, Ingest>? =
        sessions.entries.firstOrNull { it.key !in closed && it.value.dupes.isNotEmpty() }

    fun close(key: Int) { closed.add(key) }
}
