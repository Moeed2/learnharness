package ai.learnharness.tablet

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Intent
import android.graphics.Bitmap
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.os.Message
import android.util.Log
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast

/**
 * External links. Anything that is not the loopback server opens in the system
 * browser (ACTION_VIEW). Only http(s), mailto and tel are launched; blob:,
 * data:, javascript: and file: are never handed to other apps.
 */
class LhLinks(private val activity: Activity) {

    private val ui = Handler(Looper.getMainLooper())
    private val popups = HashSet<WebView>()

    fun isAppOrigin(uri: Uri): Boolean =
        uri.scheme == "http" && uri.host == "127.0.0.1" && uri.port == ServerState.port

    fun openExternal(uri: Uri) {
        if (uri.scheme !in EXTERNAL_SCHEMES) {
            Log.i(AppConfig.TAG, "blocked external scheme: ${uri.scheme}")
            return
        }
        try {
            activity.startActivity(Intent(Intent.ACTION_VIEW, uri).addCategory(Intent.CATEGORY_BROWSABLE).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        } catch (e: ActivityNotFoundException) {
            Log.w(AppConfig.TAG, "no handler for $uri", e)
            Toast.makeText(activity, "No app can open this link", Toast.LENGTH_SHORT).show()
        }
    }

    /**
     * window.open / target=_blank. The popup is a throw-away, never-attached
     * WebView whose only job is to learn the destination: window.open("about:blank")
     * followed by `tab.location.href = url` (the sign-in flow) is covered too.
     */
    fun onCreateWindow(parent: WebView, resultMsg: Message): Boolean {
        val transport = resultMsg.obj as? WebView.WebViewTransport ?: return false
        val popup = WebView(activity)
        popups.add(popup)
        var done = false
        fun handle(url: String?) {
            if (done || url.isNullOrEmpty() || url == "about:blank") return
            done = true
            val uri = Uri.parse(url)
            // Same-origin pages (not API endpoints) stay in the app; the rest leaves it.
            if (isAppOrigin(uri) && uri.path?.startsWith("/api/") != true) parent.loadUrl(url) else openExternal(uri)
            ui.post { dispose(popup) }
        }
        popup.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                handle(request.url.toString())
                return true
            }

            override fun onPageStarted(view: WebView, url: String?, favicon: Bitmap?) {
                handle(url)
            }
        }
        transport.webView = popup
        resultMsg.sendToTarget()
        ui.postDelayed({ dispose(popup) }, POPUP_TTL_MS)
        return true
    }

    private fun dispose(popup: WebView) {
        if (!popups.remove(popup)) return
        popup.stopLoading()
        popup.destroy()
    }

    fun destroy() {
        popups.toList().forEach { dispose(it) }
    }

    companion object {
        private val EXTERNAL_SCHEMES = setOf("http", "https", "mailto", "tel")
        private const val POPUP_TTL_MS = 60_000L
    }
}
