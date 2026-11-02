package ai.learnharness.tablet

import android.app.Activity
import android.util.Base64
import android.util.Log
import android.webkit.JavascriptInterface
import android.webkit.WebView
import org.json.JSONObject
import java.util.UUID

/**
 * Native half of the partial `window.lh` (assets/lh-android-shim.js).
 *
 * The Java object is registered under a private name and every method needs
 * the per-process [token], which is handed only to the top-frame shim. Java
 * interfaces are visible to every frame (including the sandboxed demo
 * iframes, which run model-written code), so without the token a demo could
 * silently write into Downloads.
 */
class LhJsBridge(
    private val activity: Activity,
    private val webView: WebView,
    private val imports: LhImports,
    private val downloads: LhDownloads,
) {
    private val token: String = UUID.randomUUID().toString()
    private val shim: String by lazy {
        activity.assets.open(SHIM_ASSET).bufferedReader().use { it.readText() }.replace("__LH_TOKEN__", token)
    }

    fun install() {
        webView.addJavascriptInterface(Native(), NAME)
    }

    /** Evaluate the shim (idempotent) in the top frame, app origin only. */
    fun injectShim(url: String?) {
        val origin = "http://127.0.0.1:${ServerState.port}"
        if (url == null || !(url == origin || url.startsWith("$origin/"))) return
        webView.evaluateJavascript(shim, null)
    }

    /** Resolve the Promise created by window.lh.pick*() for [callId]. */
    fun resolve(callId: String, json: JSONObject) {
        js("window.__lhNativeCb&&window.__lhNativeCb.resolve(${JSONObject.quote(callId)},${JSONObject.quote(json.toString())})")
    }

    fun progress(done: Long, total: Long) {
        js("window.__lhNativeCb&&window.__lhNativeCb.progress($done,$total)")
    }

    /** Ask the shim to fetch [url] (blob:, data: or same-origin) and save it. */
    fun saveUrl(url: String, name: String, mime: String?) {
        js("window.__lhNativeCb&&window.__lhNativeCb.saveUrl(${JSONObject.quote(url)},${JSONObject.quote(name)},${JSONObject.quote(mime ?: "")})")
    }

    private fun js(script: String) {
        activity.runOnUiThread { webView.evaluateJavascript(script, null) }
    }

    /** Runs on the WebView's JavaBridge thread, never the UI thread. */
    private inner class Native {
        private fun ok(t: String?) = t == token

        @JavascriptInterface
        fun pickFiles(t: String?, callId: String, optsJson: String) {
            if (!ok(t)) return
            imports.pickFiles(callId, extensionsOf(optsJson))
        }

        @JavascriptInterface
        fun pickFolder(t: String?, callId: String, optsJson: String) {
            if (!ok(t)) return
            imports.pickFolder(callId, extensionsOf(optsJson))
        }

        @JavascriptInterface
        fun releaseImport(t: String?, id: String) {
            if (!ok(t)) return
            imports.release(id)
        }

        @JavascriptInterface
        fun saveBegin(t: String?, name: String, mime: String): String? =
            if (ok(t)) downloads.begin(name, mime) else null

        @JavascriptInterface
        fun saveChunk(t: String?, id: String, b64: String): Boolean {
            if (!ok(t)) return false
            return try {
                downloads.write(id, Base64.decode(b64, Base64.DEFAULT))
            } catch (e: IllegalArgumentException) {
                Log.w(AppConfig.TAG, "bad save chunk", e)
                false
            }
        }

        @JavascriptInterface
        fun saveEnd(t: String?, id: String): String =
            if (ok(t)) downloads.finish(id).toString() else """{"ok":false,"error":"refused"}"""

        @JavascriptInterface
        fun saveAbort(t: String?, id: String) {
            if (ok(t)) downloads.abort(id)
        }
    }

    private fun extensionsOf(optsJson: String): Set<String> = try {
        val arr = JSONObject(optsJson).optJSONArray("extensions")
        buildSet {
            if (arr != null) for (i in 0 until arr.length()) {
                val e = arr.optString(i).trim().lowercase().removePrefix(".")
                if (e.isNotEmpty() && e.length <= 12 && e.all { it.isLetterOrDigit() }) add(e)
            }
        }
    } catch (_: Exception) {
        emptySet()
    }

    companion object {
        const val NAME = "__lhAndroidNative"
        private const val SHIM_ASSET = "lh-android-shim.js"
    }
}
