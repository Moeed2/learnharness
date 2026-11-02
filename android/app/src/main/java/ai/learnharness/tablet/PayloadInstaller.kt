package ai.learnharness.tablet

import android.content.Context
import android.content.res.AssetManager
import java.io.BufferedInputStream
import java.io.File
import java.io.FileOutputStream
import java.util.zip.ZipInputStream

/**
 * Extracts assets/server.zip into filesDir/server when its payload-version.txt
 * (always the FIRST zip entry, see scripts/android/build-payload.mjs) differs
 * from the installed one. Extracts to a temp dir, then swaps by rename.
 */
object PayloadInstaller {
    private const val ASSET = "server.zip"
    private const val VERSION_FILE = "payload-version.txt"

    fun ensureInstalled(ctx: Context, onProgress: (String) -> Unit): File {
        val serverDir = File(ctx.filesDir, "server")
        ctx.assets.open(ASSET, AssetManager.ACCESS_STREAMING).use { raw ->
            ZipInputStream(BufferedInputStream(raw, 1 shl 16)).use { zip ->
                val first = zip.nextEntry ?: error("$ASSET is empty")
                require(first.name == VERSION_FILE) { "$ASSET must start with $VERSION_FILE (got ${first.name})" }
                val version = zip.readBytes().toString(Charsets.UTF_8).trim()
                val installed = File(serverDir, VERSION_FILE).takeIf { it.isFile }?.readText()?.trim()
                if (installed == version && File(serverDir, "server.js").isFile) {
                    onProgress("Server payload up to date ($version)")
                    return serverDir
                }

                onProgress("Installing server payload $version (first launch takes a while)")
                val tmp = File(ctx.filesDir, "server.tmp")
                val old = File(ctx.filesDir, "server.old")
                tmp.deleteRecursively()
                old.deleteRecursively()
                tmp.mkdirs()
                val tmpRoot = tmp.canonicalPath + File.separator

                val buf = ByteArray(1 shl 16)
                var count = 0
                while (true) {
                    val e = zip.nextEntry ?: break
                    val out = File(tmp, e.name)
                    require(out.canonicalPath.startsWith(tmpRoot)) { "Unsafe zip entry: ${e.name}" }
                    if (e.isDirectory) {
                        out.mkdirs()
                        continue
                    }
                    out.parentFile?.mkdirs()
                    FileOutputStream(out).use { fos ->
                        while (true) {
                            val n = zip.read(buf)
                            if (n < 0) break
                            fos.write(buf, 0, n)
                        }
                    }
                    if (++count % 2000 == 0) onProgress("Installing server payload ($count files)")
                }
                File(tmp, VERSION_FILE).writeText(version)

                if (serverDir.exists() && !serverDir.renameTo(old)) {
                    serverDir.deleteRecursively()
                }
                check(tmp.renameTo(serverDir)) { "Could not move extracted payload into place" }
                old.deleteRecursively()
                onProgress("Installed $count files")
                return serverDir
            }
        }
    }
}
