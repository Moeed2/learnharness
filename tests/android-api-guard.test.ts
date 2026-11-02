import { after, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { NextRequest } from "next/server";
import { desktopAPIAuthorized, cookieValue, ANDROID_COOKIE } from "../src/server/desktop-access.ts";
import { proxy } from "../proxy.ts";

const secret = "ab12".repeat(24); // 96 chars
const android = { LH_ANDROID: "1", LH_ANDROID_API_SECRET: secret };
const withCookie = (cookie: string) => new Headers({ cookie });

test("cookieValue parses a Cookie header", () => {
	assert.equal(cookieValue(null, "a"), undefined);
	assert.equal(cookieValue("a=1; b=2", "b"), "2");
	assert.equal(cookieValue("xlh_android=1; lh_android=ok", "lh_android"), "ok");
	assert.equal(cookieValue("a", "a"), undefined);
});

test("android server accepts only the exact cookie secret", () => {
	assert.equal(desktopAPIAuthorized(withCookie(`${ANDROID_COOKIE}=${secret}`), android), true);
	assert.equal(desktopAPIAuthorized(withCookie(`theme=dark; ${ANDROID_COOKIE}=${secret}`), android), true);
	assert.equal(desktopAPIAuthorized(new Headers(), android), false);
	assert.equal(desktopAPIAuthorized(withCookie(`${ANDROID_COOKIE}=${secret.slice(1)}`), android), false);
	assert.equal(desktopAPIAuthorized(withCookie(`${ANDROID_COOKIE}=${secret}x`), android), false);
	assert.equal(desktopAPIAuthorized(withCookie(`${ANDROID_COOKIE}=${"c".repeat(secret.length)}`), android), false);
	assert.equal(desktopAPIAuthorized(withCookie(`other=${secret}`), android), false);
	// The desktop header is not an Android credential.
	assert.equal(desktopAPIAuthorized(new Headers({ "x-learnharness-desktop": secret }), android), false);
});

test("android server fails closed without a valid secret", () => {
	const short = "a".repeat(63);
	assert.equal(desktopAPIAuthorized(new Headers(), { LH_ANDROID: "1" }), false);
	assert.equal(desktopAPIAuthorized(withCookie(`${ANDROID_COOKIE}=`), { LH_ANDROID: "1" }), false);
	assert.equal(desktopAPIAuthorized(withCookie(`${ANDROID_COOKIE}=${short}`), { LH_ANDROID: "1", LH_ANDROID_API_SECRET: short }), false);
});

test("desktop and browser modes are unchanged and ignore the android secret", () => {
	assert.equal(desktopAPIAuthorized(new Headers(), {}), true); // web mode stays open
	assert.equal(desktopAPIAuthorized(new Headers(), { LH_ANDROID_API_SECRET: secret }), true); // does not flip web mode
	const desktop = { LH_DESKTOP_SERVER: "1", LH_DESKTOP_API_SECRET: "d".repeat(64) };
	assert.equal(desktopAPIAuthorized(new Headers({ "x-learnharness-desktop": "d".repeat(64) }), desktop), true);
	assert.equal(desktopAPIAuthorized(withCookie(`${ANDROID_COOKIE}=${secret}`), { ...desktop, LH_ANDROID_API_SECRET: secret }), false);
});

test("android web mode: subscription transport stays enabled (LH_ANDROID_API_SECRET is not a desktop marker)", async () => {
	const saved = { s: process.env.LH_DESKTOP_SERVER, k: process.env.LH_DESKTOP_API_SECRET, a: process.env.LH_ANDROID_API_SECRET };
	delete process.env.LH_DESKTOP_SERVER;
	delete process.env.LH_DESKTOP_API_SECRET;
	process.env.LH_ANDROID_API_SECRET = secret;
	try {
		const { configureWebSubscriptionRuntime, webSubscriptionsEnabled } = await import("../src/agent/subscription-runtime.ts");
		configureWebSubscriptionRuntime((async () => undefined) as never);
		assert.equal(webSubscriptionsEnabled(), true);
	} finally {
		for (const [k, v] of [["LH_DESKTOP_SERVER", saved.s], ["LH_DESKTOP_API_SECRET", saved.k], ["LH_ANDROID_API_SECRET", saved.a]] as const) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
	}
});

test("proxy returns 403 without the cookie and passes with it on android", () => {
	const saved = { a: process.env.LH_ANDROID, s: process.env.LH_ANDROID_API_SECRET };
	process.env.LH_ANDROID = "1";
	process.env.LH_ANDROID_API_SECRET = secret;
	try {
		const url = "http://127.0.0.1:1234/api/settings";
		const denied = proxy(new NextRequest(url));
		assert.equal(denied.status, 403);
		assert.equal(denied.headers.get("cache-control"), "no-store");
		const ok = proxy(new NextRequest(url, { headers: { cookie: `${ANDROID_COOKIE}=${secret}` } }));
		assert.equal(ok.headers.get("x-middleware-next"), "1");
	} finally {
		if (saved.a === undefined) delete process.env.LH_ANDROID;
		else process.env.LH_ANDROID = saved.a;
		if (saved.s === undefined) delete process.env.LH_ANDROID_API_SECRET;
		else process.env.LH_ANDROID_API_SECRET = saved.s;
	}
});

test("android catalog exposes only the chatgpt provider", async () => {
	const data = fs.mkdtempSync(path.join(os.tmpdir(), "lh-android-catalog-"));
	process.env.LH_DATA_DIR = data;
	process.env.LH_ANDROID = "1";
	after(() => {
		delete process.env.LH_ANDROID;
		fs.rmSync(data, { recursive: true, force: true });
	});
	const { catalogProviders, modelCatalog, validateChatSettings } = await import("../src/server/model-catalog.ts");
	assert.deepEqual(catalogProviders().map((p) => p.id), ["chatgpt"]);
	assert.deepEqual(modelCatalog().models.filter((m) => m.provider !== "chatgpt"), []);
	assert.equal(validateChatSettings({ model: { provider: "openai", id: "gpt-5" } } as never).ok, false);
});
