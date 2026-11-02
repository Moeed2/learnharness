package ai.learnharness.tablet

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.util.Log
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URI
import java.net.URL

/**
 * ChatGPT sign-in (step 3). Native half of window.lh.openSubscriptionBrowser,
 * mirroring electron/web-subscription-browser.cjs: POST the one-use action to
 * the local server (guard cookie + same-origin headers), read the 303 Location
 * WITHOUT following it, require https://auth.openai.com, then open it in a
 * Custom Tab (or the default browser when no provider supports tabs).
 *
 * The OAuth redirect goes to http://127.0.0.1:<port>/auth/callback inside the
 * Node process (kept alive by [NodeService]); that page links back to the app
 * through learnharness://auth-done, which [MainActivity] handles.
 */
class LhSignIn(private val activity: Activity) {

    /** Runs the POST on a worker thread; [done] is called with the JSON reply on any thread. */
    fun open(action: String, done: (JSONObject) -> Unit) {
        Thread({
            try {
                val target = resolve(action)
                activity.runOnUiThread { launch(target, done) }
            } catch (e: Exception) {
                Log.w(AppConfig.TAG, "sign-in action failed", e)
                done(JSONObject().put("ok", false).put("error", e.message ?: "Sign-in action failed."))
            }
        }, "lh-signin").start()
    }

    private fun resolve(action: String): Uri {
        if (!ACTION_RE.matches(action)) throw IllegalArgumentException("Invalid sign-in action.")
        val port = ServerState.port
        if (port <= 0) throw IllegalStateException("The local server is not ready.")
        val origin = "http://127.0.0.1:$port"
        val c = URL(origin + action).openConnection() as HttpURLConnection
        try {
            c.requestMethod = "POST"
            c.instanceFollowRedirects = false
            c.connectTimeout = 5000
            c.readTimeout = 15000
            c.doOutput = false
            c.setRequestProperty("Origin", origin)
            c.setRequestProperty("x-learnharness-subscriptions", "1")
            c.setRequestProperty("Cookie", "${ApiGuard.COOKIE_NAME}=${ApiGuard.secret}")
            val location = c.getHeaderField("Location")
            if (c.responseCode != 303 || location.isNullOrEmpty()) throw IllegalStateException("Sign-in action expired.")
            return validateProviderUrl(location) ?: throw IllegalStateException("Invalid provider page.")
        } finally {
            c.disconnect()
        }
    }

    private fun launch(target: Uri, done: (JSONObject) -> Unit) {
        val intent = Intent(Intent.ACTION_VIEW, target).addCategory(Intent.CATEGORY_BROWSABLE)
        // A Custom Tab is a plain VIEW intent carrying a null session binder (what
        // androidx.browser's CustomTabsIntent builds), so no extra dependency is
        // needed; browsers without tab support just open the page normally.
        // No NEW_TASK: the tab stays in our task and learnharness://auth-done closes it.
        intent.putExtras(Bundle().apply { putBinder(EXTRA_SESSION, null) })
        try {
            activity.startActivity(intent)
            done(JSONObject().put("ok", true))
        } catch (_: ActivityNotFoundException) {
            try {
                activity.startActivity(Intent(Intent.ACTION_VIEW, target).addCategory(Intent.CATEGORY_BROWSABLE).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                done(JSONObject().put("ok", true))
            } catch (e: ActivityNotFoundException) {
                done(JSONObject().put("ok", false).put("error", "No browser is available to open the sign-in page."))
            }
        }
    }

    companion object {
        private const val EXTRA_SESSION = "android.support.customtabs.extra.SESSION"
        private val ACTION_RE = Regex("^/api/subscriptions/browser\\?id=[0-9a-f-]{36}$")

        /** Only https://auth.openai.com[:443] pages without credentials; null otherwise. */
        fun validateProviderUrl(location: String): Uri? = try {
            val u = URI(location)
            val ok = u.scheme == "https" && u.host == "auth.openai.com" && (u.port == -1 || u.port == 443) && u.rawUserInfo == null
            if (ok) Uri.parse(location) else null
        } catch (_: Exception) {
            null
        }
    }
}
