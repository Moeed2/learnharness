package ai.learnharness.tablet

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.system.Os
import android.util.Log
import java.io.File
import java.net.InetAddress
import java.net.ServerSocket
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Foreground service that hosts the embedded Node.js server. Node can only be
 * started once per process, so this service never restarts it; if the process
 * dies the next launch starts a fresh one.
 */
class NodeService : Service() {

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        promoteToForeground()
        if (bootstrapStarted.compareAndSet(false, true)) {
            Thread({ bootstrap() }, "lh-bootstrap").start()
        }
        return START_NOT_STICKY
    }

    private fun promoteToForeground() {
        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(
            NotificationChannel(CHANNEL, getString(R.string.notification_channel), NotificationManager.IMPORTANCE_LOW)
        )
        val open = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val notification = Notification.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat)
            .setContentTitle(getString(R.string.notification_title))
            .setContentText(getString(R.string.notification_text))
            .setContentIntent(open)
            .setOngoing(true)
            .build()
        if (Build.VERSION.SDK_INT >= 34) {
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
    }

    private fun bootstrap() {
        try {
            ServerState.setPhase(ServerState.Phase.EXTRACTING, "Preparing server files")
            val serverDir = PayloadInstaller.ensureInstalled(this) { msg ->
                ServerState.setPhase(ServerState.Phase.EXTRACTING, msg)
            }

            val dataDir = File(filesDir, "data").apply { mkdirs() }
            val homeDir = File(filesDir, "home").apply { mkdirs() }
            val port = freeLoopbackPort()
            // Step 5: render service (demo verification) must be up before Node starts.
            val (renderUrl, renderToken) = RenderService.start(this)
            ServerState.setPort(port)

            val env = mapOf(
                "PORT" to port.toString(),
                "HOSTNAME" to "127.0.0.1",
                "NODE_ENV" to "production",
                "HOME" to homeDir.path,
                "TMPDIR" to cacheDir.path,
                "LH_ANDROID" to "1",
                ApiGuard.ENV_NAME to ApiGuard.secret, // cookie guard for /api (see ApiGuard)
                "LH_DATA_DIR" to dataDir.path,
                "LH_AUTH_FILE" to File(filesDir, "auth.json").path,
                "NEXT_TELEMETRY_DISABLED" to "1",
                "LH_ANDROID_RENDER_URL" to renderUrl,
                "LH_ANDROID_RENDER_TOKEN" to renderToken,
                // Read by lh-diagnostics.mjs (step-1 spike).
                "LH_DIAGNOSTICS_FILE" to File(filesDir, "diagnostics.json").path,
                // NOTE: LH_DESKTOP_SERVER / LH_DESKTOP_API_SECRET are deliberately NOT
                // set: the server's web mode is what in-app ChatGPT sign-in uses.
            )
            env.forEach { (k, v) -> Os.setenv(k, v, true) }

            val args = mutableListOf("node")
            // Must load first: replaces Intl.Segmenter, which segfaults libnode on Android.
            val fixes = File(serverDir, "lh-runtime-fixes.mjs")
            if (fixes.isFile) {
                args += "--import"
                args += fixes.path
            }
            val diag = File(serverDir, "lh-diagnostics.mjs")
            if (diag.isFile) {
                args += "--import"
                args += diag.path
            }
            args += File(serverDir, "server.js").path

            ServerState.setPhase(ServerState.Phase.STARTING, "Starting Node.js on port $port")
            val rc = NodeBridge.nativeStart(args.toTypedArray(), serverDir.path)
            if (rc < 0) {
                ServerState.fail("Native start failed ($rc)")
            } else {
                ServerState.setPhase(ServerState.Phase.RUNNING, "Node.js running on port $port")
            }
        } catch (t: Throwable) {
            Log.e(AppConfig.TAG, "bootstrap failed", t)
            ServerState.fail("${t.javaClass.simpleName}: ${t.message}")
        }
    }

    private fun freeLoopbackPort(): Int =
        ServerSocket(0, 1, InetAddress.getByName("127.0.0.1")).use { it.localPort }

    companion object {
        private const val CHANNEL = "lh_server"
        private const val NOTIFICATION_ID = 1
        private val bootstrapStarted = AtomicBoolean(false)
    }
}
