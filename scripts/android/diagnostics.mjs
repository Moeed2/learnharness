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

async function run() {
	await probe("canvas", async () => {
		const { createCanvas } = await import("@napi-rs/canvas");
		const c = createCanvas(10, 10);
		c.getContext("2d").fillRect(0, 0, 5, 5);
		return `png ${c.toBuffer("image/png").length} bytes`;
	});
	await probe("resvg", async () => {
		const mod = await import("@resvg/resvg-js");
		const Resvg = mod.Resvg ?? mod.default?.Resvg;
		const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="red"/></svg>';
		return `png ${new Resvg(svg).render().asPng().length} bytes`;
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
