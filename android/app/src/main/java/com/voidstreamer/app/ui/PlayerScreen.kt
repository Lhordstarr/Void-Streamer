package com.voidstreamer.app.ui

import android.view.ViewGroup
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.ui.unit.dp
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.ui.PlayerView
import com.voidstreamer.app.Api
import com.voidstreamer.app.ProgressStore
import kotlinx.coroutines.launch

@kotlin.OptIn(UnstableApi::class)
@Composable
fun PlayerScreen(
    url: String,
    title: String,
    mirrors: List<String>,
    tmdbId: String,
    type: String,
    season: Int,
    onBack: () -> Unit
) {
    val ctx = LocalContext.current
    val player = remember {
        ExoPlayer.Builder(ctx).build().apply { playWhenReady = true }
    }
    var error by remember { mutableStateOf<String?>(null) }
    var subtitles by remember { mutableStateOf<List<com.voidstreamer.app.Subtitle>>(emptyList()) }
    var subsLabel by remember { mutableStateOf<String?>(null) }
    var subsCues by remember { mutableStateOf<List<Cue>>(emptyList()) }
    var resumeAt by remember { mutableLongStateOf(0L) }
    var mirrorsLeft by remember { mutableStateOf(mirrors) }

    DisposableEffect(player) {
        onDispose {
            ProgressStore.save(ctx, title, "", tmdbId, type, season, 0, resumeAt, player.duration.coerceAtLeast(0))
            player.release()
        }
    }

    LaunchedEffect(url) {
        player.setMediaItem(MediaItem.fromUri(url))
        try {
            val saved = ProgressStore.get(ctx, tmdbId, type, season, 0)
            if (saved != null && saved.at > 5) resumeAt = saved.at
        } catch (_: Exception) {}
        player.prepare()
    }

    LaunchedEffect(player) {
        var last = 0L
        while (true) {
            kotlinx.coroutines.delay(2000)
            val pos = player.currentPosition
            val dur = player.duration
            if (pos > 0) {
                resumeAt = pos
                ProgressStore.save(ctx, title, "", tmdbId, type, season, 0, pos, if (dur > 0) dur else 0)
            }
            val now = player.contentPosition
            if (player.playbackState == androidx.media3.common.Player.STATE_READY) {
                if (now != last && resumeAt > 0 && resumeAt < (dur - 20)) {
                    player.seekTo(resumeAt)
                }
            }
            last = now
        }
    }

    // Mirror failover on fatal errors
    LaunchedEffect(player) {
        player.addListener(object : androidx.media3.common.Player.Listener {
            override fun onPlayerError(e: androidx.media3.common.PlaybackException) {
                if (mirrorsLeft.isNotEmpty()) {
                    val next = mirrorsLeft.first()
                    mirrorsLeft = mirrorsLeft.drop(1)
                    player.setMediaItem(MediaItem.fromUri(next))
                    player.prepare()
                    player.play()
                } else {
                    error = "Could not play this stream"
                }
            }
        })
    }

    // Subtitles
    var cueText by remember { mutableStateOf("") }
    suspend fun loadSubtitles(sub: com.voidstreamer.app.Subtitle) {
        try {
            val resp = okhttp3.OkHttpClient().newCall(
                okhttp3.Request.Builder().url(sub.url).build()
            ).execute()
            var text = resp.body?.string() ?: return
            if (sub.ext == "srt") text = srtToVtt(text)
            subsCues = parseVtt(text)
            subsLabel = sub.label
        } catch (_: Exception) {}
    }

    Column(Modifier.fillMaxSize().background(Color.Black)) {
        Box(Modifier.fillMaxWidth().aspectRatio(16f / 9f).background(Color.Black)) {
            AndroidView(factory = { c ->
                PlayerView(c).apply {
                    this.player = player
                    layoutParams = ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
                    useController = true
                }
            }, update = { it.player = player })
            Text(title, color = Color.White, modifier = Modifier.align(Alignment.TopStart).padding(12.dp))
        }

        // Subtitle cue overlay (simple WebVTT renderer)
        if (subsLabel != null) {
            LaunchedEffect(subsCues) {
                while (true) {
                    val pos = player.currentPosition
                    val cue = subsCues.firstOrNull { pos >= it.start && pos <= it.end }
                    cueText = cue?.text ?: ""
                    kotlinx.coroutines.delay(200)
                }
            }
            if (cueText.isNotEmpty()) {
                Text(cueText, color = Color.White,
                    modifier = Modifier.fillMaxWidth().background(Color(0xCC000000)).padding(10.dp))
            }
        }

        Row(Modifier.fillMaxWidth().padding(16.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Button(onClick = {
                subtitles = subtitles.ifEmpty { loadSubsBlocking() }
            }) { Text("CC") }
            TextButton(onClick = {
                subtitles = emptyList()
                subsLabel = null
                subsCues = emptyList()
            }) { Text("Off") }
            if (subsLabel != null) Text(subsLabel!!, color = Color.White, modifier = Modifier.align(Alignment.CenterVertically))
        }
        if (subtitles.isNotEmpty()) {
            subtitles.take(30).forEach { sub ->
                TextButton(onClick = { /* fetch+render on IO */ }) { Text(sub.label) }
            }
        }
        if (error != null) Text(error!!, color = Color.Red, modifier = Modifier.padding(16.dp))
        TextButton(onClick = onBack) { Text("← Back") }
    }
}

private fun loadSubsBlocking(): List<com.voidstreamer.app.Subtitle> {
    // subtitles were already loaded on demand by the detail flow in M1
    return emptyList()
}

data class Cue(val start: Long, val end: Long, val text: String)

fun parseVtt(text: String): List<Cue> {
    val out = ArrayList<Cue>()
    for (block in text.replace("\r", "").split("\n\n")) {
        val lines = block.split("\n").filter { it.isNotBlank() }
        val timeLine = lines.firstOrNull { it.contains("-->") } ?: continue
        val (a, b) = timeLine.split("-->", limit = 2).map { it.trim() }
        val start = parseTime(a); val end = parseTime(b)
        if (start < 0 || end < 0) continue
        val body = lines.filter { !it.contains("-->") && !Regex("^\\d+$").matches(it.trim()) }.joinToString("\n")
        if (body.isNotBlank()) out.add(Cue(start, end, body))
    }
    return out
}

fun parseTime(t: String): Long {
    val m = Regex("""(\d+):(\d+):(\d+)[.,](\d+)""").find(t) ?: return -1
    val h = m.groupValues[1].toLong(); val min = m.groupValues[2].toLong()
    val s = m.groupValues[3].toLong(); val ms = m.groupValues[4].padEnd(3, '0').take(3).toLong()
    return (h * 3600 + min * 60 + s) * 1000 + ms
}

fun srtToVtt(srt: String): String {
    val out = StringBuilder("WEBVTT\n\n")
    for (block in srt.replace("\r", "").split("\n\n")) {
        val lines = block.split("\n").filter { it.isNotBlank() }
        val timeLine = lines.firstOrNull { it.contains("-->") } ?: continue
        val (a, b) = timeLine.split("-->", limit = 2).map { it.trim() }
        out.append(a.replace(',', '.')).append(" --> ").append(b.replace(',', '.')).append("\n")
        out.append(lines.filter { !it.contains("-->") && !Regex("^\\d+$").matches(it.trim()) }.joinToString("\n")).append("\n\n")
    }
    return out.toString()
}
