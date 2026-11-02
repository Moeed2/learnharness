/**
 * Touch-device detection for the Android tablet build (docs/android.md).
 * Desktop and mouse-driven browsers answer false, so every caller keeps its
 * existing behavior there. Matches the CSS gate used in the stylesheets.
 */
import { useSyncExternalStore } from "react";

export const TOUCH_QUERY = "(hover: none) and (pointer: coarse)";

type MatchMedia = (query: string) => { matches: boolean };

function defaultMatch(): MatchMedia | undefined {
	if (typeof window === "undefined" || typeof window.matchMedia !== "function") return undefined;
	return window.matchMedia.bind(window);
}

/** True when the primary input is a finger (no hover, coarse pointer). */
export function isTouchDevice(match: MatchMedia | undefined = defaultMatch()): boolean {
	if (!match) return false;
	try {
		return match(TOUCH_QUERY).matches;
	} catch {
		return false;
	}
}

const subscribe = (cb: () => void) => {
	if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => {};
	const mq = window.matchMedia(TOUCH_QUERY);
	mq.addEventListener("change", cb);
	return () => mq.removeEventListener("change", cb);
};

/** Reactive variant; false during SSR and the first hydration pass. */
export function useTouchDevice(): boolean {
	return useSyncExternalStore(
		subscribe,
		() => isTouchDevice(),
		() => false,
	);
}
