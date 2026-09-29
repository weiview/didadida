package tw.didadida.app.upload

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import okhttp3.OkHttpClient
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * 網路是不是真的通（有 INTERNET 而且系統驗證過 VALIDATED）。
 * ⚠️ 只看「有沒有連上 Wi-Fi」不夠 —— 連上了但還沒拿到 IP、或是要登入的公共 Wi-Fi，
 *    送出去照樣是 IOException。
 */
object Net {
    /**
     * 全 App 共用一個 OkHttpClient（連線池、執行緒池都跟著共用）。
     *
     * ⚠️ 讀寫逾時放到 5 分鐘：Drive 的 8MB 分塊在行動網路上真的會傳很久，
     *    預設 10 秒會把好好的一塊砍掉，然後我們再重傳一次 —— 白花流量。
     */
    val client: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(30, TimeUnit.SECONDS)
        .readTimeout(5, TimeUnit.MINUTES)
        .writeTimeout(5, TimeUnit.MINUTES)
        .retryOnConnectionFailure(true)
        .build()

    fun online(context: Context): Boolean {
        val cm = context.getSystemService(ConnectivityManager::class.java) ?: return true
        val caps = cm.getNetworkCapabilities(cm.activeNetwork ?: return false) ?: return false
        return caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) &&
            caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
    }

    /** 等到網路通為止，最多 timeoutMs。回傳結束時通不通。會擋住呼叫的執行緒（服務的 worker） */
    fun await(context: Context, timeoutMs: Long): Boolean {
        if (online(context)) return true
        val cm = context.getSystemService(ConnectivityManager::class.java) ?: return true
        val latch = CountDownLatch(1)
        val cb = object : ConnectivityManager.NetworkCallback() {
            override fun onCapabilitiesChanged(network: Network, caps: NetworkCapabilities) {
                if (caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) &&
                    caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
                ) latch.countDown()
            }
        }
        try {
            cm.registerDefaultNetworkCallback(cb)
            latch.await(timeoutMs, TimeUnit.MILLISECONDS)
        } catch (_: Exception) {
        } finally {
            runCatching { cm.unregisterNetworkCallback(cb) }
        }
        return online(context)
    }
}
