package com.voidstreamer.app

import android.util.Log
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.builtins.serializer
import kotlinx.serialization.json.Json
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.util.UUID
import java.util.concurrent.TimeUnit

/**
 * Network layer. Ports of the desktop app's main-process logic:
 *  - TMDB browsing/detail via StreameX proxy (api/tmdb)
 *  - PeeStream API (streamdata.vaplayer.ru) for stream URLs
 *  - Abibli search/detail + signed HLS via s5v.lazyrocket.space local proxy
 *  - VDRK + Natsuki subtitle APIs
 */
object Api {
    private const val UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    private val client = OkHttpClient.Builder().connectTimeout(20, TimeUnit.SECONDS).readTimeout(30, TimeUnit.SECONDS).build()
    private val json = Json { ignoreUnknownKeys = true }

    // ── TMDB listing ────────────────────────────────────────────
    suspend fun fetchListing(query: String?, section: String): List<TmdbItem> = withContext(Dispatchers.IO) {
        val url = if (query != null) {
            "https://streamex.sh/api/tmdb/search/multi?query=${query.q()}&page=1"
        } else when (section) {
            "tv" -> "https://streamex.sh/api/tmdb/tv/popular?page=1"
            else -> "https://streamex.sh/api/tmdb/movie/popular?page=1"
        }
        val body = get(url) ?: return@withContext emptyList()
        val root = JSONObject(body)
        val arr = root.optJSONArray("results") ?: return@withContext emptyList()
        val out = ArrayList<TmdbItem>(arr.length())
        for (i in 0 until arr.length()) {
            val it = arr.optJSONObject(i) ?: continue
            val mt = it.optString("media_type", section.ifEmpty { "movie" })
            if (query != null) {
                if (section == "movie" && mt != "movie") continue
                if (section == "tv" && mt != "tv") continue
            }
            if (it.isNull("id") || it.optInt("id") <= 0) continue
            out.add(TmdbItem(
                id = it.optInt("id"),
                title = it.optString("title").ifEmpty { it.optString("name") },
                type = mt.ifEmpty { "movie" },
                year = (it.optString("release_date").ifEmpty { it.optString("first_air_date") }).take(4),
                poster = if (it.optString("poster_path").isNotEmpty()) "https://image.tmdb.org/t/p/w342" + it.optString("poster_path") else "",
                backdrop = if (it.optString("backdrop_path").isNotEmpty()) "https://image.tmdb.org/t/p/w1280" + it.optString("backdrop_path") else "",
                overview = it.optString("overview"),
                rating = it.optDouble("vote_average")
            ))
        }
        out.take(40)
    }

    // ── TMDB detail ─────────────────────────────────────────────
    suspend fun fetchDetail(type: String, tmdbId: Int): DetailInfo? = withContext(Dispatchers.IO) {
        val data = jget("https://streamex.sh/api/tmdb/$type/$tmdbId") ?: return@withContext null
        val credits = jget("https://streamex.sh/api/tmdb/$type/$tmdbId/credits") ?: JSONObject()
        val seasons = ArrayList<Int>()
        val seasonsArr = (data as JSONObject).optJSONArray("seasons")
        val count = if (seasonsArr != null) seasonsArr.length() else 0
        for (i in 0 until data.optInt("number_of_seasons", count)) seasons.add(i + 1)
        val castArr = credits.optJSONArray("cast")
        val cast = ArrayList<Pair<String, String>>()
        if (castArr != null) for (i in 0 until minOf(castArr.length(), 12)) {
            val c = castArr.optJSONObject(i) ?: continue
            cast.add((c.optString("name") to if (c.optString("profile_path").isNotEmpty()) "https://image.tmdb.org/t/p/w342" + c.optString("profile_path") else ""))
        }
        DetailInfo(
            title = data.optString("title").ifEmpty { data.optString("name") },
            year = (data.optString("release_date").ifEmpty { data.optString("first_air_date") }).take(4),
            overview = data.optString("overview"),
            poster = if (data.optString("poster_path").isNotEmpty()) "https://image.tmdb.org/t/p/w342" + data.optString("poster_path") else "",
            backdrop = if (data.optString("backdrop_path").isNotEmpty()) "https://image.tmdb.org/t/p/w1280" + data.optString("backdrop_path") else "",
            rating = data.optDouble("vote_average"),
            genres = (data.optJSONArray("genres")?.let { g ->
                ArrayList<String>().apply { for (i in 0 until g.length()) add(g.optJSONObject(i)?.optString("name") ?: "") }.filter { it.isNotEmpty() }
            } ?: emptyList()).take(3),
            cast = cast,
            seasons = if (type == "tv") seasons else emptyList()
        )
    }

    suspend fun fetchEpisodes(tmdbId: Int, season: Int): List<Episode> = withContext(Dispatchers.IO) {
        val data = jget("https://streamex.sh/api/tmdb/tv/$tmdbId/season/$season") ?: return@withContext emptyList()
        val arr = (data as JSONObject).optJSONArray("episodes") ?: return@withContext emptyList()
        ArrayList<Episode>().apply {
            for (i in 0 until arr.length()) {
                val e = arr.optJSONObject(i) ?: continue
                add(Episode(
                    number = e.optInt("episode_number", i + 1),
                    title = e.optString("name").ifEmpty { "Episode " + e.optInt("episode_number", i + 1) },
                    still = if (e.optString("still_path").isNotEmpty()) "https://image.tmdb.org/t/p/w342" + e.optString("still_path") else ""
                ))
            }
        }
    }

    // ── Stream resolution ───────────────────────────────────────
    suspend fun resolvePeestream(tmdb: String, type: String, season: Int, episode: Int): List<String> = withContext(Dispatchers.IO) {
        val url = "https://streamdata.vaplayer.ru/api.php?tmdb=$tmdb&type=$type" +
            if (type == "tv") "&season=$season&episode=$episode" else ""
        val body = get(url) ?: return@withContext emptyList()
        val data = JSONObject(body).optJSONObject("data") ?: return@withContext emptyList()
        val arr = data.optJSONArray("stream_urls") ?: return@withContext emptyList()
        ArrayList<String>().apply { for (i in 0 until arr.length()) if (arr.optString(i).startsWith("http")) add(arr.optString(i)) }
    }

    suspend fun resolveAbibliStreamUrl(title: String, year: String, type: String, season: Int, episode: Int): String? = withContext(Dispatchers.IO) {
        // 1. suggest
        val suggestRaw = get("https://abibli.com/search/suggest?q=${title.q()}") ?: return@withContext null
        val suggest = try { JSONObject(suggestRaw) } catch (_: Exception) { return@withContext null }
        val items = suggest.optJSONArray("items") ?: return@withContext null
        val picked = pickAbibliItem(items, title, year, type) ?: return@withContext null
        val detailUrl = picked.split('?')[0]
        // 2. detail page -> stream hash (fallback to series page)
        var html = get(detailUrl) ?: return@withContext null
        var play = parseAbibliPlays(html).firstOrNull { p ->
            if (type == "tv") p.seasonNumber == season && p.episodeNumber == episode
            else true
        }
        if (play == null && type == "tv") {
            val html2 = get("$detailUrl?season=$season") ?: ""
            play = parseAbibliPlays(html2).firstOrNull { p -> p.seasonNumber == season && p.episodeNumber == episode }
        }
        if (play == null) return@withContext null
        val hash = play.hash
        if (!hash.matches(Regex("^[A-Za-z0-9]{6}$"))) return@withContext null
        // 3. sign a stream
        val clientId = UUID.randomUUID().toString().replace("-", "")
        val signed = postJson("https://s5v.lazyrocket.space/mQ7x2P",
            "{\"video\":\"$hash\",\"client\":\"$clientId\"}",
            mapOf("Origin" to ABIBLI_ORIGIN, "Referer" to "$ABIBLI_ORIGIN/", "X-S5V-Client" to clientId)) ?: return@withContext null
        val playlist = JSONObject(signed).optString("playlist")
        if (playlist.isEmpty()) return@withContext null
        val playlistUrl = if (playlist.startsWith("http")) playlist else "https://s5v.lazyrocket.space$playlist"
        // 4. the Android client talks to upstream directly through a tiny
        //    in-process proxy (AppProxy) needing no server. We return the
        //    target URL and let the player fetch via WebView-free OkHttp
        //    with the same headers — handled in AppProxy/streamWithHeaders
        //    (playback and downloads both read through it).
        AppProxy.registerAbibli(playlistUrl, clientId)
        AppProxy.abibliUrl(playlistUrl, clientId)
    }

    // ── Subtitles (VDRK + Natsuki) ──────────────────────────────
    suspend fun fetchSubtitles(tmdb: String, imdb: String, type: String, season: Int, episode: Int): List<Subtitle> = withContext(Dispatchers.IO) {
        val results = ArrayList<Subtitle>()
        if (tmdb.isNotEmpty()) {
            val vdrkUrl = "https://sub.vdrk.site/v1/" + if (type == "tv") "tv/$tmdb/$season/$episode" else "movie/$tmdb"
            val body = get(vdrkUrl)
            if (body != null) {
                val arr = try { org.json.JSONArray(body) } catch (_: Exception) { null }
                if (arr != null) for (i in 0 until arr.length()) {
                    val item = arr.optJSONObject(i) ?: continue
                    val file = item.optString("file")
                    if (file.startsWith("http")) results.add(Subtitle(item.optString("label").ifEmpty { "Unknown" }, file, "vtt", "VDRK"))
                }
            }
        }
        if (imdb.isNotEmpty()) {
            val body = get("https://natsuki.hls.lol/subs?imdbId=$imdb", mapOf("Origin" to "https://cinecat.eu", "Referer" to "https://cinecat.eu/"))
            if (body != null) {
                val obj = try { JSONObject(body) } catch (_: Exception) { null }
                val subs = obj?.optJSONArray("subtitles")
                if (subs != null) for (i in 0 until subs.length()) {
                    val item = subs.optJSONObject(i) ?: continue
                    val u = item.optString("url")
                    if (u.startsWith("http")) results.add(Subtitle(item.optString("language").ifEmpty { "Unknown" }, u, "srt", "Natsuki"))
                }
            }
        }
        results.sortedWith(compareBy({ rank(it.label) }, { it.label.lowercase() })).take(60)
    }

    // ── Analyze (HLS variants) ──────────────────────────────────
    suspend fun analyze(url: String, quick: Boolean): List<Quality> = withContext(Dispatchers.IO) {
        val body = get(url) ?: return@withContext emptyList()
        if (!body.contains("#EXT-X-STREAM-INF:")) {
            return@withContext listOf(Quality(url, "Auto", 0, ""))
        }
        val lines = body.split("\n")
        val variants = ArrayList<Quality>()
        for (i in lines.indices) {
            if (!lines[i].contains("#EXT-X-STREAM-INF:")) continue
            val bw = Regex("BANDWIDTH=(\\d+)", RegexOption.IGNORE_CASE).find(lines[i])?.groupValues?.get(1)?.toIntOrNull() ?: 0
            val resolution = Regex("RESOLUTION=(\\d+x\\d+)", RegexOption.IGNORE_CASE).find(lines[i])?.groupValues?.get(1) ?: ""
            val next = lines.getOrNull(i + 1)?.trim() ?: ""
            if (next.isNotEmpty() && !next.startsWith("#")) {
                val height = resolution.split("x").getOrNull(1)?.filter { it.isDigit() } ?: ""
                val label = if (height.isNotEmpty()) height + "p"
                else when (bw) { in 8000001..Int.MAX_VALUE -> "4K"; in 3000001..8000000 -> "1080p"; in 1500001..3000000 -> "720p"; in 700001..1500000 -> "480p"; in 300001..700000 -> "360p"; else -> "240p" }
                variants.add(Quality(resolveUrl(url, next), label, bw, resolution))
            }
        }
        variants.sortedByDescending { it.bandwidth }
    }

    // ── Quality ladder preview for a master URL via analyze ──────

    // ── Health ──────────────────────────────────────────────────
    suspend fun health(name: String): String {
        val url = when (name) {
            "PeeStream" -> "https://streamdata.vaplayer.ru/api.php?tmdb=550&type=movie"
            "Abibli" -> "https://abibli.com/search/suggest?q=Av"
            "StreameX" -> "https://play.xpass.top/"
            else -> "https://image.tmdb.org/"
        }
        return try {
            val req = Request.Builder().url(url).header("User-Agent", UA).get().build()
            client.newCall(req).execute().use { if (it.code < 500) "ok" else "err" }
        } catch (_: Exception) { "err" }
    }

    // ── Low-level helpers ───────────────────────────────────────
    private fun get(url: String, headers: Map<String, String> = emptyMap()): String? {
        Log.d("Api", "GET $url")
        val builder = Request.Builder().url(url).header("User-Agent", UA)
        headers.forEach { (k, v) -> builder.header(k, v) }
        val req = builder.get().build()
        return try {
            client.newCall(req).execute().use { r -> if (r.isSuccessful) r.body?.string() else null }
        } catch (e: Exception) { Log.w("Api", e.message ?: "error"); null }
    }
    private fun postJson(url: String, body: String, headers: Map<String, String>): String? {
        val req = Request.Builder().url(url)
            .header("User-Agent", UA)
            .header("Accept", "application/json")
            .header("Content-Type", "application/json")
            .apply { headers.forEach { (k, v) -> header(k, v) } }
            .post(body.toRequestBody("application/json".toMediaType()))
            .build()
        return try {
            client.newCall(req).execute().use { r -> if (r.isSuccessful) r.body?.string() else null }
        } catch (e: Exception) { Log.w("Api", e.message ?: "error"); null }
    }
    private fun jget(url: String): JSONObject? {
        val body = get(url) ?: return null
        return try { JSONObject(body) } catch (_: Exception) { null }
    }
    private fun String.q() = java.net.URLEncoder.encode(this, "UTF-8")
    private fun resolveUrl(base: String, href: String): String {
        if (href.startsWith("http://") || href.startsWith("https://")) return href
        return java.net.URL(java.net.URL(base), href).toString()
    }
    private fun rank(label: String): Int {
        val l = label.lowercase()
        return when { l.startsWith("english") -> 0; l.startsWith("arabic") -> 1; l.startsWith("hindi") -> 2; else -> 3 }
    }
    private fun pickAbibliItem(items: org.json.JSONArray, title: String, year: String, type: String): String? {
        val target = title.normalize()
        var best: String? = null
        var bestScore = Int.MIN_VALUE
        for (i in 0 until items.length()) {
            val item = items.optJSONObject(i) ?: continue
            val href = item.optString("href")
            if (type == "tv" && !href.contains("/series/")) continue
            if (type != "tv" && !href.contains("/movie/")) continue
            val it = item.optString("title").normalize()
            val hrefYear = Regex("-([0-9]{4})(?:\\?|$)").find(href)?.groupValues?.get(1) ?: ""
            var score = 0
            if (it.isNotEmpty() && it == target) score += 100
            else if (it.isNotEmpty() && (it.startsWith(target) || target.startsWith(it))) score += 60
            else if (it.isNotEmpty() && (it.contains(target) || target.contains(it))) score += 25
            else score -= 40
            if (year.isNotEmpty() && hrefYear.isNotEmpty()) score += if (hrefYear == year) 50 else -30
            if (href.contains("?season=")) score -= 20
            if (score > bestScore) { bestScore = score; best = href }
        }
        return if (bestScore > 0) best else null
    }
    private fun String.normalize(): String =
        lowercase().replace(Regex("\\([^)]*\\)"), " ")
            .replace(Regex("\\b(?:season|series)\\s*\\d+.*$"), " ")
            .replace(Regex("[^a-z0-9]+"), "")

    private data class PlayEntry(val hash: String, val seasonNumber: Int, val episodeNumber: Int)
    private fun parseAbibliPlays(html: String): List<PlayEntry> {
        val out = ArrayList<PlayEntry>()
        val re = Regex("streamPlayer\\.play\\(\\s*'([^']+)'\\s*,\\s*JSON\\.parse\\(\\s*'((?:[^'\\\\]|\\\\.)*)'\\s*\\)\\s*\\)")
        for (m in re.findAll(html)) {
            val streamUrl = m.groupValues[1].replace("\\/", "/")
            val sNum = Regex("\"seasonNumber\"\\s*:\\s*(\\d+)").find(m.groupValues[2])?.groupValues?.get(1)?.toIntOrNull() ?: 0
            val eNum = Regex("\"episodeNumber\"\\s*:\\s*(\\d+)").find(m.groupValues[2])?.groupValues?.get(1)?.toIntOrNull() ?: 0
            out.add(PlayEntry(streamUrl.split('#').getOrNull(1) ?: "", sNum, eNum))
        }
        return out
    }

    const val ABIBLI_ORIGIN = "https://rov.funnyotter.xyz"
}

data class TmdbItem(
    val id: Int, val title: String, val type: String, val year: String,
    val poster: String, val backdrop: String, val overview: String, val rating: Double
)
data class DetailInfo(
    val title: String, val year: String, val overview: String,
    val poster: String, val backdrop: String, val rating: Double,
    val genres: List<String>, val cast: List<Pair<String, String>>, val seasons: List<Int>
)
data class Episode(val number: Int, val title: String, val still: String)
data class Quality(val url: String, val label: String, val bandwidth: Int, val resolution: String)
data class Subtitle(val label: String, val url: String, val ext: String, val source: String)
