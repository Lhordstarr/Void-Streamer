package com.voidstreamer.app

import android.util.Log
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.URLDecoder
import kotlin.concurrent.thread

/**
 * Minimal HTTP server bound to 127.0.0.1 handling the app's internal proxy
 * routes:
 *   GET /abibli/{token}/master.m3u8
 *   GET /abibli/{token}/stream?u=<encoded upstream>
 * Playlists are buffered + rewritten; binary media streams through.
 */
object TinyHttpServer {
    @Volatile var port: Int = 0
        private set

    private var running = false
    private var server: ServerSocket? = null

    @Synchronized
    fun start() {
        if (running) return
        try {
            server = ServerSocket()
            server!!.bind(InetSocketAddress("127.0.0.1", 0))
            port = server!!.localPort
            running = true
            Log.i("Proxy", "TinyHttpServer listening on port $port")
            thread(name = "VoidProxy") {
                while (running) {
                    val client = try { server!!.accept() } catch (_: Exception) { break }
                    thread { handle(client) }
                }
            }
        } catch (e: Exception) {
            Log.e("Proxy", "failed to start: ${e.message}")
        }
    }

    private fun handle(sock: Socket) {
        try {
            sock.soTimeout = 30000
            val reader = sock.getInputStream().bufferedReader()
            val writer = sock.getOutputStream().bufferedWriter()
            val requestLine = reader.readLine() ?: return sock.close()
            val parts = requestLine.split(" ")
            if (parts.size < 2) return sock.close()
            val method = parts[0]
            var path = parts[1]
            // skip headers
            while (true) {
                val h = reader.readLine() ?: break
                if (h.isEmpty()) break
            }
            val q = path.indexOf('?')
            val pathname = if (q >= 0) path.substring(0, q) else path
            val query = if (q >= 0) path.substring(q + 1) else ""

            val m = Regex("^/abibli/([a-z0-9-]+)/(master(?:\\.m3u8)?|stream)$").matchEntire(pathname)
            if (m == null) {
                writeStatus(writer, 404, "text/plain", "Not found")
                writer.close()
                return
            }
            val token = m.groupValues[1]
            val sess = AppProxy.session(token)
            if (sess == null) {
                writeStatus(writer, 410, "text/plain", "Stream session expired")
                writer.close()
                return
            }
            val target = if (m.groupValues[2].startsWith("master")) sess.playlistUrl else queryParam(query, "u")
            if (target.isNullOrEmpty()) {
                writeStatus(writer, 400, "text/plain", "Missing u")
                writer.close()
                return
            }
            if (try { java.net.URL(target).host } catch (_: Exception) { "" } != "s5v.lazyrocket.space") {
                writeStatus(writer, 403, "text/plain", "Host not allowed")
                writer.close()
                return
            }
            val upstream = try {
                AppProxy.fetchUpstream(target, mapOf(
                    "Origin" to AppProxy.ABIBLI_ORIGIN_LOCAL,
                    "Referer" to AppProxy.ABIBLI_ORIGIN_LOCAL + "/",
                    "X-S5V-Client" to sess.client
                ))
            } catch (e: Exception) {
                writeStatus(writer, 502, "text/plain", "Proxy error: " + e.message)
                writer.close()
                return
            }

            val outHeaders = HashMap<String, String>()
            outHeaders["Access-Control-Allow-Origin"] = "*"
            outHeaders["Access-Control-Allow-Headers"] = "*"
            outHeaders["Access-Control-Allow-Methods"] = "GET, HEAD, OPTIONS"
            for (key in listOf("Content-Type", "Content-Range", "Accept-Ranges", "ETag", "Last-Modified", "Cache-Control", "Content-Length")) {
                upstream.headers[key]?.firstOrNull()?.let { outHeaders[key] = it }
            }

            val ct = upstream.headers["Content-Type"]?.firstOrNull() ?: ""
            if (method == "HEAD") {
                writer.write("HTTP/1.1 ${upstream.status} OK\r\n")
                outHeaders.forEach { (k, v) -> writer.write("$k: $v\r\n") }
                writer.write("\r\n"); writer.flush()
                writer.close()
                return
            }
            if (AppProxy.isPlaylist(target, ct)) {
                val text = upstream.body.bufferedReader().readText()
                var auth = ""
                try { auth = java.net.URL(sess.playlistUrl).query ?: "" } catch (_: Exception) {}
                val rewritten = AppProxy.rewritePlaylist(text, target, { abs ->
                    "http://127.0.0.1:$port/abibli/$token/stream?u=" + java.net.URLEncoder.encode(abs, "UTF-8")
                }, auth)
                val body = rewritten.toByteArray(Charsets.UTF_8)
                writer.write("HTTP/1.1 ${upstream.status} OK\r\n")
                for ((k, v) in outHeaders) if (!k.equals("Content-Length", true)) writer.write("$k: $v\r\n")
                writer.write("Content-Type: application/vnd.apple.mpegurl\r\n")
                writer.write("Content-Length: ${body.size}\r\n\r\n")
                writer.write(body.decodeToString())
                writer.flush()
                writer.close()
                return
            }
            writer.write("HTTP/1.1 ${upstream.status} OK\r\n")
            outHeaders.forEach { (k, v) -> writer.write("$k: $v\r\n") }
            writer.write("\r\n"); writer.flush()
            upstream.body.copyTo(sock.getOutputStream())
            upstream.body.close()
            writer.close()
        } catch (e: Exception) {
            Log.e("Proxy", "handle: ${e.message}")
        } finally {
            try { sock.close() } catch (_: Exception) {}
        }
    }

    private fun writeStatus(w: java.io.Writer, status: Int, ct: String, body: String) {
        val b = body.toByteArray(Charsets.UTF_8)
        w.write("HTTP/1.1 $status Error\r\nContent-Type: $ct\r\nContent-Length: ${b.size}\r\nAccess-Control-Allow-Origin: *\r\n\r\n")
        w.write(body)
        w.flush()
    }

    private fun queryParam(q: String, key: String): String? {
        for (pair in q.split("&")) {
            val i = pair.indexOf('=')
            if (i < 0) continue
            if (URLDecoder.decode(pair.substring(0, i), "UTF-8") == key) {
                return URLDecoder.decode(pair.substring(i + 1), "UTF-8")
            }
        }
        return null
    }
}
