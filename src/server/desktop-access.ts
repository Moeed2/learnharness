import { timingSafeEqual } from "node:crypto";
import { isAndroidServer } from "../../lib/platform.ts";

export const ANDROID_COOKIE = "lh_android";
const MIN_SECRET = 64;

function safeEqual(supplied: string, expected: string): boolean {
	const actual = Buffer.from(supplied);
	const wanted = Buffer.from(expected);
	return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}

/** Value of one cookie from a Cookie request header (no decoding). */
export function cookieValue(header: string | null, name: string): string | undefined {
	if (!header) return undefined;
	for (const part of header.split(";")) {
		const eq = part.indexOf("=");
		if (eq < 0 || part.slice(0, eq).trim() !== name) continue;
		return part.slice(eq + 1).trim();
	}
	return undefined;
}

/** Android app: any app on the device can reach loopback, so /api needs the
 * per-process secret the Kotlin shell hands only to its own WebView as a
 * cookie. Fails closed when the secret is missing or too short. */
function androidAPIAuthorized(headers: Headers, env: Record<string, string | undefined>): boolean {
	const expected = env.LH_ANDROID_API_SECRET;
	if (!expected || expected.length < MIN_SECRET) return false;
	const supplied = cookieValue(headers.get("cookie"), ANDROID_COOKIE);
	return supplied !== undefined && safeEqual(supplied, expected);
}

/** Per-launch desktop HTTP capability. This is not an OS-user malware
 * boundary and is not an OAuth credential. Browser-only mode is unchanged. */
export function desktopAPIAuthorized(
	headers: Headers,
	env: Record<string, string | undefined> = process.env,
): boolean {
	if (isAndroidServer(env)) return androidAPIAuthorized(headers, env);
	const expected = env.LH_DESKTOP_API_SECRET;
	if (env.LH_DESKTOP_SERVER !== "1" && !expected) return true;
	if (!expected || expected.length < 64) return false;
	const supplied = headers.get("x-learnharness-desktop");
	if (!supplied) return false;
	return safeEqual(supplied, expected);
}
