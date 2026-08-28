# Void Streamer — Android Port (skeleton)

Electron **cannot** run on Android, and electron-builder has no Android target.
This directory is a native **Android (Kotlin) WebView** shell that reuses the
existing web UI (`index.html`, `renderer.js`, `style.css`) while reimplementing
the Electron `main.js`/`preload.js` layer natively.

## How it works

```
Electron (desktop)                 Android (this port)
─────────────────                 ───────────────────
main.js / preload.js (Node)   -->  app/src/main/java/.../AndroidBridge.kt
ipcMain <-> ipcRenderer      -->  WebView.addJavascriptInterface + window.api shim
BrowserWindow (hidden scrape) -->  OkHttp / Jsoup in coroutines
local http media server       -->  localhost socket OR ContentProvider
fs / downloads dir            -->  app-specific storage / MediaStore
FFmpeg WASM remux            -->  ffmpeg-kit / mobile-ffmpeg
```

`MainActivity.kt` loads `file:///android_asset/index.html` in a `WebView`, then
injects a `window.api` shim whose methods call into the native `AndroidBridge`
object (exposed via `@JavascriptInterface`). Each native method gets a
`callbackId`; when the work finishes it calls `window.__resolve(id, ok, payload)`
in JS, resolving the Promise the shim created. The UI code in `renderer.js` is
unchanged because it only talks to `window.api`.

## Build / run

1. Copy the web assets into the Android assets folder:
   ```bash
   mkdir -p app/src/main/assets
   cp ../index.html ../renderer.js ../style.css ../25.gif ../icon.png app/src/main/assets/
   # NOTE: preload.js and scraper.js are NOT used on Android (native replaces them)
   ```
2. Open this `android/` folder in Android Studio (or build with Gradle):
   ```bash
   ./gradlew assembleDebug
   ```
3. Install `app/build/outputs/apk/debug/app-debug.apk` on a device/emulator.

## What's stubbed (must be reimplemented natively)

Every `AndroidBridge` method currently returns
`{"success":false,"error":"not implemented on Android"}`. Map each to a native
implementation:

| `window.api` call | Native replacement |
|---|---|
| `scrapeUrl` / `scrapeDetail` | Jsoup / OkHttp HTML parsing (or AniList/TMDB GraphQL via Retrofit) in coroutines |
| `scrapeMoviboxStream` / `scrapeKawaiiVideo` / `scrapeAnimeSourceVideo` | WebView/Jsoup network interception to capture `.m3u8`/`.mp4` URLs |
| `analyzeStream` | HEAD requests for size + HLS variant playlist parsing (OkHttp) |
| `startDownload` / pause / resume / cancel | `DownloadManager` or `WorkManager` + native stream copy |
| `cacheVideo` / `listCache` / `saveCache` / `deleteCache` | Write to app storage; expose via `MediaStore` for "saved" items |
| `readFile` / `writeFile` / `remuxTsToMp4` | `ffmpeg-kit` (`com.arthenica:ffmpeg-kit-min`) for TS→MP4 |
| `playLocalFile` | Serve the cached file over a localhost socket OR a `ContentProvider` and pass that URI to `<video>` |

### Progress + events
The Electron build pushes `download-progress`, `download-done`, `cache-progress`,
etc. from main → renderer. On Android, emit the same by calling e.g.
`window.__pushDownloadProgress(id, payload)` from native code inside
`AndroidBridge` (add those JS callbacks to the shim in `MainActivity`).

### Video playback
`renderer.js` already uses **hls.js** for HLS and native `<video>` for MP4, so
in-app playback works once `analyzeStream`/`scrape*Stream` return real URLs.
For DRM/Widevine or smoother playback you can swap the `<video>` element for
**Media3 ExoPlayer** via a native player surface — a larger change.

## Limitations
- No hidden-BrowserWindow scraping: replicate each site's logic with HTTP clients.
- Battery/data: background caching must use `WorkManager` with notifications.
- This is a **starting skeleton**, not a finished app.
