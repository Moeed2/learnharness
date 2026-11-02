import assert from "node:assert/strict";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import {
	androidRenderConfig,
	createAndroidHeadless,
	createAndroidRenderClient,
} from "../src/agent/subagents/headless-android.ts";
import { getHeadless, realHeadless } from "../src/agent/subagents/headless.ts";

interface Seen {
	path?: string;
	auth?: string;
	body?: Record<string, unknown>;
}

async function withFake(
	handler: (path: string, body: Record<string, unknown>) => { status: number; type: string; body: Buffer | string },
	fn: (url: string, seen: Seen) => Promise<void>,
) {
	const seen: Seen = {};
	const server = http.createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (c) => chunks.push(c));
		req.on("end", () => {
			seen.path = req.url;
			seen.auth = req.headers.authorization;
			seen.body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
			const r = handler(req.url ?? "", seen.body!);
			res.writeHead(r.status, { "content-type": r.type });
			res.end(r.body);
		});
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	try {
		await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen);
	} finally {
		server.close();
	}
}

test("androidRenderConfig requires LH_ANDROID, url and token, loopback only", () => {
	const env = { LH_ANDROID: "1", LH_ANDROID_RENDER_URL: "http://127.0.0.1:1234/", LH_ANDROID_RENDER_TOKEN: "t" };
	assert.deepEqual(androidRenderConfig(env), { url: "http://127.0.0.1:1234", token: "t" });
	assert.equal(androidRenderConfig({ ...env, LH_ANDROID: undefined }), null);
	assert.equal(androidRenderConfig({ ...env, LH_ANDROID_RENDER_TOKEN: undefined }), null);
	assert.equal(androidRenderConfig({ ...env, LH_ANDROID_RENDER_URL: "http://example.com:80" }), null);
	assert.equal(androidRenderConfig({ ...env, LH_ANDROID_RENDER_URL: "not a url" }), null);
});

test("runDemo posts to /demo with the bearer token and maps the result", async () => {
	await withFake(
		() => ({
			status: 200,
			type: "application/json",
			body: JSON.stringify({ consoleErrors: ["boom"], pageErrors: [], failedRequests: [], probeResult: { n: 3 }, ok: true }),
		}),
		async (url, seen) => {
			const client = createAndroidRenderClient({ url, token: "secret" });
			const r = await client.runDemo("<p>hi</p>", { settleMs: 5, probe: "1+2" });
			assert.equal(seen.path, "/demo");
			assert.equal(seen.auth, "Bearer secret");
			assert.deepEqual(seen.body, { html: "<p>hi</p>", settleMs: 5, probe: "1+2" });
			assert.deepEqual(r.consoleErrors, ["boom"]);
			assert.deepEqual(r.probeResult, { n: 3 });
			assert.equal(r.ok, false); // recomputed locally from the arrays
		},
	);
});

test("runDemo omits probeResult when the service sends none; errors surface", async () => {
	await withFake(
		(path) =>
			path === "/demo"
				? { status: 200, type: "application/json", body: JSON.stringify({ consoleErrors: [], pageErrors: [], failedRequests: [] }) }
				: { status: 401, type: "application/json", body: JSON.stringify({ error: "unauthorized" }) },
		async (url) => {
			const client = createAndroidRenderClient({ url, token: "x" });
			const r = await client.runDemo("<p/>");
			assert.equal(r.ok, true);
			assert.equal("probeResult" in r, false);
			await assert.rejects(client.renderSvg("<svg/>"), /HTTP 401: unauthorized/);
		},
	);
});

test("renderSvg returns the PNG bytes", async () => {
	const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
	await withFake(
		() => ({ status: 200, type: "image/png", body: png }),
		async (url, seen) => {
			const client = createAndroidRenderClient({ url, token: "x" });
			const out = await client.renderSvg("<svg/>", { width: 300, height: 200 });
			assert.equal(seen.path, "/svg");
			assert.deepEqual(seen.body, { svg: "<svg/>", width: 300, height: 200 });
			assert.deepEqual(out, png);
		},
	);
});

test("createAndroidHeadless is available and delegates SVG/PDF to the base", async () => {
	const calls: string[] = [];
	const base = {
		...realHeadless,
		renderSvg: async () => (calls.push("svg"), Buffer.from("s")),
		renderPdfPages: async () => (calls.push("pdf"), []),
	};
	const client = { runDemo: async () => (calls.push("demo"), { consoleErrors: [], pageErrors: [], failedRequests: [], ok: true }), renderSvg: async () => Buffer.from("x") };
	const api = createAndroidHeadless(client, base);
	assert.equal(api.available(), true);
	assert.equal(api.unavailableReason(), null);
	await api.runDemo("<p/>");
	await api.renderSvg("<svg/>");
	await api.renderPdfPages("a.pdf", [1]);
	assert.deepEqual(calls, ["demo", "svg", "pdf"]);
});

test("getHeadless stays the desktop implementation off Android", () => {
	const saved = { ...process.env };
	try {
		delete process.env.LH_ANDROID;
		process.env.LH_ANDROID_RENDER_URL = "http://127.0.0.1:1";
		process.env.LH_ANDROID_RENDER_TOKEN = "t";
		assert.equal(getHeadless(), realHeadless);
		process.env.LH_ANDROID = "1";
		assert.notEqual(getHeadless(), realHeadless);
		assert.equal(getHeadless().available(), true);
	} finally {
		process.env = saved;
	}
});
