package com.voidstreamer.app.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import coil.compose.AsyncImage
import com.voidstreamer.app.Api
import com.voidstreamer.app.ProgressStore
import com.voidstreamer.app.TmdbItem
import kotlinx.coroutines.launch

class HomeViewModel : ViewModel() {
    var movies by mutableStateOf<List<TmdbItem>>(emptyList()); private set
    var shows by mutableStateOf<List<TmdbItem>>(emptyList()); private set
    var error by mutableStateOf<String?>(null); private set
    var loading by mutableStateOf(true); private set

    init {
        viewModelScope.launch {
            try {
                movies = Api.fetchListing(null, "movie")
                shows = Api.fetchListing(null, "tv")
            } catch (e: Exception) {
                error = e.message
            } finally {
                loading = false
            }
        }
    }
}

@Composable
fun HomeScreen(
    onOpen: (TmdbItem) -> Unit,
    onContinue: (String, String, Int, Int) -> Unit
) {
    val vm: HomeViewModel = viewModel()
    val ctx = LocalContext.current
    val cont = remember { ProgressStore.list(ctx) }

    Column(Modifier.fillMaxSize()) {
        if (vm.loading) {
            Box(Modifier.fillMaxSize(), contentAlignment = androidx.compose.ui.Alignment.Center) {
                CircularProgressIndicator(color = androidx.compose.ui.graphics.Color.White)
            }
            return@Column
        }
        if (cont.isNotEmpty()) {
            Text("⏱ Continue Watching", color = androidx.compose.ui.graphics.Color.White,
                style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(16.dp))
            LazyRow(Modifier.fillMaxWidth(), contentPadding = PaddingValues(horizontal = 12.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                items(cont) { e ->
                    Column(Modifier.width(120.dp).clickable { onContinue(e.tmdbId, e.type, e.season, e.episode) }) {
                        AsyncImage(
                            model = e.image,
                            contentDescription = e.title,
                            contentScale = ContentScale.Crop,
                            modifier = Modifier.width(120.dp).height(180.dp).clip(RoundedCornerShape(10.dp))
                        )
                        Spacer(Modifier.height(4.dp))
                        val pct = if (e.dur > 0) (e.at.toFloat() / e.dur).coerceIn(0f, 1f) else 0f
                        LinearProgressIndicator(progress = { pct }, modifier = Modifier.fillMaxWidth().height(3.dp), color = androidx.compose.ui.graphics.Color(0xFF10B981))
                        Text(e.title, color = androidx.compose.ui.graphics.Color.White, maxLines = 1, style = MaterialTheme.typography.bodySmall)
                    }
                }
            }
        }
        RowSection("🔥 Top Movies", vm.movies, onOpen)
        RowSection("📺 Top TV Series", vm.shows, onOpen)
        if (vm.error != null) {
            Text(vm.error ?: "", color = androidx.compose.ui.graphics.Color.Red, modifier = Modifier.padding(16.dp))
        }
    }
}

@Composable
private fun RowSection(title: String, items: List<TmdbItem>, onOpen: (TmdbItem) -> Unit) {
    Column(Modifier.fillMaxWidth()) {
        Text(title, color = androidx.compose.ui.graphics.Color.White,
            style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(16.dp))
        LazyRow(Modifier.fillMaxWidth(), contentPadding = PaddingValues(horizontal = 12.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            items(items) { item ->
                Column(Modifier.width(110.dp).clickable { onOpen(item) }) {
                    AsyncImage(
                        model = item.poster,
                        contentDescription = item.title,
                        contentScale = ContentScale.Crop,
                        modifier = Modifier.width(110.dp).height(165.dp).clip(RoundedCornerShape(10.dp))
                    )
                    Spacer(Modifier.height(4.dp))
                    Text(item.title, color = androidx.compose.ui.graphics.Color.White, maxLines = 1, style = MaterialTheme.typography.bodySmall)
                    Text(item.year + if (item.rating > 0) " ★ " + String.format("%.1f", item.rating) else "",
                        color = androidx.compose.ui.graphics.Color(0xFF94A3B8), style = MaterialTheme.typography.bodySmall)
                }
            }
        }
    }
}
