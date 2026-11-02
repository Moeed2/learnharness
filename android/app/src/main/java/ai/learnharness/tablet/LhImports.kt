package ai.learnharness.tablet

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.provider.DocumentsContract
import android.provider.OpenableColumns
import android.util.Log
import android.webkit.MimeTypeMap
import android.webkit.WebResourceResponse
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileInputStream
import java.net.URLConnection
import java.net.URLDecoder
import java.net.URLEncoder
import java.util.UUID

/**
 * Native pickers behind window.lh.pickFiles / pickFolder.
 *
 * Chosen documents are copied into filesDir/imports/<id>/..., so the embedded
 * server (same process and uid) can read real paths: file-path chips use the
 * returned absolute paths unchanged, and folder imports are served back to the
 * page via [intercept] (the notes importer uploads File objects).
 *
 * Limits keep a stray huge selection from filling the tablet. Copies run on a
 * worker thread and report progress to the page.
 */
class LhImports(private val activity: Activity, private val bridge: () -> LhJsBridge?) {

    private class Pending(val callId: String, val folder: Boolean, val extensions: Set<String>)

    private val ui = Handler(Looper.getMainLooper())
    private val root = File(activity.filesDir, "imports")
    @Volatile private var pending: Pending? = null
    @Volatile private var copying = false

    init {
        Thread({ sweep() }, "lh-import-sweep").start()
    }

    // ---- entry points (JavaBridge thread) ------------------------------------

    fun pickFiles(callId: String, extensions: Set<String>) = start(Pending(callId, false, extensions))

    fun pickFolder(callId: String, extensions: Set<String>) = start(Pending(callId, true, extensions))

    private fun start(p: Pending) {
        ui.post {
            if (pending != null || copying) {
                reply(p.callId, error("Another file selection is already in progress."))
                return@post
            }
            val intent = if (p.folder) {
                Intent(Intent.ACTION_OPEN_DOCUMENT_TREE)
            } else {
                Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("*/*")
                    .putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
            }
            pending = p
            try {
                activity.startActivityForResult(intent, if (p.folder) REQ_TREE else REQ_FILES)
            } catch (e: Exception) {
                pending = null
                Log.w(AppConfig.TAG, "no document picker", e)
                reply(p.callId, error("No file picker is available on this device."))
            }
        }
    }

    /** Called from MainActivity.onActivityResult; returns true when consumed. */
    fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?): Boolean {
        if (requestCode != REQ_FILES && requestCode != REQ_TREE) return false
        val p = pending ?: return true
        pending = null
        if (resultCode != Activity.RESULT_OK || data == null) {
            reply(p.callId, empty(p.folder))
            return true
        }
        copying = true
        Thread({
            try {
                val result = if (p.folder) copyTree(data.data, p.extensions) else copyFiles(urisOf(data))
                reply(p.callId, result)
            } catch (t: Throwable) {
                Log.w(AppConfig.TAG, "import failed", t)
                reply(p.callId, error("Could not copy the selection: ${t.message ?: t.javaClass.simpleName}"))
            } finally {
                copying = false
            }
        }, "lh-import").start()
        return true
    }

    private fun urisOf(data: Intent): List<Uri> {
        val clip = data.clipData
        if (clip != null) return (0 until clip.itemCount).mapNotNull { clip.getItemAt(it).uri }
        return listOfNotNull(data.data)
    }

    // ---- individual files -------------------------------------------------------

    private fun copyFiles(uris: List<Uri>): JSONObject {
        val id = newId()
        val dir = File(root, id).also { it.mkdirs() }
        val sizes = uris.map { sizeOf(it) }
        val progress = Progress(sizes.filter { it > 0 }.sum())
        val files = JSONArray()
        var skipped = 0
        var total = 0L
        var note: String? = null
        val used = HashSet<String>()
        for ((i, uri) in uris.withIndex()) {
            if (files.length() >= MAX_PICKED_FILES) { skipped++; note = "Only the first $MAX_PICKED_FILES files were copied."; continue }
            val size = sizes[i]
            if (size > MAX_FILE_BYTES || (size > 0 && total + size > MAX_TOTAL_BYTES)) {
                skipped++
                note = "Some files were skipped: limit is ${MAX_FILE_BYTES shr 20} MB per file and ${MAX_TOTAL_BYTES shr 20} MB in total."
                continue
            }
            val name = uniqueName(sanitizeSegment(displayName(uri) ?: "file"), used)
            val dest = File(dir, name)
            val copied = copyOne(uri, dest, progress)
            if (copied < 0) { skipped++; dest.delete(); continue }
            total += copied
            files.put(JSONObject().put("name", name).put("path", dest.absolutePath).put("size", copied))
        }
        if (files.length() == 0) dir.deleteRecursively()
        return JSONObject().put("id", id).put("files", files).put("skipped", skipped).also { if (note != null) it.put("error", note) }
    }

    // ---- folder tree ---------------------------------------------------------------

    private class Entry(val docUri: Uri, val rel: String, val size: Long)

    private fun copyTree(tree: Uri?, extensions: Set<String>): JSONObject {
        if (tree == null) return empty(true)
        val treeDocId = DocumentsContract.getTreeDocumentId(tree)
        val rootName = queryName(DocumentsContract.buildDocumentUriUsingTree(tree, treeDocId)) ?: "Folder"
        val rootSeg = sanitizeSegment(rootName)
        val found = ArrayList<Entry>()
        val skipped = intArrayOf(0)
        val limitHit = booleanArrayOf(false)
        walk(tree, treeDocId, rootSeg, 0, extensions, found, skipped, limitHit)

        val id = newId()
        val dir = File(root, id).also { it.mkdirs() }
        val progress = Progress(found.sumOf { it.size.coerceAtLeast(0) })
        val files = JSONArray()
        for (e in found) {
            val dest = safeResolve(dir, e.rel)
            if (dest == null) { skipped[0]++; continue }
            dest.parentFile?.mkdirs()
            val copied = copyOne(e.docUri, dest, progress)
            if (copied < 0) { skipped[0]++; dest.delete(); continue }
            files.put(
                JSONObject().put("path", e.rel).put("size", copied)
                    .put("url", "$IMPORT_PREFIX$id/" + e.rel.split('/').joinToString("/") { URLEncoder.encode(it, "UTF-8").replace("+", "%20") }),
            )
        }
        if (files.length() == 0) dir.deleteRecursively()
        val out = JSONObject().put("id", id).put("name", rootSeg).put("files", files).put("skipped", skipped[0])
        if (limitHit[0]) out.put("error", "The folder is large: only the first $MAX_TREE_FILES files (up to ${MAX_TOTAL_BYTES shr 20} MB) were copied.")
        return out
    }

    private fun walk(
        tree: Uri, docId: String, rel: String, depth: Int, ext: Set<String>,
        out: MutableList<Entry>, skipped: IntArray, limitHit: BooleanArray,
    ) {
        if (depth > MAX_DEPTH || limitHit[0]) return
        val children = DocumentsContract.buildChildDocumentsUriUsingTree(tree, docId)
        val cols = arrayOf(
            DocumentsContract.Document.COLUMN_DOCUMENT_ID, DocumentsContract.Document.COLUMN_DISPLAY_NAME,
            DocumentsContract.Document.COLUMN_MIME_TYPE, DocumentsContract.Document.COLUMN_SIZE,
        )
        val rows = ArrayList<Array<Any?>>()
        try {
            activity.contentResolver.query(children, cols, null, null, null)?.use { c ->
                while (c.moveToNext()) rows.add(arrayOf(c.getString(0), c.getString(1), c.getString(2), if (c.isNull(3)) -1L else c.getLong(3)))
            }
        } catch (e: Exception) {
            Log.w(AppConfig.TAG, "cannot list $rel", e)
            skipped[0]++
            return
        }
        var bytes = out.sumOf { it.size.coerceAtLeast(0) }
        for (r in rows) {
            val childId = r[0] as String
            val name = (r[1] as String?) ?: continue
            if (name.startsWith(".")) continue // .git, .obsidian, .DS_Store ...
            val seg = sanitizeSegment(name)
            if ((r[2] as String?) == DocumentsContract.Document.MIME_TYPE_DIR) {
                walk(tree, childId, "$rel/$seg", depth + 1, ext, out, skipped, limitHit)
                continue
            }
            if (ext.isNotEmpty() && name.substringAfterLast('.', "").lowercase() !in ext) continue
            val size = r[3] as Long
            if (size > MAX_FILE_BYTES) { skipped[0]++; continue }
            if (out.size >= MAX_TREE_FILES || bytes + size.coerceAtLeast(0) > MAX_TOTAL_BYTES) { limitHit[0] = true; return }
            bytes += size.coerceAtLeast(0)
            out.add(Entry(DocumentsContract.buildDocumentUriUsingTree(tree, childId), "$rel/$seg", size))
        }
    }

    // ---- helpers ---------------------------------------------------------------------

    private inner class Progress(val total: Long) {
        var done = 0L
        private var lastReport = 0L
        fun add(n: Int) {
            done += n
            val now = System.currentTimeMillis()
            if (total > 0 && now - lastReport > 250) {
                lastReport = now
                bridge()?.progress(done.coerceAtMost(total), total)
            }
        }
    }

    /** Returns bytes copied, or -1 on failure. */
    private fun copyOne(src: Uri, dest: File, progress: Progress): Long {
        return try {
            var n = 0L
            activity.contentResolver.openInputStream(src)?.use { input ->
                dest.outputStream().use { output ->
                    val buf = ByteArray(64 * 1024)
                    while (true) {
                        val r = input.read(buf)
                        if (r < 0) break
                        if (n + r > MAX_FILE_BYTES) return -1
                        output.write(buf, 0, r)
                        n += r
                        progress.add(r)
                    }
                }
            } ?: return -1
            n
        } catch (e: Exception) {
            Log.w(AppConfig.TAG, "copy failed: $src", e)
            -1
        }
    }

    private fun sizeOf(uri: Uri): Long = try {
        activity.contentResolver.query(uri, arrayOf(OpenableColumns.SIZE), null, null, null)?.use { c ->
            if (c.moveToFirst() && !c.isNull(0)) c.getLong(0) else -1L
        } ?: -1L
    } catch (_: Exception) { -1L }

    private fun displayName(uri: Uri): String? = try {
        activity.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c ->
            if (c.moveToFirst()) c.getString(0) else null
        }
    } catch (_: Exception) { null }

    private fun queryName(docUri: Uri): String? = displayName(docUri)

    fun release(id: String) {
        if (!ID_RE.matches(id)) return
        Thread({ File(root, id).deleteRecursively() }, "lh-import-release").start()
    }

    /** Drop copies older than 30 days, then oldest-first beyond 2 GB. */
    private fun sweep() {
        try {
            val dirs = root.listFiles()?.filter { it.isDirectory }?.sortedBy { it.lastModified() } ?: return
            val cutoff = System.currentTimeMillis() - 30L * 24 * 3600 * 1000
            val live = ArrayList<File>()
            for (d in dirs) if (d.lastModified() < cutoff) d.deleteRecursively() else live.add(d)
            var total = live.sumOf { d -> d.walkTopDown().filter { it.isFile }.sumOf { it.length() } }
            for (d in live) {
                if (total <= STORE_CAP_BYTES) break
                total -= d.walkTopDown().filter { it.isFile }.sumOf { it.length() }
                d.deleteRecursively()
            }
        } catch (t: Throwable) {
            Log.w(AppConfig.TAG, "import sweep failed", t)
        }
    }

    /** Serves /__lh_import/<id>/<path> from the copies; null for other requests. */
    fun intercept(url: Uri): WebResourceResponse? {
        val path = url.encodedPath ?: return null
        if (!path.startsWith(IMPORT_PREFIX)) return null
        val parts = path.removePrefix(IMPORT_PREFIX).split('/', limit = 2)
        val id = parts.getOrNull(0) ?: return notFound()
        val rel = parts.getOrNull(1)?.let { URLDecoder.decode(it.replace("+", "%2B"), "UTF-8") } ?: return notFound()
        if (!ID_RE.matches(id)) return notFound()
        val file = safeResolve(File(root, id), rel)?.takeIf { it.isFile } ?: return notFound()
        val mime = MimeTypeMap.getSingleton().getMimeTypeFromExtension(file.extension.lowercase())
            ?: URLConnection.guessContentTypeFromName(file.name) ?: "application/octet-stream"
        return WebResourceResponse(mime, null, 200, "OK", mapOf("Cache-Control" to "no-store"), FileInputStream(file))
    }

    private fun notFound() = WebResourceResponse("text/plain", "utf-8", 404, "Not Found", emptyMap(), "".byteInputStream())

    private fun reply(callId: String, json: JSONObject) {
        bridge()?.resolve(callId, json)
    }

    private fun empty(folder: Boolean): JSONObject =
        JSONObject().put("id", "").put("files", JSONArray()).put("skipped", 0).also { if (folder) it.put("name", "") }

    private fun error(msg: String): JSONObject = empty(false).put("error", msg)

    companion object {
        const val REQ_FILES = 41002
        const val REQ_TREE = 41003
        const val IMPORT_PREFIX = "/__lh_import/"

        private const val MAX_FILE_BYTES = 200L shl 20
        private const val MAX_TOTAL_BYTES = 512L shl 20
        private const val STORE_CAP_BYTES = 2048L shl 20
        private const val MAX_PICKED_FILES = 100
        private const val MAX_TREE_FILES = 2000
        private const val MAX_DEPTH = 12
        private val ID_RE = Regex("[0-9a-f]{32}")

        private fun newId() = UUID.randomUUID().toString().replace("-", "")

        /** One path segment: no separators, controls or leading dots; never empty, max 120 chars. */
        fun sanitizeSegment(name: String): String {
            val s = name.map { if (it == '/' || it == '\\' || it.isISOControl() || it == ':') '_' else it }
                .joinToString("").trim().trimStart('.').take(120).trim()
            return s.ifEmpty { "file" }
        }

        private fun uniqueName(base: String, used: MutableSet<String>): String {
            var name = base
            var n = 2
            val dot = base.lastIndexOf('.').takeIf { it > 0 }
            while (!used.add(name.lowercase())) {
                name = if (dot != null) "${base.substring(0, dot)} ($n)${base.substring(dot)}" else "$base ($n)"
                n++
            }
            return name
        }

        /** [rel] under [base], or null when it would escape it. */
        fun safeResolve(base: File, rel: String): File? {
            val f = File(base, rel)
            val b = base.canonicalPath + File.separator
            return if (f.canonicalPath.startsWith(b)) f else null
        }
    }
}
