"use client";
import { useSyncExternalStore } from "react";
import { isAndroidApp } from "./platform.ts";

const subscribe = () => () => {};

/** True inside the Android tablet app's WebView. Hydration-safe: the server
 *  snapshot is always false, so server markup matches desktop and browsers;
 *  the client switches over right after hydration. */
export function useIsAndroidApp(): boolean {
	return useSyncExternalStore(subscribe, () => isAndroidApp(), () => false);
}
