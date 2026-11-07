package com.voidstreamer.app

import android.util.Log
import okhttp3.OkHttpClient
import okhttp3.Request
import java.util.concurrent.TimeUnit

/**
 * Local in-process HTTP proxy for Abibli's header-gated S5V CDN.
 * The Android app runs everything on-device (no server): ExoPlayer and the
 * downloader fetch through here so we can inject Origin/Referer/X-S5V-Client
 * and rewrite HLS playlists to carry the auth query. Implemented as an
 * OkHttp interceptor served from AppProxyHost (a TinyHttpServer in
 * TinyHttpServer.kt) on 127.0.0.1 with a random port.
 */
object AppProxy {
    const val ABIBLI_ORIGIN_LOCAL = Api.ABIBLI_ORIGIN
    private val sessions = HashMap<String, Session>()

    data class Session(val playlistUrl: String, val client: String, val createdAt: Long)

    @Synchronized
    fun registerAbibli(playlistUrl: String, client: String): String {
        val token = UUID16().hex
        sessions[token] = Session(playlistUrl, client, System.currentTimeMillis())
        prune()
        return token
    }

    @Synchronized
    fun abibliUrl(playlistUrl: String, clientId: String): String? {
        // Find or create the session
        val token = sessions.entries.firstOrNull { it.value.playlistUrl == playlistUrl }?.key ?: registerAbibli(playlistUrl, clientId)
        val base = "http://127.0.0.1:${TinyHttpServer.port}"
        return "$base/abibli/$token/master.m3u8"
    }

    @Synchronized
    fun session(token: String): Session? {
        val s = sessions[token] ?: return null
        if (System.currentTimeMillis() - s.createdAt > 2 * 60 * 60 * 1000L) {
            sessions.remove(token)
            return null
        }
        return s
    }

    private fun prune() {
        val cutoff = System.currentTimeMillis() - 2 * 60 * 60 * 1000L
        sessions.entries.removeIf { it.value.createdAt < cutoff }
    }

    // ── Upstream fetch (OkHttp) ───────────────────────────────
    private val client = OkHttpClient.Builder()
        .connectTimeout(30, TimeUnit.SECONDS).readTimeout(60, TimeUnit.SECONDS)
        .followRedirects(true).build()

    fun fetchUpstream(url: String, headers: Map<String, String>): UpstreamResponse {
        val req = Request.Builder().url(url)
            .header("User-Agent", ApiUA.UA)
            .header("Accept", "*/*")
            .apply { headers.forEach { (k, v) -> if (url.startsWith("http", ignoreCase = true)) header(k, v) } }
            .get().build()
        val resp = client.newCall(req).execute()
        return UpstreamResponse(resp.code, resp.headers.toMultimap(), resp.body!!.byteStream())
    }

    data class UpstreamResponse(val status: Int, val headers: Map<String, List<String>>, val body: java.io.InputStream)

    // ── Playlist rewriting ────────────────────────────────────
    fun rewritePlaylist(body: String, baseUrl: String, wrap: (String) -> String, authQuery: String): String {
        fun proxyUri(raw: String): String {
            if (raw.isEmpty() || raw.startsWith("data:") || raw.startsWith("blob:")) return raw
            val abs = try { java.net.URL(java.net.URL(baseUrl), raw) } catch (_: Exception) { return raw }
            if (authQuery.isNotEmpty()) {
                val u = java.net.URI(abs.toString())
                val existing = u.query ?: ""
                val merged = StringBuilder(existing)
                for ((k, v) in java.net.URLDecoder.decode(existing, "UTF-8").split("&").filter { it.isNotEmpty() }.map {
                    val i = it.indexOf('=')
                    if (i < 0) it to "" else it.substring(0, i) to it.substring(i + 1)
                }) { if (merged.isNotEmpty()) merged.append('&'); merged.append(k).append('=').append(java.net.URLEncoder.encode(v, "UTF-8")) }
                val nc = java.net.URI(u.scheme, u.authority, u.path, merged.toString(), u.fragment)
                return wrap(nc.toString())
            }
            return wrap(abs.toString())
        }
        return body.split(Regex("\r?\n")).joinToString("\n") { line ->
            if (line.isBlank()) line
            else if (line.trimStart().startsWith("#")) line.replace(Regex("URI=\"([^\"]+)\"")) { m -> "URI=\"${proxyUri(m.groupValues[1])}\"" }
            else proxyUri(line.trim())
        }
    }

    fun isPlaylist(target: String, contentType: String?): Boolean {
        val path = try { java.net.URL(target).path.lowercase() } catch (_: Exception) { "" }
        return path.endsWith(".m3u8") || path.endsWith(".txt") || (contentType ?: "").lowercase().contains("mpegurl")
    }
}

private class UUID16 {
    val hex: String = java.util.UUID.randomUUID().toString().replace("-", "").take(24)
}

object ApiUA {
    const val UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
}
