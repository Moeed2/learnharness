/**
 * Android tablet file bridge (docs/android.md, step 6). Client side only.
 *
 * The Kotlin shell (android/.../LhJsBridge.kt) defines a PARTIAL `window.lh`
 * in the WebView: pickFiles / pickFolder / releaseImport / saveFile, all
 * Promise based. Nothing here exists on desktop or in a plain browser, and
 * every helper is a no-op unless isAndroidApp() is true AND the member exists.
 *
 * Native pickers copy what the user chose into app storage
 * (filesDir/imports/<id>/...), so the server (same device, same uid) reads
 * real paths and the existing path-based flows work unchanged.
 */
import { isAndroidApp } from "./platform";

export interface AndroidPickedFile { name: string; path: string; size: number }
export interface AndroidPickResult { id: string; files: AndroidPickedFile[]; skipped: number; error?: string }
export interface AndroidFolderEntry { path: string; size: number; url: string }
export interface AndroidFolderResult { id: string; name: string; files: AndroidFolderEntry[]; skipped: number; error?: string }
export interface AndroidPickOptions { extensions?: readonly string[] }

export interface AndroidFilesBridge {
	pickFiles(options?: AndroidPickOptions): Promise<AndroidPickResult>;
	pickFolder(options?: AndroidPickOptions): Promise<AndroidFolderResult>;
	releaseImport(id: string): Promise<void>;
}

export const IMPORT_PROGRESS_EVENT = "lh:import-progress";
export interface ImportProgress { done: number; total: number }

/** The bridge, or undefined outside the Android app. */
export function androidFilesBridge(): AndroidFilesBridge | undefined {
	if (typeof window === "undefined" || !isAndroidApp()) return undefined;
	const lh = (window as unknown as { lh?: Partial<AndroidFilesBridge> }).lh;
	return lh && typeof lh.pickFiles === "function" && typeof lh.pickFolder === "function" && typeof lh.releaseImport === "function"
		? (lh as AndroidFilesBridge)
		: undefined;
}

/** Subscribe to native copy progress; returns unsubscribe. */
export function onImportProgress(cb: (progress: ImportProgress) => void): () => void {
	if (typeof window === "undefined") return () => {};
	const listener = (event: Event) => {
		const detail = (event as CustomEvent<ImportProgress>).detail;
		if (detail && Number.isFinite(detail.done) && Number.isFinite(detail.total)) cb(detail);
	};
	window.addEventListener(IMPORT_PROGRESS_EVENT, listener);
	return () => window.removeEventListener(IMPORT_PROGRESS_EVENT, listener);
}

const MB = 1024 * 1024;

/** "Copying 12 of 120 MB…" (sizes under 1 MB read as "<1"). Pure. */
export function describeProgress({ done, total }: ImportProgress): string {
	if (!(total > 0)) return "Copying…";
	const mb = (n: number) => (n < MB ? "<1" : String(Math.round(n / MB)));
	return `Copying ${mb(Math.min(done, total))} of ${mb(total)} MB…`;
}

/** Turn a picker result into the paths to insert plus a user notice. Pure. */
export function summarizePick(result: AndroidPickResult): { paths: string[]; notice: string } {
	const paths = result.files.map((file) => file.path);
	if (result.error) return { paths, notice: result.error };
	if (paths.length === 0) return { paths, notice: result.skipped > 0 ? "None of the chosen files could be copied." : "" };
	return { paths, notice: result.skipped > 0 ? `${result.skipped} chosen file${result.skipped === 1 ? " was" : "s were"} skipped (too large or unreadable).` : "" };
}

/** Rebuild the browser File list a `webkitdirectory` input would have given,
 * from the native copy (served same-origin by the shell). `webkitRelativePath`
 * is read-only on File, so it is defined on the instance, which is all
 * notesPath() and FormData need. */
export async function importFolderFiles(
	result: AndroidFolderResult,
	fetchImpl: (url: string) => Promise<Response> = (url) => fetch(url),
): Promise<{ files: File[]; failed: number }> {
	const files: File[] = [];
	let failed = 0;
	for (const entry of result.files) {
		try {
			const response = await fetchImpl(entry.url);
			if (!response.ok) throw new Error(`HTTP ${response.status}`);
			const name = entry.path.slice(entry.path.lastIndexOf("/") + 1);
			const file = new File([await response.blob()], name);
			Object.defineProperty(file, "webkitRelativePath", { value: entry.path });
			files.push(file);
		} catch {
			failed++;
		}
	}
	return { files, failed };
}
