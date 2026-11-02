package ai.learnharness.tablet

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.Matrix
import android.graphics.pdf.PdfRenderer
import android.os.ParcelFileDescriptor
import android.util.Base64
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.IOException
import kotlin.math.ceil
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sqrt

/** Failure the Node client should surface as-is. code: "encrypted" | "invalid" | "bad_request". */
class PdfRenderException(val code: String, message: String) : Exception(message)

/**
 * PDF page rasterisation with android.graphics.pdf.PdfRenderer (used by the
 * render service's POST /pdf). The geometry limits mirror pdfCanvasGeometry in
 * src/agent/subagents/headless.ts so both back ends bound memory identically.
 */
object PdfPageRenderer {
    private const val MAX_PIXELS = 16_000_000.0
    private const val MAX_SIDE = 8192.0

    /**
     * Request: {pdfBase64 | path, pages: [1-based ints], dpi = 150}.
     * `path` must live inside the app's files/cache dirs.
     * Response: {numPages, pages: [{page, width, height, png (base64)}]}.
     */
    fun render(context: Context, j: JSONObject): JSONObject {
        val dpi = j.optDouble("dpi", 150.0)
        if (!dpi.isFinite() || dpi <= 0) throw PdfRenderException("bad_request", "dpi must be positive")
        val pagesJson = j.optJSONArray("pages") ?: JSONArray()
        val wanted = ArrayList<Int>()
        for (i in 0 until min(pagesJson.length(), 200)) wanted.add(pagesJson.optInt(i, 0))

        var temp: File? = null
        try {
            val file: File
            if (j.has("pdfBase64")) {
                val bytes = try {
                    Base64.decode(j.getString("pdfBase64"), Base64.DEFAULT)
                } catch (e: IllegalArgumentException) {
                    throw PdfRenderException("bad_request", "pdfBase64 is not valid base64")
                }
                temp = File.createTempFile("lh-pdf-", ".pdf", context.cacheDir)
                temp.writeBytes(bytes)
                file = temp
            } else if (j.has("path")) {
                file = File(j.getString("path")).canonicalFile
                if (!allowedRoots(context).any { file.path.startsWith(it.path + File.separator) }) {
                    throw PdfRenderException("bad_request", "path is outside the app's storage")
                }
                if (!file.isFile) throw PdfRenderException("invalid", "PDF file not found")
            } else {
                throw PdfRenderException("bad_request", "pdfBase64 or path required")
            }
            return renderFile(file, wanted, dpi)
        } finally {
            temp?.delete()
        }
    }

    private fun allowedRoots(context: Context): List<File> {
        val roots = ArrayList<File>()
        roots.add(context.filesDir.canonicalFile)
        roots.add(context.cacheDir.canonicalFile)
        context.getExternalFilesDir(null)?.let { roots.add(it.canonicalFile) }
        return roots
    }

    private fun renderFile(file: File, wanted: List<Int>, dpi: Double): JSONObject {
        val pfd = try {
            ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY)
        } catch (e: IOException) {
            throw PdfRenderException("invalid", "cannot open PDF: ${e.message}")
        }
        val renderer = try {
            PdfRenderer(pfd)
        } catch (e: SecurityException) { // password-protected
            pfd.close()
            throw PdfRenderException("encrypted", "PDF is password protected")
        } catch (e: IOException) { // corrupt / not a PDF
            pfd.close()
            throw PdfRenderException("invalid", "not a readable PDF")
        } catch (e: IllegalArgumentException) {
            pfd.close()
            throw PdfRenderException("invalid", "not a readable PDF")
        }
        try {
            val out = JSONArray()
            for (n in wanted) {
                if (n < 1 || n > renderer.pageCount) continue
                renderer.openPage(n - 1).use { page ->
                    val (scale, w, h) = geometry(page.width.toDouble(), page.height.toDouble(), dpi)
                    val bmp = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
                    try {
                        bmp.eraseColor(Color.WHITE)
                        val m = Matrix().apply { setScale(scale.toFloat(), scale.toFloat()) }
                        page.render(bmp, null, m, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY)
                        val baos = ByteArrayOutputStream()
                        bmp.compress(Bitmap.CompressFormat.PNG, 100, baos)
                        out.put(
                            JSONObject().put("page", n).put("width", w).put("height", h)
                                .put("png", Base64.encodeToString(baos.toByteArray(), Base64.NO_WRAP)),
                        )
                    } finally {
                        bmp.recycle()
                    }
                }
            }
            return JSONObject().put("numPages", renderer.pageCount).put("pages", out)
        } finally {
            renderer.close()
        }
    }

    private fun geometry(bw: Double, bh: Double, dpi: Double): Triple<Double, Int, Int> {
        if (bw <= 0 || bh <= 0) throw PdfRenderException("invalid", "PDF page has no size")
        var scale = min(dpi / 72.0, min(MAX_SIDE / bw, MAX_SIDE / bh))
        val area = bw * scale * bh * scale
        if (area > MAX_PIXELS) scale *= sqrt(MAX_PIXELS / area)
        fun dims(s: Double) = Pair(max(1, ceil(bw * s).toInt()), max(1, ceil(bh * s).toInt()))
        fun fits(d: Pair<Int, Int>) =
            d.first <= MAX_SIDE && d.second <= MAX_SIDE && d.first.toDouble() * d.second <= MAX_PIXELS
        while (!fits(dims(scale))) scale *= 0.999
        val d = dims(scale)
        return Triple(scale, d.first, d.second)
    }
}
