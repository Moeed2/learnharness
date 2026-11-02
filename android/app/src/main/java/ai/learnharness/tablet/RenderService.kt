package ai.learnharness.tablet

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.util.Log
import org.json.JSONObject
import java.io.BufferedInputStream
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ExecutionException
import java.util.concurrent.TimeUnit
import java.util.concurrent.locks.ReentrantLock

/**
 * Loopback render service used by the embedded Node server (docs/android.md,
 * "Render service"). Minimal HTTP/1.1 over java.net.ServerSocket, bound to
 * 127.0.0.1 on a random port and protected by a random bearer token. Jobs run
 * one at a time. Must be started before Node so the URL/token can go in env.
 */
object RenderService {
    private const val MAX_BODY = 16 * 1024 * 1024
    private const val TAG = "LH-Render"

    @Volatile private var url: String? = null
    @Volatile private var token: String? = null
    private lateinit var appContext: Context
    private val jobLock = ReentrantLock() // serializes jobs
    private val main = Handler(Looper.getMainLooper())

    /** Idempotent. Returns (url, token). */
    @Synchronized
    fun start(context: Context): Pair<String, String> {
        val u = url
        val t = token
        if (u != null && t != null) return u to t
        appContext = context.applicationContext
        val bytes = ByteArray(32).also { SecureRandom().nextBytes(it) }
        val tok = bytes.joinToString("") { "%02x".format(it) }
        val server = ServerSocket(0, 8, InetAddress.getByName("127.0.0.1"))
        token = tok
        url = "http://127.0.0.1:${server.localPort}"
        Thread({
            while (true) {
                val s = try { server.accept() } catch (e: Exception) { Log.w(TAG, "accept failed", e); break }
                Thread({ handle(s) }, "lh-render-conn").start()
            }
        }, "lh-render-accept").apply { isDaemon = true }.start()
        Log.i(TAG, "render service on ${url}")
        return url!! to tok
    }

    private class Request(val method: String, val path: String, val headers: Map<String, String>, val body: ByteArray)

    private fun handle(socket: Socket) {
        socket.use { s ->
            try {
                s.soTimeout = 30_000
                val input = BufferedInputStream(s.getInputStream())
                val req = readRequest(input) ?: return respond(s, 400, "application/json", err("bad request"))
                val auth = req.headers["authorization"] ?: ""
                val expected = "Bearer $token"
                if (!MessageDigest.isEqual(auth.toByteArray(), expected.toByteArray())) {
                    return respond(s, 401, "application/json", err("unauthorized"))
                }
                if (req.method != "POST") return respond(s, 405, "application/json", err("method not allowed"))
                val json = try { JSONObject(String(req.body, Charsets.UTF_8)) } catch (e: Exception) {
                    return respond(s, 400, "application/json", err("invalid JSON"))
                }
                when (req.path) {
                    "/demo" -> {
                        val out = runJob { demo(json) }
                        respond(s, 200, "application/json", out.toString().toByteArray())
                    }
                    "/svg" -> {
                        val png = runJob { svg(json) }
                        respond(s, 200, "image/png", png)
                    }
                    "/pdf" -> try {
                        val out = runJob { PdfPageRenderer.render(appContext, json) }
                        respond(s, 200, "application/json", out.toString().toByteArray())
                    } catch (e: PdfRenderException) {
                        val body = JSONObject().put("error", e.message).put("code", e.code)
                        respond(s, 422, "application/json", body.toString().toByteArray())
                    }
                    else -> respond(s, 404, "application/json", err("not found"))
                }
            } catch (e: Exception) {
                Log.w(TAG, "request failed", e)
                try { respond(s, 500, "application/json", err(e.message ?: e.javaClass.simpleName)) } catch (_: Exception) {}
            }
        }
    }

    private fun <T> runJob(block: () -> T): T {
        jobLock.lock()
        try { return block() } finally { jobLock.unlock() }
    }

    private fun <T : Any> onMain(timeoutMs: Long, post: (CompletableFuture<T>) -> Unit): T {
        val f = CompletableFuture<T>()
        main.post { try { post(f) } catch (t: Throwable) { f.completeExceptionally(t) } }
        try {
            return f.get(timeoutMs, TimeUnit.MILLISECONDS)
        } catch (e: ExecutionException) {
            throw RuntimeException(e.cause?.message ?: "render failed")
        }
    }

    private fun demo(j: JSONObject): JSONObject {
        val html = if (j.has("html")) j.getString("html") else null
        val pageUrl = if (j.has("url")) j.getString("url") else null
        if (html == null && pageUrl == null) throw IllegalArgumentException("html or url required")
        val settle = j.optLong("settleMs", 2000).coerceIn(0, 30_000)
        val probe = if (j.has("probe") && !j.isNull("probe")) j.getString("probe") else null
        val w = j.optInt("width", 1024).coerceIn(100, 4096)
        val h = j.optInt("height", 768).coerceIn(100, 4096)
        val shot = j.optBoolean("screenshot", false)
        val outcome = onMain<DemoOutcome>(settle + 70_000) { f ->
            OffscreenWebView(appContext, w, h).runDemo(html, pageUrl, settle, probe, shot, f)
        }
        return outcome.toJson()
    }

    private fun svg(j: JSONObject): ByteArray {
        val svg = j.getString("svg")
        val w = j.optInt("width", 900).coerceIn(10, 4096)
        val h = j.optInt("height", 700).coerceIn(10, 4096)
        return onMain<ByteArray>(40_000) { f -> OffscreenWebView(appContext, w, h).renderSvg(svg, f) }
    }

    private fun err(msg: String): ByteArray = JSONObject().put("error", msg).toString().toByteArray()

    private fun readRequest(input: InputStream): Request? {
        val head = ByteArrayOutputStream()
        var matched = 0
        val term = byteArrayOf(13, 10, 13, 10)
        while (matched < 4) {
            val b = input.read()
            if (b < 0) return null
            head.write(b)
            if (head.size() > 32 * 1024) return null
            matched = if (b.toByte() == term[matched]) matched + 1 else if (b.toByte() == term[0]) 1 else 0
        }
        val lines = String(head.toByteArray(), Charsets.ISO_8859_1).split("\r\n")
        val parts = lines[0].split(" ")
        if (parts.size < 2) return null
        val headers = HashMap<String, String>()
        for (l in lines.drop(1)) {
            val i = l.indexOf(':')
            if (i > 0) headers[l.substring(0, i).trim().lowercase()] = l.substring(i + 1).trim()
        }
        val len = headers["content-length"]?.toIntOrNull() ?: 0
        if (len < 0 || len > MAX_BODY) return null
        val body = ByteArray(len)
        var read = 0
        while (read < len) {
            val n = input.read(body, read, len - read)
            if (n < 0) return null
            read += n
        }
        return Request(parts[0], parts[1].substringBefore('?'), headers, body)
    }

    private fun respond(s: Socket, status: Int, type: String, body: ByteArray) {
        val reason = when (status) { 200 -> "OK"; 400 -> "Bad Request"; 401 -> "Unauthorized"; 404 -> "Not Found"; 422 -> "Unprocessable Entity"; 405 -> "Method Not Allowed"; else -> "Error" }
        val out = s.getOutputStream()
        out.write("HTTP/1.1 $status $reason\r\nContent-Type: $type\r\nContent-Length: ${body.size}\r\nConnection: close\r\n\r\n".toByteArray(Charsets.ISO_8859_1))
        out.write(body)
        out.flush()
    }
}
