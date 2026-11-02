/**
 * Platform detection shared by the web UI and the server.
 *
 * Android tablet build (see docs/android.md): the Kotlin shell appends
 * `LearnHarnessAndroid/<version>` to the WebView user agent and starts the
 * embedded server with LH_ANDROID=1. Desktop and plain-browser behavior must
 * stay unchanged whenever these return false.
 */
export const ANDROID_UA_TOKEN = "LearnHarnessAndroid/";

/** Client side: true inside the Android tablet app's WebView. */
export function isAndroidApp(userAgent: string | undefined = typeof navigator === "undefined" ? undefined : navigator.userAgent): boolean {
	return typeof userAgent === "string" && userAgent.includes(ANDROID_UA_TOKEN);
}

/** Server side: true when the server runs inside the Android app. */
export function isAndroidServer(env: Record<string, string | undefined> = process.env): boolean {
	return env.LH_ANDROID === "1";
}
