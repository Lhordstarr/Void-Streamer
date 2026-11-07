package com.voidstreamer.app

import android.content.Context
import android.content.SharedPreferences

/** Persists Continue Watching entries (title/episode + position). */
object ProgressStore {
    private const val PREFS = "void_progress"
    private const val KEY = "continue"

    private fun prefs(ctx: Context): SharedPreferences =
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    data class Entry(
        val key: String,
        val title: String,
        val image: String,
        val tmdbId: String,
        val type: String,
        val season: Int,
        val episode: Int,
        val at: Long,
        val dur: Long,
        val updated: Long
    )

    private fun all(ctx: Context): MutableMap<String, Entry> {
        val raw = prefs(ctx).getString(KEY, "{}") ?: "{}"
        val map = HashMap<String, Entry>()
        try {
            val obj = org.json.JSONObject(raw)
            val keys = obj.keys()
            while (keys.hasNext()) {
                val k = keys.next()
                val e = obj.optJSONObject(k) ?: continue
                map[k] = Entry(
                    k,
                    e.optString("title"),
                    e.optString("image"),
                    e.optString("tmdbId"),
                    e.optString("type", "movie"),
                    e.optInt("season"),
                    e.optInt("episode"),
                    e.optLong("at"),
                    e.optLong("dur"),
                    e.optLong("updated")
                )
            }
        } catch (_: Exception) {}
        return map
    }

    private fun write(ctx: Context, map: Map<String, Entry>) {
        val obj = org.json.JSONObject()
        for ((k, e) in map) {
            obj.put(k, org.json.JSONObject().apply {
                put("title", e.title); put("image", e.image); put("tmdbId", e.tmdbId)
                put("type", e.type); put("season", e.season); put("episode", e.episode)
                put("at", e.at); put("dur", e.dur); put("updated", e.updated)
            })
        }
        prefs(ctx).edit().putString(KEY, obj.toString()).apply()
    }

    fun save(ctx: Context, title: String, image: String, tmdbId: String, type: String, season: Int, episode: Int, at: Long, dur: Long) {
        if (tmdbId.isEmpty()) return
        val key = "$type|$tmdbId|$season|$episode"
        val map = all(ctx)
        if (at > 5 && dur > 0 && at.toDouble() / dur > 0.95) {
            map.remove(key) // finished
        } else if (at > 5) {
            map[key] = Entry(key, title, image, tmdbId, type, season, episode, at, dur, System.currentTimeMillis())
        } else {
            map.remove(key)
        }
        write(ctx, map)
    }

    fun list(ctx: Context): List<Entry> =
        all(ctx).values.filter { it.at > 5 }.sortedByDescending { it.updated }.take(15)

    fun get(ctx: Context, tmdbId: String, type: String, season: Int, episode: Int): Entry? =
        all(ctx)["$type|$tmdbId|$season|$episode"]
}
