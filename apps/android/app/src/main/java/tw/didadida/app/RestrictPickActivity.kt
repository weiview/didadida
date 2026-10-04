package tw.didadida.app

import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.media.MediaMetadataRetriever
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.LruCache
import android.util.Size
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.AbsListView
import android.widget.BaseAdapter
import android.widget.Button
import android.widget.FrameLayout
import android.widget.GridView
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import java.util.concurrent.Executors

/**
 * 上傳前逐張挑「不開放」（1.0.25，網頁 UploadPickModal 的原生版）。
 *
 * 只有可管理全站內容的人會走到這一步 —— 網頁透過 pickAndUploadEx(…, canManage) 告訴 App。
 * 收進來的是挑好的網址（GalleryActivity 的 MediaStore 網址，或系統選擇器的 SAF 網址），
 * 回傳同一份網址 ＋ 一個同順序的 BooleanArray。
 *
 * ⚠️ 標記跟著 POST /api/upload 那一趟寫進 INSERT（後端只認 canManageOthers），
 *    網址從來沒發出去過，所以不必換 R2 鍵。
 */
class RestrictPickActivity : AppCompatActivity() {

    private var uris: ArrayList<Uri> = ArrayList()
    private var videos: BooleanArray = BooleanArray(0)
    private var marked = BooleanArray(0)

    private lateinit var grid: GridView
    private lateinit var title: TextView
    private lateinit var all: Button

    private val io = Executors.newFixedThreadPool(3)
    private val main = Handler(Looper.getMainLooper())
    private val cache = object : LruCache<Int, Bitmap>((Runtime.getRuntime().maxMemory() / 8).toInt()) {
        override fun sizeOf(key: Int, value: Bitmap) = value.byteCount
    }
    private var cellPx = 0

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        @Suppress("DEPRECATION")
        uris = intent.getParcelableArrayListExtra<Uri>(EXTRA_URIS) ?: ArrayList()
        if (uris.isEmpty()) { setResult(RESULT_CANCELED); finish(); return }
        marked = savedInstanceState?.getBooleanArray(KEY_MARKED)?.takeIf { it.size == uris.size }
            ?: BooleanArray(uris.size)
        videos = BooleanArray(uris.size) { i ->
            runCatching { contentResolver.getType(uris[i]) }.getOrNull()?.startsWith("video/") == true
        }

        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(Color.WHITE)
        }

        val bar = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(8), dp(4), dp(8), dp(4))
        }
        bar.addView(Button(this).apply {
            text = "取消"; isAllCaps = false
            setOnClickListener { setResult(RESULT_CANCELED); finish() }
        })
        title = TextView(this).apply {
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 16f)
            gravity = Gravity.CENTER
            setTextColor(Color.parseColor("#222222"))
        }
        bar.addView(title, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        bar.addView(Button(this).apply {
            text = "開始上傳"; isAllCaps = false
            setOnClickListener { done() }
        })
        root.addView(bar)

        root.addView(TextView(this).apply {
            text = "點一下縮圖可標成「不開放」：只有可管理全站內容的人看得到，其他成員與訪客看不到；" +
                "這些檔案也不會出現在「有人上傳了」的通知裡。不標就照一般方式上傳。"
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
            setTextColor(Color.parseColor("#64748B"))
            setPadding(dp(14), dp(2), dp(14), dp(6))
        })
        all = Button(this).apply {
            isAllCaps = false
            setOnClickListener {
                marked.fill(!marked.all { it })
                refresh()
            }
        }
        root.addView(all, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
            gravity = Gravity.END; marginEnd = dp(8)
        })

        grid = GridView(this).apply {
            numColumns = COLUMNS
            stretchMode = GridView.STRETCH_COLUMN_WIDTH
            horizontalSpacing = dp(2)
            verticalSpacing = dp(2)
            adapter = Adapter()
            setOnItemClickListener { _, _, pos, _ ->
                marked[pos] = !marked[pos]
                refresh()
            }
        }
        root.addView(grid, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))

        setContentView(root)
        SystemBars.apply(this, root)
        cellPx = resources.displayMetrics.widthPixels / COLUMNS
        refresh()
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        outState.putBooleanArray(KEY_MARKED, marked)
    }

    override fun onDestroy() {
        io.shutdownNow()
        super.onDestroy()
    }

    private fun refresh() {
        val n = marked.count { it }
        title.text = if (n == 0) "${uris.size} 個檔案" else "$n 個不開放"
        all.text = if (marked.all { it }) "全部取消" else "全部標為不開放"
        (grid.adapter as BaseAdapter).notifyDataSetChanged()
    }

    private fun done() {
        setResult(RESULT_OK, Intent()
            .putParcelableArrayListExtra(EXTRA_URIS, uris)
            .putExtra(EXTRA_RESTRICTED, marked))
        finish()
    }

    // ---- 格子 ----

    private class Cell(ctx: Context) : FrameLayout(ctx) {
        val image = ImageView(ctx).apply {
            scaleType = ImageView.ScaleType.CENTER_CROP
            setBackgroundColor(Color.parseColor("#EEEEEE"))
        }
        val shade = View(ctx).apply { setBackgroundColor(Color.parseColor("#99000000")) }
        val frame = View(ctx)
        val badge = TextView(ctx).apply {
            setTextColor(Color.WHITE)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 11f)
        }
        val video = TextView(ctx).apply {
            text = "▶"
            setTextColor(Color.WHITE)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f)
            setShadowLayer(3f, 0f, 0f, Color.BLACK)
        }
        var boundPos = -1

        init {
            val d = ctx.resources.displayMetrics.density
            addView(image, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
            addView(shade, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
            addView(frame, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
            addView(badge, LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT, Gravity.TOP or Gravity.START).apply {
                val m = (5 * d).toInt(); topMargin = m; marginStart = m
            })
            addView(video, LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT, Gravity.BOTTOM or Gravity.END).apply {
                val m = (5 * d).toInt(); bottomMargin = m; marginEnd = m
            })
        }

        override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) =
            super.onMeasure(widthMeasureSpec, widthMeasureSpec)
    }

    private fun pill(fill: Int) = GradientDrawable().apply {
        cornerRadius = dp(10).toFloat()
        setColor(fill)
    }

    private val orange = Color.parseColor("#F59E0B")

    private inner class Adapter : BaseAdapter() {
        override fun getCount() = uris.size
        override fun getItem(position: Int) = uris[position]
        override fun getItemId(position: Int) = position.toLong()

        override fun getView(position: Int, convertView: View?, parent: ViewGroup): View {
            val cell = (convertView as? Cell) ?: Cell(this@RestrictPickActivity).apply {
                layoutParams = AbsListView.LayoutParams(AbsListView.LayoutParams.MATCH_PARENT, AbsListView.LayoutParams.WRAP_CONTENT)
            }
            val on = marked[position]
            cell.shade.visibility = if (on) View.VISIBLE else View.GONE
            cell.frame.background = if (on) GradientDrawable().apply { setStroke(dp(3), orange) } else null
            cell.badge.text = if (on) "🔒 不開放" else "🔓"
            cell.badge.background = pill(if (on) orange else Color.parseColor("#8C0F172A"))
            cell.badge.setPadding(dp(6), dp(1), dp(6), dp(1))
            cell.video.visibility = if (videos[position]) View.VISIBLE else View.GONE

            if (cell.boundPos != position) {
                cell.boundPos = position
                val hit = cache.get(position)
                cell.image.setImageBitmap(hit)
                if (hit == null) loadThumb(cell, position)
            }
            return cell
        }
    }

    private fun loadThumb(cell: Cell, pos: Int) {
        val px = cellPx.coerceIn(96, 512)
        io.execute {
            if (cell.boundPos != pos) return@execute
            val bmp = runCatching { thumb(uris[pos], videos[pos], px) }.getOrNull() ?: return@execute
            cache.put(pos, bmp)
            main.post { if (cell.boundPos == pos) cell.image.setImageBitmap(bmp) }
        }
    }

    /** MediaStore 與 SAF 網址都吃得下；29 以下自己解（取樣到格子大小） */
    private fun thumb(uri: Uri, video: Boolean, px: Int): Bitmap? {
        if (Build.VERSION.SDK_INT >= 29) {
            runCatching { return contentResolver.loadThumbnail(uri, Size(px, px), null) }
        }
        if (video) {
            val r = MediaMetadataRetriever()
            return try {
                r.setDataSource(this, uri)
                r.getFrameAtTime(1_000_000)?.let {
                    Bitmap.createScaledBitmap(it, px, px * it.height / it.width.coerceAtLeast(1), true)
                }
            } finally { runCatching { r.release() } }
        }
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        contentResolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, bounds) }
        var sample = 1
        while (bounds.outWidth / (sample * 2) >= px && bounds.outHeight / (sample * 2) >= px) sample *= 2
        return contentResolver.openInputStream(uri)?.use {
            BitmapFactory.decodeStream(it, null, BitmapFactory.Options().apply { inSampleSize = sample })
        }
    }

    private fun dp(v: Int): Int = (v * resources.displayMetrics.density).toInt()

    companion object {
        const val EXTRA_URIS = "uris"
        const val EXTRA_RESTRICTED = "restricted"
        private const val COLUMNS = 4
        private const val KEY_MARKED = "marked"
    }
}
