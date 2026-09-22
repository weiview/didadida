package tw.didadida.app.upload

/**
 * Android 的「動態照片」：一個 .jpg 檔尾巴上黏著一段 mp4。
 *
 * ⚠️⚠️ **這一檔是 `apps/frontend/src/lib/motionPhoto.ts` 的複本**（那邊還有一份
 *    CRLF 的後端副本）。只做一件事 —— 算出那段 mp4 **從第幾個位元組開始**。
 *    位元組本身完全不動：播放時由 `/api/photos/:id/motion` 從 Drive 上那份原始檔
 *    現切。抽出來另外存一份等於同樣的位元組收兩次錢（一支 1～4MB，兩千張就是
 *    好幾 GB），而 R2 儲存是免費額度裡真的會被吃掉的那一格。
 *
 * 兩種格式都是「長度從檔尾往回算」：
 *   ① **MicroVideo**（舊的 MVIMG_*.jpg）`GCamera:MicroVideoOffset="N"`，
 *      ⚠️ 名字叫 Offset，值卻是**影片長度**；
 *   ② **Motion Photo v1**（Pixel 的 *.MP.jpg、近年三星）XMP 的 `Container:Directory`
 *      裡 `Semantic="MotionPhoto"` 那一項的 `Length` ＋ `Padding`。
 * 兩種都是 `起點 = 檔案大小 − 長度 − padding`。三星更早期那種（尾巴接
 * `MotionPhoto_Data` 標記）**刻意不支援** —— 它的 XMP 沒有長度，只能整片掃檔尾。
 *
 * ⚠️ **不解 JPEG 的段結構**：要的只是幾個 ASCII 字串，而 `Semantic="MotionPhoto"`
 *    不會憑空出現在 APP1 以外的地方。
 */
object MotionPhoto {

    /** 檔頭要讀多少才找得到 XMP。跟網頁同一個數字，兩邊行為才會一致 */
    const val HEAD_CHUNK = 128 * 1024

    /** 小於這個長度的「影片」不當真 —— 那多半是解錯了 */
    private const val MIN_CLIP_BYTES = 8 * 1024

    /*
     * ⚠️⚠️ 這幾個樣式**一律寫成 Regex 字面值，不要塞進字串再組出來** ——
     *    字串裡的 `\d`／`\s`／`\w` 只要經過任何一層會處理跳脫字元的東西就會安靜地
     *    掉成 `d`／`s`／`w`，樣式照樣編譯得過、只是永遠比不中。這個站被同一件事
     *    咬過一次（見 CLAUDE.md「資料模型」那顆指定時間的按鈕）。
     */
    private val LENGTH_ATTR = Regex("""(?:\w+:)?Length\s*=\s*["'](\d+)["']""")
    private val PADDING_ATTR = Regex("""(?:\w+:)?Padding\s*=\s*["'](\d+)["']""")
    private val SEMANTIC = Regex("""Semantic\s*=\s*["']MotionPhoto["']""")
    private val MICRO_ATTR = Regex("""MicroVideoOffset\s*=\s*["'](\d+)["']""")
    private val MICRO_ELEM = Regex("""<\w+:MicroVideoOffset>\s*(\d+)\s*<""")

    /** 把位元組當 latin1 讀成字串。XMP 是 UTF-8，但要比對的全是 ASCII */
    private fun asLatin1(buf: ByteArray): String = String(buf, Charsets.ISO_8859_1)

    private fun attrNum(tag: String, re: Regex): Long? =
        re.find(tag)?.groupValues?.get(1)?.toLongOrNull()

    /**
     * 從檔頭的 XMP 算出起點。**不是動態照片就回 0。**
     *
     * 回 0 是「確定沒有」，呼叫端會把它存進 D1 當成「掃過了」—— 所以這裡寧可保守：
     * 位置不合理（超出檔案、影片短得離譜）一律回 0。
     */
    fun offsetFromHead(head: ByteArray, fileSize: Long): Long {
        val text = asLatin1(head)

        fun take(clipLen: Long?, padding: Long): Long {
            if (clipLen == null || clipLen < MIN_CLIP_BYTES) return 0
            val start = fileSize - clipLen - padding
            // 起點至少要在 JPEG 的 SOI 之後，而且不能把整個檔都算成影片
            return if (start > 2 && start < fileSize) start else 0
        }

        // ② Motion Photo v1：先找 Semantic="MotionPhoto"，再回頭取它所在那個標籤的 Length
        val sem = SEMANTIC.find(text)
        if (sem != null) {
            val lt = text.lastIndexOf('<', sem.range.first)
            val gt = text.indexOf('>', sem.range.first)
            val tag = text.substring(
                if (lt < 0) 0 else lt,
                if (gt < 0) text.length else gt + 1,
            )
            val hit = take(attrNum(tag, LENGTH_ATTR), attrNum(tag, PADDING_ATTR) ?: 0L)
            if (hit > 0) return hit
        }

        // ① MicroVideo：屬性與元素兩種寫法都收
        val micro = MICRO_ATTR.find(text) ?: MICRO_ELEM.find(text)
        if (micro != null) {
            val hit = take(micro.groupValues[1].toLongOrNull(), 0L)
            if (hit > 0) return hit
        }

        return 0
    }

    /** 那個位置看起來像不像一個 mp4 的開頭（`....ftyp`） */
    fun looksLikeMp4(chunk: ByteArray, at: Int = 0): Boolean {
        if (chunk.size < at + 8) return false
        return chunk[at + 4] == 0x66.toByte() && chunk[at + 5] == 0x74.toByte() &&
            chunk[at + 6] == 0x79.toByte() && chunk[at + 7] == 0x70.toByte()   // 'ftyp'
    }

    /** 在一小段位元組裡找 `ftyp`，回它所屬 box 的起點（找不到回 -1） */
    private fun findFtyp(buf: ByteArray): Int {
        var i = 4
        while (i + 8 <= buf.size) {
            if (looksLikeMp4(buf, i - 4)) return i - 4
            i++
        }
        return -1
    }

    /**
     * 算出並**驗證**起點。不是動態照片回 0。
     *
     * ⚠️ 驗證那一次讀取**只有真的疑似動態照片時才會發生** —— 一般照片在檔頭那一步
     *    就回 0 了。整批的成本是「每張一次讀取」，不是兩次。
     * ⚠️ **絕不往外丟例外**：讀不出來只代表「這張不是動態照片」，跟上傳成不成功無關。
     * ⚠️ 不是動態照片也**一定要把 0 送上去** —— 不送的話那一列留在 NULL，
     *    之後後台補掃還會回 Drive 讀一次我們剛剛才讀過的檔頭。
     */
    fun read(source: ByteSource, mime: String?, name: String): Long = runCatching {
        val isJpeg = (mime ?: "").lowercase().let { it == "image/jpeg" || it == "image/jpg" } ||
            (mime.isNullOrBlank() && Regex("""\.jpe?g$""", RegexOption.IGNORE_CASE).containsMatchIn(name))
        if (!isJpeg) return@runCatching 0L

        val total = source.size
        if (total <= 0) return@runCatching 0L

        val head = source.read(0, minOf(total, HEAD_CHUNK.toLong()).toInt())
        val guess = offsetFromHead(head, total)
        if (guess <= 0) return@runCatching 0L

        val probe = source.read(guess, (minOf(total, guess + 16) - guess).toInt())
        if (looksLikeMp4(probe)) return@runCatching guess

        /*
         * 算出來的位置差了幾個位元組（有些機型的 Padding 沒寫進 XMP）。
         * 在附近 4KB 裡找一次 `ftyp`，找不到就當成不是動態照片 ——
         * 硬給一個位置只會讓燈箱端出一支播不了的影片。
         */
        val from = maxOf(0L, guess - 2048)
        val near = source.read(from, (minOf(total, guess + 2048) - from).toInt())
        val at = findFtyp(near)
        if (at >= 0) from + at else 0L
    }.getOrDefault(0L)
}
