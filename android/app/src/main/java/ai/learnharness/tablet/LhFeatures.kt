package ai.learnharness.tablet

import android.app.Activity
import android.content.Intent
import android.graphics.Bitmap
import android.net.Uri
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView

/**
 * Step 6 wiring (files, folders, links, downloads, microphone). MainActivity
 * creates one of these per WebView and forwards a handful of callbacks:
 *
 *   features = LhFeatures(this, wv)                      // configureWebView
 *   features.onPageStarted(url) / onPageFinished(url)    // WebViewClient
 *   features.shouldInterceptRequest(request)             // WebViewClient
 *   features.openExternal(uri)                           // shouldOverrideUrlLoading
 *   features.onActivityResult / onRequestPermissionsResult / destroy
 */
class LhFeatures(private val activity: Activity, private val webView: WebView) {

    private val links = LhLinks(activity)
    private val chooser = FileChooser(activity)
    private val chrome = LhChromeClient(activity, chooser, links)
    private var jsBridge: LhJsBridge? = null
    private val imports = LhImports(activity) { jsBridge }
    private val downloads = LhDownloads(activity) { jsBridge }

    init {
        webView.settings.apply {
            // target=_blank and window.open reach LhLinks.onCreateWindow.
            setSupportMultipleWindows(true)
            javaScriptCanOpenWindowsAutomatically = true
        }
        webView.webChromeClient = chrome
        webView.setDownloadListener(downloads)
        jsBridge = LhJsBridge(activity, webView, imports, downloads).also { it.install() }
    }

    fun onPageStarted(url: String?, @Suppress("UNUSED_PARAMETER") favicon: Bitmap? = null) {
        jsBridge?.injectShim(url)
    }

    fun onPageFinished(url: String?) {
        jsBridge?.injectShim(url)
    }

    /** Serves imported-folder files to the page; null for everything else. */
    fun shouldInterceptRequest(request: WebResourceRequest): WebResourceResponse? {
        if (!links.isAppOrigin(request.url) || request.method != "GET") return null
        return imports.intercept(request.url)
    }

    fun openExternal(uri: Uri) = links.openExternal(uri)

    fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?): Boolean =
        chooser.onActivityResult(requestCode, resultCode, data) || imports.onActivityResult(requestCode, resultCode, data)

    fun onRequestPermissionsResult(requestCode: Int, grantResults: IntArray): Boolean =
        chrome.onRequestPermissionsResult(requestCode, grantResults)

    fun destroy() {
        chooser.cancel()
        links.destroy()
    }
}
