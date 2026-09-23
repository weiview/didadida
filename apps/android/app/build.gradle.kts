import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

/** 版本號放在 version.properties，publish-apk.ps1 讀同一份產 version.json */
val versionProps = Properties().apply {
    rootProject.file("version.properties").inputStream().use { load(it) }
}

/**
 * 簽章金鑰不在 repo 裡（同 .dev.vars 的規矩）。
 * 沒有 keystore.properties 時 release 就不簽 —— 本機跑 assembleDevDebug 照樣能裝。
 */
val keystoreProps = Properties().apply {
    val f = rootProject.file("keystore.properties")
    if (f.exists()) f.inputStream().use { load(it) }
}

/**
 * Firebase（推播）的四個識別值，照 flavor 分開：`prod.appId=…`、`dev.appId=…`。
 * ⚠️ 刻意**不用 google-services 外掛**：它要一份 google-services.json 進 repo，
 *    而我們只需要四個字串，`Push.init()` 自己拿它們 `FirebaseApp.initializeApp`。
 * 檔案不在（或某個 flavor 沒填）時值是空字串 → App 照常運作，只是沒有推播。
 */
val firebaseProps = Properties().apply {
    val f = rootProject.file("firebase.properties")
    if (f.exists()) f.inputStream().use { load(it) }
}
fun com.android.build.api.dsl.ProductFlavor.firebaseFields(flavor: String) {
    for ((field, key) in listOf("FCM_API_KEY" to "apiKey", "FCM_APP_ID" to "appId",
                                "FCM_PROJECT_ID" to "projectId", "FCM_SENDER_ID" to "senderId")) {
        buildConfigField("String", field, "\"" + firebaseProps.getProperty("$flavor.$key", "") + "\"")
    }
}

android {
    namespace = "tw.didadida.app"
    compileSdk = 35

    defaultConfig {
        applicationId = "tw.didadida.app"
        // 28：ImageDecoder 才解得開 HEIC，而站上收 HEIC
        minSdk = 28
        targetSdk = 35
        versionCode = versionProps.getProperty("versionCode").toInt()
        versionName = versionProps.getProperty("versionName")
    }

    signingConfigs {
        create("release") {
            val path = keystoreProps.getProperty("storeFile")
            if (path != null) {
                storeFile = rootProject.file(path)
                storePassword = keystoreProps.getProperty("storePassword")
                keyAlias = keystoreProps.getProperty("keyAlias")
                keyPassword = keystoreProps.getProperty("keyPassword")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            if (keystoreProps.getProperty("storeFile") != null) {
                signingConfig = signingConfigs.getByName("release")
            }
        }
    }

    flavorDimensions += "env"
    productFlavors {
        create("prod") {
            dimension = "env"
            manifestPlaceholders["authScheme"] = "didadida"
            buildConfigField("String", "SITE_URL", "\"https://didadida-frontend.pages.dev\"")
            buildConfigField("String", "API_URL", "\"https://didadida-api.didadida.workers.dev/api\"")
            firebaseFields("prod")
        }
        create("dev") {
            dimension = "env"
            // 兩支可以同時裝在同一台手機上，所以 id 與 scheme 都要分開
            applicationIdSuffix = ".dev"
            versionNameSuffix = "-dev"
            manifestPlaceholders["authScheme"] = "didadida-dev"
            buildConfigField("String", "SITE_URL", "\"https://dev.didadida-frontend.pages.dev\"")
            buildConfigField("String", "API_URL", "\"https://didadida-api-dev.didadida.workers.dev/api\"")
            firebaseFields("dev")
        }
    }

    buildFeatures {
        buildConfig = true
        viewBinding = false
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }

    packaging {
        resources.excludes += setOf("META-INF/*.version", "kotlin/**", "DebugProbesKt.bin")
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.browser:browser:1.8.0")
    implementation("androidx.exifinterface:exifinterface:1.3.7")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1")
    implementation("com.google.firebase:firebase-messaging:24.1.0")
}
