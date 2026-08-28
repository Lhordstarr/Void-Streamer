package com.void.streamer

import android.os.Handler
import android.os.Looper
import android.webkit.JavascriptInterface

/**
 * Native bridge exposed to the WebView as `AndroidBridge`.
 *
 * Every method mirrors a `window.api.*` call from the Electron `preload.js`.
 * Each async method receives a `callbackId`; when the native work finishes it
 * calls [resolve], which invokes `window.__resolve(id, ok, payload)` in JS,
 * resolving the Promise that the injected shim created.
 *
 * For the skeleton, every method returns a "not implemented on Android"
 * payload. The README explains what native reimplementation each one needs
 * (scraping with Jsoup/OkHttp, streaming with ExoPlayer/Media3, downloads
 * with WorkManager, etc.).
 */
object AndroidBridge {

    private var webView: android.webkit.WebView? = null
    private val handler = Handler(Looper.getMainLooper())

    fun attach(wv: android.webkit.WebView) {
        webView = wv
    }

    /** Send a result back to JS. `payload` must already be valid JSON. */
    private fun resolve(callbackId: String, ok: Boolean, payload: String) {
        val safe = payload
            .replace("\\", "\\\\")
            .replace("'", "\\'")
            .replace("\n", " ")
            .replace("\r", " ")
        val js = "window.__resolve('$callbackId', $ok, '$safe')"
        handler.post { webView?.evaluateJavascript(js, null) }
    }

    private fun notImpl(callbackId: String) {
        resolve(callbackId, true, "{\"success\":false,\"error\":\"not implemented on Android\"}")
    }

    // ── Scraping (replace with Jsoup / OkHttp + coroutines) ──────────────────
    @JavascriptInterface
    fun scrapeUrl(url: String, configJson: String, callbackId: String) = notImpl(callbackId)

    @JavascriptInterface
    fun scrapeDetail(url: String, configJson: String, callbackId: String) = notImpl(callbackId)

    @JavascriptInterface
    fun scrapeMoviboxStream(url: String, callbackId: String) = notImpl(callbackId)

    @JavascriptInterface
    fun scrapeSpa(url: String, jsCode: String, callbackId: String) = notImpl(callbackId)

    @JavascriptInterface
    fun scrapeKawaiiVideo(url: String, callbackId: String) = notImpl(callbackId)

    @JavascriptInterface
    fun scrapeAnimeSourceVideo(url: String, lang: String, callbackId: String) = notImpl(callbackId)

    // ── Downloads (replace with WorkManager + native file writing) ───────────
    @JavascriptInterface
    fun startDownload(url: String, title: String, quality: String, image: String, callbackId: String) = notImpl(callbackId)

    @JavascriptInterface
    fun pauseDownload(downloadId: String, callbackId: String) = notImpl(callbackId)

    @JavascriptInterface
    fun resumeDownload(downloadId: String, callbackId: String) = notImpl(callbackId)

    @JavascriptInterface
    fun cancelDownload(downloadId: String, callbackId: String) = notImpl(callbackId)

    // ── Stream analysis (HEAD requests; sizes, HLS variants) ────────────────
    @JavascriptInterface
    fun analyzeStream(url: String, quick: Boolean, callbackId: String) = notImpl(callbackId)

    // ── FFmpeg remux (use a native lib: mobile-ffmpeg / ffmpeg-kit) ─────────
    @JavascriptInterface
    fun readFile(path: String, callbackId: String) = notImpl(callbackId)

    @JavascriptInterface
    fun writeFile(path: String, dataJson: String, callbackId: String) = notImpl(callbackId)

    @JavascriptInterface
    fun remuxTsToMp4(tsPath: String, mp4Path: String, downloadId: String, callbackId: String) = notImpl(callbackId)

    // ── Cache (write to app-specific storage / MediaStore) ──────────────────
    @JavascriptInterface
    fun cacheVideo(url: String, title: String, cacheId: String, callbackId: String) = notImpl(callbackId)

    @JavascriptInterface
    fun listCache(callbackId: String) = notImpl(callbackId)

    @JavascriptInterface
    fun saveCache(cachePath: String, callbackId: String) = notImpl(callbackId)

    @JavascriptInterface
    fun deleteCache(cachePath: String, callbackId: String) = notImpl(callbackId)

    @JavascriptInterface
    fun listActiveCaches(callbackId: String) = notImpl(callbackId)

    @JavascriptInterface
    fun cancelCache(cacheId: String, callbackId: String) = notImpl(callbackId)

    // ── Local file playback (serve via a tiny localhost socket / ContentProvider) ─
    @JavascriptInterface
    fun playLocalFile(path: String, callbackId: String) = notImpl(callbackId)

    // ── Open external (no Promise) ──────────────────────────────────────────
    @JavascriptInterface
    fun openExternal(url: String) { /* TODO: startActivity(Intent.ACTION_VIEW) */ }
}
