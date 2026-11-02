package ai.learnharness.tablet

object AppConfig {
    /**
     * Minimum Chromium (system WebView) major version. Next 16 / React 19 output
     * needs roughly Chromium 111 (CSS cascade layers, color-mix, etc). Raise or
     * lower this ONE constant if testing shows a different floor.
     */
    const val MIN_WEBVIEW_MAJOR = 111

    /** Give up waiting for the server after this long (first launch extracts ~200 MB). */
    const val STARTUP_TIMEOUT_MS = 240_000L

    const val POLL_INTERVAL_MS = 500L

    /** User-agent token appended to the WebView UA; later steps key off it. */
    const val UA_TOKEN = "LearnHarnessAndroid"

    const val TAG = "LH"
}
