package tw.didadida.app.upload

import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MultipartBody
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject

/**
 * 站上那幾支 API 的 Kotlin 版本（只取上傳那條路用得到的）。
 *
 * ⚠️⚠️ **這一檔是 `apps/frontend/src/lib/api.ts` 的複本。** 欄位名一個字都不能差 ——
 *    後端 `POST /api/upload` 讀的是 multipart 的欄位名，寫錯不會報錯，只會安靜地
 *    少存一格（`motion_offset` 漏掉就留成 NULL，之後補掃得回 Drive 重讀一次檔頭）。
 *    網頁那條管線改了，這裡要跟著改（見 CLAUDE.md「Android App」）。
 */
class Api(private val base: String, private val token: String) {

    private fun req(path: String) = Request.Builder()
        .url(base + path)
        .header("Authorization", "Bearer " + token)

    private val json = "application/json".toMediaType()

    /* ---- 上傳 ---- */

    data class ExistingPhoto(
        val id: Long,
        val title: String,
        val thumbLg: String?,
        val thumbUrl: String?,
        val takenAt: String?,
        val mediaType: String,
        val sameFile: Boolean,
        val has4k: Boolean,
        val hasOriginal: Boolean,
    )

    sealed class UploadResult {
        data class Created(val id: Long, val lat: Double?, val lng: Double?) : UploadResult()
        data class Duplicate(val reason: String, val existing: List<ExistingPhoto>) : UploadResult()
        data class Failed(val reason: String) : UploadResult()
    }

    /**
     * `POST /api/upload`。
     *
     * ⚠️ `thumb` 與 `album_id` 缺一個就是 400；`thumb` 的 MIME 只收 jpeg／webp。
     * ⚠️ `motion_offset` **一定要送，0 也要送** —— 不送的話那一列留在 NULL，
     *    後端會當成「還沒掃過」。（它只在 media_type 是 photo 時被採用。）
     */
    fun upload(
        albumId: Long,
        filename: String,
        thumbMd: ByteArray,
        thumbSm: ByteArray?,
        exifJson: String?,
        takenAtIso: String?,
        phash: String?,
        mediaType: String,
        durationMs: Long?,
        motionOffset: Long,
        gifBytes: ByteArray?,
        allowDuplicate: Boolean,
    ): UploadResult {
        val webp = "image/webp".toMediaType()
        val body = MultipartBody.Builder().setType(MultipartBody.FORM)
        body.addFormDataPart("thumb", "thumb.webp", thumbMd.toRequestBody(webp))
        if (thumbSm != null) {
            body.addFormDataPart("thumb_sm", "thumb_sm.webp", thumbSm.toRequestBody(webp))
        }
        body.addFormDataPart("filename", filename)
        body.addFormDataPart("album_id", albumId.toString())
        if (exifJson != null) body.addFormDataPart("exif", exifJson)
        if (takenAtIso != null) body.addFormDataPart("taken_at", takenAtIso)
        if (phash != null) body.addFormDataPart("phash", phash)
        if (mediaType != "photo") body.addFormDataPart("media_type", mediaType)
        if (durationMs != null && durationMs > 0) {
            body.addFormDataPart("duration_ms", durationMs.toString())
        }
        body.addFormDataPart("motion_offset", motionOffset.toString())
        if (gifBytes != null) {
            body.addFormDataPart("gif", filename, gifBytes.toRequestBody("image/gif".toMediaType()))
        }
        if (allowDuplicate) body.addFormDataPart("allow_duplicate", "1")

        Net.client.newCall(req("/upload").post(body.build()).build()).execute().use { res ->
            val text = res.body?.string().orEmpty()
            if (!res.isSuccessful) {
                return UploadResult.Failed("伺服器回 " + res.code + "：" + text.take(120))
            }
            val obj = runCatching { JSONObject(text) }.getOrNull()
                ?: return UploadResult.Failed("伺服器回了看不懂的內容")
            if (obj.optBoolean("duplicate")) {
                val arr = obj.optJSONArray("existing") ?: JSONArray()
                val list = ArrayList<ExistingPhoto>(arr.length())
                for (i in 0 until arr.length()) {
                    val e = arr.getJSONObject(i)
                    list.add(
                        ExistingPhoto(
                            id = e.optLong("id"),
                            title = e.optString("title", ""),
                            thumbLg = e.optStringOrNull("thumb_lg"),
                            thumbUrl = e.optStringOrNull("thumb_url"),
                            takenAt = e.optStringOrNull("taken_at"),
                            mediaType = e.optString("media_type", "photo"),
                            // ⚠️ 邊快取裡躺著舊版後端的回應時這幾欄是 undefined，
                            //    預設值要跟 api.ts 同一套：same_file 當 false、兩份當已經有
                            sameFile = e.optBoolean("same_file", false),
                            has4k = e.optBoolean("has_4k", true),
                            hasOriginal = e.optBoolean("has_original", true),
                        )
                    )
                }
                return UploadResult.Duplicate(obj.optString("reason", "same_time"), list)
            }
            return UploadResult.Created(
                id = obj.optLong("id"),
                lat = if (obj.isNull("lat")) null else obj.optDouble("lat"),
                lng = if (obj.isNull("lng")) null else obj.optDouble("lng"),
            )
        }
    }

    /* ---- Drive ---- */

    data class DriveToken(
        val accessToken: String?,
        val expiresIn: Long,
        val error: String?,
        val reason: String?,
    )

    /** `POST /api/drive/token`：站長那張 refresh token 換一顆短效 access token */
    fun driveToken(): DriveToken {
        val empty = ByteArray(0).toRequestBody(json)
        Net.client.newCall(req("/drive/token").post(empty).build()).execute().use { res ->
            val obj = runCatching { JSONObject(res.body?.string().orEmpty()) }.getOrNull()
            return DriveToken(
                accessToken = obj?.optStringOrNull("access_token"),
                expiresIn = obj?.optLong("expires_in") ?: 0L,
                error = obj?.optStringOrNull("error")
                    ?: if (res.isSuccessful) null else "http_" + res.code,
                reason = obj?.optStringOrNull("reason"),
            )
        }
    }

    data class DriveConfig(
        val saEmail: String?,
        val photosFolderId: String?,
        val trashFolderId: String?,
        val rootFolderName: String?,
    )

    fun driveConfig(): DriveConfig {
        Net.client.newCall(req("/config/drive").get().build()).execute().use { res ->
            val obj = runCatching { JSONObject(res.body?.string().orEmpty()) }.getOrNull()
                ?: return DriveConfig(null, null, null, null)
            return DriveConfig(
                saEmail = obj.optStringOrNull("sa_email"),
                photosFolderId = obj.optStringOrNull("photos_folder_id"),
                trashFolderId = obj.optStringOrNull("trash_folder_id"),
                rootFolderName = obj.optStringOrNull("root_folder_name"),
            )
        }
    }

    fun saveDriveFolders(photosFolderId: String, trashFolderId: String) {
        val payload = JSONObject()
            .put("photos_folder_id", photosFolderId)
            .put("trash_folder_id", trashFolderId)
        runCatching {
            Net.client
                .newCall(req("/config/drive-folders").post(payload.toString().toRequestBody(json)).build())
                .execute().close()
        }
    }

    data class AlbumInfo(val name: String, val driveFolderId: String?)

    fun album(albumId: Long): AlbumInfo? {
        Net.client.newCall(req("/albums/" + albumId).get().build()).execute().use { res ->
            if (!res.isSuccessful) return null
            val obj = runCatching { JSONObject(res.body?.string().orEmpty()) }.getOrNull() ?: return null
            return AlbumInfo(obj.optString("name", ""), obj.optStringOrNull("drive_folder_id"))
        }
    }

    /** ⚠️ 一律用**回傳的** folder_id：另一邊可能在這中間已經建好一個了 */
    fun saveAlbumDriveFolder(albumId: Long, folderId: String, rebind: Boolean): String {
        val payload = JSONObject().put("folder_id", folderId)
        if (rebind) payload.put("rebind", true)
        val call = req("/albums/" + albumId + "/drive-folder").post(payload.toString().toRequestBody(json))
        Net.client.newCall(call.build()).execute().use { res ->
            val obj = runCatching { JSONObject(res.body?.string().orEmpty()) }.getOrNull()
            return obj?.optStringOrNull("folder_id") ?: folderId
        }
    }

    data class RecordResult(val ok: Boolean, val retryable: Boolean)

    /**
     * `POST /api/photos/:id/drive`。
     * **這一步比上傳本身更不能掉** —— 檔案已經在 Drive 上了，沒記回來就是一個孤兒
     *（站上看起來「沒備份」→ 使用者去補傳 → Drive 上再多一份）。
     */
    fun recordPhotoDrive(photoId: Long, driveFileId: String?, driveOriginalId: String?): RecordResult {
        val payload = JSONObject()
        if (driveFileId != null) payload.put("drive_file_id", driveFileId)
        if (driveOriginalId != null) payload.put("drive_original_id", driveOriginalId)
        return try {
            val call = req("/photos/" + photoId + "/drive").post(payload.toString().toRequestBody(json))
            Net.client.newCall(call.build()).execute().use { res ->
                RecordResult(res.isSuccessful, res.code >= 500 || res.code == 429)
            }
        } catch (e: Exception) {
            RecordResult(false, true) // 網路層的錯值得再試
        }
    }

    /** 影片的 Drive 失敗要回滾掉剛建的那一列。⚠️ 它自己也會失敗，呼叫端要看回傳值 */
    fun deletePhoto(photoId: Long): Boolean = try {
        Net.client.newCall(req("/photos/" + photoId).delete().build()).execute().use { it.isSuccessful }
    } catch (e: Exception) {
        false
    }

    /**
     * `POST /api/uploads/announce`：一批收工時通知全站一次。
     * ⚠️ 零張不送（站上一格新的都沒多出來，講「有新東西」是句假話），
     *    失敗一律吞掉（通知掉一則無所謂，把剛傳完的那批講成失敗就糟了）。
     */
    fun announceUpload(albumId: Long, photos: Int, videos: Int) {
        if (photos + videos <= 0) return
        val payload = JSONObject()
            .put("album_id", albumId)
            .put("photos", photos)
            .put("videos", videos)
        runCatching {
            Net.client
                .newCall(req("/uploads/announce").post(payload.toString().toRequestBody(json)).build())
                .execute().close()
        }
    }
}

/** org.json 的 optString 會把 JSON null 變成 "null"／""，這裡要分得出來 */
internal fun JSONObject.optStringOrNull(key: String): String? =
    if (isNull(key)) null else optString(key).ifEmpty { null }
