package tw.didadida.app

import android.app.Application
import tw.didadida.app.push.Push

/**
 * 只為了一件事存在：**在任何元件之前把 Firebase 初始化**。
 *
 * ⚠️ 沒有用 google-services 外掛，所以 Firebase 自己的 InitProvider 找不到預設設定
 *    （只記一行警告，不會當掉）。推播可能在 App 完全沒開著時送達 —— 那時系統直接
 *    叫起 `PushService`，沒有任何 Activity 跑過，初始化只能放在 Application 這一層，
 *    不然 `FirebaseMessagingService` 一碰就丟「Default FirebaseApp is not initialized」。
 */
class App : Application() {
    override fun onCreate() {
        super.onCreate()
        Push.init(this)
    }
}
