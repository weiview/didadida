package tw.didadida.app

import android.appwidget.AppWidgetManager
import android.content.Intent
import android.os.Bundle
import android.util.TypedValue
import android.widget.Button
import android.widget.LinearLayout
import android.widget.SeekBar
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity

/**
 * 桌面小工具「本次精選」的設定：背景與照片各一根透明度拉桿。
 *
 *  - 從哪裡進來：Android 12+ 長按小工具 →「設定」（`widgetFeatures="reconfigurable"`）；
 *    更舊的系統在加小工具的當下跳一次（`configuration_optional` 在那裡不認）。
 *  - 拉的當下就套到桌面上（`FeaturedWidget.applyStyle`，只換顏色與 alpha，
 *    **不重抓清單也不重下載縮圖**）—— 一次拖曳會噴幾十下，每一下打一次網路不划算。
 *  - 值是全部小工具共用一份（prefs `app`）：`render()` 對所有 id 畫同一份 RemoteViews。
 *  - ⚠️ 從「加小工具」進來時一定要 `setResult(RESULT_OK, …EXTRA_APPWIDGET_ID)`，
 *    不然系統當作使用者取消，剛放上去的小工具會被收掉。按返回鍵也算數，所以一進來就先設。
 */
class WidgetConfigActivity : AppCompatActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
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
        root.addView(TextView(this).apply {
            text = "拉動時桌面上的小工具會跟著變。照片會完整顯示，不裁切，空出來的地方就是背景。"
            setPadding(0, dp(12), 0, dp(12))
        })
        root.addView(Button(this).apply {
            text = "完成"
            setOnClickListener { finish() }
        })
        setContentView(root)
        SystemBars.apply(this, root)
    }

    private fun slider(label: String, initial: Int, max: Int = 100, onChange: (Int) -> Unit): LinearLayout {
        val box = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(0, dp(20), 0, 0)
        }
        val title = TextView(this).apply { text = "$label：${initial.coerceIn(0, max)}%" }
        val bar = SeekBar(this).apply {
            this.max = max
            progress = initial.coerceIn(0, max)
            setOnSeekBarChangeListener(object : SeekBar.OnSeekBarChangeListener {
                override fun onProgressChanged(s: SeekBar, value: Int, fromUser: Boolean) {
                    title.text = "$label：$value%"
                    if (fromUser) onChange(value)
                }
                override fun onStartTrackingTouch(s: SeekBar) {}
                override fun onStopTrackingTouch(s: SeekBar) {}
            })
        }
        box.addView(title)
        box.addView(bar)
        return box
    }

    private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()
}
