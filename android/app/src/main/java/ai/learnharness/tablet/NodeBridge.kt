package ai.learnharness.tablet

import android.util.Log

/** Kotlin side of lh_node.cpp. Node can be started once per process. */
object NodeBridge {
    init {
        System.loadLibrary("lhnode") // also pulls in libnode.so
    }

    /** 0 = started, 1 = already started, < 0 = native error. */
    external fun nativeStart(args: Array<String>, workDir: String): Int

    @JvmStatic
    fun onLog(line: String) {
        ServerState.log(line)
    }

    @JvmStatic
    fun onExit(code: Int) {
        Log.w(AppConfig.TAG, "node exited with code $code")
        ServerState.fail("Node.js exited with code $code")
    }
}
