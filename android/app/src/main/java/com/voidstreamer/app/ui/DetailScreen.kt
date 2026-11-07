package com.voidstreamer.app.ui

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import coil.compose.AsyncImage
import com.voidstreamer.app.Api
import com.voidstreamer.app.DetailInfo
import com.voidstreamer.app.Episode
import kotlinx.coroutines.launch

class DetailViewModel(
    private val type: String,
    private val tmdbId: Int
) : ViewModel() {
    var detail by mutableStateOf<DetailInfo?>(null); private set
    var loading by mutableStateOf(true); private set
    var episodes by mutableStateOf<List<Episode>>(emptyList()); private set
    var season by mutableStateOf(1)
    var resolving by mutableStateOf(false); private set
    var streamUrls by mutableStateOf<List<String>>(emptyList()); private set
    var qualities by mutableStateOf<List<com.voidstreamer.app.Quality>>(emptyList()); private set
    var error by mutableStateOf<String?>(null); private set

    init {
        viewModelScope.launch {
            try {
                detail = Api.fetchDetail(type, tmdbId)
                if (type == "tv") {
                    val s = detail?.seasons?.minOrNull() ?: 1
                    season = s
                    episodes = Api.fetchEpisodes(tmdbId, s)
                }
            } catch (e: Exception) {
                error = e.message
            } finally {
                loading = false
            }
        }
    }

    fun changeSeason(season: Int) {
        this.season = season
        viewModelScope.launch {
            episodes = Api.fetchEpisodes(tmdbId, season)
        }
    }

    fun resolveAndAnalyze(episode: Int? = null): Boolean {
        if (resolving) return false
        resolving = true
        val ep = episode ?: 0
        viewModelScope.launch {
            try {
                val urls = Api.resolvePeestream(
                    tmdbId.toString(), type, season, if (ep == 0) 1 else ep
                )
                if (urls.isEmpty()) {
                    error = "No streams found on PeeStream"
                    resolving = false
                    return@launch
                }
                streamUrls = urls
                val q = Api.analyze(urls[0], true)
                qualities = q
            } catch (e: Exception) {
                error = e.message
            } finally {
                resolving = false
            }
        }
        return true
    }
}

@Composable
fun DetailScreen(
    type: String,
    tmdbId: Int,
    onPlay: (url: String, title: String, mirrors: List<String>, subtitleCtx: Map<String, String>) -> Unit
) {
    val vm: DetailViewModel = viewModel { DetailViewModel(type, tmdbId) }
    val ctx = LocalContext.current
    val detail = vm.detail

    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
        AsyncImage(
            model = detail?.backdrop?.ifEmpty { detail.poster },
            contentDescription = null,
            contentScale = ContentScale.Crop,
            modifier = Modifier.fillMaxWidth().height(240.dp)
        )
        Spacer(Modifier.height(12.dp))
        Text(detail?.title ?: "Loading…", color = Color.White, style = MaterialTheme.typography.headlineSmall, modifier = Modifier.padding(horizontal = 16.dp))
        if (detail != null) {
            Row(Modifier.padding(horizontal = 16.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                detail.genres.forEach { AssistChip(onClick = {}, label = { Text(it) }) }
                if (detail.rating > 0) AssistChip(onClick = {}, label = { Text("★ " + String.format("%.1f", detail.rating)) })
                if (detail.year.isNotEmpty()) AssistChip(onClick = {}, label = { Text(detail.year) })
            }
            Text(detail.overview, color = Color(0xFF94A3B8), modifier = Modifier.padding(16.dp))
        }

        if (detail != null && detail.seasons.isNotEmpty()) {
            var selected by remember { mutableStateOf(detail.seasons.firstOrNull() ?: 1) }
            Row(Modifier.padding(horizontal = 16.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                detail.seasons.forEach { s ->
                    AssistChip(
                        onClick = { selected = s; vm.changeSeason(s) },
                        label = { Text("S$s") },
                        colors = if (selected == s) AssistChipDefaults.assistChipColors(containerColor = Color.White, labelColor = Color.Black)
                        else AssistChipDefaults.assistChipColors()
                    )
                }
            }
            Column(Modifier.padding(16.dp)) {
                vm.episodes.forEach { ep ->
                    Row(Modifier.fillMaxWidth().padding(vertical = 4.dp)) {
                        Text("E${ep.number}  ${ep.title}", color = Color.White, modifier = Modifier.weight(1f))
                        TextButton(onClick = { vm.resolveAndAnalyze(ep.number) }) { Text("Play") }
                    }
                }
            }
        } else if (detail != null) {
            Button(
                onClick = { vm.resolveAndAnalyze(0) },
                enabled = !vm.resolving,
                modifier = Modifier.padding(16.dp)
            ) { Text("▶ Watch Now") }
        }

        if (vm.resolving) {
            Box(Modifier.fillMaxWidth().padding(8.dp), contentAlignment = Alignment.Center) {
                CircularProgressIndicator(color = Color.White)
            }
        }
        if (vm.qualities.isNotEmpty()) {
            Text("Select Quality", color = Color.White, style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(16.dp))
            LazyRow(Modifier.fillMaxWidth(), contentPadding = PaddingValues(horizontal = 16.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                items(vm.qualities) { q ->
                    Button(onClick = {
                        onPlay(q.url, detail?.title ?: "", vm.streamUrls.drop(1) + vm.qualities.drop(1).map { it.url }.distinct(), mapOf(
                            "tmdb" to tmdbId.toString(),
                            "type" to type,
                            "season" to vm.season.toString(),
                            "imdb" to ""
                        ))
                    }) { Text(q.label) }
                }
            }
        }
        if (vm.error != null) {
            Text(vm.error ?: "", color = Color.Red, modifier = Modifier.padding(16.dp))
        }
    }
}
