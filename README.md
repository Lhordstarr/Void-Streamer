# Void Streamer

A premium Electron desktop application for streaming movies, TV shows, and anime with a modern glassmorphism UI.

## Features

- **Multi-source streaming**

- **Anime support**  with dedicated anime section

- **TMDB-powered** — Popular listings, search, cast info, recommendations
- **Built-in video cache** — Cache direct video files locally for smoother playback
- **Video-on-click download** — Persistent downloads with real-time progress
- **Virtual scroll** — Smooth infinite scrolling for large result sets
- **Source switcher** — Swap between sources from any detail view

## Install

### Windows
Download `Void Streamer Setup 1.0.0.exe` from releases and run the installer.

### Linux
Download the appropriate package for your distro from releases:
- **AppImage** — `Void.Streamer-1.0.0.AppImage` (all distros)
  ```bash
  chmod +x Void.Streamer-1.0.0.AppImage
  ./Void.Streamer-1.0.0.AppImage
  ```
- **Debian / Ubuntu** — `void-streamer_1.0.0_amd64.deb`
  ```bash
  sudo dpkg -i void-streamer_1.0.0_amd64.deb
  sudo apt-get install -f   # if missing dependencies
  ```
- **Snap** (if published)
  ```bash
  sudo snap install void-streamer
  ```

### Android
Void Streamer does not ship as a finished app on Android yet — Electron cannot run
on Android, so it is delivered as a native WebView port. See
[`android/README.md`](android/README.md) for the build/run steps (open the
`android/` folder in Android Studio or run `./gradlew assembleDebug`).

## Portable

### Windows
Download `Void Streamer 1.0.0.exe` — no install required.

### Linux
Download `Void.Streamer-1.0.0.AppImage` and run it directly (see Linux install
above). A standalone portable build is also available as a `.tar.gz` from releases.

## Development

```bash
npm install
npm start
```

## Build

### Windows
```bash
npm run build          # NSIS installer
npm run build:portable # Portable EXE
```

### Linux
```bash
npm run build:linux            # AppImage + deb (x64, arm64)
npm run build:linux-appimage   # AppImage only
npm run build:linux-deb        # .deb only
npm run build:linux-snap       # Snap only
```

### Android
See [`android/README.md`](android/README.md). Requires Android Studio / Gradle and
the web assets copied into `android/app/src/main/assets/`.

## Quick install script (Linux)

```bash
# AppImage (no root required)
curl -L -o void-streamer.AppImage https://github.com/<you>/Void-Steamer/releases/latest/download/Void.Streamer-1.0.0.AppImage
chmod +x void-streamer.AppImage && ./void-streamer.AppImage
```

## Tech Stack

- **Desktop:** Electron (Windows + Linux), Node.js (axios + cheerio), vanilla JS
- **Android:** Native Kotlin WebView shell reusing the web UI (`android/`)
- **UI:** Glassmorphism, vanilla JS, virtual scroll (no framework)
- **Installers:** NSIS (Win), AppImage / deb / snap (Linux)

## Supported Platforms

| Platform | Status | Package |
|----------|--------|---------|
| Windows  | ✅ Build | NSIS installer / portable EXE |
| Linux    | ✅ Build | AppImage / `.deb` / Snap |
| Android  | 🧪 Skeleton (WebView port) | APK via `android/` |

## License

ISC
