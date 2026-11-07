package com.voidstreamer.app.ui

import android.app.DownloadManager
import android.content.Context
import android.os.Environment
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.voidstreamer.app.Api
import kotlinx.coroutines.launch
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.File
import java.util.concurrent.TimeUnit

class DownloadState(
    val id: String, val title: String, var percent: Int = 0,
    var received: Long = 0, var total: Long = 0, var done: Boolean = false,
    var error: String? = null, var path: String = ""
)

class DownloadsViewModel : ViewModel() {
    val downloads = mutableStateListOf<DownloadState>()
    private val active = HashMap<String, Boolean>()

    fun start(url: String, title: String, quality: String = "Auto") {
        if (active.containsKey(title)) return
        val id = title.hashCode().toString()
        active[url] = true
        val state = DownloadState(id, title)
        downloads.add(state)
        viewModelScope.launch {
            try {
                downloadConcat(url, state)
                state.done = true
            } catch (e: Exception) {
                state.error = e.message
            } finally {
                active.remove(url)
            }
        }
    }

    private suspend fun downloadConcat(url: String, state: DownloadState) {
        val client = OkHttpClient.Builder().connectTimeout(30, TimeUnit.SECONDS).readTimeout(60, TimeUnit.SECONDS).build()
        suspend fun fetchText(u: String): String {
            return client.newCall(Request.Builder().url(u).build()).execute().use { r ->
                if (!r.isSuccessful) throw Exception("HTTP ${r.code}")
                r.body!!.string()
            }
        }
        fun resolveUrl(base: String, href: String): String {
            if (href.startsWith("http")) return href
            val idx = base.lastIndexOf('/')
            val dir = if (idx >= 0) base.substring(0, idx + 1) else base + '/'
            return if (href.startsWith("/")) {
                val u = java.net.URL(base)
                "${u.protocol}//${u.host}$href"
            } else dir + href
        }

        var masterBody = ""
        var videoUrl = url
        var videoBody = fetchText(url)
        if (videoBody.contains("#EXT-X-STREAM-INF:")) {
            masterBody = videoBody
            val lines = videoBody.split("\n")
            var bestUrl = ""; var bestBw = -1
            for (i in lines.indices) {
                if (lines[i].contains("#EXT-X-STREAM-INF:")) {
                    val bw = Regex("BANDWIDTH=(\\d+)", RegexOption.IGNORE_CASE).find(lines[i])?.groupValues?.get(1)?.toIntOrNull() ?: 0
                    val next = lines.getOrNull(i + 1)?.trim() ?: ""
                    if (next.isNotEmpty() && !next.startsWith("#") && bw > bestBw) {
                        bestBw = bw; bestUrl = resolveUrl(url, next)
                    }
                }
            }
            if (bestUrl.isNotEmpty()) {
                videoUrl = bestUrl
                videoBody = fetchText(videoUrl)
            }
        }
        val segments = ArrayList<String>()
        var initUrl = ""
        for (raw in videoBody.split("\n")) {
            val line = raw.trim()
            if (line.isEmpty()) continue
            if (line.startsWith("#EXT-X-MAP:")) {
                val uri = Regex("URI=\"([^\"]+)\"").find(line)?.groupValues?.get(1) ?: ""
                if (uri.isNotEmpty()) initUrl = resolveUrl(videoUrl, uri)
                continue
            }
            if (line.startsWith("#")) continue
            segments.add(resolveUrl(videoUrl, line))
        }
        if (segments.isEmpty()) throw Exception("No video segments found")

        val parts = ArrayList<String>()
        if (initUrl.isNotEmpty()) parts.add(initUrl)
        parts.addAll(segments)
        val out = ArrayList<ByteArray>()
        var total = parts.size.toLong()
        state.total = total
        for ((idx, u) in parts.withIndex()) {
            client.newCall(Request.Builder().url(u).build()).execute().use { r ->
                if (!r.isSuccessful) throw Exception("Segment HTTP ${r.code}")
                out.add(r.body!!.bytes())
            }
            state.received = idx + 1L
            state.percent = ((idx + 1) * 100 / parts.size)
        }
        val merged = ByteArray(out.sumOf { it.size })
        var off = 0
        for (b in out) { System.arraycopy(b, 0, merged, off, b.size); off += b.size }

        // Save to Movies/VoidStreamer (or app files for older Android via DownloadManager below)
        val dir = File(android.os.Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_MOVIES), "VoidStreamer")
        dir.mkdirs()
        val name = state.title.replace(Regex("[<>:\"/\\\\|?*]"), "_") + ".mp4"
        val file = File(dir, name)
        file.writeBytes(merged)
        state.path = file.absolutePath
    }
}

@Composable
fun DownloadsScreen() {
    val vm: DownloadsViewModel = androidx.lifecycle.viewmodel.compose.viewModel()
    val ctx = LocalContext.current
    val downloads = vm.downloads

    Column(Modifier.fillMaxSize().padding(16.dp)) {
        Text("Downloads", color = Color.White, style = MaterialTheme.typography.titleMedium)
        Spacer(Modifier.height(12.dp))
        if (downloads.isEmpty()) {
            Text(
                "Saved downloads appear here. Start one from a title's Play screen (long-press the title on Android, or use the Downloads tab).",
                color = Color(0xFF94A3B8)
            )
        }
        LazyColumn {
            items(downloads) { d ->
                Column(Modifier.fillMaxWidth().padding(vertical = 8.dp)) {
                    Row {
                        Text(d.title, color = Color.White, modifier = Modifier.weight(1f))
                        if (d.done) Text("✓ Saved", color = Color(0xFF10B981))
                        else if (d.error != null) Text("Failed: " + d.error, color = Color.Red)
                        else Text("${d.percent}%", color = Color(0xFF94A3B8))
                    }
                    if (!d.done && d.error == null) {
                        Spacer(Modifier.height(6.dp))
                        LinearProgressIndicator(progress = { d.percent / 100f }, modifier = Modifier.fillMaxWidth())
                    }
                    if (d.path.isNotEmpty()) Text(d.path, color = Color(0xFF64748B), style = MaterialTheme.typography.bodySmall)
                }
            }
        }
    }
}
