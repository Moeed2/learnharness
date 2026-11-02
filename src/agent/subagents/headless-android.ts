import * as fs from "node:fs";
import * as path from "node:path";
import type {
	DemoRunResult,
	HeadlessApi,
	RenderedPdfPage,
	RenderPdfOptions,
	RenderSvgOptions,
	RunDemoOptions,
} from "./headless";

/**
 * Android render-service client (docs/android.md, "Render service").
 * The Kotlin shell runs a loopback HTTP server and hands Node its URL and a
 * bearer token via LH_ANDROID_RENDER_URL / LH_ANDROID_RENDER_TOKEN. Demos and
 * the SVG fallback render in an offscreen system WebView there.
 */

export interface AndroidRenderConfig {
	url: string;
	token: string;
}

export function androidRenderConfig(
	env: Record<string, string | undefined> = process.env,
): AndroidRenderConfig | null {
	if (env.LH_ANDROID !== "1") return null;
	const url = env.LH_ANDROID_RENDER_URL;
	const token = env.LH_ANDROID_RENDER_TOKEN;
	if (!url || !token) return null;
	try {
		const u = new URL(url);
		if (u.protocol !== "http:" || (u.hostname !== "127.0.0.1" && u.hostname !== "localhost")) return null;
	} catch {
		return null;
	}
	return { url: url.replace(/\/+$/, ""), token };
}

class AndroidRenderHttpError extends Error {
	constructor(
		message: string,
		readonly detail: string,
		readonly code?: string,
	) {
		super(message);
	}
}

async function post(cfg: AndroidRenderConfig, path: string, body: unknown, timeoutMs: number): Promise<Response> {
	const res = await fetch(`${cfg.url}${path}`, {
		method: "POST",
		headers: { authorization: `Bearer ${cfg.token}`, "content-type": "application/json" },
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(timeoutMs),
	});
	if (!res.ok) {
		let detail = `HTTP ${res.status}`;
		let message = "";
		let code: string | undefined;
		try {
			const j = (await res.json()) as { error?: string; code?: string };
			if (j.error) {
				detail += `: ${j.error}`;
				message = j.error;
			}
			code = j.code;
		} catch {
			/* no JSON body */
		}
		throw new AndroidRenderHttpError(`Android render service ${path} failed (${detail})`, message || detail, code);
	}
	return res;
}

/** Failure from POST /pdf. code "encrypted" | "invalid" come from PdfRenderer. */
export class AndroidPdfError extends Error {
	constructor(
		message: string,
		readonly code: string,
	) {
		super(message);
		this.name = "AndroidPdfError";
	}
}

/** PDFs up to this size travel in the request body; larger ones by file path
 *  (the service caps request bodies at 16 MiB and base64 adds a third). */
export const PDF_INLINE_LIMIT = 9 * 1024 * 1024;

export interface AndroidRenderClient {
	renderPdf(pdfPath: string, pages: number[], opts?: RenderPdfOptions): Promise<RenderedPdfPage[]>;
	runDemo(html: string, opts?: RunDemoOptions): Promise<DemoRunResult>;
	renderSvg(svg: string, opts?: RenderSvgOptions): Promise<Buffer>;
}

export function createAndroidRenderClient(cfg: AndroidRenderConfig): AndroidRenderClient {
	return {
		async renderPdf(pdfPath, pages, opts = {}) {
			const dpi = opts.dpi ?? 150;
			if (!Number.isFinite(dpi) || dpi <= 0) throw new Error("PDF render DPI must be finite and positive");
			const abs = path.resolve(pdfPath);
			const size = fs.statSync(abs).size;
			const source = size <= PDF_INLINE_LIMIT ? { pdfBase64: fs.readFileSync(abs).toString("base64") } : { path: abs };
			let res: Response;
			try {
				res = await post(cfg, "/pdf", { ...source, pages, dpi }, 120_000);
			} catch (e) {
				if (e instanceof AndroidRenderHttpError && e.code) throw new AndroidPdfError(e.detail, e.code);
				throw e;
			}
			const j = (await res.json()) as { pages?: { page: number; png: string }[] };
			return (j.pages ?? []).map((p) => ({ page: p.page, png: Buffer.from(p.png, "base64") }));
		},
		async runDemo(html, opts = {}) {
			const settleMs = opts.settleMs ?? 2000;
			const res = await post(cfg, "/demo", { html, settleMs, ...(opts.probe ? { probe: opts.probe } : {}) }, settleMs + 90_000);
			const j = (await res.json()) as Partial<DemoRunResult>;
			const consoleErrors = Array.isArray(j.consoleErrors) ? j.consoleErrors.map(String) : [];
			const pageErrors = Array.isArray(j.pageErrors) ? j.pageErrors.map(String) : [];
			const failedRequests = Array.isArray(j.failedRequests) ? j.failedRequests.map(String) : [];
			return {
				consoleErrors,
				pageErrors,
				failedRequests,
				...("probeResult" in j ? { probeResult: j.probeResult } : {}),
				ok: consoleErrors.length === 0 && pageErrors.length === 0 && failedRequests.length === 0,
			};
		},
		async renderSvg(svg, opts = {}) {
			const res = await post(
				cfg,
				"/svg",
				{ svg, ...(opts.width ? { width: opts.width } : {}), ...(opts.height ? { height: opts.height } : {}) },
				60_000,
			);
			return Buffer.from(await res.arrayBuffer());
		},
	};
}

/** The client for this process, or null off-Android / when the env is absent. */
export function androidRenderClientFromEnv(env: Record<string, string | undefined> = process.env): AndroidRenderClient | null {
	const cfg = androidRenderConfig(env);
	return cfg ? createAndroidRenderClient(cfg) : null;
}

/** HeadlessApi that renders demos and PDF pages through the Kotlin service.
 *  SVG stays with the base implementation (resvg-wasm, whose fallback itself
 *  uses the render service's WebView on Android). */
export function createAndroidHeadless(client: AndroidRenderClient, base: HeadlessApi): HeadlessApi {
	return {
		available: () => true,
		unavailableReason: () => null,
		runDemo: (html, opts) => client.runDemo(html, opts),
		renderSvg: (svg, opts) => base.renderSvg(svg, opts),
		renderPdfPages: (pdfPath, pages, opts) => client.renderPdf(pdfPath, pages, opts),
	};
}
