package tw.didadida.app.upload

import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MultipartBody
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.net.URLEncoder

/**
 * Google Drive：資料夾、小檔 multipart、大檔 resumable 分塊。
 *
 * ⚠️⚠️ **這一檔是 `apps/frontend/src/lib/drive.ts` 的複本**，行為要一模一樣，
 *    尤其這三件：① 分塊 8MB（**必須是 256KB 的整數倍**，不然 Drive 不收）；
 *    ② 分塊的 PUT **不帶 Authorization**（工作階段網址本身就授權過了，
 *    所以傳一小時也不怕 access token 過期）；③ 308 要照 `Range: bytes=0-N` 接著傳。
 * ⚠️ access token **只留在記憶體裡**，不寫檔、不進 SharedPreferences。
 */

/** 拿不到授權／資料夾讀不到 —— 整批停在這裡比較好，繼續跑只會每一張都失敗 */
class DriveAccessError(message: String) : Exception(message)

class DriveHttpError(val status: Int, message: String) : Exception(message)

/** 可以重讀同一段的位元組來源（重試時要從 Drive 說的那個位置接著傳） */
interface ByteSource {
    val size: Long
    fun read(offset: Long, len: Int): ByteArray
}

class Drive(private val api: Api) {

    companion object {
        private const val FILES = "https://www.googleapis.com/drive/v3/files"
        private const val UPLOAD = "https://www.googleapis.com/upload/drive/v3/files"
        private const val FOLDER_MIME = "application/vnd.google-apps.folder"
        private const val FALLBACK_ROOT_FOLDER_NAME = "didadida"
        private const val TRASH_FOLDER_NAME = "trash"

        /** ⚠️ 必須是 256KB 的整數倍 */
        private const val CHUNK_BYTES = 8 * 1024 * 1024
        private const val RESUMABLE_MAX_RETRY = 4
        private const val RETRY_TIMES = 3
    }

    private var token: String? = null
    private var tokenExpiresAt = 0L
    private var cfg: Api.DriveConfig? = null
    private var rootFolderId: String? = null

    /** 同一批裡同一本相簿只驗一次 */
    private val verifiedFolders = HashMap<Long, String>()

    /* ---------- token ---------- */

    private fun token(): String {
        token?.let { if (System.currentTimeMillis() < tokenExpiresAt) return it }
        val res = api.driveToken()
        val t = res.accessToken ?: throw DriveAccessError(
            when (res.reason) {
                "not_linked" -> "站長的 Google Drive 還沒連結，請站長用 Google 登入一次"
                "expired" -> "站長的 Google Drive 授權失效了，請站長重新用 Google 登入"
                else -> "拿不到 Google Drive 授權（" + (res.error ?: "unknown") + "）"
            }
        )
        token = t
        // 提早 60 秒過期，免得正好卡在一趟傳到一半
        val ttl = if (res.expiresIn > 60) res.expiresIn - 60 else 540
        tokenExpiresAt = System.currentTimeMillis() + ttl * 1000
        return t
    }

    /* ---------- 共用的請求 ---------- */

    private fun json(res: okhttp3.Response, what: String): JSONObject {
        val text = res.body?.string().orEmpty()
        if (!res.isSuccessful) throw DriveHttpError(res.code, what + " " + res.code + "：" + text.take(200))
        return runCatching { JSONObject(text) }.getOrElse { JSONObject() }
    }

    private fun get(url: String): JSONObject {
        val req = Request.Builder().url(url).header("Authorization", "Bearer " + token()).get().build()
        Net.client.newCall(req).execute().use { return json(it, "Drive") }
    }

    private fun postJson(url: String, payload: JSONObject): JSONObject {
        val req = Request.Builder().url(url)
            .header("Authorization", "Bearer " + token())
            .post(payload.toString().toRequestBody("application/json; charset=UTF-8".toMediaType()))
            .build()
        Net.client.newCall(req).execute().use { return json(it, "Drive") }
    }

    private fun enc(s: String) = URLEncoder.encode(s, "UTF-8")

    /**
     * ⚠️ 先跳脫反斜線再跳脫單引號 —— 順序反了會把自己剛加上去的那個反斜線再跳脫一次。
     */
    private fun esc(s: String) = s.replace("\\", "\\\\").replace("'", "\\'")

    /* ---------- 資料夾 ---------- */

    /** ⚠️ 照名字找，Drive 裡留著同名舊資料夾會被直接接管 */
    private fun findOwnFolder(name: String, parent: String?): String? {
        val q = StringBuilder("name='").append(esc(name)).append("' and mimeType='")
            .append(FOLDER_MIME).append("' and trashed=false")
        if (parent != null) q.append(" and '").append(esc(parent)).append("' in parents")
        val url = FILES + "?q=" + enc(q.toString()) + "&fields=" + enc("files(id)") + "&pageSize=1"
        val files = get(url).optJSONArray("files") ?: return null
        return if (files.length() > 0) files.getJSONObject(0).optStringOrNull("id") else null
    }

    private fun createFolder(name: String, parent: String?): String {
        val payload = JSONObject().put("name", name).put("mimeType", FOLDER_MIME)
        if (parent != null) payload.put("parents", JSONArray().put(parent))
        return postJson(FILES + "?fields=id", payload).optString("id")
    }

    /** 分享給 service account（讀檔那一頭要）。已經分享過會回 4xx，吞掉 */
    private fun shareWithServiceAccount(fileId: String, saEmail: String) {
        runCatching {
            postJson(
                FILES + "/" + fileId + "/permissions?sendNotificationEmail=false&fields=id",
                JSONObject().put("role", "writer").put("type", "user").put("emailAddress", saEmail),
            )
        }
    }

    private fun config(): Api.DriveConfig = cfg ?: api.driveConfig().also { cfg = it }

    /** 站台的根資料夾（三個環境靠 DRIVE_ROOT_FOLDER 的名字分開） */
    private fun ensureRoot(): String {
        rootFolderId?.let { return it }
        val c = config()
        c.photosFolderId?.let { rootFolderId = it; return it }

        val rootName = c.rootFolderName?.takeIf { it.isNotBlank() } ?: FALLBACK_ROOT_FOLDER_NAME
        val root = findOwnFolder(rootName, null) ?: createFolder(rootName, null)
        val trash = findOwnFolder(TRASH_FOLDER_NAME, root) ?: createFolder(TRASH_FOLDER_NAME, root)
        c.saEmail?.let {
            shareWithServiceAccount(root, it)
            shareWithServiceAccount(trash, it)
        }
        api.saveDriveFolders(root, trash)
        rootFolderId = root
        return root
    }

    private data class Probe(val ok: Boolean, val status: Int, val canAddChildren: Boolean)

    private fun probeFolder(folderId: String): Probe = try {
        val obj = get(FILES + "/" + folderId + "?fields=" + enc("id,name,capabilities/canAddChildren"))
        Probe(true, 200, obj.optJSONObject("capabilities")?.optBoolean("canAddChildren") ?: false)
    } catch (e: DriveHttpError) {
        Probe(false, e.status, false)
    }

    /**
     * 相簿的資料夾。
     * ⚠️⚠️ **只有 404 才重綁。** 403（權限被拿掉）、5xx（Drive 在鬧）都不是
     *    「那個資料夾不見了」—— 重綁會在 Drive 上多開一個空資料夾，而舊的那些檔
     *    從此沒有任何一本相簿指著。
     */
    fun ensureAlbumFolder(albumId: Long): String {
        verifiedFolders[albumId]?.let { return it }
        val root = ensureRoot()
        // ⚠️ 現撈一次，不要相信手上那份相簿 JSON：另一頭可能剛建好
        val album = api.album(albumId) ?: throw DriveAccessError("找不到相簿 " + albumId)

        val bound = album.driveFolderId
        if (bound != null) {
            val p = probeFolder(bound)
            if (p.ok && p.canAddChildren) {
                verifiedFolders[albumId] = bound
                return bound
            }
            if (p.status != 404) {
                throw DriveAccessError("相簿的 Drive 資料夾讀不到（" + p.status + "），先不重綁以免多開一個")
            }
        }

        val name = album.name.trim().ifEmpty { "相簿 " + albumId }
        val folder = findOwnFolder(name, root) ?: createFolder(name, root)
        config().saEmail?.let { shareWithServiceAccount(folder, it) }
        // ⚠️ 一律用**回傳的** id：另一邊可能在這中間已經建好一個了
        val saved = api.saveAlbumDriveFolder(albumId, folder, bound != null)
        verifiedFolders[albumId] = saved
        return saved
    }

    /* ---------- 重試 ---------- */

    /**
     * ⚠️ **只有 5xx／429／網路層丟出來的才重試。** 4xx 一律不重試 ——
     *    403 是權限、404 是資料夾被搬走，試一百次一樣。
     */
    private fun <T> withRetry(block: () -> T): T {
        var attempt = 0
        while (true) {
            try {
                return block()
            } catch (e: DriveHttpError) {
                val retryable = e.status >= 500 || e.status == 429
                if (!retryable || ++attempt >= RETRY_TIMES) throw e
            } catch (e: IOException) {
                if (++attempt >= RETRY_TIMES) throw e
            }
            Thread.sleep(attempt * 1000L)
        }
    }

    /* ---------- 上傳 ---------- */

    /** 小檔（4K WebP、GIF、照片原始檔）走 multipart 一趟 */
    fun uploadMultipart(name: String, folderId: String, bytes: ByteArray, mime: String): String = withRetry {
        val meta = JSONObject().put("name", name).put("parents", JSONArray().put(folderId))
        val body = MultipartBody.Builder().setType("multipart/related".toMediaType())
            .addPart(meta.toString().toRequestBody("application/json; charset=UTF-8".toMediaType()))
            .addPart(bytes.toRequestBody(mime.toMediaType()))
            .build()
        val req = Request.Builder().url(UPLOAD + "?uploadType=multipart&fields=id")
            .header("Authorization", "Bearer " + token())
            .post(body).build()
        Net.client.newCall(req).execute().use { json(it, "Drive 上傳失敗").optString("id") }
    }

    /**
     * 大檔（影片、幾十 MB 的原始檔）走 resumable 分塊。
     * ⚠️ **不要改成經過 Worker** —— Worker 請求體上限 100MB，幾 GB 的檔直接爆。
     */
    fun uploadResumable(
        name: String,
        folderId: String,
        source: ByteSource,
        mime: String,
        onProgress: ((Long, Long) -> Unit)? = null,
    ): String {
        val total = source.size
        if (total <= 0L) throw DriveHttpError(0, "檔案是空的，沒有東西可以傳")

        // 開工作階段這一趟才帶 Authorization（它本來就有自己的重試）
        val session = withRetry {
            val meta = JSONObject().put("name", name).put("parents", JSONArray().put(folderId))
            val req = Request.Builder().url(UPLOAD + "?uploadType=resumable&fields=id")
                .header("Authorization", "Bearer " + token())
                .header("X-Upload-Content-Type", mime)
                .header("X-Upload-Content-Length", total.toString())
                .post(meta.toString().toRequestBody("application/json; charset=UTF-8".toMediaType()))
                .build()
            Net.client.newCall(req).execute().use { res ->
                if (!res.isSuccessful) {
                    throw DriveHttpError(res.code, "Drive 開不了上傳工作階段 " + res.code)
                }
                res.header("Location") ?: throw DriveHttpError(res.code, "Drive 沒有給工作階段網址")
            }
        }

        var offset = 0L
        var attempt = 0
        while (true) {
            val len = minOf(CHUNK_BYTES.toLong(), total - offset).toInt()
            if (len <= 0) throw DriveHttpError(0, "Drive 收下了全部位元組卻沒有回檔案 id")
            val end = offset + len

            val outcome = try {
                val chunk = source.read(offset, len)
                // ⚠️⚠️ 分塊的 PUT **不帶 Authorization**
                val put = Request.Builder().url(session)
                    .header("Content-Range", "bytes " + offset + "-" + (end - 1) + "/" + total)
                    .put(chunk.toRequestBody(mime.toMediaType()))
                    .build()
                Net.client.newCall(put).execute().use { res ->
                    when {
                        res.code == 308 -> Outcome.Next(rangeEnd(res.header("Range")) ?: end)
                        res.isSuccessful ->
                            Outcome.Done(json(res, "Drive 分塊上傳").optString("id"))
                        res.code >= 500 -> Outcome.Retry(res.code)
                        else -> throw DriveHttpError(res.code, "Drive 分塊上傳失敗 " + res.code)
                    }
                }
            } catch (e: IOException) {
                Outcome.Retry(0)
            }

            when (outcome) {
                is Outcome.Done -> return outcome.id
                is Outcome.Next -> {
                    attempt = 0
                    offset = outcome.offset
                    onProgress?.invoke(offset, total)
                }
                is Outcome.Retry -> {
                    if (++attempt > RESUMABLE_MAX_RETRY) {
                        throw DriveHttpError(outcome.status, "Drive 分塊上傳重試多次仍失敗")
                    }
                    Thread.sleep(attempt * 1000L)
                    offset = resumeOffset(session, total)
                    onProgress?.invoke(offset, total)
                }
            }
        }
    }

    private sealed class Outcome {
        data class Done(val id: String) : Outcome()
        data class Next(val offset: Long) : Outcome()
        data class Retry(val status: Int) : Outcome()
    }

    /** 問 Drive「你收到哪裡了」：`bytes *&#47;total` */
    private fun resumeOffset(session: String, total: Long): Long {
        val req = Request.Builder().url(session)
            .header("Content-Range", "bytes */" + total)
            .put(ByteArray(0).toRequestBody(null))
            .build()
        Net.client.newCall(req).execute().use { res ->
            if (res.code == 308) return rangeEnd(res.header("Range")) ?: 0L
            if (res.isSuccessful) return total
            throw DriveHttpError(res.code, "Drive 查不到上傳進度 " + res.code)
        }
    }

    private fun rangeEnd(header: String?): Long? {
        val m = Regex("bytes=0-(\\d+)").find(header ?: return null) ?: return null
        return m.groupValues[1].toLong() + 1
    }
}
