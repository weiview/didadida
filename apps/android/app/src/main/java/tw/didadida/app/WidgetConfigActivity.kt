package tw.didadida.app

import android.appwidget.AppWidgetManager
import android.content.Intent
import android.os.Bundle
import android.util.TypedValue
import android.widget.Button
import android.widget.LinearLayout
import android.widget.RadioButton
import android.widget.RadioGroup
import android.widget.ScrollView
import android.widget.SeekBar
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.appcompat.app.AppCompatDelegate

/**
 * 桌面小工具「本次精選」的設定：換圖間隔（連續漸變的秒數）、照片顯示方式、背景／照片透明度、圓角、柔邊。
 *
 *  - 從哪裡進來：Android 12+ 長按小工具 →「設定」（`widgetFeatures="reconfigurable"`）；
 *    更舊的系統在加小工具的當下跳一次（`configuration_optional` 在那裡不認）。
 *  - 外觀是烤進點陣圖的（見 `FeaturedWidget.compose`），所以拉桿**放手才重畫**一次
 *    （`onStopTrackingTouch` → `FeaturedWidget.refresh`），拖曳中不重畫。
 *    縮圖在磁碟上有快取，重畫不會重新下載。
 *  - 值是全部小工具共用一份（prefs `app`）；每個小工具照自己的尺寸各畫一份。
 *  - 尺寸不在這裡調：長按小工具、拖邊框就能拉大拉小，照片會跟著重畫。
 *  - 「照片顯示方式」（裁切滿版／完整顯示）是 `FeaturedWidget.fit`，鎖定畫面的動態桌布也看這一格。
 *    Android 不准 App 自己改小工具的尺寸，所以「跟著照片直橫變形」是靠完整顯示＋背景全透明做出來的。
 *  - ⚠️ 從「加小工具」進來時一定要 `setResult(RESULT_OK, …EXTRA_APPWIDGET_ID)`，
 *    不然系統當作使用者取消，剛放上去的小工具會被收掉。按返回鍵也算數，所以一進來就先設。
 */
class WidgetConfigActivity : AppCompatActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        // ⚠️ 手機開著深色模式時，DayNight 主題把文字畫成白色，而 SystemBars 把底色墊成白的 ——
        //    白底白字，上面那排換圖間隔的選項整個看不見（Pixel 7 Pro 回報）。這一頁鎖在淺色。
        //    一定要在 super.onCreate 之前設，之後設會整頁重建一次。
        delegate.localNightMode = AppCompatDelegate.MODE_NIGHT_NO
        super.onCreate(savedInstanceState)
        val widgetId = intent?.extras?.getInt(
            AppWidgetManager.EXTRA_APPWIDGET_ID, AppWidgetManager.INVALID_APPWIDGET_ID,
        ) ?: AppWidgetManager.INVALID_APPWIDGET_ID
        setResult(RESULT_OK, Intent().putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, widgetId))

        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(20), dp(20), dp(20), dp(24))
        }
        root.addView(TextView(this).apply {
            text = "本次精選小工具"
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 20f)
        })

        root.addView(TextView(this).apply {
            text = "換圖間隔"
            setPadding(0, dp(20), 0, dp(4))
        })
        val current = FeaturedWidget.interval(this)
        root.addView(RadioGroup(this).apply {
            orientation = RadioGroup.VERTICAL
            for (m in FeaturedWidget.INTERVALS) {
                addView(RadioButton(this@WidgetConfigActivity).apply {
                    id = 1000 + m
                    text = if (m == 0) "連續漸變（照下面的秒數淡入下一張）" else "$m 分鐘"
                    isChecked = m == current
                })
            }
            setOnCheckedChangeListener { _, checkedId ->
                FeaturedWidget.setInterval(this@WidgetConfigActivity, checkedId - 1000)
                FeaturedWidget.refresh(this@WidgetConfigActivity)
            }
        })

        root.addView(TextView(this).apply {
            text = "照片顯示方式"
            setPadding(0, dp(20), 0, dp(4))
        })
        val fit = FeaturedWidget.fit(this)
        root.addView(RadioGroup(this).apply {
            orientation = RadioGroup.VERTICAL
            addView(RadioButton(this@WidgetConfigActivity).apply {
                id = 2000
                text = "裁切滿版"
                isChecked = !fit
            })
            addView(RadioButton(this@WidgetConfigActivity).apply {
                id = 2001
                text = "完整顯示（直的就直的、橫的就橫的）"
                isChecked = fit
            })
            setOnCheckedChangeListener { _, checkedId ->
                FeaturedWidget.setFit(this@WidgetConfigActivity, checkedId == 2001)
                FeaturedWidget.refresh(this@WidgetConfigActivity)
            }
        })

        root.addView(slider(
            label = "連續漸變：每張停",
            initial = FeaturedWidget.flipSeconds(this),
            min = FeaturedWidget.FLIP_SEC_MIN,
            max = FeaturedWidget.FLIP_SEC_MAX,
            suffix = " 秒",
        ) { sec -> FeaturedWidget.setFlipSeconds(this, sec) })
        root.addView(slider(
            label = "背景透明度",
            initial = 100 - FeaturedWidget.backgroundAlpha(this) * 100 / 255,
        ) { pct -> FeaturedWidget.setBackgroundAlpha(this, (100 - pct) * 255 / 100) })
        root.addView(slider(
            label = "照片透明度",
            initial = 100 - FeaturedWidget.imageAlpha(this) * 100 / 255,
            // 照片全透明等於小工具什麼都不顯示，上限夾在 90%
            max = 90,
        ) { pct -> FeaturedWidget.setImageAlpha(this, (100 - pct) * 255 / 100) })
        root.addView(slider(label = "圓角", initial = FeaturedWidget.corner(this)) { pct ->
            FeaturedWidget.setCorner(this, pct)
        })
        root.addView(slider(label = "柔邊", initial = FeaturedWidget.feather(this)) { pct ->
            FeaturedWidget.setFeather(this, pct)
        })
        root.addView(TextView(this).apply {
            text = "放開拉桿後桌面上的小工具會跟著變。" +
                "選「完整顯示」再把背景透明度拉到 100%，小工具就會跟著每張照片的直橫變形；" +
                "鎖定畫面的動態桌布也照這個設定（照片外圍是黑的）。" +
                "要換尺寸，長按桌面上的小工具、拖曳邊框就能拉大拉小。"
            setPadding(0, dp(16), 0, dp(12))
        })
        root.addView(Button(this).apply {
            text = "也設成鎖定畫面的動態桌布"
            setOnClickListener { FeaturedWallpaper.open(this@WidgetConfigActivity) }
        })
        root.addView(Button(this).apply {
            text = "完成"
            setOnClickListener { finish() }
        })
        val scroll = ScrollView(this).apply { addView(root) }
        setContentView(scroll)
        SystemBars.apply(this, scroll)
    }

    /** SeekBar 的 `min` 要 API 26 —— minSdk 28，可以直接用 */
    private fun slider(
        label: String,
        initial: Int,
        min: Int = 0,
        max: Int = 100,
        suffix: String = "%",
        onChange: (Int) -> Unit,
    ): LinearLayout {
        val box = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(0, dp(20), 0, 0)
        }
        val title = TextView(this).apply { text = "$label：${initial.coerceIn(min, max)}$suffix" }
        val bar = SeekBar(this).apply {
            this.min = min
            this.max = max
            progress = initial.coerceIn(min, max)
            setOnSeekBarChangeListener(object : SeekBar.OnSeekBarChangeListener {
                override fun onProgressChanged(s: SeekBar, value: Int, fromUser: Boolean) {
                    title.text = "$label：$value$suffix"
                    if (fromUser) onChange(value)
                }
                override fun onStartTrackingTouch(s: SeekBar) {}
                override fun onStopTrackingTouch(s: SeekBar) {
                    FeaturedWidget.refresh(this@WidgetConfigActivity)
                }
            })
        }
        box.addView(title)
        box.addView(bar)
        return box
    }

    private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()
}
