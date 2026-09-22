package tw.didadida.app.upload

import android.content.Context
import android.graphics.Bitmap
import android.media.MediaMetadataRetriever
import android.net.Uri
import org.json.JSONArray
import org.json.JSONObject

/**
 * 影片的拍攝時間、座標與「影片資訊」：解 mp4／mov 的 `moov` box。
 *
 * ⚠️⚠️ **這一檔是 `apps/frontend/src/lib/videoMeta.ts` 的複本**（那邊還有一份 CRLF 的
 *    後端副本）。網頁改了這邊要跟著改，不然同一支影片從 App 與網頁傳上去時間會不一樣。
 *
 * ⚠️ **這一檔本身不做任何時間換算**，只把檔案裡有什麼挖出來湊成一份 **EXIF 形狀**的
 *    物件交給 `Geo.normalizeGeo()`。全站的不變式（taken_at = taken_at_local − tz）
 *    只能有一份實作。
 *
 * ⚠️⚠️ `mvhd.creation_time` **沒有時區**。規格說是 UTC，實際上一大票 Android 機身寫的是
 *    當地時間 —— 所以時間分四層，**優先序不能對調**（見 `toExif`）。
 */
object VideoMeta {

    /** 先讀的檔頭。faststart 的手機影片 moov 整個就在裡面＝只讀一次 */
    private const val HEAD_CHUNK = 128 * 1024
    /** moov 在檔尾時最多讀這麼多 */
    private const val MOOV_MAX = 8 * 1024 * 1024
    /** 1904-01-01 到 1970-01-01 的秒數（QuickTime 的紀元） */
    private const val MAC_EPOCH_OFFSET = 2082844800L
    private const val MAX_TZ = 840
    /** mvhd 常記錄影結束、檔名記開始 —— 容許這麼多分鐘的殘差 */
    private const val DERIVE_RESIDUAL_MAX_MIN = 10.0

    /** 1990-01-01 UTC：比這早的 mvhd 多半是沒設時鐘的機身寫的 0 */
    private const val MIN_VALID_MS = 631152000000L

    class Meta {
        var instantMs: Long? = null
        var wallClock: String? = null
        var offsetMinutes: Int? = null
        var wallClockOnly: String? = null
        var lat: Double? = null
        var lng: Double? = null
        val tags = LinkedHashMap<String, String>()
        var width: Int? = null
        var height: Int? = null
        var rotation: Int? = null
        var durationMs: Long? = null
        var videoCodec: String? = null
        var audioCodec: String? = null
        var frameRate: Double? = null
    }

    /**
     * @param exif        交給 `Geo.normalizeGeo` 的那份（null＝什麼都沒讀到）
     * @param fallbackIso 只有 mvhd 瞬間時（第③層）當備援瞬間
     * @param how         instant／derived／tagged／wall／none —— 除錯用
     */
    data class VideoExif(
        val exif: JSONObject?,
        val fallbackIso: String?,
        val how: String,
        val durationMs: Long?,
    )

    /* ---------- 位元組小工具 ---------- */

    private fun u8(b: ByteArray, i: Int) = b[i].toInt() and 0xFF
    private fun u16(b: ByteArray, i: Int) = (u8(b, i) shl 8) or u8(b, i + 1)
    private fun u32(b: ByteArray, i: Int): Long =
        (u8(b, i).toLong() shl 24) or (u8(b, i + 1).toLong() shl 16) or
            (u8(b, i + 2).toLong() shl 8) or u8(b, i + 3).toLong()
    private fun u64(b: ByteArray, i: Int): Long = u32(b, i) * 4294967296L + u32(b, i + 4)
    private fun s32(b: ByteArray, i: Int): Int = u32(b, i).toInt()
    private fun boxType(b: ByteArray, i: Int): String = String(b, i, 4, Charsets.ISO_8859_1)

    private data class Head(val size: Long, val type: String, val headLen: Int)

    private fun readBoxHead(b: ByteArray, i: Int): Head? {
        if (i + 8 > b.size) return null
        val size32 = u32(b, i)
        val type = boxType(b, i + 4)
        if (size32 == 1L) {
            if (i + 16 > b.size) return null
            return Head(u64(b, i + 8), type, 16)
        }
        return Head(size32, type, 8)
    }

    /** 走過 [from, to) 之間的 box。size 0＝一路到 to；截斷的最後一個照樣回報 */
    private fun walkBoxes(b: ByteArray, from: Int, to: Int, visit: (String, Int, Int) -> Unit) {
        var p = from
        while (p + 8 <= to) {
            val h = readBoxHead(b, p) ?: break
            val end: Long = if (h.size == 0L) to.toLong() else p + h.size
            if (h.size != 0L && h.size < h.headLen) break
            visit(h.type, p + h.headLen, minOf(end, to.toLong()).toInt())
            if (end <= p) break
            p = if (end > Int.MAX_VALUE) break else end.toInt()
        }
    }

    /** `meta` 在 ISO BMFF 是 FullBox、在 QuickTime 不是 —— 探一下下一個位置像不像 box 頭 */
    private fun looksLikeBox(b: ByteArray, i: Int, to: Int): Boolean {
        if (i + 8 > b.size) return false
        val size = u32(b, i)
        if (size < 8 || i + size > to + 8) return false
        for (k in 4 until 8) {
            val c = u8(b, i + k)
            if (c != 0xA9 && (c < 0x20 || c > 0x7e)) return false
        }
        return true
    }

    /* ---------- 各個 box ---------- */

    private fun parseMvhd(b: ByteArray, s: Int, e: Int, m: Meta) {
        if (s + 5 > e) return
        val v1 = u8(b, s) == 1
        val secs: Long? = if (v1) {
            if (s + 12 <= e) u64(b, s + 4) else null
        } else {
            if (s + 8 <= e) u32(b, s + 4) else null
        }
        if (secs != null && secs > 0) {
            val ms = (secs - MAC_EPOCH_OFFSET) * 1000
            if (ms >= MIN_VALID_MS && ms <= System.currentTimeMillis() + 86_400_000L) m.instantMs = ms
        }
        val tsAt = if (v1) s + 20 else s + 12
        val durAt = if (v1) s + 24 else s + 16
        val durEnd = if (v1) durAt + 8 else durAt + 4
        if (durEnd <= e) {
            val timescale = u32(b, tsAt)
            val duration = if (v1) u64(b, durAt) else u32(b, durAt)
            if (timescale > 0 && duration > 0 && duration != 0xffffffffL) {
                m.durationMs = Math.round(duration.toDouble() / timescale * 1000)
            }
        }
    }

    private fun fixed1616(b: ByteArray, i: Int): Double = s32(b, i) / 65536.0

    private class Track {
        var handler: String? = null
        var width: Int? = null
        var height: Int? = null
        var rotation: Int? = null
        var codec: String? = null
        var timescale: Long = 0
        var duration: Long = 0
        var samples: Long = 0
        val fps: Double?
            get() {
                if (timescale <= 0 || duration <= 0 || samples <= 0) return null
                val f = samples / (duration.toDouble() / timescale)
                return if (f > 0 && f < 1000) Math.round(f * 100) / 100.0 else null
            }
    }

    private fun parseTkhd(b: ByteArray, s: Int, e: Int, t: Track) {
        if (s + 1 > e) return
        val v1 = u8(b, s) == 1
        val matrix = if (v1) s + 52 else s + 40
        if (matrix + 44 > e) return
        val a = fixed1616(b, matrix)
        val bb = fixed1616(b, matrix + 4)
        var deg = Math.round(Math.toDegrees(Math.atan2(bb, a))).toInt()
        if (deg < 0) deg += 360
        deg = (Math.round(deg / 90.0) * 90).toInt() % 360
        t.rotation = deg
        var w = Math.round(fixed1616(b, matrix + 36)).toInt()
        var h = Math.round(fixed1616(b, matrix + 40)).toInt()
        if (deg == 90 || deg == 270) { val x = w; w = h; h = x }
        if (w >= 1 && h >= 1) { t.width = w; t.height = h }
    }

    private fun parseTrak(b: ByteArray, s: Int, e: Int): Track {
        val t = Track()
        walkBoxes(b, s, e) { type, cs, ce ->
            when (type) {
                "tkhd" -> parseTkhd(b, cs, ce, t)
                "mdia" -> walkBoxes(b, cs, ce) { mt, ms, me ->
                    when (mt) {
                        "mdhd" -> if (ms + 5 <= me) {
                            val v1 = u8(b, ms) == 1
                            val tsAt = if (v1) ms + 20 else ms + 12
                            val durAt = if (v1) ms + 24 else ms + 16
                            val durEnd = if (v1) durAt + 8 else durAt + 4
                            if (durEnd <= me) {
                                t.timescale = u32(b, tsAt)
                                t.duration = if (v1) u64(b, durAt) else u32(b, durAt)
                            }
                        }
                        "hdlr" -> if (ms + 12 <= me) t.handler = boxType(b, ms + 8)
                        "minf" -> walkBoxes(b, ms, me) { nt, ns, ne ->
                            if (nt == "stbl") walkBoxes(b, ns, ne) { st, ss, se ->
                                when (st) {
                                    "stsd" -> if (ss + 16 <= se && t.codec == null) {
                                        t.codec = boxType(b, ss + 12).trim()
                                    }
                                    "stts" -> if (ss + 8 <= se) {
                                        val n = u32(b, ss + 4)
                                        var sum = 0L
                                        var i = 0L
                                        while (i < n) {
                                            val at = ss + 8 + (8 * i).toInt()
                                            if (at + 4 > se) break
                                            sum += u32(b, at)
                                            i++
                                        }
                                        t.samples = sum
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
        return t
    }

    private val ISO6709 = Regex("""^([+-]\d{1,3}(?:\.\d+)?)([+-]\d{1,3}(?:\.\d+)?)""")

    private fun parseIso6709(raw: String, m: Meta) {
        val g = ISO6709.find(raw.trim())?.groupValues ?: return
        val la = g[1].toDoubleOrNull() ?: return
        val lo = g[2].toDoubleOrNull() ?: return
        if (Math.abs(la) > 90 || Math.abs(lo) > 180) return
        m.lat = la
        m.lng = lo
    }

    private val UDTA_TEXT_TYPES = setOf("name", "auth", "titl", "desc", "albm", "gnre", "yrrc")

    private fun parseUdtaText(b: ByteArray, s: Int, e: Int): String? {
        if (s + 4 > e) return null
        val len = u16(b, s)
        val from = s + 4
        val to = minOf(e, if (len > 0) from + len else e)
        if (to <= from) return null
        return String(b, from, to - from, Charsets.UTF_8).replace("\u0000", "").trim()
    }

    private data class Dated(val wallClock: String, val offsetMinutes: Int)

    private val DATE_WITH_OFFSET =
        Regex("""^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})$""")

    private fun parseDateWithOffset(raw: String): Dated? {
        val g = DATE_WITH_OFFSET.find(raw.trim())?.groupValues ?: return null
        val wc = Geo.WallClock(
            g[1].toInt(), g[2].toInt(), g[3].toInt(),
            g[4].toInt(), g[5].toInt(), g[6].toInt(),
        )
        if (wc.y < 1990 || wc.mo < 1 || wc.mo > 12 || wc.d < 1 || wc.d > 31) return null
        val z = g[7]
        val offset = if (z == "Z") 0 else {
            val digits = z.substring(1).replace(":", "")
            val mins = digits.substring(0, 2).toInt() * 60 + digits.substring(2, 4).toInt()
            if (mins > MAX_TZ) return null
            if (z[0] == '-') -mins else mins
        }
        return Dated(Geo.formatWallClock(wc), offset)
    }

    private fun parseDateNoOffset(raw: String): String? =
        Geo.parseExifDateTime(raw.trim())?.let { Geo.formatWallClock(it) }

    /** Apple 的 `meta/keys/ilst`：keys 給名字，ilst 的子 box 型別就是 1 起算的索引 */
    private fun parseAppleMeta(b: ByteArray, s: Int, e: Int, out: MutableMap<String, String>) {
        val from = if (looksLikeBox(b, s, e)) s else s + 4
        val keys = ArrayList<String>()
        var ilstStart = -1
        var ilstEnd = -1
        walkBoxes(b, from, e) { type, cs, ce ->
            when (type) {
                "keys" -> {
                    var p = cs + 8
                    while (p + 8 <= ce) {
                        val size = u32(b, p).toInt()
                        if (size < 8 || p + size > ce) break
                        keys.add(String(b, p + 8, size - 8, Charsets.UTF_8))
                        p += size
                    }
                }
                "ilst" -> { ilstStart = cs; ilstEnd = ce }
            }
        }
        if (ilstStart < 0) return
        walkBoxes(b, ilstStart, ilstEnd) { _, cs, ce ->
            // 子 box 的「型別」四個位元組其實是 big-endian 的索引
            val idx = u32(b, cs - 4).toInt()
            val name = keys.getOrNull(idx - 1) ?: return@walkBoxes
            walkBoxes(b, cs, ce) { dt, ds, de ->
                if (dt == "data" && ds + 8 <= de) {
                    val text = String(b, ds + 8, de - ds - 8, Charsets.UTF_8).replace("\u0000", "").trim()
                    if (text.isNotEmpty()) out[name] = text
                }
            }
        }
    }

    /* ---------- 主流程 ---------- */

    /**
     * 讀出一支影片的 metadata。**絕不往外丟例外**（讀不到＝空的 Meta）。
     */
    fun read(source: ByteSource): Meta = runCatching { readInner(source) }.getOrElse { Meta() }

    private fun readInner(source: ByteSource): Meta {
        val m = Meta()
        val size = source.size
        if (size < 16) return m
        val head = source.read(0, minOf(size, HEAD_CHUNK.toLong()).toInt())
        if (head.size < 8) return m

        // 找頂層的 moov。mdat 靠自己的 size 直接跳過去，不逐段試
        var p = 0L
        var moovStart = -1L
        var moovEnd = -1L
        while (p + 8 <= size) {
            val hb: ByteArray
            val hi: Int
            if (p + 16 <= head.size) { hb = head; hi = p.toInt() }
            else { hb = source.read(p, (minOf(size, p + 16) - p).toInt()); hi = 0 }
            val h = readBoxHead(hb, hi) ?: break
            val boxSize = if (h.size == 0L) size - p else h.size
            if (boxSize < h.headLen) break
            if (h.type == "moov") {
                moovStart = p + h.headLen
                moovEnd = minOf(size, p + boxSize)
                break
            }
            p += boxSize
        }
        if (moovStart < 0) return m

        val buf: ByteArray
        val base: Int
        if (moovEnd <= head.size) { buf = head; base = moovStart.toInt() }
        else {
            buf = source.read(moovStart, (minOf(moovEnd, moovStart + MOOV_MAX) - moovStart).toInt())
            base = 0
        }
        val stop = minOf(buf.size.toLong(), base + (moovEnd - moovStart)).toInt()

        val tracks = ArrayList<Track>()
        val apple = LinkedHashMap<String, String>()

        fun udtaChild(type: String, cs: Int, ce: Int) {
            val first = type[0].code
            if (first == 0xA9 || type in UDTA_TEXT_TYPES) {
                val text = parseUdtaText(buf, cs, ce)
                if (!text.isNullOrEmpty()) m.tags[type] = text
                when (type) {
                    "©xyz" -> if (text != null) parseIso6709(text, m)
                    "©day" -> if (text != null) {
                        val d = parseDateWithOffset(text)
                        if (d != null) { m.wallClock = d.wallClock; m.offsetMinutes = d.offsetMinutes }
                        else m.wallClockOnly = parseDateNoOffset(text) ?: m.wallClockOnly
                    }
                }
            } else if (type == "meta") {
                parseAppleMeta(buf, cs, ce, apple)
            }
        }

        walkBoxes(buf, base, stop) { type, cs, ce ->
            when (type) {
                "mvhd" -> parseMvhd(buf, cs, ce, m)
                "trak" -> tracks.add(parseTrak(buf, cs, ce))
                "udta" -> walkBoxes(buf, cs, ce) { t, s2, e2 -> udtaChild(t, s2, e2) }
                "meta" -> parseAppleMeta(buf, cs, ce, apple)
            }
        }

        apple["com.apple.quicktime.creationdate"]?.let { raw ->
            val d = parseDateWithOffset(raw)
            if (d != null) { m.wallClock = d.wallClock; m.offsetMinutes = d.offsetMinutes }
            else m.wallClockOnly = parseDateNoOffset(raw) ?: m.wallClockOnly
        }
        if (m.lat == null) apple["com.apple.quicktime.location.ISO6709"]?.let { parseIso6709(it, m) }
        m.tags.putAll(apple)

        var vid: Track? = null
        var aud: Track? = null
        for (t in tracks) {
            if (t.handler == "soun" && aud == null) aud = t
            if (t.handler == "vide" && vid?.handler != "vide") vid = t
        }
        if (vid == null) vid = tracks.firstOrNull { it.width != null }
        vid?.let {
            m.width = it.width
            m.height = it.height
            m.rotation = it.rotation
            m.videoCodec = it.codec
            m.frameRate = it.fps
        }
        m.audioCodec = aud?.codec
        return m
    }

    /* ---------- 檔名 ---------- */

    private val NAME_STAMP =
        Regex("""(?:^|[^0-9])(\d{4})(\d{2})(\d{2})[_-]?(\d{2})(\d{2})(\d{2})(?![0-9])""")

    /**
     * 從 `VID_20260824_143000.mp4` 這類檔名猜一個牆上時間（`YYYY-MM-DDTHH:MM:SS`）。
     * ⚠️ `PXL_` 開頭回 "utc" —— Pixel 那串數字是 **UTC**，當牆上時間用會整整差一個時區。
     */
    fun guessWallClockFromName(name: String): String? {
        if (name.startsWith("PXL_", ignoreCase = true)) return "utc"
        val g = NAME_STAMP.find(name)?.groupValues ?: return null
        val y = g[1].toInt(); val mo = g[2].toInt(); val d = g[3].toInt()
        val h = g[4].toInt(); val mi = g[5].toInt(); val s = g[6].toInt()
        if (y < 1990 || y > 2100 || mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) return null
        return "${g[1]}-${g[2]}-${g[3]}T${g[4]}:${g[5]}:${g[6]}"
    }

    /* ---------- 燈箱的「影片資訊」 ---------- */

    private val MAKE_KEYS = listOf("com.apple.quicktime.make", "©mak", "com.android.manufacturer")
    private val MODEL_KEYS = listOf("com.apple.quicktime.model", "©mod", "com.android.model")
    private val SOFTWARE_KEYS = listOf("com.apple.quicktime.software", "©swr", "com.android.version")
    private val SHOWN_ELSEWHERE = setOf(
        "©day", "©xyz", "com.apple.quicktime.creationdate", "com.apple.quicktime.location.ISO6709",
    )

    private fun cleanTagValue(v: String): String {
        val sb = StringBuilder()
        for (c in v) {
            if (c.code < 0x20 || c.code == 0x7f || c.code == 0xfffd) continue
            sb.append(c)
        }
        val t = sb.toString().trim()
        return if (t.length > 200) t.substring(0, 200) + "…" else t
    }

    private fun pickTag(tags: Map<String, String>, keys: List<String>, used: MutableSet<String>): String? {
        for (k in keys) {
            val v = tags[k]?.let(::cleanTagValue)
            if (!v.isNullOrEmpty()) { used.add(k); return v }
        }
        return null
    }

    /** 存進 `Photo.exif._video` 的那一塊。沒東西回 null */
    fun block(m: Meta): JSONObject? {
        val o = JSONObject()
        val used = HashSet<String>(SHOWN_ELSEWHERE)
        MAKE_KEYS.forEach { used.add(it) }
        pickTag(m.tags, MAKE_KEYS, used)?.let { o.put("Make", it) }
        pickTag(m.tags, MODEL_KEYS, used)?.let { o.put("Model", it) }
        pickTag(m.tags, SOFTWARE_KEYS, used)?.let { o.put("Software", it) }
        used.addAll(MODEL_KEYS); used.addAll(SOFTWARE_KEYS)
        if (m.width != null && m.height != null) { o.put("Width", m.width); o.put("Height", m.height) }
        m.rotation?.let { if (it != 0) o.put("Rotation", it) }
        m.durationMs?.let { o.put("DurationMs", it) }
        m.frameRate?.let { o.put("FrameRate", it) }
        m.videoCodec?.takeIf { it.isNotEmpty() }?.let { o.put("VideoCodec", it) }
        m.audioCodec?.takeIf { it.isNotEmpty() }?.let { o.put("AudioCodec", it) }
        val rest = JSONObject()
        for ((k, v) in m.tags) {
            if (k in used) continue
            val c = cleanTagValue(v)
            if (c.isNotEmpty()) rest.put(k, c)
        }
        if (rest.length() > 0) o.put("Tags", rest)
        return if (o.length() > 0) o else null
    }

    /* ---------- 四層時間 ---------- */

    /**
     * 把 Meta 湊成一份 EXIF 形狀的物件。⚠️⚠️ **四層的順序不可調換**：
     *   ① 檔案自己寫明時區（Apple creationdate `…+0800`、帶時區的 ©day）→ OffsetTimeOriginal；
     *   ② mvhd 瞬間 ＋ 另一個牆上時間來源（沒帶時區的 ©day，或檔名）→ 相減就是時區；
     *   ③ 只有 mvhd → 照規格當 UTC 瞬間（fallbackIso）；
     *   ④ 只有牆上時間 → normalizeGeo 配站台預設 +8。
     * ②相減出來剛好是 0 代表 mvhd 寫的其實是當地時間，退回④，**不要存 UTC+0**。
     * `PXL_` 開頭的檔名是 UTC，不參與②（它落在③剛好是對的）。
     */
    fun toExif(m: Meta, fileName: String): VideoExif {
        val exif = JSONObject()
        val blk = block(m)
        if (blk != null) exif.put("_video", blk)
        val hasGeo = m.lat != null && m.lng != null
        if (hasGeo) { exif.put("latitude", m.lat); exif.put("longitude", m.lng) }
        val hasAny = hasGeo || blk != null

        // ①
        val wc = m.wallClock
        val off = m.offsetMinutes
        if (wc != null && off != null) {
            exif.put("DateTimeOriginal", wc)
            val a = Math.abs(off)
            exif.put("OffsetTimeOriginal", "%s%02d:%02d".format(if (off < 0) "-" else "+", a / 60, a % 60))
            return VideoExif(exif, null, "tagged", m.durationMs)
        }

        val named = guessWallClockFromName(fileName)?.takeIf { it != "utc" }
        val wall = m.wallClockOnly ?: named
        val instant = m.instantMs

        // ②
        if (instant != null && wall != null) {
            val parsed = Geo.parseExifDateTime(wall)
            if (parsed != null) {
                val diff = (Geo.wallClockAsUtcMs(parsed) - instant) / 60000.0
                val snapped = Math.round(diff / 15.0) * 15
                val residual = Math.abs(diff - snapped)
                if (snapped != 0L && Math.abs(snapped) <= MAX_TZ && residual <= DERIVE_RESIDUAL_MAX_MIN) {
                    val cand = JSONObject(exif.toString())
                    cand.put("DateTimeOriginal", wall)
                    val u = Geo.wallClockFromUtc(instant, 0)
                    cand.put("GPSDateStamp", "%04d:%02d:%02d".format(u.y, u.mo, u.d))
                    cand.put("GPSTimeStamp", JSONArray().put(u.h).put(u.mi).put(u.s))
                    if (Geo.deriveTzOffset(cand) != null) {
                        return VideoExif(cand, null, "derived", m.durationMs)
                    }
                }
                exif.put("DateTimeOriginal", wall)
                return VideoExif(exif, null, "wall", m.durationMs)
            }
        }

        // ③
        if (instant != null) {
            return VideoExif(if (hasAny) exif else null, Geo.toIso(instant), "instant", m.durationMs)
        }

        // ④
        if (wall != null) {
            exif.put("DateTimeOriginal", wall)
            return VideoExif(exif, null, "wall", m.durationMs)
        }

        return VideoExif(if (hasAny) exif else null, null, "none", m.durationMs)
    }

    /** 上傳路徑用的：**絕不往外丟例外**，讀不到就是「這支影片沒有時間」 */
    fun exifFromSource(source: ByteSource, fileName: String): VideoExif =
        runCatching { toExif(read(source), fileName) }.getOrElse { toExif(Meta(), fileName) }

    /* ---------- 封面 ---------- */

    /** 封面長邊上限。跟 `videoUtils.ts` 的 POSTER_MAX_EDGE 同一個數字 */
    private const val POSTER_MAX_EDGE = 1600

    data class Poster(val bitmap: Bitmap, val durationMs: Long)

    /**
     * 擷一格當封面：第 1 秒，短片取一成的位置（取小的）—— 很多相機第一格是全黑。
     * 解不開往外丟，訊息跟網頁同一句，呼叫端逐檔收進失敗清單。
     */
    fun poster(context: Context, uri: Uri, name: String): Poster {
        val r = MediaMetadataRetriever()
        try {
            try { r.setDataSource(context, uri) } catch (e: Exception) {
                throw IllegalStateException("無法讀取「$name」的影片資訊")
            }
            val durationMs = r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)
                ?.toLongOrNull()?.takeIf { it > 0 } ?: 0L
            val seekMs = if (durationMs > 0) minOf(1000L, durationMs / 10) else 0L
            val frame = r.getFrameAtTime(seekMs * 1000, MediaMetadataRetriever.OPTION_CLOSEST_SYNC)
                ?: r.frameAtTime
                ?: throw IllegalStateException("無法擷取「$name」的封面畫面，請改用 MP4 上傳")
            val scaled = Media.scaleDown(frame, POSTER_MAX_EDGE)
            if (scaled !== frame) frame.recycle()
            return Poster(scaled, durationMs)
        } finally {
            runCatching { r.release() }
        }
    }
}
