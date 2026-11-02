package ai.learnharness.tablet

import android.app.Activity
import android.app.DownloadManager
import android.content.ContentValues
import android.content.Context
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import android.util.Log
import android.webkit.CookieManager
import android.webkit.DownloadListener
import android.webkit.URLUtil
import android.widget.Toast
import org.json.JSONObject
import java.io.File
import java.io.OutputStream
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

/**
 * Downloads for the WebView.
 *
 * - Blob/data downloads (every in-app download: artifact + conversation
 *   exports) are streamed from the page in chunks through [begin]/[write]/
 *   [finish] and stored in the public Downloads folder (MediaStore on API 29+).
 * - Same-origin http URLs are fetched by the page itself (cookies, Origin) and
 *   take the same path.
 * - Other http(s) URLs go to the system DownloadManager.
 */
class LhDownloads(private val activity: Activity, private val bridge: () -> LhJsBridge?) : DownloadListener {

    private class Session(val name: String, val out: OutputStream, val uri: Uri?, val file: File?) {
        var bytes = 0L
    }

    private val sessions = ConcurrentHashMap<String, Session>()

    // ---- DownloadListener (UI thread) ----------------------------------------------

    override fun onDownloadStart(url: String, userAgent: String?, contentDisposition: String?, mimeType: String?, contentLength: Long) {
        val name = sanitizeFileName(URLUtil.guessFileName(url, contentDisposition, mimeType))
        val sameOrigin = url.startsWith("http://127.0.0.1:${ServerState.port}/")
        if (url.startsWith("blob:") || url.startsWith("data:") || sameOrigin) {
            val js = bridge()
            if (js == null) toast("Download failed") else js.saveUrl(url, name, mimeType)
            return
        }
        if (!url.startsWith("https://") && !url.startsWith("http://")) {
            toast("Unsupported download")
            return
        }
        try {
            val req = DownloadManager.Request(Uri.parse(url))
                .setTitle(name)
                .setMimeType(mimeType)
                .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
            userAgent?.let { req.addRequestHeader("User-Agent", it) }
            CookieManager.getInstance().getCookie(url)?.let { req.addRequestHeader("Cookie", it) }
            if (Build.VERSION.SDK_INT >= 29) {
                req.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, name)
            } else {
                req.setDestinationInExternalFilesDir(activity, Environment.DIRECTORY_DOWNLOADS, name)
            }
            (activity.getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager).enqueue(req)
            toast("Downloading $name")
        } catch (e: Exception) {
            Log.w(AppConfig.TAG, "DownloadManager failed for $url", e)
            toast("Download failed")
        }
    }

    // ---- chunked save (JavaBridge thread) ----------------------------------------------

    fun begin(rawName: String, mime: String): String? {
        if (sessions.size >= 4) return null
        val name = sanitizeFileName(rawName)
        return try {
            val session = if (Build.VERSION.SDK_INT >= 29) {
                val values = ContentValues().apply {
                    put(MediaStore.Downloads.DISPLAY_NAME, name)
                    put(MediaStore.Downloads.MIME_TYPE, mime.ifBlank { "application/octet-stream" })
                    put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS)
                    put(MediaStore.Downloads.IS_PENDING, 1)
                }
                val uri = activity.contentResolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values) ?: return null
                val out = activity.contentResolver.openOutputStream(uri) ?: return null
                Session(name, out, uri, null)
            } else {
                // API 26-28 would need WRITE_EXTERNAL_STORAGE: use the app's own Downloads folder.
                val dir = activity.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS) ?: return null
                dir.mkdirs()
                val file = uniqueFile(dir, name)
                Session(file.name, file.outputStream(), null, file)
            }
            UUID.randomUUID().toString().also { sessions[it] = session }
        } catch (e: Exception) {
            Log.w(AppConfig.TAG, "cannot start save of $name", e)
            null
        }
    }

    fun write(id: String, data: ByteArray): Boolean {
        val s = sessions[id] ?: return false
        if (s.bytes + data.size > MAX_SAVE_BYTES) return false
        return try {
            s.out.write(data)
            s.bytes += data.size
            true
        } catch (e: Exception) {
            Log.w(AppConfig.TAG, "save write failed", e)
            false
        }
    }

    fun finish(id: String): JSONObject {
        val s = sessions.remove(id) ?: return JSONObject().put("ok", false).put("error", "unknown save")
        return try {
            s.out.close()
            if (s.uri != null) {
                activity.contentResolver.update(s.uri, ContentValues().apply { put(MediaStore.Downloads.IS_PENDING, 0) }, null, null)
            }
            toast("Saved ${s.name} to Downloads")
            JSONObject().put("ok", true).put("name", s.name)
        } catch (e: Exception) {
            Log.w(AppConfig.TAG, "save finish failed", e)
            cleanup(s)
            toast("Could not save ${s.name}")
            JSONObject().put("ok", false).put("error", e.message ?: "failed")
        }
    }

    fun abort(id: String) {
        val s = sessions.remove(id) ?: return
        try { s.out.close() } catch (_: Exception) {}
        cleanup(s)
        toast("Could not save ${s.name}")
    }

    private fun cleanup(s: Session) {
        try {
            if (s.uri != null) activity.contentResolver.delete(s.uri, null, null)
            s.file?.delete()
        } catch (_: Exception) {}
    }

    private fun toast(text: String) {
        activity.runOnUiThread { Toast.makeText(activity, text, Toast.LENGTH_LONG).show() }
    }

    companion object {
        private const val MAX_SAVE_BYTES = 512L shl 20

        /** File name only: no separators/controls, no leading dots, max 120 chars. */
        fun sanitizeFileName(raw: String): String {
            val s = raw.map { if (it == '/' || it == '\\' || it == ':' || it.isISOControl()) '_' else it }
                .joinToString("").trim().trimStart('.').take(120).trim()
            return s.ifEmpty { "download" }
        }

        private fun uniqueFile(dir: File, name: String): File {
            var f = File(dir, name)
            val dot = name.lastIndexOf('.').takeIf { it > 0 }
            var n = 2
            while (f.exists()) {
                f = File(dir, if (dot != null) "${name.substring(0, dot)} ($n)${name.substring(dot)}" else "$name ($n)")
                n++
            }
            return f
        }
    }
}
