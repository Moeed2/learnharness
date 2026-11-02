/**
 * diagnostics.mjs — Android spike preload (loaded with `node --import` before
 * server.js by NodeService). Probes the features LearnHarness depends on and
 * writes the results to $LH_DIAGNOSTICS_FILE plus one stdout line:
 *
 *   LH_DIAGNOSTICS {json}
 *
 * HARD RULES: never throw, never block server start-up (all probes run in the
 * background after this module has evaluated), never call process.exit.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { isMainThread } from "node:worker_threads";

const here = path.dirname(fileURLToPath(import.meta.url));
const results = {};

const clip = (v) => String(v && v.message ? v.message : v).slice(0, 160);

async function probe(name, fn) {
	const t0 = Date.now();
	try {
		const detail = await Promise.race([
			fn(),
			new Promise((_, rej) => setTimeout(() => rej(new Error("timeout 15s")), 15_000).unref()),
		]);
		results[name] = { ok: true, ms: Date.now() - t0, ...(detail === undefined ? {} : { detail: clip(detail) }) };
	} catch (e) {
		results[name] = { ok: false, ms: Date.now() - t0, error: clip(e) };
	}
}

// 1x1 transparent PNG.
const PNG_1X1 = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
	"base64",
);

const TINY_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="red"/></svg>';

/** One-page PDF with a correct xref table ("Hello" in Helvetica). */
const TINY_PDF = (() => {
	const objs = [
		"<< /Type /Catalog /Pages 2 0 R >>",
		"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
		"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
		"<< /Length 36 >>\nstream\nBT /F1 24 Tf 20 40 Td (Hello) Tj ET\nendstream",
		"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
	];
	let out = "%PDF-1.4\n";
	const offsets = [];
	objs.forEach((o, i) => {
		offsets.push(out.length);
		out += `${i + 1} 0 obj\n${o}\nendobj\n`;
	});
	const xref = out.length;
	out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
	for (const o of offsets) out += `${String(o).padStart(10, "0")} 00000 n \n`;
	out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
	return Buffer.from(out, "latin1");
})();

async function run() {
	// The android N-API addons are not shipped (they cannot dlopen in nodejs-mobile).
	// Informational only, opt in with LH_PROBE_NATIVE_ADDONS=1 after re-adding them.
	if (process.env.LH_PROBE_NATIVE_ADDONS === "1") {
		await probe("canvas", async () => {
			const { createCanvas } = await import("@napi-rs/canvas");
			const c = createCanvas(10, 10);
			c.getContext("2d").fillRect(0, 0, 5, 5);
			return `png ${c.toBuffer("image/png").length} bytes`;
		});
		await probe("resvg", async () => {
			const mod = await import("@resvg/resvg-js");
			const Resvg = mod.Resvg ?? mod.default?.Resvg;
			return `png ${new Resvg(TINY_SVG).render().asPng().length} bytes`;
		});
	}
	// SVG path used by the app: resvg compiled to WASM, fonts from /system/fonts.
	await probe("resvg-wasm", async () => {
		const mod = await import("@resvg/resvg-wasm");
		const { createRequire } = await import("node:module");
		await mod.initWasm(fs.readFileSync(createRequire(import.meta.url).resolve("@resvg/resvg-wasm/index_bg.wasm")));
		const plain = new mod.Resvg(TINY_SVG).render().asPng().length;
		const fontDirs = ["/system/fonts", "/product/fonts"].filter((d) => fs.existsSync(d));
		const roboto = fontDirs.map((d) => path.join(d, "Roboto-Regular.ttf")).find((f) => fs.existsSync(f));
		let text = "no Roboto-Regular.ttf";
		if (roboto) {
			const withText = '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="30"><text x="4" y="22" font-family="Roboto" font-size="20">Hello</text></svg>';
			const blank = '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="30"/>';
			const opts = { font: { fontBuffers: [new Uint8Array(fs.readFileSync(roboto))], defaultFontFamily: "Roboto" } };
			const a = new mod.Resvg(withText, opts).render().pixels;
			const b = new mod.Resvg(blank, opts).render().pixels;
			text = a.some((v, i) => v !== b[i]) ? "text drawn" : "TEXT NOT DRAWN";
		}
		return `png ${plain} bytes; ${text}`;
	});
	// pdfjs text extraction must work without any canvas package.
	await probe("pdfjs-text", async () => {
		const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
		const task = pdfjs.getDocument({ data: new Uint8Array(TINY_PDF), verbosity: 0 });
		const doc = await task.promise;
		const content = await (await doc.getPage(1)).getTextContent();
		const text = content.items.map((i) => i.str).join("");
		await task.destroy();
		return `pages ${doc.numPages}, text "${text}"`;
	});
	// Kotlin PdfRenderer through the loopback render service (POST /pdf).
	await probe("render-service-pdf", async () => {
		const url = process.env.LH_ANDROID_RENDER_URL;
		const token = process.env.LH_ANDROID_RENDER_TOKEN;
		if (!url || !token) return "skipped (no render service env)";
		const res = await fetch(`${url}/pdf`, {
			method: "POST",
			headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
			body: JSON.stringify({ pdfBase64: TINY_PDF.toString("base64"), pages: [1], dpi: 72 }),
		});
		const j = await res.json();
		if (!res.ok) throw new Error(`HTTP ${res.status} ${j.error ?? ""}`);
		const p = j.pages?.[0];
		return `pages ${j.numPages}, page1 ${p?.width}x${p?.height} png ${Buffer.from(p?.png ?? "", "base64").length} bytes`;
	});
	await probe("photon-wasm", async () => {
		const photon = await import("@silvia-odwyer/photon-node");
		const P = photon.PhotonImage ?? photon.default?.PhotonImage;
		const img = P.new_from_byteslice(new Uint8Array(PNG_1X1));
		const w = img.get_width();
		img.free?.();
		return `decoded width ${w}`;
	});
	await probe("worker-eval", async () => {
		const { Worker } = await import("node:worker_threads");
		return await new Promise((resolve, reject) => {
			const w = new Worker("require('node:worker_threads').parentPort.postMessage('pong')", { eval: true });
			w.once("message", (m) => { w.terminate(); resolve(m); });
			w.once("error", reject);
		});
	});
	await probe("worker-file", async () => {
		const { Worker } = await import("node:worker_threads");
		const file = path.join(os.tmpdir(), `lh-diag-worker-${process.pid}.mjs`);
		fs.writeFileSync(file, "import { parentPort } from 'node:worker_threads'; parentPort.postMessage('pong');");
		try {
			return await new Promise((resolve, reject) => {
				const w = new Worker(file);
				w.once("message", (m) => { w.terminate(); resolve(m); });
				w.once("error", reject);
			});
		} finally {
			try { fs.unlinkSync(file); } catch { /* ignore */ }
		}
	});
	await probe("registerHooks", async () => {
		const m = await import("node:module");
		if (typeof m.registerHooks !== "function") throw new Error("module.registerHooks missing");
	});
	await probe("regex-unicode-property", () => {
		if (!/\p{L}/u.test("é")) throw new Error("no match");
	});
	// Tests the JS replacement from runtime-fixes.mjs; the native one segfaults.
	await probe("intl-segmenter", () => {
		const n = [...new Intl.Segmenter("en", { granularity: "word" }).segment("hello world")].length;
		return `${n} segments`;
	});
	await probe("crypto-subtle", async () => {
		const d = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode("x"));
		return `digest ${d.byteLength} bytes`;
	});
	await probe("fetch", () => {
		if (typeof fetch !== "function") throw new Error("fetch missing");
	});
	await probe("os-homedir", () => os.homedir());
	await probe("os-cpus", () => `${os.cpus()?.length ?? "undefined"}`);
}

async function main() {
	try {
		await run();
	} catch (e) {
		results._fatal = { ok: false, error: clip(e) };
	}
	const report = {
		node: process.version,
		mobile: process.versions.mobile,
		platform: process.platform,
		arch: process.arch,
		cwd: process.cwd(),
		results,
	};
	let json = "{}";
	try { json = JSON.stringify(report); } catch { /* ignore */ }
	try {
		const file = process.env.LH_DIAGNOSTICS_FILE;
		if (file) fs.writeFileSync(file, JSON.stringify(report, null, 2));
	} catch { /* ignore */ }
	console.log(`LH_DIAGNOSTICS ${json}`);
}

// Fire and forget: never delay or break server start-up. --import is inherited
// by worker threads (and the env by child processes): run once, main thread only.
if (isMainThread && !process.env.LH_DIAGNOSTICS_RAN) {
	process.env.LH_DIAGNOSTICS_RAN = "1";
	setTimeout(() => { main().catch(() => {}); }, 0).unref?.();
}
