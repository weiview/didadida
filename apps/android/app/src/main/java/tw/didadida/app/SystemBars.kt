package tw.didadida.app

import android.app.Activity
import android.graphics.Color
import android.view.View
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat

/**
 * 讓畫面讓開手機的狀態列、導覽列、瀏海與鍵盤。
 *
 * ⚠️⚠️ targetSdk 35 在 Android 15 上**強制 edge-to-edge**：內容一律畫到狀態列底下，
 *    `windowSoftInputMode="adjustResize"` 也跟著失效。於是網頁右上角那一排
 *    （精選、誰在線上、帳號牌）跟燈箱左上角的鎖整個被狀態列蓋住、按不到。
 *    解法是自己把 inset 墊成 padding（含 `ime()` —— 不墊的話鍵盤會蓋住留言輸入框）。
 *
 * `bare()` 回 true 時整個不墊（影片全螢幕那時候要吃滿整個畫面）。狀態改變之後
 * 呼叫端要自己 `ViewCompat.requestApplyInsets(root)`。
 */
object SystemBars {
    fun apply(activity: Activity, root: View, bare: () -> Boolean = { false }) {
        root.setBackgroundColor(Color.WHITE)
        // 墊出來的那一條是白的，狀態列的圖示要畫成深色，不然白底白字看不到時間與電量
        WindowCompat.getInsetsController(activity.window, root).apply {
            isAppearanceLightStatusBars = true
            isAppearanceLightNavigationBars = true
        }
        ViewCompat.setOnApplyWindowInsetsListener(root) { v, insets ->
            if (bare()) {
                v.setPadding(0, 0, 0, 0)
            } else {
                val b = insets.getInsets(
                    WindowInsetsCompat.Type.systemBars() or
                        WindowInsetsCompat.Type.displayCutout() or
                        WindowInsetsCompat.Type.ime(),
                )
                v.setPadding(b.left, b.top, b.right, b.bottom)
            }
            WindowInsetsCompat.CONSUMED
        }
    }
}
