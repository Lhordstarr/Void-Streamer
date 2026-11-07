package com.voidstreamer.app.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import coil.compose.AsyncImage
import com.voidstreamer.app.Api
import com.voidstreamer.app.TmdbItem
import kotlinx.coroutines.launch

class SearchViewModel : ViewModel() {
    var results by mutableStateOf<List<TmdbItem>>(emptyList()); private set
    var loading by mutableStateOf(false); private set

    fun search(query: String, section: String) {
        if (query.isBlank()) { results = emptyList(); return }
        loading = true
        viewModelScope.launch {
            try {
                results = Api.fetchListing(query, section)
            } catch (_: Exception) {
                results = emptyList()
            } finally {
                loading = false
            }
        }
    }
}

@Composable
fun SearchScreen(onOpen: (TmdbItem) -> Unit) {
    val vm: SearchViewModel = androidx.lifecycle.viewmodel.compose.viewModel()
    var query by remember { mutableStateOf("") }
    var section by remember { mutableStateOf("movie") }

    Column(Modifier.fillMaxSize().padding(12.dp)) {
        OutlinedTextField(
            value = query,
            onValueChange = { query = it; vm.search(it, section) },
            label = { Text("Search movies & shows") },
            modifier = Modifier.fillMaxWidth(),
            singleLine = true,
            colors = OutlinedTextFieldDefaults.colors(
                focusedTextColor = Color.White,
                unfocusedTextColor = Color.White,
                cursorColor = Color.White,
                focusedLabelColor = Color.White,
                unfocusedLabelColor = Color(0xFF94A3B8)
            )
        )
        Spacer(Modifier.height(8.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            FilterChip(
                selected = section == "movie",
                onClick = { section = "movie"; vm.search(query, section) },
                label = { Text("Movies") }
            )
            FilterChip(
                selected = section == "tv",
                onClick = { section = "tv"; vm.search(query, section) },
                label = { Text("TV Series") }
            )
        }
        if (query.isBlank()) {
            Text("Type to search across TMDB.", color = Color(0xFF94A3B8), modifier = Modifier.padding(vertical = 24.dp))
        } else {
            LazyVerticalGrid(
                columns = GridCells.Adaptive(110.dp),
                modifier = Modifier.fillMaxWidth().weight(1f),
                contentPadding = PaddingValues(4.dp),
                horizontalArrangement = Arrangement.spacedBy(10.dp),
                verticalArrangement = Arrangement.spacedBy(10.dp)
            ) {
                items(vm.results) { item ->
                    Column(Modifier.clickable { onOpen(item) }) {
                        AsyncImage(
                            model = item.poster,
                            contentDescription = item.title,
                            contentScale = ContentScale.Crop,
                            modifier = Modifier.width(110.dp).height(165.dp).clip(RoundedCornerShape(8.dp))
                        )
                        Text(item.title, color = Color.White, maxLines = 1, style = MaterialTheme.typography.bodySmall)
                    }
                }
            }
        }
        if (vm.results.isEmpty() && query.isNotBlank()) {
            Text("No results.", color = Color(0xFF94A3B8), modifier = Modifier.padding(top = 12.dp))
        }
    }
}
