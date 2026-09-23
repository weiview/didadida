package tw.didadida.app

import android.Manifest
import android.annotation.SuppressLint
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Message
import android.util.Base64
import android.view.View
import android.view.ViewGroup
import android.webkit.JavascriptInterface
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.browser.customtabs.CustomTabsIntent
import androidx.core.content.ContextCompat
import tw.didadida.app.upload.UploadEvents
import tw.didadida.app.upload.UploadService
import java.security.SecureRandom

/**
 * 整個 App 就是這一頁：一個 WebView 裝著站台，外加三件網頁在 WebView 裡做不到的事。
 *
 *  1. **上傳**：網頁的上傳鈕在 App 裡改呼叫 `window.DidadidaApp.pickAndUpload()`
 *     （`lib/nativeApp.ts`），選檔之後整條管線交給 `UploadService` 在背景跑 ——
 *     關掉畫面、鎖螢幕都不會中斷，這正是做 App 的理由。
 *  2. **Google 登入**：Google 不准在 WebView 裡登入（disallowed_useragent），
 *     所以攔下 `/api/auth/google/login`，帶上一次性亂數改用 Custom Tab 開；
 *     回呼導回 `didadida://auth?n=<亂數>#token=…`，再把 fragment 接到站台網址上
 *     交給網頁自己的 `consumeAuthHash()` 收。
 *  3. **Google 相簿的選片視窗**：網頁先 `window.open("")` 再改 `location.href`，
 *     我們在 `onCreateWindow` 給它一個看不見的 WebView，等它真的要導去哪裡時
 *     改用 Custom Tab 開（同樣是 Google 不准在 WebView 裡登入）。
 *     ⚠️ 匯入本身仍然是網頁那條 JS 管線，不是背景上傳 —— Picker 的位元組只拿得到
 *     後端代理的那一份，要搬進原生得另外做一套，先不做。
 */
class MainActivity : AppCompatActivity(), UploadEvents.Listener {

    private lateinit var web: WebView
    private lateinit var root: FrameLayout

    /** 等選檔回來才知道要傳去哪一本、用哪張票 */
    private var pendingAlbum: Long = 0
    private var pendingToken: String = ""

    /** 網頁自己的 `<input type="file">`（頭像、GPX…）那一條 */
    private var fileCallback: ValueCallback<Array<Uri>>? = null

    /** `window.open` 給出去的暫時 WebView，要留著參考不然會被回收 */
    private var popupView: WebView? = null

    /** 影片全螢幕 */
    private var customView: View? = null
    private var customCallback: WebChromeClient.CustomViewCallback? = null

    private val prefs by lazy { getSharedPreferences("app", MODE_PRIVATE) }

    private val pickMedia = registerForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { uris ->
        if (uris.isNullOrEmpty() || pendingAlbum <= 0 || pendingToken.isEmpty()) return@registerForActivityResult
        val list = ArrayList<Uri>()
        for (u in uris) {
            // ⚠️ 一定要拿「持久」的讀取權：背景服務在畫面關掉之後才讀得到檔，
            //    暫時權限跟著這個 Activity 一起失效
            runCatching {
                contentResolver.takePersistableUriPermission(u, Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
            list.add(u)
        }
        UploadService.upload(this, pendingAlbum, pendingToken, list)
        pendingToken = ""
    }

    private val pickForWeb = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { res ->
        val cb = fileCallback ?: return@registerForActivityResult
        fileCallback = null
        cb.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(res.resultCode, res.data))
    }

    private val askNotify = registerForActivityResult(ActivityResultContracts.RequestPermission()) { }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        UploadService.ensureChannels(this)

        root = FrameLayout(this)
        web = WebView(this)
        root.addView(web, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        setContentView(root)

        with(web.settings) {
            javaScriptEnabled = true
            domStorageEnabled = true
            // 動態照片進燈箱就自己播（muted），不必等使用者點
            mediaPlaybackRequiresUserGesture = false
            setSupportMultipleWindows(true)
            javaScriptCanOpenWindowsAutomatically = true
            userAgentString = "$userAgentString DidadidaApp/${BuildConfig.VERSION_CODE}"
        }
        web.addJavascriptInterface(Bridge(), "DidadidaApp")
        web.webViewClient = MainClient()
        web.webChromeClient = Chrome()

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                when {
                    customView != null -> customCallback?.onCustomViewHidden()
                    web.canGoBack() -> web.goBack()
                    else -> { isEnabled = false; onBackPressedDispatcher.onBackPressed(); isEnabled = true }
                }
            }
        })

        if (Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            askNotify.launch(Manifest.permission.POST_NOTIFICATIONS)
        }

        if (!handleAuthIntent(intent)) {
            if (savedInstanceState == null || web.restoreState(savedInstanceState) == null) {
                web.loadUrl(Config.SITE + "/")
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleAuthIntent(intent)
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        web.saveState(outState)
    }

    override fun onResume() {
        super.onResume()
        UploadEvents.listener = this
        // 在前景時才有重複照片要決定的，直接端出來
        if (tw.didadida.app.upload.DupStore.first() != null) onDuplicates()
        Updater.check(this)
    }

    override fun onStart() {
        super.onStart()
        visible = true
    }

    override fun onStop() {
        visible = false
        // 離開 App 才裝新版：安裝會把行程殺掉，開著的時候裝等於 App 當場消失
        Updater.installIfReady(this)
        super.onStop()
    }

    override fun onPause() {
        if (UploadEvents.listener === this) UploadEvents.listener = null
        super.onPause()
    }

    override fun onDestroy() {
        popupView?.destroy()
        web.destroy()
        super.onDestroy()
    }

    /* ---- 服務 → 畫面 ---- */

    override fun onUploadDone(albumId: Long) {
        web.evaluateJavascript(
            "window.dispatchEvent(new CustomEvent('${Config.JS_UPLOAD_DONE}',{detail:{albumId:'$albumId'}}))",
            null,
        )
    }

    override fun onDuplicates() {
        startActivity(Intent(this, DuplicateActivity::class.java))
    }

    /* ---- 登入 ---- */

    /** 是 `didadida://auth` 就處理掉並回 true */
    private fun handleAuthIntent(intent: Intent?): Boolean {
        val data = intent?.data ?: return false
        if (data.scheme != Config.AUTH_SCHEME || data.host != "auth") return false
        intent.data = null   // 轉螢幕重建時不要再吃一次

        val expected = prefs.getString(KEY_NONCE, null)
        prefs.edit().remove(KEY_NONCE).apply()
        // ⚠️ 只收自己發出去的那一個：別的 App 也能叫 didadida://auth，
        //    不驗的話任何人都能塞一張他自己的票進來（登入成別人的帳號）
        if (expected == null || data.getQueryParameter("n") != expected) {
            web.loadUrl(Config.SITE + "/")
            return true
        }
        val album = data.getQueryParameter("album")?.takeIf { it.isNotBlank() }
        val frag = data.encodedFragment.orEmpty()
        val base = if (album != null) "${Config.SITE}/album?id=${Uri.encode(album)}" else "${Config.SITE}/"
        web.loadUrl(if (frag.isNotEmpty()) "$base#$frag" else base)
        return true
    }

    private fun startGoogleLogin(url: Uri) {
        val bytes = ByteArray(24).also { SecureRandom().nextBytes(it) }
        val nonce = Base64.encodeToString(bytes, Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP)
        prefs.edit().putString(KEY_NONCE, nonce).apply()
        openCustomTab(url.buildUpon().appendQueryParameter("app", nonce).build())
    }

    private fun openCustomTab(url: Uri) {
        runCatching {
            CustomTabsIntent.Builder().setShowTitle(true).build().launchUrl(this, url)
        }.onFailure {
            runCatching { startActivity(Intent(Intent.ACTION_VIEW, url)) }
        }
    }

    private fun isOwnSite(u: Uri): Boolean = u.host == Uri.parse(Config.SITE).host
    private fun isOwnApi(u: Uri): Boolean = u.host == Uri.parse(Config.API).host

    /** 一個網址該怎麼開：回 true＝已經處理掉（不要在 WebView 裡載） */
    private fun route(u: Uri): Boolean {
        val s = u.toString()
        if (isOwnApi(u) && u.path.orEmpty().endsWith("/auth/google/login")) {
            startGoogleLogin(u)
            return true
        }
        if (u.scheme == "http" || u.scheme == "https") {
            if (isOwnSite(u) || isOwnApi(u)) return false
            openCustomTab(u)
            return true
        }
        if (s.startsWith("about:") || s.startsWith("data:") || s.startsWith("blob:")) return false
        // intent:、mailto:、tel: … 交給系統
        runCatching { startActivity(Intent(Intent.ACTION_VIEW, u)) }
        return true
    }

    private inner class MainClient : WebViewClient() {
        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean =
            route(request.url)
    }

    private inner class Chrome : WebChromeClient() {
        override fun onShowFileChooser(
            view: WebView, callback: ValueCallback<Array<Uri>>, params: FileChooserParams,
        ): Boolean {
            fileCallback?.onReceiveValue(null)
            fileCallback = callback
            return runCatching { pickForWeb.launch(params.createIntent()); true }.getOrElse {
                fileCallback = null
                false
            }
        }

        /**
         * `window.open`：給一個看不見的 WebView，等它第一次真的要去哪裡再決定。
         * 自己的站台（例如「看照片 ↗」開新分頁）就在主畫面載；其他一律 Custom Tab。
         */
        override fun onCreateWindow(view: WebView, isDialog: Boolean, isUserGesture: Boolean, resultMsg: Message): Boolean {
            popupView?.destroy()
            val popup = WebView(this@MainActivity)
            popup.settings.javaScriptEnabled = true
            popup.webViewClient = object : WebViewClient() {
                override fun shouldOverrideUrlLoading(v: WebView, request: WebResourceRequest): Boolean {
                    val u = request.url
                    if (u.toString().startsWith("about:")) return false
                    if (isOwnSite(u)) web.loadUrl(u.toString()) else route(u)
                    return true
                }
            }
            popupView = popup
            val transport = resultMsg.obj as WebView.WebViewTransport
            transport.webView = popup
            resultMsg.sendToTarget()
            return true
        }

        override fun onCloseWindow(window: WebView) {
            if (window === popupView) {
                popupView = null
                window.destroy()
            }
        }

        override fun onShowCustomView(view: View, callback: CustomViewCallback) {
            customView?.let { root.removeView(it) }
            customView = view
            customCallback = callback
            view.setBackgroundColor(Color.BLACK)
            root.addView(view, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        }

        override fun onHideCustomView() {
            customView?.let { root.removeView(it) }
            customView = null
            customCallback = null
        }
    }

    /**
     * 網頁看得到的 `window.DidadidaApp`（型別在前端 `lib/nativeApp.ts`）。
     * ⚠️ 這些方法跑在 WebView 自己的執行緒上，碰畫面一律 runOnUiThread。
     */
    private inner class Bridge {
        @JavascriptInterface
        fun pickAndUpload(albumId: String, token: String) {
            val id = albumId.toLongOrNull() ?: return
            if (token.isBlank()) return
            runOnUiThread {
                pendingAlbum = id
                pendingToken = token
                pickMedia.launch(arrayOf("image/*", "video/*"))
            }
        }

        @JavascriptInterface
        fun version(): String = BuildConfig.VERSION_NAME
    }

    companion object {
        /** 畫面在不在前景（onStart～onStop）。`Updater`／`InstallReceiver` 用它決定裝不裝、怎麼問 */
        @Volatile var visible = false
        private const val KEY_NONCE = "auth_nonce"
    }
}
