package ai.learnharness.tablet

import android.content.Context
import android.net.Uri
import android.util.Log
import java.io.File

/**
 * Process-death recovery (step 3).
 *
 *  - The last app page (path + query) is kept in SharedPreferences and loaded
 *    again after Android killed the process or the user relaunched the app.
 *  - Temp files a killed Node process left behind are removed before the next
 *    server start. The server itself keeps no lock or pid files; its atomic
 *    writers use unique `*.tmp*` names, so leftovers are only clutter.
 *  - [isAuthDone] recognises the deep link the sign-in callback page opens.
 */
object LhSession {
    private const val PREFS = "lh_session"
    private const val KEY_PATH = "last_path"
    private const val MAX_PATH = 2000

    /** The app page to load first: the saved one, else "/". Always starts with "/". */
    fun restorePath(context: Context): String {
        val saved = try {
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY_PATH, null)
        } catch (_: Exception) {
            null
        }
        return if (saved != null && isRestorable(saved)) saved else "/"
    }

    /** Remember [url] when it is an app page on [origin]. */
    fun save(context: Context, origin: String, url: String?) {
        if (url == null || !url.startsWith("$origin/")) return
        val path = url.substring(origin.length)
        if (!isRestorable(path)) return
        try {
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(KEY_PATH, path).apply()
        } catch (e: Exception) {
            Log.w(AppConfig.TAG, "could not save last page", e)
        }
    }

    /** App pages only: never API endpoints, never protocol-relative or odd paths. */
    fun isRestorable(path: String): Boolean =
        path.length <= MAX_PATH && path.startsWith("/") && !path.startsWith("//") &&
            !path.contains('\\') && path.none { it.isISOControl() } &&
            !(path == "/api" || path.startsWith("/api/") || path.startsWith("/api?")) &&
            !path.startsWith("/auth") && !path.startsWith("/_next")

    fun isAuthDone(uri: Uri?): Boolean =
        uri != null && uri.scheme == "learnharness" && uri.host == "auth-done"

    /** Delete temp files left by a killed server. Call before Node starts. */
    fun cleanStaleTemp(filesDir: File) {
        val dirs = listOf(filesDir, File(filesDir, "data"))
        for (dir in dirs) {
            val files = dir.listFiles() ?: continue
            for (f in files) {
                if (f.isFile && (f.name.endsWith(".tmp") || f.name.contains(".tmp-"))) {
                    if (f.delete()) Log.i(AppConfig.TAG, "removed stale temp file ${f.name}")
                }
            }
        }
    }
}
