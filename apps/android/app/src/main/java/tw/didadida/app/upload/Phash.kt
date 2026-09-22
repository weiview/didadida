package tw.didadida.app.upload

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Rect

/**
 * dHash（64 bit）—— 「特徵碼不同但長得一樣」的重複照片靠它抓。
 *
 * ⚠️⚠️ **這一檔是 `apps/frontend/src/lib/phash.ts` 的複本，算出來必須一模一樣。**
 *    後台那格「相片的像素比對」是拿存量照片的 400px 縮圖在瀏覽器裡算的，
 *    App 傳上來的如果不一樣，存量與新照片就永遠比不到一起（而且錯得很安靜 ——
 *    只是比不出重複，沒有任何錯誤訊息）。四件事一個都不能改：
 *      ① 9×8 灰階，**刻意不管長寬比**（同一張照片的 800px 與 400px 版本因此雜湊相同）；
 *      ② 進 canvas 前**要先填白** —— 透明的 PNG／WebP 像素會被讀成黑色，
 *         跟它的 JPEG 版對不上；
 *      ③ 灰階是 .299R + .587G + .114B；
 *      ④ 位元是「左邊比右邊亮」，由高位往低位排成 16 個十六進位字。
 *
 * ⚠️ 算的是**同一顆 400px 縮圖**（`Media.thumbs` 的 sm 那張的來源），
 *    不是原圖 —— 後台掃描抓的也是 400px 那顆。
 */
object Phash {

    private const val W = 9
    private const val H = 8

    /** 算不出來只是「這張比不出重複」，**絕不往外丟**（同 `dhashFromBlob`） */
    fun of(bmp: Bitmap): String? = runCatching { compute(bmp) }.getOrNull()

    private fun compute(src: Bitmap): String {
        val small = Bitmap.createBitmap(W, H, Bitmap.Config.ARGB_8888)
        try {
            val canvas = Canvas(small)
            canvas.drawColor(Color.WHITE)          // ⚠️ ② 先填白
            val paint = Paint(Paint.FILTER_BITMAP_FLAG or Paint.ANTI_ALIAS_FLAG)
            canvas.drawBitmap(src, Rect(0, 0, src.width, src.height), Rect(0, 0, W, H), paint)

            val px = IntArray(W * H)
            small.getPixels(px, 0, W, 0, 0, W, H)

            val gray = DoubleArray(W * H)
            for (i in px.indices) {
                val p = px[i]
                gray[i] = 0.299 * ((p shr 16) and 0xFF) +
                          0.587 * ((p shr 8) and 0xFF) +
                          0.114 * (p and 0xFF)
            }

            val sb = StringBuilder(16)
            var nibble = 0
            var bits = 0
            for (y in 0 until H) {
                for (x in 0 until W - 1) {
                    val bit = if (gray[y * W + x] > gray[y * W + x + 1]) 1 else 0
                    nibble = (nibble shl 1) or bit
                    bits++
                    if (bits == 4) {
                        sb.append("0123456789abcdef"[nibble])
                        nibble = 0
                        bits = 0
                    }
                }
            }
            return sb.toString()
        } finally {
            small.recycle()
        }
    }
}
