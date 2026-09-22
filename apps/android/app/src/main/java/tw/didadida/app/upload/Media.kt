package tw.didadida.app.upload

import android.content.Context
import android.graphics.Bitmap
import android.graphics.ImageDecoder
import android.net.Uri
import android.os.Build
import androidx.exifinterface.media.ExifInterface
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream

/**
 * 照片那條管線的 Kotlin 版本。
 *
 * ⚠️⚠️ **這一檔是 `apps/frontend/src/lib/imageUtils.ts` ＋ `api.ts` 縮圖那幾個常數的複本。**
 *    數字改了兩邊要一起改（見 CLAUDE.md「Android App」）。
 *
 * 跟網頁那條**刻意不同**的只有一件事，而且它有後果：
 *   網頁是「原圖 →（EXIF 轉正的）2000px JPEG → 800／400 縮圖」，中間那張 2000px
 *   只餵縮圖、從來不上傳。這裡直接從原圖解一次就產 800／400，**少一次重取樣**
 *   （畫質反而好一點，記憶體也省）。代價是**同一個檔從 App 傳與從網頁傳，
 *   800px 的位元組不會一樣 → `file_hash` 不一樣 → 對不上 `same_file`**。
 *   那只影響重複偵測的那一半（`same_time` 還是抓得到），而要讓它一樣就得把
 *   網頁那個「先縮 2000 再縮 800」的雙重取樣連同 JPEG 的量化誤差一起複製過來 ——
 *   複製得再像也不保證位元組相同（不同的 libwebp 版本就差了）。**不要嘗試。**
 *
 * ⚠️ EXIF 的 `Orientation` **只能被套用一次**。`ImageDecoder` 已經幫我們轉正了，
 *    所以底下**不會**再自己轉一次；而交出去的縮圖是重新編碼的 WebP、不帶 EXIF，
 *    也就不會有人再轉第二次（網頁那個「縮圖躺著」的 bug 就是被套了兩次）。
 */
object Media {

    /* ---- 常數：跟網頁同一組 ---- */

    /** api.ts 的 THUMB_QUALITY 0.8 */
    private const val THUMB_QUALITY = 80
    /** api.ts 的 THUMB_MAX_EDGE_SM／MD */
    const val THUMB_MAX_EDGE_SM = 400
    const val THUMB_MAX_EDGE_MD = 800
    /** imageUtils.ts 的 encode4kWebp(file, maxEdge = 3840)，quality 0.8 */
    private const val FOURK_MAX_EDGE = 3840
    private const val FOURK_QUALITY = 80

    /** imageUtils.ts 的 GIF_MAX_BYTES。⚠️ 後端 index.ts 有同一個數字，要改一起改 */
    const val GIF_MAX_BYTES = 25L * 1024 * 1024

    /* ---- 解碼 ---- */

    /**
     * 解一張圖，長邊不超過 [maxEdge]（只縮不放）。
     *
     * ⚠️ 一定要走 `ImageDecoder`：`BitmapFactory` 不看 EXIF 的 Orientation，
     *    而且 minSdk 28 的 ImageDecoder 本來就讀得了 HEIC／HEIF ——
     *    網頁那邊得先拉一整包 heic2any 進來轉，這裡不必。
     * ⚠️ `setTargetSampleSize` 是為了記憶體：5000 萬像素的原圖整張進來是 200MB，
     *    前景服務照樣會被 OOM 掉。取樣只取 2 的次方，所以之後還要再精縮一次。
     */
    fun decode(context: Context, uri: Uri, maxEdge: Int): Bitmap {
        val src = ImageDecoder.createSource(context.contentResolver, uri)
        val bmp = ImageDecoder.decodeBitmap(src) { decoder, info, _ ->
            decoder.allocator = ImageDecoder.ALLOCATOR_SOFTWARE  // 之後要讀 pixel（dHash）
            decoder.isMutableRequired = false
            var sample = 1
            val long = maxOf(info.size.width, info.size.height)
            while (long / (sample * 2) >= maxEdge) sample *= 2
            if (sample > 1) decoder.setTargetSampleSize(sample)
        }
        return scaleDown(bmp, maxEdge)
    }

    /** 只縮不放 —— 原圖比目標還小的時候放大只會多佔位元組，畫質一點都不會變好 */
    fun scaleDown(bmp: Bitmap, maxEdge: Int): Bitmap {
        val long = maxOf(bmp.width, bmp.height)
        if (long <= maxEdge) return bmp
        val scale = maxEdge.toDouble() / long
        val w = maxOf(1, Math.round(bmp.width * scale).toInt())
        val h = maxOf(1, Math.round(bmp.height * scale).toInt())
        val out = Bitmap.createScaledBitmap(bmp, w, h, true)  // filter = true ＝ 雙線性
        if (out !== bmp) bmp.recycle()
        return out
    }

    /* ---- 編碼 ---- */

    private fun webpFormat(): Bitmap.CompressFormat =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            Bitmap.CompressFormat.WEBP_LOSSY
        } else {
            @Suppress("DEPRECATION")
            Bitmap.CompressFormat.WEBP
        }

    fun webp(bmp: Bitmap, quality: Int): ByteArray {
        val out = ByteArrayOutputStream(1 shl 18)
        if (!bmp.compress(webpFormat(), quality, out)) {
            throw IllegalStateException("WebP 編碼失敗")
        }
        return out.toByteArray()
    }

    data class Thumbs(val md: ByteArray, val sm: ByteArray?)

    /**
     * 800 ＋ 400 兩顆 WebP。**共用同一次解碼**（api.ts 的 generateThumbnails 也是）。
     * ⚠️ 800 那顆是必填的，400 編不出來只會讓首頁輪播與地圖標記退回 800。
     */
    fun thumbs(source: Bitmap): Thumbs {
        val md = scaleDownCopy(source, THUMB_MAX_EDGE_MD)
        val mdBytes = webp(md, THUMB_QUALITY)
        val sm = scaleDownCopy(md, THUMB_MAX_EDGE_SM)
        val smBytes = runCatching { webp(sm, THUMB_QUALITY) }.getOrNull()
        if (sm !== md) sm.recycle()
        if (md !== source) md.recycle()
        return Thumbs(mdBytes, smBytes)
    }

    /** 跟 scaleDown 一樣，只是**不會**回收傳進來的那張（呼叫端還要用） */
    fun scaleDownCopy(bmp: Bitmap, maxEdge: Int): Bitmap {
        val long = maxOf(bmp.width, bmp.height)
        if (long <= maxEdge) return bmp
        val scale = maxEdge.toDouble() / long
        val w = maxOf(1, Math.round(bmp.width * scale).toInt())
        val h = maxOf(1, Math.round(bmp.height * scale).toInt())
        return Bitmap.createScaledBitmap(bmp, w, h, true)
    }

    /**
     * Drive 上那份 4K WebP（imageUtils.ts 的 `encode4kWebp`）。
     * ⚠️ **只縮不放**：原圖本來就小於 3840 時照原尺寸編，不要放大。
     * ⚠️ GIF 不走這裡（使用者拍板：GIF 的 Drive 只放原始檔一份，
     *    「4K WebP」對它是把第一格放大成一張靜態圖，存了沒有用途）。
     */
    fun encode4kWebp(context: Context, uri: Uri): ByteArray? = runCatching {
        val bmp = decode(context, uri, FOURK_MAX_EDGE)
        try {
            webp(bmp, FOURK_QUALITY)
        } finally {
            bmp.recycle()
        }
    }.getOrNull()

    /* ---- EXIF ---- */

    /**
     * 後端 `uploadPhoto` 的 EXIF 白名單。**沒列到的鍵會被丟掉**，
     * 所以這裡塞了也是白塞；而漏掉一個（例如影片那邊的 `_video`）就會安靜地少一格。
     */
    private val WHITELIST = listOf(
        "Make", "Model", "DateTimeOriginal", "Software", "Orientation",
        "ExposureTime", "FNumber", "ISO", "FocalLength", "LensModel",
        "latitude", "longitude",
        "GPSLatitude", "GPSLatitudeRef", "GPSLongitude", "GPSLongitudeRef",
        "GPSAltitude", "GPSAltitudeRef",
        "OffsetTimeOriginal", "GPSDateStamp", "GPSTimeStamp",
        "_video",
    )

    /** 把一份 JSONObject 濾成白名單內的鍵，並丟掉 null／空字串 */
    fun whitelist(src: JSONObject): JSONObject {
        val out = JSONObject()
        for (k in WHITELIST) {
            if (!src.has(k) || src.isNull(k)) continue
            val v = src.get(k)
            if (v is String && v.isEmpty()) continue
            out.put(k, v)
        }
        return out
    }

    /**
     * 讀一張照片的 EXIF，湊成 `normalizeGeo()` 吃得下的形狀。
     *
     * ⚠️⚠️ **時間一律交原始字串，不要自己轉成毫秒或 Date。**
     *    `taken_at = taken_at_local − tz` 這個不變量全站只能有一份實作
     *    （後端的 `normalizeGeo`）。網頁那邊為了這件事還得把 exifr 重新解析一次
     *    （它會拿「瀏覽器的時區」把 EXIF 時間 revive 成 Date，日本 09:30 從台灣傳
     *    會變成 01:30Z）—— `ExifInterface` 回的本來就是原始字串，天然沒有那個坑。
     *
     * ⚠️ 座標優先給十進位的 `latitude`／`longitude`（`toDecimalCoord` 的第一條路），
     *    這樣就不必在這裡重做一次 DMS ＋ Ref 的換算。
     * ⚠️ `GPSTimeStamp` 給**陣列** `[h, m, s]`：`ExifInterface` 回的是 "16:11:0"
     *    這種字串，而 geo.ts 那個字串分支要求秒是兩位數，會比不中。
     *
     * 讀不到一律回 null —— 「這張照片沒有 EXIF」跟上傳成不成功無關，**絕不往外丟**。
     */
    fun exifJson(context: Context, uri: Uri): JSONObject? = runCatching {
        val exif = context.contentResolver.openInputStream(uri)?.use { ExifInterface(it) }
            ?: return null
        val o = JSONObject()

        fun str(tag: String, key: String) {
            val v = exif.getAttribute(tag)?.replace("\u0000", "")?.trim()
            if (!v.isNullOrEmpty()) o.put(key, v)
        }
        fun num(tag: String, key: String) {
            val v = exif.getAttributeDouble(tag, Double.NaN)
            if (!v.isNaN()) o.put(key, v)
        }

        str(ExifInterface.TAG_MAKE, "Make")
        str(ExifInterface.TAG_MODEL, "Model")
        str(ExifInterface.TAG_SOFTWARE, "Software")
        str(ExifInterface.TAG_LENS_MODEL, "LensModel")
        str(ExifInterface.TAG_DATETIME_ORIGINAL, "DateTimeOriginal")
        str(ExifInterface.TAG_OFFSET_TIME_ORIGINAL, "OffsetTimeOriginal")
        str(ExifInterface.TAG_GPS_DATESTAMP, "GPSDateStamp")

        val orientation = exif.getAttributeInt(ExifInterface.TAG_ORIENTATION, 0)
        // ⚠️ 位元組已經被 ImageDecoder 轉正了，這一格純粹是給燈箱那塊面板看的紀錄。
        //    **不要拿它再轉一次圖。**
        if (orientation > 0) o.put("Orientation", orientation)

        num(ExifInterface.TAG_EXPOSURE_TIME, "ExposureTime")
        num(ExifInterface.TAG_F_NUMBER, "FNumber")
        num(ExifInterface.TAG_FOCAL_LENGTH, "FocalLength")
        val iso = exif.getAttributeInt(ExifInterface.TAG_PHOTOGRAPHIC_SENSITIVITY, 0)
        if (iso > 0) o.put("ISO", iso)

        exif.latLong?.let { (lat, lng) ->
            o.put("latitude", lat)
            o.put("longitude", lng)
        }
        num(ExifInterface.TAG_GPS_ALTITUDE, "GPSAltitude")
        str(ExifInterface.TAG_GPS_ALTITUDE_REF, "GPSAltitudeRef")

        // "16:11:0" 或 "16/1:11/1:0/1" 都拆得開
        exif.getAttribute(ExifInterface.TAG_GPS_TIMESTAMP)?.let { raw ->
            val parts = raw.trim().split(":")
            if (parts.size >= 3) {
                val arr = JSONArray()
                var ok = true
                for (p in parts.take(3)) {
                    val n = p.split("/").let { f ->
                        when {
                            f.size == 2 -> f[0].toDoubleOrNull()?.div(f[1].toDoubleOrNull() ?: 0.0)
                            else -> f[0].toDoubleOrNull()
                        }
                    }
                    if (n == null || n.isNaN() || n.isInfinite()) { ok = false; break }
                    arr.put(n)
                }
                if (ok) o.put("GPSTimeStamp", arr)
            }
        }

        if (o.length() == 0) null else whitelist(o)
    }.getOrNull()

    /* ---- 雜項 ---- */

    /** imageUtils.ts 的 `isGifFile`：先看 MIME，沒有才看副檔名 */
    fun isGif(mime: String?, name: String): Boolean =
        if (!mime.isNullOrEmpty()) mime.lowercase() == "image/gif"
        else name.endsWith(".gif", ignoreCase = true)
}
