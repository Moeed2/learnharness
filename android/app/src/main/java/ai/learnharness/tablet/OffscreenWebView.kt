package ai.learnharness.tablet

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.os.Handler
import android.os.Looper
import android.util.Base64
import android.view.View
import android.view.ViewGroup
import android.webkit.ConsoleMessage
import android.webkit.JavascriptInterface
import android.webkit.JsPromptResult
import android.webkit.JsResult
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import org.json.JSONArray
import org.json.JSONObject
import org.json.JSONTokener
import java.io.ByteArrayOutputStream
import java.lang.ref.WeakReference
import java.util.concurrent.CompletableFuture
import java.util.concurrent.atomic.AtomicBoolean

/** Gives offscreen WebViews a window to live in while the UI is visible. */
object RenderHost {
    private var ref: WeakReference<ViewGroup>? = null

    /** Call from Activity.onResume with window.decorView as ViewGroup. */
    fun attach(root: ViewGroup) { ref = WeakReference(root) }

    /** Call from Activity.onPause. */
    fun detach(root: ViewGroup) { if (ref?.get() === root) ref = null }

    fun root(): ViewGroup? = ref?.get()
}

/** Result of a demo run; field names match DemoRunResult in headless.ts. */
class DemoOutcome {
    val consoleErrors = ArrayList<String>()
    val pageErrors = ArrayList<String>()
    val failedRequests = ArrayList<String>()
    var probed = false
    var probeJson: String? = null // raw JSON text of the probe value
    var screenshotPng: ByteArray? = null

    fun toJson(): JSONObject {
        val o = JSONObject()
        o.put("consoleErrors", JSONArray(consoleErrors))
        o.put("pageErrors", JSONArray(pageErrors))
        o.put("failedRequests", JSONArray(failedRequests))
        val pj = probeJson
        if (probed && pj != null) o.put("probeResult", JSONTokener(pj).nextValue())
        o.put("ok", consoleErrors.isEmpty() && pageErrors.isEmpty() && failedRequests.isEmpty())
        screenshotPng?.let { o.put("screenshotPng", Base64.encodeToString(it, Base64.NO_WRAP)) }
        return o
    }
}

/**
 * One throwaway WebView with a real fixed layout size, driven entirely on the
 * main thread. Always destroyed when finished (success, error or timeout).
 * Create and call it from the main thread only.
 */
class OffscreenWebView(
    private val context: Context,
    private val width: Int,
    private val height: Int,
) {
    private val main = Handler(Looper.getMainLooper())
    private var webView: WebView? = null
    private var holder: FrameLayout? = null
    private var done = false

    private fun <T : Any> start(
        future: CompletableFuture<T>,
        timeoutMs: Long,
        body: (finish: (T) -> Unit, fail: (Throwable) -> Unit) -> Unit,
    ) {
        val finish: (T) -> Unit = { v -> if (!done) { done = true; future.complete(v); destroy() } }
        val fail: (Throwable) -> Unit = { t -> if (!done) { done = true; future.completeExceptionally(t); destroy() } }
        main.postDelayed({ fail(RuntimeException("render timed out after ${timeoutMs}ms")) }, timeoutMs)
        try {
            create()
            body(finish, fail)
        } catch (t: Throwable) {
            fail(t)
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun create() {
        val density = context.resources.displayMetrics.density
        val pxW = (width * density).toInt().coerceAtLeast(1)
        val pxH = (height * density).toInt().coerceAtLeast(1)
        val wv = WebView(context)
        wv.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            mediaPlaybackRequiresUserGesture = false
            allowFileAccess = false
            allowContentAccess = false
            mixedContentMode = WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE
            userAgentString = userAgentString + " LearnHarnessRender/1"
        }
        wv.setBackgroundColor(Color.WHITE)
        // Real layout: CSS viewport == requested width x height.
        wv.measure(
            View.MeasureSpec.makeMeasureSpec(pxW, View.MeasureSpec.EXACTLY),
            View.MeasureSpec.makeMeasureSpec(pxH, View.MeasureSpec.EXACTLY),
        )
        wv.layout(0, 0, pxW, pxH)
        // Behind the real UI and nearly transparent, so Chromium keeps compositing.
        RenderHost.root()?.let { root ->
            val box = FrameLayout(context)
            box.alpha = 0.01f
            box.addView(wv, FrameLayout.LayoutParams(pxW, pxH))
            root.addView(box, 0, ViewGroup.LayoutParams(pxW, pxH))
            holder = box
        }
        webView = wv
    }

    private fun destroy() {
        main.removeCallbacksAndMessages(null)
        val wv = webView ?: return
        webView = null
        try {
            wv.stopLoading()
            wv.webViewClient = WebViewClient()
            wv.webChromeClient = null
            holder?.let { (it.parent as? ViewGroup)?.removeView(it); it.removeAllViews() }
            (wv.parent as? ViewGroup)?.removeView(wv)
            wv.removeJavascriptInterface("__lh")
            wv.destroy()
        } catch (_: Throwable) {
        }
        holder = null
    }

    private fun screenshot(wv: WebView): ByteArray? = try {
        val w = wv.width.coerceAtLeast(1)
        val h = wv.height.coerceAtLeast(1)
        val bmp = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
        bmp.eraseColor(Color.WHITE)
        wv.draw(Canvas(bmp))
        val out = ByteArrayOutputStream()
        bmp.compress(Bitmap.CompressFormat.PNG, 100, out)
        bmp.recycle()
        out.toByteArray()
    } catch (_: Throwable) {
        null
    }

    /** Executes a demo page and gathers errors. Main thread only. */
    fun runDemo(
        html: String?,
        url: String?,
        settleMs: Long,
        probe: String?,
        wantScreenshot: Boolean,
        future: CompletableFuture<DemoOutcome>,
    ) {
        start(future, 30_000L + settleMs + 15_000L) { finish, _ ->
            val wv = webView!!
            val out = DemoOutcome()
            var loaded = false

            fun conclude() {
                if (wantScreenshot) out.screenshotPng = screenshot(wv)
                finish(out)
            }

            fun runProbe() {
                if (probe.isNullOrEmpty()) { conclude(); return }
                out.probed = true
                val resolved = AtomicBoolean(false)
                wv.addJavascriptInterface(object {
                    @JavascriptInterface
                    fun ok(json: String) {
                        main.post { if (resolved.compareAndSet(false, true)) { out.probeJson = json; conclude() } }
                    }

                    @JavascriptInterface
                    fun err(msg: String) {
                        main.post { if (resolved.compareAndSet(false, true)) { out.pageErrors.add("probe failed: $msg"); conclude() } }
                    }
                }, "__lh")
                val script = "Promise.resolve().then(function(){return (0,eval)(${JSONObject.quote(probe)})})" +
                    ".then(function(v){__lh.ok(v===undefined?'null':JSON.stringify(v))}," +
                    "function(e){__lh.err(String(e&&e.message||e))})"
                wv.evaluateJavascript(script, null)
                main.postDelayed({
                    if (resolved.compareAndSet(false, true)) { out.pageErrors.add("probe failed: timed out"); conclude() }
                }, 10_000)
            }

            wv.webChromeClient = object : WebChromeClient() {
                override fun onConsoleMessage(m: ConsoleMessage): Boolean {
                    if (m.messageLevel() == ConsoleMessage.MessageLevel.ERROR) {
                        val text = m.message() ?: ""
                        // Chromium logs uncaught exceptions / rejections as "Uncaught ..." console
                        // errors; puppeteer reports those as pageerror, so route them the same way.
                        if (text.startsWith("Uncaught")) out.pageErrors.add(text) else out.consoleErrors.add(text)
                    }
                    return true
                }

                override fun onJsAlert(v: WebView?, u: String?, msg: String?, r: JsResult): Boolean { r.confirm(); return true }
                override fun onJsConfirm(v: WebView?, u: String?, msg: String?, r: JsResult): Boolean { r.cancel(); return true }
                override fun onJsPrompt(v: WebView?, u: String?, msg: String?, d: String?, r: JsPromptResult): Boolean { r.cancel(); return true }
            }
            wv.webViewClient = object : WebViewClient() {
                override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                    val u = request.url.toString()
                    if (u.startsWith("about:") || u.endsWith("/favicon.ico")) return
                    if (request.isForMainFrame && html != null) return
                    out.failedRequests.add("$u (${error.description})")
                }

                override fun onReceivedHttpError(view: WebView, request: WebResourceRequest, errorResponse: WebResourceResponse) {
                    val u = request.url.toString()
                    if (u.endsWith("/favicon.ico")) return
                    out.failedRequests.add("$u (HTTP ${errorResponse.statusCode})")
                }

                override fun onPageFinished(view: WebView, u: String?) {
                    if (loaded) return
                    loaded = true
                    main.postDelayed({ runProbe() }, settleMs)
                }
            }
            if (html != null) wv.loadDataWithBaseURL(DEMO_BASE_URL, html, "text/html", "utf-8", null)
            else wv.loadUrl(url!!)
        }
    }

    /** Rasterize an SVG document inside a plain white page. Main thread only. */
    fun renderSvg(svg: String, future: CompletableFuture<ByteArray>) {
        start(future, 30_000L) { finish, fail ->
            val wv = webView!!
            val page = "<!doctype html><html><head><meta charset=\"utf-8\"><style>" +
                "html,body{margin:0;padding:0;background:#fff}svg{display:block}</style></head><body>$svg</body></html>"
            var fired = false
            wv.webViewClient = object : WebViewClient() {
                override fun onPageFinished(view: WebView, u: String?) {
                    if (fired) return
                    fired = true
                    main.postDelayed({
                        val png = screenshot(wv)
                        if (png != null) finish(png) else fail(RuntimeException("screenshot failed"))
                    }, 150)
                }
            }
            wv.loadDataWithBaseURL(DEMO_BASE_URL, page, "text/html", "utf-8", null)
        }
    }

    companion object {
        const val DEMO_BASE_URL = "https://learnharness-demo.invalid/"
    }
}
