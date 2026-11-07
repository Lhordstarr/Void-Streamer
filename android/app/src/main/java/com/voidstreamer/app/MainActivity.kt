package com.voidstreamer.app

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.navigation.NavHost
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import com.voidstreamer.app.ui.DownloadsScreen
import com.voidstreamer.app.ui.HomeScreen
import com.voidstreamer.app.ui.SearchScreen
import com.voidstreamer.app.ui.DetailScreen
import com.voidstreamer.app.ui.PlayerScreen

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        TinyHttpServer.start()
        setContent {
            VoidTheme {
                val nav = rememberNavController()
                var tab by remember { mutableIntStateOf(0) }

                Scaffold(
                    containerColor = Color.Black,
                    bottomBar = {
                        NavigationBar(containerColor = Color(0xFF0A0A0A)) {
                            NavigationBarItem(
                                selected = tab == 0,
                                onClick = { tab = 0; nav.navigate("home") { popUpTo("home") { inclusive = false } } },
                                label = { Text("Home") },
                                icon = {}
                            )
                            NavigationBarItem(
                                selected = tab == 1,
                                onClick = { tab = 1; nav.navigate("search") { popUpTo("home") { inclusive = false } } },
                                label = { Text("Search") },
                                icon = {}
                            )
                            NavigationBarItem(
                                selected = tab == 2,
                                onClick = { tab = 2; nav.navigate("downloads") { popUpTo("home") { inclusive = false } } },
                                label = { Text("Downloads") },
                                icon = {}
                            )
                        }
                    }
                ) { padding ->
                    BoxWithConstraints(Modifier.padding(padding)) {
                        NavHost(navController = nav, startDestination = "home") {
                            composable("home") {
                                HomeScreen(
                                    onOpen = { item ->
                                        nav.navigate("detail/${item.type}/${item.id}/${item.title}/${item.poster}/${item.backdrop}/${item.year}/${item.rating}")
                                    },
                                    onContinue = { tmdbId, type, season, episode ->
                                        nav.navigate("detail/$type/$tmdbId/Continue///${""}/${""}/${""}")
                                    }
                                )
                            }
                            composable("search") {
                                SearchScreen(onOpen = { item ->
                                    nav.navigate("detail/${item.type}/${item.id}/${item.title}/${item.poster}/${item.backdrop}/${item.year}/${item.rating}")
                                })
                            }
                            composable("downloads") { DownloadsScreen() }
                            composable("detail/{type}/{tmdbId}/{title}/{poster}/{backdrop}/{year}/{rating}") { backStackEntry ->
                                val type = backStackEntry.arguments?.getString("type") ?: "movie"
                                val tmdbId = backStackEntry.arguments?.getString("tmdbId")?.toIntOrNull() ?: 0
                                DetailScreen(type = type, tmdbId = tmdbId, onPlay = { url, title, mirrors, ctx ->
                                    val enc = java.net.URLEncoder.encode(url, "UTF-8")
                                    val encMirrors = java.net.URLEncoder.encode(mirrors.joinToString("|"), "UTF-8")
                                    nav.navigate("play/$enc/$encMirrors/$title/${ctx["tmdb"] ?: ""}/${ctx["type"] ?: type}")
                                })
                            }
                            composable("play/{url}/{mirrors}/{title}/{tmdbId}/{type}") { backStackEntry ->
                                val url = java.net.URLDecoder.decode(backStackEntry.arguments?.getString("url") ?: "", "UTF-8")
                                val mirrorsRaw = java.net.URLDecoder.decode(backStackEntry.arguments?.getString("mirrors") ?: "", "UTF-8")
                                val title = backStackEntry.arguments?.getString("title") ?: ""
                                val tmdbId = backStackEntry.arguments?.getString("tmdbId") ?: ""
                                val type = backStackEntry.arguments?.getString("type") ?: "movie"
                                PlayerScreen(
                                    url = url,
                                    title = title,
                                    mirrors = if (mirrorsRaw.isEmpty()) emptyList() else mirrorsRaw.split("|"),
                                    tmdbId = tmdbId,
                                    type = type,
                                    season = 1,
                                    onBack = { nav.popBackStack() }
                                )
                            }
                        }
                    }
                }
            }
        }
    }
}
