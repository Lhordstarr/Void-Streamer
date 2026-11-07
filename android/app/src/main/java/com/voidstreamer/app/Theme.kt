package com.voidstreamer.app

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

private val Scheme = darkColorScheme(
    primary = Color.White,
    onPrimary = Color.Black,
    background = Color(0xFF000000),
    surface = Color(0xFF050505),
    onBackground = Color(0xFFF1F5F9),
    onSurface = Color(0xFFF1F5F9),
    secondary = Color(0xFF94A3B8)
)

@Composable
fun VoidTheme(content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = Scheme, content = content)
}
