package ai.learnharness.tablet

import android.Manifest
import android.app.Activity
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Message
import android.webkit.PermissionRequest
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebView

/**
 * The app's single WebChromeClient. Features hook in here: file chooser
 * (FileChooser.kt), window.open / target=_blank (LhLinks.kt) and microphone
 * permission. Other steps add overrides to this class rather than creating a
 * second client.
 */
class LhChromeClient(
    private val activity: Activity,
    private val chooser: FileChooser,
    private val links: LhLinks,
) : WebChromeClient() {

    private var micRequest: PermissionRequest? = null

    // ---- file chooser ---------------------------------------------------------------

    override fun onShowFileChooser(
        webView: WebView, filePathCallback: ValueCallback<Array<Uri>>, fileChooserParams: FileChooserParams,
    ): Boolean = chooser.show(filePathCallback, fileChooserParams)

    // ---- windows / links ----------------------------------------------------------------

    override fun onCreateWindow(view: WebView, isDialog: Boolean, isUserGesture: Boolean, resultMsg: Message): Boolean =
        links.onCreateWindow(view, resultMsg)

    // ---- microphone (dictation: getUserMedia({audio})) -----------------------------------

    /** Audio capture for the loopback origin only; video and everything else is denied. */
    override fun onPermissionRequest(request: PermissionRequest) {
        val sameOrigin = links.isAppOrigin(request.origin)
        val wantsAudio = request.resources.contains(PermissionRequest.RESOURCE_AUDIO_CAPTURE)
        val onlyAudio = request.resources.all { it == PermissionRequest.RESOURCE_AUDIO_CAPTURE }
        if (!sameOrigin || !wantsAudio || !onlyAudio) {
            request.deny()
            return
        }
        if (activity.checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
            request.grant(arrayOf(PermissionRequest.RESOURCE_AUDIO_CAPTURE))
            return
        }
        micRequest?.deny()
        micRequest = request
        activity.requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO), REQ_MIC)
    }

    override fun onPermissionRequestCanceled(request: PermissionRequest) {
        if (micRequest === request) micRequest = null
    }

    /** Called from MainActivity.onRequestPermissionsResult; returns true when consumed. */
    fun onRequestPermissionsResult(requestCode: Int, grantResults: IntArray): Boolean {
        if (requestCode != REQ_MIC) return false
        val request = micRequest
        micRequest = null
        if (request != null) {
            if (grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED) {
                request.grant(arrayOf(PermissionRequest.RESOURCE_AUDIO_CAPTURE))
            } else {
                request.deny()
            }
        }
        return true
    }

    companion object {
        const val REQ_MIC = 41004
    }
}
