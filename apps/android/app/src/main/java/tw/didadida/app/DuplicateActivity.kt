package tw.didadida.app

import android.graphics.BitmapFactory
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.text.TextUtils
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.widget.Button
import android.widget.HorizontalScrollView
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AppCompatActivity
import okhttp3.Request
import tw.didadida.app.upload.DupStore
import tw.didadida.app.upload.Ingest
import tw.didadida.app.upload.Net
import tw.didadida.app.upload.PendingDup
import tw.didadida.app.upload.UploadService
import java.util.concurrent.Executors

/**
 * 撞到重複的那幾張，一張一張問（網頁 `GoogleSyncConflictModal` 的原生版）。
 *
 * 三個選擇跟網頁一樣：**跳過**／**兩張都留**／**取代所選**（點右邊既有的那幾張來選）。
 * 按完立刻換下一張，真正的上傳由 `UploadService` 在背景排隊做 —— 同網頁
 * 「按完立刻跳下一張，事情排到背景做」那條規矩。
 *
 * ⚠️ 一定要顯示檔名：縮圖小到兩張長得幾乎一樣，檔名才是當場判斷得了的線索。
 * ⚠️ 標題那句話跟著 `reason` 換 —— 確定與疑似要使用者做的事完全不同。
 */
class DuplicateActivity : AppCompatActivity() {

    private var session = 0
    private var ingest: Ingest? = null
    private var index = 0
    private val selected = HashSet<Long>()

    private lateinit var content: LinearLayout
    private val io = Executors.newFixedThreadPool(3)
    private val main = Handler(Looper.getMainLooper())
    /** 換到下一張之後，上一張還在飛的縮圖回來時不要畫上去 */
    private var generation = 0

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val scroll = ScrollView(this)
        content = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(16), dp(16), dp(16), dp(24))
        }
        scroll.addView(content)
        setContentView(scroll)
        SystemBars.apply(this, scroll)

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            // 返回鍵＝這一張跳過（不做任何事），繼續問下一張；要全部跳過用底下那顆
            override fun handleOnBackPressed() = decide(skip = true)
        })

        val want = savedInstanceState?.getInt(KEY_SESSION, 0) ?: 0
        index = savedInstanceState?.getInt(KEY_INDEX, 0) ?: 0
        val entry = if (want != 0) DupStore.sessions[want]?.let { want to it } else null
        if (entry != null) {
            session = entry.first; ingest = entry.second
        } else if (!nextSession()) {
            finish(); return
        }
        render()
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        outState.putInt(KEY_SESSION, session)
        outState.putInt(KEY_INDEX, index)
    }

    override fun onDestroy() {
        io.shutdownNow()
        super.onDestroy()
    }

    private fun nextSession(): Boolean {
        val e = DupStore.first() ?: return false
        session = e.key; ingest = e.value; index = 0
        return true
    }

    private fun current(): PendingDup? = ingest?.dupes?.getOrNull(index)

    private fun decide(skip: Boolean, replace: LongArray = LongArray(0), backfill: Long = 0L) {
        UploadService.decideDup(this, session, index, skip, replace, backfill)
        advance()
    }

    private fun skipAll() {
        val total = ingest?.dupes?.size ?: 0
        // 跳過本來就什麼都不必做，直接收掉這一批
        index = total
        advance()
    }

    private fun advance() {
        index++
        selected.clear()
        val total = ingest?.dupes?.size ?: 0
        if (index >= total) {
            DupStore.close(session)
            UploadService.finishDups(this, session)
            if (!nextSession()) { finish(); return }
        }
        render()
    }

    private fun render() {
        generation++
        val gen = generation
        content.removeAllViews()
        val dup = current() ?: run { finish(); return }
        val total = ingest?.dupes?.size ?: 0

        content.addView(text("可能重複的照片（${index + 1} / $total）", 20f, bold = true))
        content.addView(
            text(
                when (dup.reason) {
                    "same_file" -> "確定是同一個檔：位元組跟站上那一張一模一樣。"
                    "same_image" -> "畫面一模一樣，但檔案不同（手機與電腦各自縮圖，位元組本來就對不上）。" +
                        "多半是同一張，請比一下檔名與大小。"
                    else -> "可能是同一張：拍攝時間一樣，但檔案不同。連拍會撞在同一秒，請自己看一眼。"
                },
                14f,
            ).also { it.setPadding(0, dp(6), 0, dp(14)) },
        )

        content.addView(text("準備上傳的新照片", 13f, bold = true))
        val newImg = ImageView(this).apply {
            adjustViewBounds = true
            scaleType = ImageView.ScaleType.FIT_CENTER
            setBackgroundColor(Color.parseColor("#11000000"))
        }
        BitmapFactory.decodeByteArray(dup.thumbMd, 0, dup.thumbMd.size)?.let { newImg.setImageBitmap(it) }
        content.addView(newImg, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(220)))
        content.addView(
            text(listOfNotNull(dup.name, sizeText(dup.size)).joinToString(" · "), 13f)
                .also { it.setPadding(0, dp(4), 0, dp(16)) },
        )

        content.addView(text("站上已經有的（點選要被取代的）", 13f, bold = true))
        val row = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
        val hs = HorizontalScrollView(this).apply { addView(row) }
        content.addView(hs)
        for (ex in dup.existing) {
            val cell = LinearLayout(this).apply {
                orientation = LinearLayout.VERTICAL
                setPadding(dp(4), dp(4), dp(4), dp(4))
            }
            val img = ImageView(this).apply { scaleType = ImageView.ScaleType.CENTER_CROP }
            cell.addView(img, LinearLayout.LayoutParams(dp(140), dp(140)))
            cell.addView(
                text(ex.title, 12f).apply {
                    maxLines = 2; ellipsize = TextUtils.TruncateAt.MIDDLE
                    layoutParams = LinearLayout.LayoutParams(dp(140), LinearLayout.LayoutParams.WRAP_CONTENT)
                },
            )
            val tag = when {
                ex.sameFile -> "內容相同"
                ex.sameImage -> "畫面相同"
                else -> "時間相同"
            }
            cell.addView(
                text(listOfNotNull(tag, sizeText(ex.fileSize)).joinToString(" · "), 11f).apply {
                    setTextColor(Color.parseColor("#777777"))
                    layoutParams = LinearLayout.LayoutParams(dp(140), LinearLayout.LayoutParams.WRAP_CONTENT)
                },
            )
            fun paint() {
                cell.background = if (ex.id in selected) GradientDrawable().apply {
                    setStroke(dp(3), Color.parseColor("#E53935")); cornerRadius = dp(6).toFloat()
                } else null
            }
            paint()
            cell.setOnClickListener {
                if (!selected.add(ex.id)) selected.remove(ex.id)
                paint()
                renderReplaceLabel()
            }
            row.addView(cell)
            val url = absolute(ex.thumbLg ?: ex.thumbUrl)
            if (url != null) io.execute {
                val bmp = runCatching {
                    Net.client.newCall(Request.Builder().url(url).build()).execute().use { res ->
                        if (!res.isSuccessful) null
                        else res.body?.bytes()?.let { BitmapFactory.decodeByteArray(it, 0, it.size) }
                    }
                }.getOrNull()
                if (bmp != null) main.post { if (gen == generation && !isFinishing) img.setImageBitmap(bmp) }
            }
        }

        val buttons = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(0, dp(20), 0, 0)
        }
        replaceBtn = button("") { decide(skip = false, replace = selected.toLongArray()) }
        buttons.addView(replaceBtn)
        // 「就是同一張：只補缺的備份」（網頁的 backfillTarget）：剛好一列、種類一致、缺一半
        val twin = dup.existing.singleOrNull()
        if (twin != null && twin.mediaType == dup.mediaType) {
            val need4k = !twin.has4k && dup.mediaType == "photo"
            val needOrig = !twin.hasOriginal
            if (need4k || needOrig) {
                val need = listOfNotNull(if (need4k) "4K" else null, if (needOrig) "原始檔" else null)
                    .joinToString(" ＋ ")
                buttons.addView(button("就是同一張：只補缺的備份（$need）") { decide(skip = false, backfill = twin.id) })
                buttons.addView(
                    text("站上那一張的 Google Drive 缺 $need。不新增照片，標籤、留言、Story 都留著。", 12f)
                        .also { it.setPadding(dp(4), 0, dp(4), dp(10)) },
                )
            }
        }
        buttons.addView(button("兩張都留") { decide(skip = false) })
        buttons.addView(button("跳過這一張") { decide(skip = true) })
        if (total - index > 1) buttons.addView(button("剩下的全部跳過") { skipAll() })
        content.addView(buttons)
        renderReplaceLabel()
    }

    private var replaceBtn: Button? = null

    private fun renderReplaceLabel() {
        val b = replaceBtn ?: return
        b.isEnabled = selected.isNotEmpty()
        b.text = if (selected.isEmpty()) "取代所選（先點上面的照片）" else "取代所選的 ${selected.size} 張"
    }

    /** 原始檔大小；不知道（舊的列是 NULL）就不寫，不要寫成 0 */
    private fun sizeText(n: Long?): String? {
        if (n == null || n <= 0) return null
        return if (n >= 1024L * 1024) String.format("%.1f MB", n / 1024.0 / 1024.0)
        else "${Math.max(1L, Math.round(n / 1024.0))} KB"
    }

    private fun absolute(u: String?): String? {
        if (u.isNullOrBlank()) return null
        if (u.startsWith("http")) return u
        val api = android.net.Uri.parse(Config.API)
        return "${api.scheme}://${api.authority}$u"
    }

    private fun text(s: String, sp: Float, bold: Boolean = false) = TextView(this).apply {
        text = s
        setTextSize(TypedValue.COMPLEX_UNIT_SP, sp)
        if (bold) setTypeface(typeface, android.graphics.Typeface.BOLD)
    }

    private fun button(label: String, onClick: () -> Unit) = Button(this).apply {
        text = label
        isAllCaps = false
        gravity = Gravity.CENTER
        setOnClickListener { onClick() }
        layoutParams = LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT,
        ).apply { topMargin = dp(6) }
    }

    private fun dp(v: Int): Int = (v * resources.displayMetrics.density).toInt()

    companion object {
        private const val KEY_SESSION = "session"
        private const val KEY_INDEX = "index"
    }
}
