package ai.learnharness.tablet

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.util.Log
import android.webkit.MimeTypeMap
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.widget.Toast

/**
 * WebChromeClient.onShowFileChooser: every existing `<input type=file>` opens
 * the system document picker (ACTION_OPEN_DOCUMENT). The Activity result APIs
 * need androidx.activity, which MainActivity (a plain Activity) does not use,
 * so this uses startActivityForResult with a private request code.
 *
 * `webkitdirectory` inputs cannot work in a WebView (Chromium Android shows a
 * plain file picker); the UI uses window.lh.pickFolder() instead (LhImports).
 */
class FileChooser(private val activity: Activity) {

    private var callback: ValueCallback<Array<Uri>>? = null

    fun show(callback: ValueCallback<Array<Uri>>, params: WebChromeClient.FileChooserParams): Boolean {
        // A new request supersedes any unanswered one; the callback MUST be answered.
        this.callback?.onReceiveValue(null)
        this.callback = callback

        val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE)
        if (params.mode == WebChromeClient.FileChooserParams.MODE_OPEN_MULTIPLE) {
            intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
        }
        val mimes = mimeTypes(params.acceptTypes)
        if (mimes.size == 1) {
            intent.type = mimes[0]
        } else {
            intent.type = "*/*"
            if (mimes.size > 1) intent.putExtra(Intent.EXTRA_MIME_TYPES, mimes.toTypedArray())
        }
        return try {
            activity.startActivityForResult(intent, REQ_CHOOSER)
            true
        } catch (e: Exception) {
            Log.w(AppConfig.TAG, "no document picker", e)
            this.callback = null
            callback.onReceiveValue(null)
            Toast.makeText(activity, "No file picker is available", Toast.LENGTH_LONG).show()
            true
        }
    }

    /** Called from MainActivity.onActivityResult; returns true when consumed. */
    fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?): Boolean {
        if (requestCode != REQ_CHOOSER) return false
        val cb = callback
        callback = null
        val result = if (resultCode == Activity.RESULT_OK && data != null) {
            WebChromeClient.FileChooserParams.parseResult(resultCode, data)
        } else {
            null
        }
        cb?.onReceiveValue(result)
        return true
    }

    /** Answer a pending chooser with "cancelled" (activity going away). */
    fun cancel() {
        callback?.onReceiveValue(null)
        callback = null
    }

    companion object {
        const val REQ_CHOOSER = 41001

        /**
         * accept="" entries are MIME types ("image/*") or extensions (".md").
         * DocumentsUI filters by MIME only, and ".md" has no registered type, so
         * any unmappable entry widens the filter to everything (wide but correct).
         */
        fun mimeTypes(accept: Array<String>?): List<String> {
            val entries = accept.orEmpty().flatMap { it.split(',') }.map { it.trim().lowercase() }.filter { it.isNotEmpty() }
            if (entries.isEmpty()) return emptyList()
            val out = LinkedHashSet<String>()
            for (e in entries) {
                if (e.contains('/')) {
                    out.add(e)
                } else {
                    val mime = MimeTypeMap.getSingleton().getMimeTypeFromExtension(e.removePrefix(".")) ?: return emptyList()
                    out.add(mime)
                }
            }
            return out.toList()
        }
    }
}
