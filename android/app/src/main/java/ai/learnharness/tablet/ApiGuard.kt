package ai.learnharness.tablet

import android.webkit.CookieManager
import java.security.SecureRandom

/**
 * Per-process secret guarding the server's /api routes (see
 * src/server/desktop-access.ts). Any app on the device can connect to
 * 127.0.0.1, so only this app's WebView gets the cookie. A fresh secret is
 * generated on every process start; Node is started once per process, so the
 * secret and the server always match.
 */
object ApiGuard {
    const val ENV_NAME = "LH_ANDROID_API_SECRET"
    const val COOKIE_NAME = "lh_android"

    /** 48 random bytes as 96 hex chars (server requires >= 64). */
    val secret: String by lazy {
        val bytes = ByteArray(48).also { SecureRandom().nextBytes(it) }
        bytes.joinToString("") { "%02x".format(it) }
    }

    /** Sets the guard cookie for the loopback origin and flushes it; call before loadUrl. */
    fun installCookie(origin: String) {
        val cm = CookieManager.getInstance()
        cm.setAcceptCookie(true)
        cm.setCookie(origin, "$COOKIE_NAME=$secret; Path=/; HttpOnly; SameSite=Strict")
        cm.flush()
    }
}
