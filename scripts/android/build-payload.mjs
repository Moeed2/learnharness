/**
 * build-payload.mjs — package the Next standalone server for the Android app.
 *
 * Run AFTER `next build` and `node scripts/build-server.mjs`:
 *   node scripts/android/build-payload.mjs
 *
 * 1. copies .next/standalone into android/.payload-staging (dereferencing links)
 * 2. adds @resvg/resvg-wasm (SVG rasterisation on Android; the desktop build does
 *    not trace it) and, ONLY with LH_ANDROID_ADDONS=1, the android-arm64 N-API
 *    addons (@napi-rs/canvas, @resvg/resvg-js) at the versions pinned in
 *    package-lock.json, from the npm registry tarballs (integrity-checked).
 *    The addons fail to load in nodejs-mobile (they do not link libnode.so), and
 *    nothing uses them any more (SVG = resvg-wasm, PDF pages = PdfRenderer), so
 *    they are left out by default to shrink the APK. Re-add: LH_ANDROID_ADDONS=1.
 * 3. prunes host-only native binaries (linux/darwin/win32 addons, sharp's libvips)
 * 4. adds lh-diagnostics.mjs and payload-version.txt
 * 5. zips to android/app/src/main/assets/server.zip (payload-version.txt FIRST,
 *    so the app can read the version without extracting). The zip is the only
 *    asset because AAPT silently drops dot-prefixed asset paths such as .next/.
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { gunzipSync, deflateRawSync, crc32 } from "node:zlib";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const STANDALONE = path.join(ROOT, ".next", "standalone");
const STAGING = path.join(ROOT, "android", ".payload-staging");
const OUT_ZIP = path.join(ROOT, "android", "app", "src", "main", "assets", "server.zip");
const ANDROID_ADDONS = process.env.LH_ANDROID_ADDONS === "1"
	? ["@napi-rs/canvas-android-arm64", "@resvg/resvg-js-android-arm64"]
	: [];

const log = (m) => console.log(`[android-payload] ${m}`);
const die = (m) => { console.error(`[android-payload] ${m}`); process.exit(1); };

if (!fs.existsSync(path.join(STANDALONE, "server.js"))) die(".next/standalone/server.js missing: run `next build` and `node scripts/build-server.mjs` first.");
if (!fs.existsSync(path.join(STANDALONE, ".next", "static"))) die(".next/standalone/.next/static missing: run `node scripts/build-server.mjs` first.");

// ---- 1. stage ---------------------------------------------------------------
fs.rmSync(STAGING, { recursive: true, force: true });
fs.cpSync(STANDALONE, STAGING, { recursive: true, dereference: true });
log(`staged ${STANDALONE} -> ${STAGING}`);

// ---- 2. android addons from the lockfile -------------------------------------
const lock = JSON.parse(fs.readFileSync(path.join(ROOT, "package-lock.json"), "utf8"));

/** Minimal tar reader: yields {name, type, data} (handles pax/GNU long names). */
function* tarEntries(buf) {
	let off = 0;
	let longName = null;
	const str = (a, b) => buf.toString("utf8", a, b).replace(/\0.*$/s, "");
	while (off + 512 <= buf.length) {
		if (buf.every((b, i) => i < off || i >= off + 512 || b === 0)) break;
		let name = str(off, off + 100);
		const size = parseInt(str(off + 124, off + 136).trim() || "0", 8);
		const type = String.fromCharCode(buf[off + 156] || 48);
		const prefix = str(off + 345, off + 500);
		if (prefix) name = `${prefix}/${name}`;
		const data = buf.subarray(off + 512, off + 512 + size);
		off += 512 + Math.ceil(size / 512) * 512;
		if (type === "x") { // pax header: look for "path="
			const m = /\d+ path=([^\n]+)\n/.exec(data.toString("utf8"));
			if (m) longName = m[1];
			continue;
		}
		if (type === "g") continue;
		if (type === "L") { longName = data.toString("utf8").replace(/\0.*$/s, ""); continue; }
		if (longName) { name = longName; longName = null; }
		yield { name, type, data };
	}
}

for (const pkg of ANDROID_ADDONS) {
	const entry = lock.packages?.[`node_modules/${pkg}`];
	if (!entry?.resolved || !entry.integrity) die(`${pkg} not in package-lock.json (resolved/integrity missing)`);
	log(`${pkg}@${entry.version}: downloading ${entry.resolved}`);
	const res = await fetch(entry.resolved);
	if (!res.ok) die(`download failed: ${res.status} ${entry.resolved}`);
	const tgz = Buffer.from(await res.arrayBuffer());
	const [algo, expected] = entry.integrity.split("-");
	const actual = createHash(algo).update(tgz).digest("base64");
	if (actual !== expected) die(`${pkg}: integrity mismatch`);

	const dest = path.join(STAGING, "node_modules", ...pkg.split("/"));
	fs.rmSync(dest, { recursive: true, force: true });
	let files = 0;
	for (const e of tarEntries(gunzipSync(tgz))) {
		if (e.type !== "0" && e.type !== "\0") continue; // regular files only
		const rel = e.name.replace(/^[^/]+\//, ""); // strip "package/"
		const out = path.join(dest, rel);
		if (!out.startsWith(dest + path.sep)) die(`unsafe tar path: ${e.name}`);
		fs.mkdirSync(path.dirname(out), { recursive: true });
		fs.writeFileSync(out, e.data);
		files++;
	}
	log(`  extracted ${files} files -> node_modules/${pkg}`);
}

// resvg-wasm is pure JS + one .wasm file; copy it verbatim from the build's node_modules.
{
	const src = path.join(ROOT, "node_modules", "@resvg", "resvg-wasm");
	if (!fs.existsSync(path.join(src, "index_bg.wasm"))) die("node_modules/@resvg/resvg-wasm missing: run npm ci first.");
	const dest = path.join(STAGING, "node_modules", "@resvg", "resvg-wasm");
	fs.rmSync(dest, { recursive: true, force: true });
	fs.cpSync(src, dest, { recursive: true, dereference: true });
	log("  added node_modules/@resvg/resvg-wasm");
}

// ---- 3. prune host-only binaries ------------------------------------------------
const nm = path.join(STAGING, "node_modules");
const rm = (dir) => {
	const size = dirSize(dir);
	fs.rmSync(dir, { recursive: true, force: true });
	log(`  pruned ${path.relative(STAGING, dir)} (${(size / 1048576).toFixed(1)} MB)`);
};
function dirSize(p) {
	const st = fs.lstatSync(p);
	if (!st.isDirectory()) return st.size;
	return fs.readdirSync(p).reduce((n, f) => n + dirSize(path.join(p, f)), 0);
}
const HOST = /-(linux|darwin|win32|freebsd)-/;
for (const scope of ["@napi-rs", "@resvg"]) {
	const dir = path.join(nm, scope);
	if (!fs.existsSync(dir)) continue;
	for (const name of fs.readdirSync(dir)) {
		if ((name.startsWith("canvas-") || name.startsWith("resvg-js-")) && HOST.test(name)) rm(path.join(dir, name));
	}
}
// sharp (pulled in by Next's image optimizer, never imported by app code): no
// android build exists, but @img/sharp-wasm32 is the fallback. Only drop the
// native linux/darwin/win32 sharp + libvips packages when that fallback is present.
const img = path.join(nm, "@img");
if (fs.existsSync(path.join(img, "sharp-wasm32"))) {
	for (const name of fs.readdirSync(img)) {
		if (/^sharp(-libvips)?-(linux|darwin|win32)/.test(name)) rm(path.join(img, name));
	}
} else if (fs.existsSync(img)) {
	log("  @img/sharp-wasm32 absent: leaving sharp binaries in place");
}

// ---- 4. diagnostics + version -----------------------------------------------------
fs.copyFileSync(path.join(import.meta.dirname, "diagnostics.mjs"), path.join(STAGING, "lh-diagnostics.mjs"));
fs.copyFileSync(path.join(import.meta.dirname, "runtime-fixes.mjs"), path.join(STAGING, "lh-runtime-fixes.mjs"));

const git = (...a) => spawnSync("git", a, { cwd: ROOT, encoding: "utf8" });
const sha = git("rev-parse", "--short=12", "HEAD").stdout?.trim() || "nogit";
const dirty = (git("status", "--porcelain").stdout ?? "").trim() !== "";
const pkgVersion = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version;
// A dirty tree can differ under the same sha: make every such build unique.
const version = `${pkgVersion}+${sha}${dirty ? `.dirty${Date.now()}` : ""}`;
log(`payload version ${version}`);

// ---- 5. zip ---------------------------------------------------------------------------
const files = [];
(function walk(dir) {
	for (const name of fs.readdirSync(dir).sort()) {
		const p = path.join(dir, name);
		const st = fs.lstatSync(p);
		if (st.isDirectory()) walk(p);
		else if (st.isFile()) files.push(path.relative(STAGING, p).split(path.sep).join("/"));
	}
})(STAGING);
if (files.length + 1 > 65535) die(`${files.length} files exceeds the plain-zip entry limit (65535); ZIP64 is not implemented`);

fs.mkdirSync(path.dirname(OUT_ZIP), { recursive: true });
fs.rmSync(OUT_ZIP, { force: true });
const fd = fs.openSync(OUT_ZIP, "w");
let pos = 0;
const central = [];
const DOS_TIME = 0, DOS_DATE = (2026 - 1980) << 9 | 1 << 5 | 1; // fixed: reproducible
const write = (b) => { fs.writeSync(fd, b); pos += b.length; };

function addEntry(name, data) {
	const nameBuf = Buffer.from(name, "utf8");
	const crc = crc32(data);
	const deflated = data.length > 0 ? deflateRawSync(data, { level: 6 }) : data;
	const useDeflate = data.length > 0 && deflated.length < data.length;
	const body = useDeflate ? deflated : data;
	const method = useDeflate ? 8 : 0;
	if (data.length >= 0xffffffff) die(`${name} too large for plain zip`);
	const lh = Buffer.alloc(30);
	lh.writeUInt32LE(0x04034b50, 0);
	lh.writeUInt16LE(20, 4); // version needed
	lh.writeUInt16LE(0x0800, 6); // UTF-8 names
	lh.writeUInt16LE(method, 8);
	lh.writeUInt16LE(DOS_TIME, 10);
	lh.writeUInt16LE(DOS_DATE, 12);
	lh.writeUInt32LE(crc, 14);
	lh.writeUInt32LE(body.length, 18);
	lh.writeUInt32LE(data.length, 22);
	lh.writeUInt16LE(nameBuf.length, 26);
	lh.writeUInt16LE(0, 28);
	central.push({ nameBuf, crc, csize: body.length, size: data.length, method, offset: pos });
	write(lh); write(nameBuf); write(body);
}

addEntry("payload-version.txt", Buffer.from(version + "\n")); // MUST be first
for (const f of files) addEntry(f, fs.readFileSync(path.join(STAGING, ...f.split("/"))));

const cdStart = pos;
for (const c of central) {
	const h = Buffer.alloc(46);
	h.writeUInt32LE(0x02014b50, 0);
	h.writeUInt16LE(20, 4); // made by
	h.writeUInt16LE(20, 6); // needed
	h.writeUInt16LE(0x0800, 8);
	h.writeUInt16LE(c.method, 10);
	h.writeUInt16LE(DOS_TIME, 12);
	h.writeUInt16LE(DOS_DATE, 14);
	h.writeUInt32LE(c.crc, 16);
	h.writeUInt32LE(c.csize, 20);
	h.writeUInt32LE(c.size, 24);
	h.writeUInt16LE(c.nameBuf.length, 28);
	h.writeUInt32LE(((0o100644 << 16) >>> 0), 38); // unix mode in external attrs
	h.writeUInt32LE(c.offset, 42);
	write(h); write(c.nameBuf);
}
const cdSize = pos - cdStart;
if (pos >= 0xffffffff) die("zip exceeds 4 GiB");
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(central.length, 8);
end.writeUInt16LE(central.length, 10);
end.writeUInt32LE(cdSize, 12);
end.writeUInt32LE(cdStart, 16);
write(end);
fs.closeSync(fd);

log(`wrote ${path.relative(ROOT, OUT_ZIP)}: ${central.length} entries, ${(pos / 1048576).toFixed(1)} MB`);
