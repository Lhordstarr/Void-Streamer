package com.void.streamer

import android.os.Bundle
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.appcompat.app.AppCompatActivity

class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        webView = WebView(this).apply {
            settings.apply {
                javaScriptEnabled = true
                domStorageEnabled = true
                allowFileAccess = true
                allowContentAccess = true
                mediaPlaybackRequiresUserGesture = false
                // The UI is dark by design; force it so web renders correctly.
                setMediaPlaybackRequiresUserGesture(false)
            }
        }
        setContentView(webView)

        AndroidBridge.attach(webView)
        webView.addJavascriptInterface(AndroidBridge, "AndroidBridge")

        webView.webViewClient = object : WebViewClient() {
            override fun onPageFinished(view: WebView?, url: String?) {
                super.onPageFinished(view, url)
                injectApiShim()
            }
        }

        // Load the existing renderer. Copy index.html, renderer.js, style.css,
        // 25.gif and icon.png into app/src/main/assets/ (see README).
        webView.loadUrl("file:///android_asset/index.html")
    }

    /**
     * Defines `window.api` in the page, backed by the native `AndroidBridge`.
     * Layout/markup/styles from index.html are reused unchanged; only the
     * Electron `preload` bridge is replaced by this shim.
     */
    private fun injectApiShim() {
        val shim = """
        (function(){
          if (window.__vsInjected) return;
          window.__vsInjected = true;
          window.__cbs = {};
          window.__id = 0;
          function mk(cb){ var id='c'+(++window.__id); window.__cbs[id]=cb; return id; }
          window.__resolve = function(id, ok, payload){
            var cb = window.__cbs[id];
            if(!cb) return;
            try { cb(ok ? JSON.parse(payload) : {error:payload}); } catch(e){ cb({error:payload}); }
            delete window.__cbs[id];
          };
          window.api = {
            scrapeUrl: function(u,c){ return new Promise(function(r){ AndroidBridge.scrapeUrl(u, JSON.stringify(c||{}), mk(r)); }); },
            scrapeDetail: function(u,c){ return new Promise(function(r){ AndroidBridge.scrapeDetail(u, JSON.stringify(c||{}), mk(r)); }); },
            scrapeMoviboxStream: function(u){ return new Promise(function(r){ AndroidBridge.scrapeMoviboxStream(u, mk(r)); }); },
            scrapeSpa: function(u,j){ return new Promise(function(r){ AndroidBridge.scrapeSpa(u, j, mk(r)); }); },
            scrapeKawaiiVideo: function(u){ return new Promise(function(r){ AndroidBridge.scrapeKawaiiVideo(u, mk(r)); }); },
            scrapeAnimeSourceVideo: function(u,l){ return new Promise(function(r){ AndroidBridge.scrapeAnimeSourceVideo(u, l, mk(r)); }); },
            startDownload: function(u,t,q,i){ return new Promise(function(r){ AndroidBridge.startDownload(u,t,q,i,mk(r)); }); },
            pauseDownload: function(id){ return new Promise(function(r){ AndroidBridge.pauseDownload(id, mk(r)); }); },
            resumeDownload: function(id){ return new Promise(function(r){ AndroidBridge.resumeDownload(id, mk(r)); }); },
            cancelDownload: function(id){ return new Promise(function(r){ AndroidBridge.cancelDownload(id, mk(r)); }); },
            analyzeStream: function(u,q){ return new Promise(function(r){ AndroidBridge.analyzeStream(u, q===true, mk(r)); }); },
            readFile: function(p){ return new Promise(function(r){ AndroidBridge.readFile(p, mk(r)); }); },
            writeFile: function(p,d){ return new Promise(function(r){ AndroidBridge.writeFile(p, JSON.stringify(d), mk(r)); }); },
            remuxTsToMp4: function(t,m,id){ return new Promise(function(r){ AndroidBridge.remuxTsToMp4(t,m,id,mk(r)); }); },
            cacheVideo: function(u,t,id){ return new Promise(function(r){ AndroidBridge.cacheVideo(u,t,id,mk(r)); }); },
            listCache: function(){ return new Promise(function(r){ AndroidBridge.listCache(mk(r)); }); },
            saveCache: function(p){ return new Promise(function(r){ AndroidBridge.saveCache(p, mk(r)); }); },
            deleteCache: function(p){ return new Promise(function(r){ AndroidBridge.deleteCache(p, mk(r)); }); },
            listActiveCaches: function(){ return new Promise(function(r){ AndroidBridge.listActiveCaches(mk(r)); }); },
            cancelCache: function(id){ return new Promise(function(r){ AndroidBridge.cancelCache(id, mk(r)); }); },
            openExternal: function(u){ AndroidBridge.openExternal(u); },
            playLocalFile: function(p){ return new Promise(function(r){ AndroidBridge.playLocalFile(p, mk(r)); }); }
          };
          if (window.__apiReady) window.__apiReady();
        })();
        """.trimIndent()
        webView.evaluateJavascript(shim, null)
    }

    override fun onBackPressed() {
        if (webView.canGoBack()) webView.goBack() else super.onBackPressed()
    }
}
