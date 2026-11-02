package ai.learnharness.tablet

import android.util.Log

/** Process-wide server status shared by NodeService (writer) and MainActivity (reader). */
object ServerState {
    enum class Phase { IDLE, EXTRACTING, STARTING, RUNNING, FAILED }

    @Volatile var phase: Phase = Phase.IDLE
        private set
    @Volatile var port: Int = 0
        private set
    @Volatile var error: String? = null
        private set
    @Volatile var detail: String = ""
        private set

    private val lines = ArrayDeque<String>()

    @Synchronized
    fun log(line: String) {
        lines.addLast(line.take(400))
        while (lines.size > 200) lines.removeFirst()
    }

    @Synchronized
    fun tail(n: Int = 25): String = lines.toList().takeLast(n).joinToString("\n")

    fun setPhase(p: Phase, text: String = "") {
        phase = p
        detail = text
        Log.i(AppConfig.TAG, "phase=$p $text")
        log("[app] $p $text".trim())
    }

    fun setPort(p: Int) {
        port = p
        // Parsed by the CI emulator smoke test.
        Log.i(AppConfig.TAG, "LH_PORT $p")
    }

    fun fail(message: String) {
        error = message
        setPhase(Phase.FAILED, message)
    }
}
