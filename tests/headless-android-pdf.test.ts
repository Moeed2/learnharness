import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { AndroidPdfError, PDF_INLINE_LIMIT, createAndroidRenderClient } from "../src/agent/subagents/headless-android.ts";
import { getHeadless } from "../src/agent/subagents/headless.ts";

interface Seen {
	path?: string;
	auth?: string;
	body?: Record<string, unknown>;
}

async function withFake(
	reply: { status: number; body: unknown },
	fn: (url: string, seen: Seen) => Promise<void>,
): Promise<void> {
	const seen: Seen = {};
	const server = http.createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (c) => chunks.push(c));
		req.on("end", () => {
			seen.path = req.url;
			seen.auth = req.headers.authorization;
			seen.body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
			res.writeHead(reply.status, { "content-type": "application/json" });
			res.end(JSON.stringify(reply.body));
		});
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	try {
		await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen);
	} finally {
		server.close();
	}
}

const PDF_BYTES = Buffer.from("%PDF-1.4\nfake");

async function withPdfFile(bytes: Buffer, fn: (file: string) => Promise<void>): Promise<void> {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-pdf-client-"));
	const file = path.join(dir, "a.pdf");
	fs.writeFileSync(file, bytes);
	try {
		await fn(file);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

test("renderPdf posts inline base64 + pages + dpi and decodes the page PNGs", async () => {
	const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 9, 9]);
	await withPdfFile(PDF_BYTES, (file) =>
		withFake(
			{ status: 200, body: { numPages: 3, pages: [{ page: 2, width: 10, height: 20, png: png.toString("base64") }] } },
			async (url, seen) => {
				const client = createAndroidRenderClient({ url, token: "tok" });
				const out = await client.renderPdf(file, [2, 9], { dpi: 100 });
				assert.equal(seen.path, "/pdf");
				assert.equal(seen.auth, "Bearer tok");
				assert.deepEqual(seen.body, { pdfBase64: PDF_BYTES.toString("base64"), pages: [2, 9], dpi: 100 });
				assert.equal(out.length, 1);
				assert.equal(out[0]!.page, 2);
				assert.deepEqual(out[0]!.png, png);
			},
		),
	);
});

test("renderPdf defaults to 150 dpi and sends a path for PDFs over the inline limit", async () => {
	await withPdfFile(Buffer.alloc(PDF_INLINE_LIMIT + 1, 0x20), (file) =>
		withFake({ status: 200, body: { numPages: 1, pages: [] } }, async (url, seen) => {
			const client = createAndroidRenderClient({ url, token: "t" });
			assert.deepEqual(await client.renderPdf(file, [1]), []);
			assert.deepEqual(seen.body, { path: file, pages: [1], dpi: 150 });
		}),
	);
});

test("renderPdf maps encrypted service errors to AndroidPdfError; other failures stay plain errors", async () => {
	await withPdfFile(PDF_BYTES, async (file) => {
		await withFake({ status: 422, body: { error: "PDF is password protected", code: "encrypted" } }, async (url) => {
			const client = createAndroidRenderClient({ url, token: "t" });
			await assert.rejects(client.renderPdf(file, [1]), (e: unknown) => {
				assert.ok(e instanceof AndroidPdfError);
				assert.equal(e.code, "encrypted");
				assert.match(e.message, /password protected/);
				return true;
			});
			await assert.rejects(client.renderPdf(file, [1], { dpi: 0 }), /DPI/);
		});
		await withFake({ status: 500, body: { error: "oom" } }, async (url) => {
			const client = createAndroidRenderClient({ url, token: "t" });
			await assert.rejects(client.renderPdf(file, [1]), /HTTP 500: oom/);
		});
	});
});

test("getHeadless on Android routes renderPdfPages to /pdf", async () => {
	const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1]);
	const saved = { ...process.env };
	try {
		await withPdfFile(PDF_BYTES, (file) =>
			withFake({ status: 200, body: { numPages: 1, pages: [{ page: 1, png: png.toString("base64") }] } }, async (url, seen) => {
				process.env.LH_ANDROID = "1";
				process.env.LH_ANDROID_RENDER_URL = url;
				process.env.LH_ANDROID_RENDER_TOKEN = "t";
				const out = await getHeadless().renderPdfPages(file, [1], { dpi: 72 });
				assert.equal(seen.path, "/pdf");
				assert.equal(out.length, 1);
				assert.equal(out[0]!.page, 1);
			}),
		);
	} finally {
		process.env = saved;
	}
});
