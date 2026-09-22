package tw.didadida.app

/**
 * 站台位址與共用常數。值由 build flavor 烤進 BuildConfig（見 app/build.gradle.kts）：
 * prod 指 didadida-frontend.pages.dev，dev 指 dev.didadida-frontend.pages.dev。
 *
 * ⚠️ **兩支 APK 可以同時裝在同一台手機上**（dev 的 applicationId 多一個 `.dev`），
 *    所以 deep link 的 scheme 也必須分開，不然登入回來會跳「要用哪個 App 開」。
 *    scheme 是後端照自己的 hostname 決定的（index.ts 的 appScheme），這裡只是對照。
 */
object Config {
    val SITE: String = BuildConfig.SITE_URL
    val API: String = BuildConfig.API_URL
    val AUTH_SCHEME: String = if (BuildConfig.SITE_URL.contains("dev.")) "didadida-dev" else "didadida"

    const val CHANNEL_UPLOAD = "upload"
    const val CHANNEL_NOTICE = "notice"

    /** 上傳完成後丟回 WebView 的事件名（前端 lib/nativeApp.ts 同一個字串） */
    const val JS_UPLOAD_DONE = "didadida:native-upload-done"
}
