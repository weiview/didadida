package tw.didadida.app.upload

import org.json.JSONArray
import org.json.JSONObject
import java.util.GregorianCalendar
import java.util.TimeZone

/**
 * EXIF 的時間與座標正規化。
 *
 * ⚠️⚠️ **這一檔是 `apps/frontend/src/lib/geo.ts` 的複本**（那邊還有一份 CRLF 的
 *    後端副本）。網頁上傳時 `resizeImageFile()` 就是拿 `normalizeGeo(exif).takenAtUtc`
 *    當 `taken_at` 這個表單欄位送上去的（`lib/imageUtils.ts:117`），所以 App 不做
 *    這一段的話，原生傳上去的每一張照片 `taken_at` 都會是 NULL —— 而且錯得很安靜：
 *    照片進得了相簿，只是全部沉在「沒有拍攝時間」那一疊的最前面。
 *
 * ⚠️ 全站不變式 **`taken_at = taken_at_local − tz_offset_minutes`** 只能有一份實作，
 *    那份是 `utcFromLocal()`。要算 UTC 瞬間一律走它，不要在別處自己拼字串。
 *
 * 這裡**只搬時間與座標那一段**：`GEO_RANK`／`geoOverwriteGuard()` 是產 SQL 片段用的，
 * 只有後端會用到，App 一行都碰不到。
 */
object Geo {

    /**
     * 站台預設時區偏移（分鐘）。UTC+8 台灣。
     *
     * 照片只有牆上時間、拿不到任何時區資訊時只能假設它就是這個時區。使用者的機身
     * 時鐘常年設在台灣時間、出國也不改，所以這個假設對絕大多數照片成立。
     * 「這個值是猜的」由 `timeSource = "assumed"` 記錄。
     */
    const val DEFAULT_TZ_OFFSET_MINUTES = 480

    /** 地球上實際存在的最大時區偏移為 UTC+14 */
    private const val MAX_TZ_OFFSET_MINUTES = 14 * 60

    /*
     * taken_at（UTC 瞬間）的來源，可信度由高而低。**這四個字串要跟網頁一字不差**
     * —— 它們直接進 D1 的 `Photo.time_source`，燈箱那塊面板照它判斷時間改不改得動。
     *   "offset_tag" EXIF OffsetTimeOriginal，相機自己寫的時區，精確
     *   "gps_utc"    由 GPSTimeStamp（UTC）與牆上時間相減得出，精確
     *   "file_time"  檔案時間 —— 瞬間精確，但可能不是快門時間
     *   "assumed"    只有牆上時間，時區是 DEFAULT_TZ_OFFSET_MINUTES 假設的
     * （"manual" 是使用者親手改的，只會從後端寫進去，這裡產不出來。）
     */
    const val TIME_OFFSET_TAG = "offset_tag"
    const val TIME_GPS_UTC = "gps_utc"
    const val TIME_FILE_TIME = "file_time"
    const val TIME_ASSUMED = "assumed"

    data class WallClock(val y: Int, val mo: Int, val d: Int, val h: Int, val mi: Int, val s: Int)

    data class TzOffset(val offsetMinutes: Int, val source: String)

    data class NormalizedGeo(
        val lat: Double? = null,
        val lng: Double? = null,
        /** 有座標時為 "exif"，否則 null（留給軌跡／行程段填） */
        val geoSource: String? = null,
        /** UTC 瞬間 ISO 字串，用於排序與去重 */
        val takenAtUtc: String? = null,
        /** 牆上時間 'YYYY-MM-DD HH:MM:SS'，用於顯示與行程段比對 */
        val takenAtLocal: String? = null,
        val tzOffsetMinutes: Int? = null,
        /** takenAtUtc 是怎麼算出來的。沒有任何時間資訊時為 null */
        val timeSource: String? = null,
    )

    /* ---------- 小工具 ---------- */

    private val UTC: TimeZone = TimeZone.getTimeZone("UTC")

    /** 把 JSON 裡拿到的東西收斂成字串；JSONObject.NULL 與非字串一律 null */
    private fun str(v: Any?): String? = (v as? String)?.replace("\u0000", "")?.trim()

    private fun num(v: Any?): Double? = when (v) {
        is Number -> v.toDouble().takeIf { it.isFinite() }
        else -> null
    }

    /** `Date.UTC(...)`：越界的值會自己進位（1/32 → 2/1），跟 JS 一致 */
    private fun utcMs(y: Int, mo: Int, d: Int, h: Int, mi: Int, s: Int): Long {
        val cal = GregorianCalendar(UTC)
        cal.clear()
        cal.isLenient = true
        cal.set(y, mo - 1, d, h, mi, s)
        return cal.timeInMillis
    }

    /** `new Date(ms).toISOString()`，毫秒固定三位 */
    fun toIso(ms: Long): String {
        val cal = GregorianCalendar(UTC)
        cal.timeInMillis = ms
        return "%04d-%02d-%02dT%02d:%02d:%02d.%03dZ".format(
            cal.get(GregorianCalendar.YEAR),
            cal.get(GregorianCalendar.MONTH) + 1,
            cal.get(GregorianCalendar.DAY_OF_MONTH),
            cal.get(GregorianCalendar.HOUR_OF_DAY),
            cal.get(GregorianCalendar.MINUTE),
            cal.get(GregorianCalendar.SECOND),
            cal.get(GregorianCalendar.MILLISECOND),
        )
    }

    /**
     * `Date.parse(iso)`：只認帶時區的瞬間字串。
     * 收 'Z' 與 '±HH:MM'／'±HHMM'，解不開回 null（不猜時區）。
     */
    fun parseIsoMs(raw: String?): Long? {
        val s = raw?.trim().orEmpty()
        if (s.isEmpty()) return null
        return runCatching { java.time.Instant.parse(s).toEpochMilli() }
            .recoverCatching { java.time.OffsetDateTime.parse(s).toInstant().toEpochMilli() }
            .getOrNull()
    }

    /* ---------- 時區 ---------- */

    /**
     * 解析 EXIF OffsetTimeOriginal（tag 0x9011），如 "+09:00"。
     * 這是時區的第一層來源，最準確 —— iPhone (iOS 11+) 與近年 Android 都會寫。
     */
    fun parseOffsetTime(raw: Any?): Int? {
        val s = str(raw) ?: return null
        val m = Regex("""^([+-])(\d{1,2}):?(\d{2})$""").find(s) ?: return null
        val minutes = m.groupValues[2].toInt() * 60 + m.groupValues[3].toInt()
        if (minutes > MAX_TZ_OFFSET_MINUTES) return null
        return if (m.groupValues[1] == "-") -minutes else minutes
    }

    /**
     * 解析 EXIF 日期時間字串 'YYYY:MM:DD HH:MM:SS'。
     * EXIF 這個欄位不帶時區，讀出來的就是拍攝當下的牆上時間。
     * 也接受 'YYYY-MM-DD HH:MM:SS'，所以可以直接餵 DB 裡的 `taken_at_local`。
     *
     * ⚠️⚠️ **帶時區標記的字串一律回 null**（'…Z'、'…+08:00'）—— 那是一個「瞬間」
     *    而不是牆上時間，兩者長得很像但差一整個時區。硬讀數字的話台灣的照片會
     *    整整少 8 小時，而且錯得很安靜。要從瞬間得到牆上時間請用 `wallClockFromUtc`。
     */
    fun parseExifDateTime(raw: Any?): WallClock? {
        val s = str(raw) ?: return null
        if (Regex("""(?:Z|[+-]\d{2}:?\d{2})$""", RegexOption.IGNORE_CASE).containsMatchIn(s)) return null
        val m = Regex("""^(\d{4})[:\-](\d{2})[:\-](\d{2})[T ](\d{2}):(\d{2}):(\d{2})""").find(s)
            ?: return null
        val g = m.groupValues
        val wc = WallClock(
            g[1].toInt(), g[2].toInt(), g[3].toInt(),
            g[4].toInt(), g[5].toInt(), g[6].toInt(),
        )
        // EXIF 未設定時間時常見全為 0
        if (wc.y < 1900 || wc.mo < 1 || wc.mo > 12 || wc.d < 1 || wc.d > 31) return null
        return wc
    }

    /** 把牆上時間當成 UTC 來取毫秒數（用於與 GPS UTC 相減求偏移） */
    fun wallClockAsUtcMs(wc: WallClock): Long = utcMs(wc.y, wc.mo, wc.d, wc.h, wc.mi, wc.s)

    /** GPSDateStamp 'YYYY:MM:DD' ＋ GPSTimeStamp [h,m,s] 組成真正的 UTC 毫秒數 */
    fun gpsUtcMs(dateStamp: Any?, timeStamp: Any?): Long? {
        val ds = str(dateStamp) ?: return null
        val dm = Regex("""^(\d{4})[:\-](\d{2})[:\-](\d{2})$""").find(ds) ?: return null

        var h = 0.0
        var mi = 0.0
        var s = 0.0
        when (timeStamp) {
            is JSONArray -> {
                if (timeStamp.length() < 3) return null
                h = num(timeStamp.opt(0)) ?: return null
                mi = num(timeStamp.opt(1)) ?: return null
                s = num(timeStamp.opt(2)) ?: return null
            }
            is String -> {
                val tm = Regex("""^(\d{1,2}):(\d{2}):(\d{2}(?:\.\d+)?)$""").find(timeStamp.trim())
                    ?: return null
                h = tm.groupValues[1].toDouble()
                mi = tm.groupValues[2].toDouble()
                s = tm.groupValues[3].toDouble()
            }
            else -> return null
        }

        val dg = dm.groupValues
        return utcMs(
            dg[1].toInt(), dg[2].toInt(), dg[3].toInt(),
            h.toInt(), mi.toInt(), Math.round(s).toInt(),
        )
    }

    /**
     * 推導拍攝當下的時區偏移（分鐘），並回報是哪一層算出來的。
     *   第一層：OffsetTimeOriginal，直接可用。
     *   第二層：GPSDateStamp/GPSTimeStamp 記的是 UTC、DateTimeOriginal 是牆上時間，
     *           兩者相減就是偏移。只要照片有 GPS 就一定算得出來，不必查任何時區資料庫。
     * 兩層都不成立回 null，由呼叫端以 DEFAULT_TZ_OFFSET_MINUTES 兜底。
     */
    fun deriveTzOffset(exif: JSONObject?): TzOffset? {
        val direct = parseOffsetTime(exif?.opt("OffsetTimeOriginal"))
        if (direct != null) return TzOffset(direct, TIME_OFFSET_TAG)

        val wc = parseExifDateTime(exif?.opt("DateTimeOriginal")) ?: return null
        val utc = gpsUtcMs(exif?.opt("GPSDateStamp"), exif?.opt("GPSTimeStamp")) ?: return null

        val diffMinutes = (wallClockAsUtcMs(wc) - utc).toDouble() / 60000.0
        if (!diffMinutes.isFinite() || Math.abs(diffMinutes) > MAX_TZ_OFFSET_MINUTES) return null

        // 真實時區都是 15 分鐘的倍數；四捨五入到 15 分可吸收相機時鐘的少量誤差。
        // 相機時鐘若偏離超過 7.5 分鐘，推出來的偏移就會差一格，屬已知限制。
        return TzOffset((Math.round(diffMinutes / 15.0) * 15).toInt(), TIME_GPS_UTC)
    }

    /* ---------- 牆上時間 ↔ 瞬間 ---------- */

    /** 格式化為 'YYYY-MM-DD HH:MM:SS'（跟 TripSegment 的 start_local/end_local 同格式才能字串比對） */
    fun formatWallClock(wc: WallClock): String =
        "%04d-%02d-%02d %02d:%02d:%02d".format(
            Math.abs(wc.y), Math.abs(wc.mo), Math.abs(wc.d),
            Math.abs(wc.h), Math.abs(wc.mi), Math.abs(wc.s),
        )

    /** 由 UTC 毫秒數與偏移算出牆上時間 */
    fun wallClockFromUtc(utcMillis: Long, offsetMinutes: Int): WallClock {
        val cal = GregorianCalendar(UTC)
        cal.timeInMillis = utcMillis + offsetMinutes * 60000L
        return WallClock(
            cal.get(GregorianCalendar.YEAR),
            cal.get(GregorianCalendar.MONTH) + 1,
            cal.get(GregorianCalendar.DAY_OF_MONTH),
            cal.get(GregorianCalendar.HOUR_OF_DAY),
            cal.get(GregorianCalendar.MINUTE),
            cal.get(GregorianCalendar.SECOND),
        )
    }

    /**
     * 由牆上時間 ＋ 時區偏移，算回 `taken_at` 該存的 UTC 瞬間 ISO 字串。
     *
     * ⚠️⚠️ 全站不變式：**taken_at === taken_at_local − tz_offset_minutes**。
     *    任何寫入這兩欄的路徑都必須維持這個關係，否則排序、去重與軌跡比對會各自
     *    看到不同的時間。**這是那個不變式在 App 這邊的唯一實作。**
     */
    fun utcFromLocal(local: Any?, tzOffsetMinutes: Int): String? {
        val wc = parseExifDateTime(local) ?: return null
        return toIso(wallClockAsUtcMs(wc) - tzOffsetMinutes * 60000L)
    }

    /* ---------- 座標 ---------- */

    /**
     * 取出十進位座標。
     * 優先用已經換算好的 latitude／longitude；退而求其次才用 DMS 陣列 ＋ Ref。
     * ⚠️ 缺 Ref 時**不猜半球** —— 猜錯會把台北放到南半球，寧可回 null。
     */
    fun toDecimalCoord(decimal: Any?, dms: Any?, ref: Any?, max: Double): Double? {
        num(decimal)?.let { if (Math.abs(it) <= max) return it }

        var magnitude: Double? = null
        if (dms is JSONArray && dms.length() >= 1) {
            val d = num(dms.opt(0)) ?: 0.0
            val m = if (dms.length() > 1) num(dms.opt(1)) ?: 0.0 else 0.0
            val s = if (dms.length() > 2) num(dms.opt(2)) ?: 0.0 else 0.0
            magnitude = Math.abs(d) + Math.abs(m) / 60.0 + Math.abs(s) / 3600.0
        } else {
            num(dms)?.let { magnitude = Math.abs(it) }
        }
        val mag = magnitude ?: return null
        if (mag > max) return null

        return when (str(ref)?.uppercase()) {
            "S", "W" -> -mag
            "N", "E" -> mag
            else -> null
        }
    }

    /* ---------- 正規化 ---------- */

    /**
     * 把一份（已通過白名單的）EXIF 物件正規化成可直接送上去的地理與時間欄位。
     *
     * @param exif        白名單後的 EXIF 物件（`Media.exifJson()` 或 `VideoMeta` 產的）
     * @param fallbackIso 沒有 DateTimeOriginal 時的備援瞬間（影片只有 mvhd 時走這條）
     */
    fun normalizeGeo(exif: JSONObject?, fallbackIso: String? = null): NormalizedGeo {
        var lat: Double? = null
        var lng: Double? = null
        var geoSource: String? = null
        var takenAtUtc: String? = null
        var takenAtLocal: String? = null
        var timeSource: String? = null

        // --- 座標 ---
        val la = toDecimalCoord(
            exif?.opt("latitude"), exif?.opt("GPSLatitude"), exif?.opt("GPSLatitudeRef"), 90.0,
        )
        val lo = toDecimalCoord(
            exif?.opt("longitude"), exif?.opt("GPSLongitude"), exif?.opt("GPSLongitudeRef"), 180.0,
        )
        // 恰好 (0, 0) 是「無 GPS」的經典哨兵值（大西洋上的空海域），視為沒有座標
        if (la != null && lo != null && !(la == 0.0 && lo == 0.0)) {
            lat = la
            lng = lo
            geoSource = "exif"
        }

        // --- 時區與時間 ---
        // 推不出時區就寫入站台預設值，而不是留 null：這樣 taken_at 與 taken_at_local
        // 的不變式永遠成立，下游查詢不必到處 COALESCE。
        val tz = deriveTzOffset(exif)
        var tzOffsetMinutes: Int? = tz?.offsetMinutes ?: DEFAULT_TZ_OFFSET_MINUTES

        val wc = parseExifDateTime(exif?.opt("DateTimeOriginal"))
        if (wc != null) {
            takenAtLocal = formatWallClock(wc)
            takenAtUtc = utcFromLocal(takenAtLocal, tzOffsetMinutes!!)
            timeSource = tz?.source ?: TIME_ASSUMED
        } else {
            val ms = parseIsoMs(fallbackIso)
            if (ms != null) {
                takenAtUtc = toIso(ms)
                takenAtLocal = formatWallClock(wallClockFromUtc(ms, tzOffsetMinutes!!))
                // 瞬間本身精確（來源已是 UTC），但可能是檔案時間而非快門時間
                timeSource = TIME_FILE_TIME
            }
        }
        // 完全沒有時間資訊時，留著預設時區也沒有意義，一併清掉
        if (takenAtUtc == null) tzOffsetMinutes = null

        return NormalizedGeo(
            lat = lat, lng = lng, geoSource = geoSource,
            takenAtUtc = takenAtUtc, takenAtLocal = takenAtLocal,
            tzOffsetMinutes = tzOffsetMinutes, timeSource = timeSource,
        )
    }
}
