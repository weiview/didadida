package tw.didadida.app

import android.Manifest
import android.content.ContentUris
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.MediaStore
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
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import java.util.concurrent.Executors

/**
 * 自己的挑相片格子（2026-09-29 使用者：上傳挑照片要「點一下就選」，不要長按）。
 *
 * 系統的 `OpenMultipleDocuments`／Photo Picker 第一張都要長按才進多選，
 * 所以這裡直接讀 MediaStore 自己畫一個四欄格子：**點一下就勾、再點一下取消**。
 *
 * - 權限：13+ 是 `READ_MEDIA_IMAGES`＋`READ_MEDIA_VIDEO`（14+ 另有「只允許部分相片」），
 *   12 以下是 `READ_EXTERNAL_STORAGE`。拒絕的話給一顆「改用系統選擇器」當退路
 *   （回 `RESULT_USE_SYSTEM`，由 MainActivity 開舊的那條）。
 * - ⚠️⚠️ `ACCESS_MEDIA_LOCATION` 一定要要，而且每個網址都要 `setRequireOriginal` ——
 *   不然系統會把 EXIF／影片裡的 GPS 抹掉，照片上傳上去就沒有座標、足跡地圖上沒有點，
 *   而且錯得很安靜。沒給這個權限時**不能**呼叫 `setRequireOriginal`（開檔會丟例外）。
 * - 回傳的是 MediaStore 網址，不是 SAF 網址：`takePersistableUriPermission` 對它無效
 *   也不需要 —— App 本身持有讀取權限，背景服務照樣讀得到。
 * - 縮圖在背景執行緒用 `loadThumbnail` 取（系統自己有快取），格子是 `GridView` 回收，
 *   回來時比一下那一格還是不是同一張，不是就丟掉。
 */
class GalleryActivity : AppCompatActivity() {

    private class Item(val id: Long, val video: Boolean, val durationMs: Long) {
        val uri: Uri
            get() = ContentUris.withAppendedId(
                if (video) MediaStore.Video.Media.EXTERNAL_CONTENT_URI else MediaStore.Images.Media.EXTERNAL_CONTENT_URI,
                id,
            )
    }

    private var items: List<Item> = emptyList()
    /** 勾選順序就是上傳順序 */
    private val picked = LinkedHashSet<Long>()

    private lateinit var grid: GridView
    private lateinit var message: TextView
    private lateinit var more: Button
    private lateinit var fallback: Button
    private lateinit var upload: Button
    private lateinit var title: TextView

    private val io = Executors.newFixedThreadPool(4)
    private val main = Handler(Looper.getMainLooper())
    private val cache = object : LruCache<Long, Bitmap>((Runtime.getRuntime().maxMemory() / 8).toInt()) {
        override fun sizeOf(key: Long, value: Bitmap) = value.byteCount
    }
    private var cellPx = 0

    private val askPerms = registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) {
        refresh()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        savedInstanceState?.getLongArray(KEY_PICKED)?.forEach { picked.add(it) }

        val root = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }

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
        upload = Button(this).apply {
            isAllCaps = false
            setOnClickListener { finishWithPicks() }
        }
        bar.addView(upload)
        root.addView(bar)

        more = Button(this).apply {
            isAllCaps = false
            text = "目前只允許部分相片 · 點這裡選更多"
            visibility = View.GONE
            setOnClickListener { askPerms.launch(wanted()) }
        }
        root.addView(more, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))

        message = TextView(this).apply {
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 15f)
            gravity = Gravity.CENTER
            setPadding(dp(24), dp(32), dp(24), dp(8))
            visibility = View.GONE
        }
        root.addView(message)
        fallback = Button(this).apply {
            isAllCaps = false
            text = "改用系統選擇器"
            visibility = View.GONE
            setOnClickListener { setResult(RESULT_USE_SYSTEM); finish() }
        }
        root.addView(fallback, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
            gravity = Gravity.CENTER_HORIZONTAL
        })

        grid = GridView(this).apply {
            numColumns = COLUMNS
            stretchMode = GridView.STRETCH_COLUMN_WIDTH
            horizontalSpacing = dp(2)
            verticalSpacing = dp(2)
            adapter = Adapter()
            setOnItemClickListener { _, _, pos, _ -> toggle(pos) }
        }
        root.addView(grid, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))

        setContentView(root)
        SystemBars.apply(this, root)
        cellPx = resources.displayMetrics.widthPixels / COLUMNS
        updateBar()

        if (canRead()) refresh() else askPerms.launch(wanted())
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        outState.putLongArray(KEY_PICKED, picked.toLongArray())
    }

    override fun onDestroy() {
        io.shutdownNow()
        super.onDestroy()
    }

    // ---- 權限 ----

    private fun granted(p: String) = ContextCompat.checkSelfPermission(this, p) == PackageManager.PERMISSION_GRANTED

    private fun wanted(): Array<String> = when {
        Build.VERSION.SDK_INT >= 34 -> arrayOf(
            Manifest.permission.READ_MEDIA_IMAGES, Manifest.permission.READ_MEDIA_VIDEO,
            Manifest.permission.READ_MEDIA_VISUAL_USER_SELECTED, Manifest.permission.ACCESS_MEDIA_LOCATION,
        )
        Build.VERSION.SDK_INT >= 33 -> arrayOf(
            Manifest.permission.READ_MEDIA_IMAGES, Manifest.permission.READ_MEDIA_VIDEO,
            Manifest.permission.ACCESS_MEDIA_LOCATION,
        )
        Build.VERSION.SDK_INT >= 29 -> arrayOf(
            Manifest.permission.READ_EXTERNAL_STORAGE, Manifest.permission.ACCESS_MEDIA_LOCATION,
        )
        else -> arrayOf(Manifest.permission.READ_EXTERNAL_STORAGE)
    }

    private fun fullAccess(): Boolean = if (Build.VERSION.SDK_INT >= 33) {
        granted(Manifest.permission.READ_MEDIA_IMAGES) || granted(Manifest.permission.READ_MEDIA_VIDEO)
    } else {
        granted(Manifest.permission.READ_EXTERNAL_STORAGE)
    }

    private fun partialAccess(): Boolean =
        Build.VERSION.SDK_INT >= 34 && !fullAccess() && granted(Manifest.permission.READ_MEDIA_VISUAL_USER_SELECTED)

    private fun canRead() = fullAccess() || partialAccess()

    // ---- 資料 ----

    private fun refresh() {
        more.visibility = if (partialAccess()) View.VISIBLE else View.GONE
        if (!canRead()) {
            grid.visibility = View.GONE
            message.text = "需要「相片和影片」的存取權限才能列出手機裡的照片。\n也可以改用系統的選擇器（要長按才能多選）。"
            message.visibility = View.VISIBLE
            fallback.visibility = View.VISIBLE
            return
        }
        message.visibility = View.GONE
        fallback.visibility = View.GONE
        grid.visibility = View.VISIBLE
        io.execute {
            val list = runCatching { query() }.getOrElse { emptyList() }
            main.post {
                if (isFinishing || isDestroyed) return@post
                items = list
                val alive = list.mapTo(HashSet()) { it.id }
                picked.retainAll(alive)
                (grid.adapter as BaseAdapter).notifyDataSetChanged()
                if (list.isEmpty()) {
                    message.text = if (partialAccess()) "還沒有允許任何相片，點上面那顆選一些。" else "手機裡沒有照片或影片。"
                    message.visibility = View.VISIBLE
                }
                updateBar()
            }
        }
    }

    private fun query(): List<Item> {
        val out = ArrayList<Item>()
        val files = MediaStore.Files.getContentUri("external")
        val sel = "${MediaStore.Files.FileColumns.MEDIA_TYPE} IN (" +
            "${MediaStore.Files.FileColumns.MEDIA_TYPE_IMAGE},${MediaStore.Files.FileColumns.MEDIA_TYPE_VIDEO})"
        // "duration" 在 API 29 才進 MediaColumns，但 28 的 files 表裡本來就有這一欄
        val proj = arrayOf(MediaStore.Files.FileColumns._ID, MediaStore.Files.FileColumns.MEDIA_TYPE, "duration")
        contentResolver.query(files, proj, sel, null, "${MediaStore.Files.FileColumns.DATE_ADDED} DESC")?.use { c ->
            val iId = c.getColumnIndexOrThrow(MediaStore.Files.FileColumns._ID)
            val iType = c.getColumnIndexOrThrow(MediaStore.Files.FileColumns.MEDIA_TYPE)
            val iDur = c.getColumnIndex("duration")
            while (c.moveToNext()) {
                val video = c.getInt(iType) == MediaStore.Files.FileColumns.MEDIA_TYPE_VIDEO
                out.add(Item(c.getLong(iId), video, if (iDur >= 0 && video) c.getLong(iDur) else 0L))
            }
        }
        return out
    }

    // ---- 選取 ----

    private fun toggle(pos: Int) {
        val it = items.getOrNull(pos) ?: return
        if (!picked.remove(it.id)) picked.add(it.id)
        (grid.adapter as BaseAdapter).notifyDataSetChanged()
        updateBar()
    }

    private fun updateBar() {
        title.text = if (picked.isEmpty()) "點一下就選" else "已選 ${picked.size} 個"
        upload.text = if (picked.isEmpty()) "上傳" else "上傳 (${picked.size})"
        upload.isEnabled = picked.isNotEmpty()
    }

    private fun finishWithPicks() {
        if (picked.isEmpty()) return
        val byId = items.associateBy { it.id }
        // ⚠️ 沒有 ACCESS_MEDIA_LOCATION 時不能 setRequireOriginal（開檔會丟例外）
        val original = Build.VERSION.SDK_INT >= 29 && granted(Manifest.permission.ACCESS_MEDIA_LOCATION)
        val uris = ArrayList<Uri>()
        for (id in picked) {
            val u = byId[id]?.uri ?: continue
            uris.add(if (original) MediaStore.setRequireOriginal(u) else u)
        }
        setResult(RESULT_OK, Intent().putParcelableArrayListExtra(EXTRA_URIS, uris))
        finish()
    }

    // ---- 格子 ----

    /** 正方形的一格 */
    private class Cell(ctx: Context) : FrameLayout(ctx) {
        val image = ImageView(ctx).apply {
            scaleType = ImageView.ScaleType.CENTER_CROP
            setBackgroundColor(Color.parseColor("#EEEEEE"))
        }
        val shade = View(ctx).apply { setBackgroundColor(Color.parseColor("#66000000")) }
        val badge = TextView(ctx).apply {
            gravity = Gravity.CENTER
            setTextColor(Color.WHITE)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
        }
        val duration = TextView(ctx).apply {
            setTextColor(Color.WHITE)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 11f)
            setShadowLayer(3f, 0f, 0f, Color.BLACK)
        }
        var boundId = -1L

        init {
            val d = ctx.resources.displayMetrics.density
            addView(image, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
            addView(shade, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
            val s = (26 * d).toInt()
            addView(badge, LayoutParams(s, s, Gravity.TOP or Gravity.END).apply {
                val m = (6 * d).toInt(); topMargin = m; marginEnd = m
            })
            addView(duration, LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT, Gravity.BOTTOM or Gravity.END).apply {
                val m = (5 * d).toInt(); bottomMargin = m; marginEnd = m
            })
        }

        override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) =
            super.onMeasure(widthMeasureSpec, widthMeasureSpec)
    }

    private fun circle(fill: Int, stroke: Int) = GradientDrawable().apply {
        shape = GradientDrawable.OVAL
        setColor(fill)
        setStroke(dp(2), stroke)
    }

    private inner class Adapter : BaseAdapter() {
        override fun getCount() = items.size
        override fun getItem(position: Int) = items[position]
        override fun getItemId(position: Int) = items[position].id

        override fun getView(position: Int, convertView: View?, parent: ViewGroup): View {
            val cell = (convertView as? Cell) ?: Cell(this@GalleryActivity).apply {
                layoutParams = AbsListView.LayoutParams(AbsListView.LayoutParams.MATCH_PARENT, AbsListView.LayoutParams.WRAP_CONTENT)
            }
            val item = items[position]
            val order = picked.indexOf(item.id)
            cell.shade.visibility = if (order >= 0) View.VISIBLE else View.GONE
            if (order >= 0) {
                cell.badge.text = (order + 1).toString()
                cell.badge.background = circle(Color.parseColor("#1E88E5"), Color.WHITE)
            } else {
                cell.badge.text = ""
                cell.badge.background = circle(Color.parseColor("#33000000"), Color.WHITE)
            }
            cell.duration.visibility = if (item.video) View.VISIBLE else View.GONE
            if (item.video) cell.duration.text = if (item.durationMs > 0) "▶ " + formatDuration(item.durationMs) else "▶"

            if (cell.boundId != item.id) {
                cell.boundId = item.id
                val hit = cache.get(item.id)
                cell.image.setImageBitmap(hit)
                if (hit == null) loadThumb(cell, item)
            }
            return cell
        }
    }

    private fun loadThumb(cell: Cell, item: Item) {
        val px = cellPx.coerceIn(96, 512)
        io.execute {
            // 捲過去了（這一格已經換成別張）就不必解了
            if (cell.boundId != item.id) return@execute
            val bmp = runCatching { thumb(item, px) }.getOrNull() ?: return@execute
            cache.put(item.id, bmp)
            main.post { if (cell.boundId == item.id) cell.image.setImageBitmap(bmp) }
        }
    }

    @Suppress("DEPRECATION")
    private fun thumb(item: Item, px: Int): Bitmap? = if (Build.VERSION.SDK_INT >= 29) {
        contentResolver.loadThumbnail(item.uri, Size(px, px), null)
    } else if (item.video) {
        MediaStore.Video.Thumbnails.getThumbnail(contentResolver, item.id, MediaStore.Video.Thumbnails.MINI_KIND, null)
    } else {
        MediaStore.Images.Thumbnails.getThumbnail(contentResolver, item.id, MediaStore.Images.Thumbnails.MINI_KIND, null)
    }

    private fun formatDuration(ms: Long): String {
        val s = ms / 1000
        return if (s >= 3600) "%d:%02d:%02d".format(s / 3600, s / 60 % 60, s % 60) else "%d:%02d".format(s / 60, s % 60)
    }

    private fun dp(v: Int): Int = (v * resources.displayMetrics.density).toInt()

    companion object {
        const val EXTRA_URIS = "uris"
        /** 沒給權限、使用者按了「改用系統選擇器」 */
        const val RESULT_USE_SYSTEM = RESULT_FIRST_USER
        private const val COLUMNS = 4
        private const val KEY_PICKED = "picked"
    }
}
