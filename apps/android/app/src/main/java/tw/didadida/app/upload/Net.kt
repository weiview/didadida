package tw.didadida.app.upload

import okhttp3.OkHttpClient
import java.util.concurrent.TimeUnit

/**
 * 全 App 共用一個 OkHttpClient（連線池、執行緒池都跟著共用）。
 *
 * ⚠️ 讀寫逾時放到 5 分鐘：Drive 的 8MB 分塊在行動網路上真的會傳很久，
 *    預設 10 秒會把好好的一塊砍掉，然後我們再重傳一次 —— 白花流量。
 */
object Net {
    val client: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(30, TimeUnit.SECONDS)
        .readTimeout(5, TimeUnit.MINUTES)
        .writeTimeout(5, TimeUnit.MINUTES)
        .retryOnConnectionFailure(true)
        .build()
}
