# Void Streamer — Session Notes (for reinstalling on the new SSD)

Last session: Nov 2026. State: **desktop app works** (Electron), Android project is mid-build (one config bug to fix).

## Electron app

```bash
cd /home/nightmare/StarShip/Void-Streamer
npm install
npm start
```

Working providers after this session:
- **PeeStream** (`streamdata.vaplayer.ru` API, direct HLS, CORS-clean) — unified default
- **Abibli** (search API → signed HLS via local proxy in main.js) — fallback
- VidCore / VidFast / xpass embeds (scraped through the hidden-window layer in main.js, proxied locally)
- Dead (removed): vsembed/videasy/zxcstream/vidplus/vidify/vidzee/strigil, LunaStream, DuloTV, LordFlix, YouFlex, Screenscape, LunaAnime, AniLight

Desktop features (all verified in test harnesses under /tmp/opencode):
- Unified Play/Download row per selected source; quality picker with clean labels (1080p/720p…).
- HLS download + remux (system ffmpeg preferred, FFmpeg WASM fallback), subtitle sidecar VTT.
- Subtitle CC menu: VDRK + Natsuki APIs key-free (Cinecat stack), file loader as fallback.
- Health dots per source, mirror failover, HLS.js 1.x, continue watching, PiP + honest button feedback, AniLight purge.

Notes:
- The app validates with `node --check *.js` before running.
- Player buttons that silently fail (PiP/cache) were audited & fixed.
- The CSP warning is dev-only and disappears in packaged builds.

## Android (native app in `android/`)

Kotlin + Jetpack Compose + Media3 ExoPlayer. Gradle 8.4 + AGP 8.4.2 + Kotlin 2.0.20, JDK 21 toolchain (`gradle.properties` pins the Zulu 21 in `~/.gradle/jdks`). SDK: `~/Android/Sdk` with `local.properties` (`sdk.dir`).

```bash
cd android
./gradlew :app:assembleDebug   # produces app-debug.apk in app/build/outputs/apk/debug
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

**Known blocking bug** (unfinished when session paused): `processDebugResources` fails with `Package 'com.void.streamer' ... 'void' is a Java keyword`.
- Namespace (`app/build.gradle.kts`) is `com.voidstreamer.app` and the manifest has no `package=` attr, yet the merged manifest shows `package="com.void.streamer"`.
- Next step: run
  ```
  ./gradlew :app:processDebugResources --stacktrace
  ```
  and look at the stack + `app/build/intermediates/merged_manifest/debug/processDebugMainManifest/AndroidManifest.xml` to figure out where the dotted package comes from (read the lines above `package=`). Likely suspects: a `package=` attr elsewhere (a leftover file), or a kotlin `package com.void.streamer` (stale source dir). A full `rm -rf app/build .gradle` before rebuilding was already tried once — check `app/src` for stray resources/manifests if the stacktrace doesn't reveal it.

Already written Android sources:
- `Api.kt` — TMDB/StreamEx listings + detail, PeeStream resolver, Abibli (suggest→detail→signed-hash), analyze (HLS variants), VDRK+Natsuki subtitles, health ping; per-request via OkHttp.
- `AppProxy.kt` + `TinyHttpServer.kt` — in-process 127.0.0.1 proxy for Abibli's header-gated S5V CDN (playlist rewriting + streaming, mirrors main.js proxy logic).
- `ProgressStore.kt` — Continue Watching SharedPreferences.
- UI: `HomeScreen` (browse + continue row), `SearchScreen`, `DetailScreen` (unified Watch, episodes, quality variants), `PlayerScreen` (ExoPlayer, mirror fail-over, WebVTT subtitle overlay, resume), `DownloadsScreen` (HLS concat → MP4 save to `Movies/VoidStreamer`, progress).
- `Theme.kt` (AMOLED black), `MainActivity.kt` (Compose NavHost: Home/Search/Downloads/Detail/Player).

Anime sources are **not** ported to Android (needs browser scraping; PeeStream covers anime catalog through TMDB).

## Web edition (staged, not finished)

`web/` contains a Cloudflare-Workers backend (`worker.js`) + `public/` (a `api-bridge.js` shim that redefines `window.api` over fetch). It ports: PeeStream/Abibli resolvers, abibli generic proxy, subtitles, analyze, scrape (TMDB/streamex only), download concat, health. **Unfinished**: `public/index.html`/`renderer.js` copies, `wrangler.toml`, and the web copy should have anime sources filtered out of `DEFAULT_SOURCES`. Deploy: `npx wrangler login` (use your Cloudflare account; there is a campus-project account with `workers` access) then `cd web && npx wrangler deploy`. The desktop Electron copy remains the primary app; the web build is the route to Android via PWA/TWA or Cloudflare hosting.

## Environment gotchas seen this session

- `npm start` must run from the repo root (app path-relative loadFile behavior).
- Electron takes ~35–40s to scrape on slow links (this machine is ~170–400 KB/s effective).
- Do NOT re-edit renderer.js PiP block — it's already finalized; earlier churn was a stuck happy accident.
- Don't re-add `com/void/streamer` sources back — they were a stale shadow copy.
