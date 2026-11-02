package ai.learnharness.tablet

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Typeface
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.Process
import android.util.Log
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.WindowInsets
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.ScrollView
import android.widget.TextView
import java.net.HttpURLConnection
import java.net.URL

/**
 * Single full-screen activity: native loading / error screens, then one
 * long-lived WebView pointed at the loopback server. Rotation is handled via
 * configChanges so the WebView (and its page state) is never recreated.
 */
class MainActivity : Activity() {

    private enum class Screen { LOADING, ERROR, WEBVIEW_OLD, WEB }

    private val ui = Handler(Looper.getMainLooper())
    private lateinit var root: FrameLayout
    private lateinit var overlay: LinearLayout
    private lateinit var title: TextView
    private lateinit var message: TextView
    private lateinit var logView: TextView
    private lateinit var logScroll: ScrollView
    private lateinit var progress: ProgressBar
    private lateinit var primaryButton: Button
    private lateinit var secondaryButton: Button
    private var webView: WebView? = null

    private var screen = Screen.LOADING
    private var primaryAction: () -> Unit = {}
    @Volatile private var polling = false
    @Volatile private var webLoaded = false
    private var pollThread: Thread? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        buildUi()

        if (Build.VERSION.SDK_INT >= 33 &&
            checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 1)
        }

        val old = webViewTooOld()
        if (old != null) {
            showWebViewTooOld(old)
        } else {
            begin()
        }
    }

    // ---- start-up flow ------------------------------------------------------

    private fun begin() {
        showLoading("Starting LearnHarness...")
        startForegroundService(Intent(this, NodeService::class.java))
        startPolling()
    }

    private fun startPolling() {
        if (polling) return
        polling = true
        val deadline = System.currentTimeMillis() + AppConfig.STARTUP_TIMEOUT_MS
        pollThread = Thread({ pollLoop(deadline) }, "lh-poll").also { it.start() }
    }

    private fun pollLoop(deadline: Long) {
        var lastShown = ""
        while (polling) {
            val phase = ServerState.phase
            if (phase == ServerState.Phase.FAILED) {
                polling = false
                ui.post { showError("The local server stopped", ServerState.error ?: "Unknown error", restart = true) }
                return
            }
            val port = ServerState.port
            if (phase == ServerState.Phase.RUNNING && port > 0 && httpOk(port)) {
                polling = false
                ui.post { loadWeb(port) }
                return
            }
            if (System.currentTimeMillis() > deadline) {
                polling = false
                val stuck = ServerState.phase != ServerState.Phase.RUNNING
                ui.post { showError("The local server did not start in time", "Timed out waiting for 127.0.0.1:$port", restart = stuck) }
                return
            }
            val text = ServerState.detail
            if (text != lastShown) {
                lastShown = text
                ui.post { if (screen == Screen.LOADING) message.text = text }
            }
            ui.post { if (screen == Screen.LOADING) setLog(ServerState.tail(6)) }
            try {
                Thread.sleep(AppConfig.POLL_INTERVAL_MS)
            } catch (_: InterruptedException) {
                return
            }
        }
    }

    private fun httpOk(port: Int): Boolean = try {
        val c = URL("http://127.0.0.1:$port/").openConnection() as HttpURLConnection
        c.connectTimeout = 1500
        c.readTimeout = 20_000
        c.instanceFollowRedirects = true
        try { c.responseCode == 200 } finally { c.disconnect() }
    } catch (_: Exception) {
        false
    }

    // ---- WebView ------------------------------------------------------------

    private fun loadWeb(port: Int) {
        val origin = "http://127.0.0.1:$port"
        val wv: WebView = webView ?: createWebView(origin) ?: return
        if (wv.parent == null) {
            root.addView(wv, 0, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        }
        wv.loadUrl("$origin/")
    }

    private fun createWebView(origin: String): WebView? {
        val wv = try {
            WebView(this)
        } catch (t: Throwable) {
            showError("The system WebView is unavailable", "${t.javaClass.simpleName}: ${t.message}", restart = false)
            return null
        }
        webView = wv
        configureWebView(wv, origin)
        return wv
    }

    private fun configureWebView(wv: WebView, origin: String) {
        wv.visibility = View.INVISIBLE
        val s = wv.settings
        s.javaScriptEnabled = true
        s.domStorageEnabled = true
        s.mediaPlaybackRequiresUserGesture = false
        s.allowFileAccess = false
        s.allowContentAccess = false
        s.mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
        s.userAgentString = s.userAgentString + " ${AppConfig.UA_TOKEN}/${BuildConfig.VERSION_NAME}"
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)

        wv.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val uri = request.url
                val sameOrigin = uri.scheme == "http" && uri.host == "127.0.0.1" && uri.port == ServerState.port
                if (sameOrigin) return false
                // Anything else (docs, sign-in pages) opens in the system browser.
                try {
                    startActivity(Intent(Intent.ACTION_VIEW, uri).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                } catch (t: Exception) {
                    Log.w(AppConfig.TAG, "no handler for $uri", t)
                }
                return true
            }

            override fun onPageFinished(view: WebView, url: String) {
                if (url.startsWith(origin)) {
                    webLoaded = true
                    Log.i(AppConfig.TAG, "LH_WEBVIEW_LOADED $url")
                    showWeb()
                }
            }
        }
    }

    private fun showWeb() {
        screen = Screen.WEB
        overlay.visibility = View.GONE
        webView?.visibility = View.VISIBLE
        webView?.requestFocus()
    }

    // Back = WebView back; with no history, background the task to keep the server warm.
    @Suppress("OVERRIDE_DEPRECATION")
    override fun onBackPressed() {
        val wv = webView
        if (screen == Screen.WEB && wv != null && wv.canGoBack()) {
            wv.goBack()
        } else {
            moveTaskToBack(true)
        }
    }

    override fun onResume() {
        super.onResume()
        RenderHost.attach(window.decorView as ViewGroup) // step 5: window for offscreen render WebViews
        webView?.onResume()
        val port = ServerState.port
        if (screen == Screen.WEB && port > 0) {
            Thread {
                if (!httpOk(port)) {
                    ui.post { showError("The local server stopped", ServerState.error ?: "The server no longer answers.", restart = true) }
                }
            }.start()
        }
    }

    override fun onPause() {
        RenderHost.detach(window.decorView as ViewGroup)
        webView?.onPause()
        super.onPause()
    }

    override fun onDestroy() {
        polling = false
        pollThread?.interrupt()
        webView?.let { (it.parent as? ViewGroup)?.removeView(it); it.destroy() }
        super.onDestroy()
    }

    // ---- WebView version gate ------------------------------------------------

    /** Returns a description of the WebView if its Chromium major is below the minimum, else null. */
    private fun webViewTooOld(): String? {
        val pkg = try {
            WebView.getCurrentWebViewPackage()
        } catch (_: Throwable) {
            null
        }
        if (pkg == null) return null
        val version = pkg.versionName ?: return null
        val major = Regex("\\d+").find(version)?.value?.toIntOrNull() ?: return null
        Log.i(AppConfig.TAG, "WebView ${pkg.packageName} $version (major $major, min ${AppConfig.MIN_WEBVIEW_MAJOR})")
        return if (major < AppConfig.MIN_WEBVIEW_MAJOR) "${pkg.packageName} $version" else null
    }

    private fun showWebViewTooOld(current: String) {
        screen = Screen.WEBVIEW_OLD
        showPanel(
            "System WebView needs an update",
            "LearnHarness needs Android System WebView (Chromium) ${AppConfig.MIN_WEBVIEW_MAJOR} or newer to " +
                "display its interface.\n\nInstalled: $current\n\nUpdate \"Android System WebView\" (or Chrome / " +
                "your device's browser engine) from your app store or system updater, then reopen LearnHarness.",
            spinner = false, log = "",
        )
        primaryButton.text = "Try anyway"
        primaryButton.visibility = View.VISIBLE
        primaryAction = { begin() }
        secondaryButton.visibility = View.GONE
    }

    // ---- native screens -------------------------------------------------------

    private fun showLoading(text: String) {
        screen = Screen.LOADING
        webView?.visibility = View.INVISIBLE
        showPanel("LearnHarness", text, spinner = true, log = ServerState.tail(6))
        primaryButton.visibility = View.GONE
        secondaryButton.visibility = View.GONE
    }

    private fun showError(heading: String, detail: String, restart: Boolean) {
        screen = Screen.ERROR
        webView?.visibility = View.INVISIBLE
        showPanel(heading, detail, spinner = false, log = ServerState.tail(25))
        primaryButton.visibility = View.VISIBLE
        if (restart) {
            primaryButton.text = "Restart app"
            primaryAction = { restartProcess() }
            secondaryButton.visibility = View.GONE
        } else {
            primaryButton.text = "Keep waiting"
            primaryAction = { showLoading("Waiting for the local server..."); startPolling() }
            secondaryButton.text = "Restart app"
            secondaryButton.visibility = View.VISIBLE
        }
    }

    private fun showPanel(heading: String, text: String, spinner: Boolean, log: String) {
        overlay.visibility = View.VISIBLE
        title.text = heading
        message.text = text
        progress.visibility = if (spinner) View.VISIBLE else View.GONE
        setLog(log)
    }

    private fun setLog(text: String) {
        logScroll.visibility = if (text.isBlank()) View.GONE else View.VISIBLE
        logView.text = text
        logScroll.post { logScroll.fullScroll(View.FOCUS_DOWN) }
    }

    /** Node cannot be restarted in-process, so a restart means a new process. */
    private fun restartProcess() {
        val launch = packageManager.getLaunchIntentForPackage(packageName)
        stopService(Intent(this, NodeService::class.java))
        if (launch != null) {
            startActivity(launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK))
        }
        Process.killProcess(Process.myPid())
    }

    private fun dp(v: Int): Int =
        TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v.toFloat(), resources.displayMetrics).toInt()

    private fun buildUi() {
        root = FrameLayout(this)
        // Android 15 (targetSdk 35) draws edge-to-edge: keep content inside the system bars.
        root.setOnApplyWindowInsetsListener { v, insets ->
            if (Build.VERSION.SDK_INT >= 30) {
                val b = insets.getInsets(WindowInsets.Type.systemBars() or WindowInsets.Type.displayCutout() or WindowInsets.Type.ime())
                v.setPadding(b.left, b.top, b.right, b.bottom)
            } else {
                @Suppress("DEPRECATION")
                v.setPadding(insets.systemWindowInsetLeft, insets.systemWindowInsetTop, insets.systemWindowInsetRight, insets.systemWindowInsetBottom)
            }
            insets
        }

        overlay = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_HORIZONTAL
            setPadding(dp(32), dp(32), dp(32), dp(32))
        }
        title = TextView(this).apply {
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 26f)
            setTypeface(typeface, Typeface.BOLD)
            gravity = Gravity.CENTER
        }
        message = TextView(this).apply {
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 16f)
            gravity = Gravity.CENTER
            setPadding(0, dp(12), 0, dp(12))
        }
        progress = ProgressBar(this).apply { isIndeterminate = true }
        logView = TextView(this).apply {
            typeface = Typeface.MONOSPACE
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 11f)
            setTextIsSelectable(true)
        }
        logScroll = ScrollView(this).apply { addView(logView) }
        primaryButton = Button(this).apply { setOnClickListener { primaryAction() } }
        secondaryButton = Button(this).apply { setOnClickListener { restartProcess() } }

        val wide = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
        val log = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f)
        overlay.addView(title, wide)
        overlay.addView(message, wide)
        overlay.addView(progress, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        overlay.addView(primaryButton, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        overlay.addView(secondaryButton, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        overlay.addView(logScroll, log)

        root.addView(overlay, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        setContentView(root)
    }
}
