import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
type Reply = { status: number; headers: Record<string, string>; body: string };
const { callbackResponse } = require("../electron/chatgpt-callback.cjs") as {
	callbackResponse(o?: { android?: boolean; failed?: boolean; nonce?: string }): Reply;
};

test("desktop/web callback response is the original plain text", () => {
	for (const failed of [false, true]) {
		const r = callbackResponse({ android: false, failed, nonce: "ignored" });
		assert.equal(r.status, 200);
		assert.deepEqual(r.headers, { "content-type": "text/plain; charset=utf-8" });
		assert.equal(r.body, "Return to LearnHarness to view the sign-in result. You may close this tab.");
	}
	assert.equal(callbackResponse().body, callbackResponse({ android: false }).body);
});

test("android callback page links back to the app and carries a nonce CSP", () => {
	const ok = callbackResponse({ android: true, nonce: "abc" });
	assert.equal(ok.headers["content-type"], "text/html; charset=utf-8");
	assert.match(ok.body, /learnharness:\/\/auth-done\?status=ok/);
	assert.match(ok.body, /Return to LearnHarness<\/a>/);
	assert.match(ok.body, /<script nonce="abc">/);
	assert.equal(ok.headers["content-security-policy"], "default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-abc'");
	const bad = callbackResponse({ android: true, failed: true, nonce: "abc" });
	assert.match(bad.body, /status=error/);
	assert.doesNotMatch(bad.body, /status=ok/);
});

test("the OAuth listener serves the app-return page only on android", async () => {
	const { createChatGPT } = require("../electron/chatgpt.cjs") as { createChatGPT(o: Record<string, unknown>): { login(): Promise<unknown>; close(): void } };
	for (const android of [false, true]) {
		let authorize = "";
		const service = createChatGPT({
			android, store: { read: async () => null, write: async () => {} },
			openExternal: async (url: string) => { authorize = url; },
			fetch: async () => { throw new Error("offline"); },
		});
		await service.login();
		const params = new URL(authorize).searchParams;
		const redirect = new URL(params.get("redirect_uri")!);
		redirect.search = new URLSearchParams({ state: params.get("state")!, error: "access_denied" }).toString();
		const res = await fetch(redirect);
		const text = await res.text();
		assert.equal(res.headers.get("content-type"), android ? "text/html; charset=utf-8" : "text/plain; charset=utf-8");
		assert.equal(text.includes("learnharness://auth-done?status=error"), android);
		assert.equal(res.headers.get("content-security-policy") === "default-src 'none'", !android);
		service.close();
	}
});
