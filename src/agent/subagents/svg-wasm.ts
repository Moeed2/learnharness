import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";

/**
 * SVG rasterization through @resvg/resvg-wasm: the same resvg engine as the
 * desktop's native @resvg/resvg-js, compiled to WASM. Used on Android, where
 * prebuilt N-API addons cannot load into nodejs-mobile (they do not link
 * libnode.so). Differences from resvg-js: no loadSystemFonts, so font bytes
 * are read from the system font directories and passed in as buffers.
 */

/** Directories searched for fonts, in order (AOSP + OEM font locations). */
export const ANDROID_FONT_DIRS = ["/system/fonts", "/product/fonts", "/system_ext/fonts", "/vendor/fonts"];

/** Total font bytes handed to resvg per render. CJK families dominate this. */
export const FONT_BYTE_BUDGET = 48 * 1024 * 1024;

export interface FontFileInfo {
	file: string;
	size: number;
}

/** Lower rank is loaded first. null = never load (no vector glyphs, or irrelevant). */
function rankFont(file: string): number | null {
	if (!/\.(ttf|otf|ttc)$/i.test(file)) return null;
	if (/emoji|color/i.test(file)) return null; // resvg cannot paint color bitmap glyphs
	if (/^Roboto-/.test(file) || /^Roboto\[/.test(file)) return 0;
	if (/^NotoSerif-/.test(file)) return 1;
	if (/^(DroidSansMono|RobotoMono|CutiveMono)/.test(file)) return 2;
	if (/^(HarmonyOS_Sans|HarmonyOS_Sans_SC)/.test(file)) return 3;
	if (/^NotoSans(CJK|SC|TC|JP|KR)/.test(file)) return 4;
	if (/^NotoSans[A-Za-z]*-(Regular|Bold)\.(ttf|otf)$/i.test(file)) return 5;
	if (/^NotoSansSymbols/.test(file) || /^NotoSansMath/.test(file)) return 5;
	return null;
}

/** Pure selection of which font files to load under a byte budget (first-fit by rank). */
export function selectFontFiles(files: FontFileInfo[], budget = FONT_BYTE_BUDGET): FontFileInfo[] {
	const ranked = files
		.map((f) => ({ f, r: rankFont(path.basename(f.file)) }))
		.filter((x): x is { f: FontFileInfo; r: number } => x.r !== null)
		.sort((a, b) => a.r - b.r || a.f.file.localeCompare(b.f.file));
	const out: FontFileInfo[] = [];
	let used = 0;
	for (const { f } of ranked) {
		if (used + f.size > budget) continue;
		out.push(f);
		used += f.size;
	}
	return out;
}

/** Generic-family mapping, only for families whose files were actually selected. */
export function genericFamilies(selected: FontFileInfo[]): Record<string, string> {
	const names = selected.map((f) => path.basename(f.file));
	const out: Record<string, string> = {};
	if (names.some((n) => /^Roboto[-[]/.test(n))) {
		out.defaultFontFamily = "Roboto";
		out.sansSerifFamily = "Roboto";
	}
	if (names.some((n) => /^NotoSerif-/.test(n))) out.serifFamily = "Noto Serif";
	if (names.some((n) => /^DroidSansMono/.test(n))) out.monospaceFamily = "Droid Sans Mono";
	return out;
}

export function listFontFiles(dirs: string[]): FontFileInfo[] {
	const out: FontFileInfo[] = [];
	for (const dir of dirs) {
		let names: string[];
		try {
			names = fs.readdirSync(dir);
		} catch {
			continue;
		}
		for (const name of names) {
			const file = path.join(dir, name);
			try {
				const st = fs.statSync(file);
				if (st.isFile()) out.push({ file, size: st.size });
			} catch {
				/* unreadable entry */
			}
		}
	}
	return out;
}

interface FontSet {
	buffers: Uint8Array[];
	families: Record<string, string>;
}

const fontCache = new Map<string, FontSet>();

function loadFonts(dirs: string[]): FontSet {
	const key = dirs.join("\0");
	const hit = fontCache.get(key);
	if (hit) return hit;
	const selected = selectFontFiles(listFontFiles(dirs));
	const buffers: Uint8Array[] = [];
	const loaded: FontFileInfo[] = [];
	for (const f of selected) {
		try {
			buffers.push(new Uint8Array(fs.readFileSync(f.file)));
			loaded.push(f);
		} catch {
			/* skip unreadable font */
		}
	}
	const set = { buffers, families: genericFamilies(loaded) };
	fontCache.set(key, set);
	return set;
}

type ResvgModule = typeof import("@resvg/resvg-wasm");
let wasmReady: Promise<ResvgModule> | null = null;

function loadResvgWasm(): Promise<ResvgModule> {
	wasmReady ??= (async () => {
		// Resolved at runtime from the server root (cwd) and hidden from the
		// bundler: Turbopack otherwise bundles index_bg.wasm as an ES module
		// and fails on its "wbg" import. build-payload.mjs ships the package.
		const pkg = ["@resvg", "resvg-wasm"].join("/");
		const req = createRequire(path.join(process.cwd(), "package.json"));
		const entry = req.resolve(pkg);
		const mod = req(entry) as ResvgModule;
		await mod.initWasm(fs.readFileSync(path.join(path.dirname(entry), "index_bg.wasm")));
		return mod;
	})().catch((e) => {
		wasmReady = null; // allow a retry after a transient failure
		throw e;
	});
	return wasmReady;
}

export interface RenderSvgWasmOptions {
	/** Output width in px (resvg fitTo width). */
	width: number;
	/** Font directories; defaults to LH_SVG_FONT_DIRS (colon-separated) or the Android set. */
	fontDirs?: string[];
}

export function defaultFontDirs(env: Record<string, string | undefined> = process.env): string[] {
	const custom = env.LH_SVG_FONT_DIRS?.split(path.delimiter).filter(Boolean);
	return custom && custom.length > 0 ? custom : ANDROID_FONT_DIRS;
}

/** Rasterize an SVG to PNG bytes with a white background (same options as the native path). */
export async function renderSvgWasm(svg: string, opts: RenderSvgWasmOptions): Promise<Uint8Array> {
	const { Resvg } = await loadResvgWasm();
	const fonts = loadFonts(opts.fontDirs ?? defaultFontDirs());
	const resvg = new Resvg(svg, {
		fitTo: { mode: "width", value: opts.width },
		font: { fontBuffers: fonts.buffers, ...fonts.families },
		background: "#ffffff",
	});
	try {
		const img = resvg.render();
		try {
			return img.asPng();
		} finally {
			img.free();
		}
	} finally {
		resvg.free();
	}
}
