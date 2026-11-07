# Void Streamer — Android (native)

A native Android port of Void Streamer. Everything runs on the phone — no VPS or Cloudflare backend, all resolvers/subtitles/download paths are direct device-side (see `app/src/main/java/com/voidstreamer/app/`).

## What's inside

| Part | Notes |
|---|---|
| Browse & search | TMDB via the StreameX metadata proxy (`api/tmdb`) |
| Detail & Watch | **PeeStream API** (`streamdata.vaplayer.ru`) first, **Abibli** (title search → signed HLS) as fallback |
| Player | Media3 ExoPlayer (HLS) with quality variants (1080/720/480/360p), CDN mirror fail-over, continue-watching resume |
| Subtitles | VDRK (direct WebVTT) + Natsuki (SRT converted on-device), per-title fetched by TMDB/IMDb id, English first |
| Downloads | HLS segment concatenation → fMP4 kept as MP4 (m3u8/TS variants handled); saves to `Movies/VoidStreamer` |
| Abibli header-gating | Done on-device via `TinyHttpServer` (127.0.0.1) + OkHttp — same logic as the desktop app's local proxy |

Anime sources from the desktop app are **not** ported (they need Chromium page scraping; PeeStream covers anime catalog via TMDB already).

## Build

Requirements: JDK 17+ (uses the Android Studio bundled JBR or any Zulu/Temurin 17/21), Android SDK (`platforms;android-34`, `build-tools;34.0.0`), network for Maven artifacts.

```bash
cd android
./gradlew :app:assembleDebug
```

APK lands at `app/build/outputs/apk/debug/app-debug.apk`.

Install on a connected device:

```bash
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

Release build (signing): pass keystore properties via environment variables or `gradle.properties`:

```properties
signing.storeFile=/path/to/keystore.jks
signing.storePassword=...
signing.keyAlias=...
signing.keyPassword=...
```

then `./gradlew :app:assembleRelease`.
