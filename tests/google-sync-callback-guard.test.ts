import { after, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { NextRequest } from "next/server";
import { proxy } from "../proxy.ts";

const secret = "ab12".repeat(24);

test("proxy exempts only GET /api/sync/google/callback from the guard (android and desktop)", () => {
	const keys = ["LH_ANDROID", "LH_ANDROID_API_SECRET", "LH_DESKTOP_SERVER", "LH_DESKTOP_API_SECRET"] as const;
	const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
	try {
		for (const mode of ["android", "desktop"] as const) {
			for (const key of keys) delete process.env[key];
			if (mode === "android") { process.env.LH_ANDROID = "1"; process.env.LH_ANDROID_API_SECRET = secret; }
			else { process.env.LH_DESKTOP_SERVER = "1"; process.env.LH_DESKTOP_API_SECRET = "d".repeat(64); }
			const base = "http://127.0.0.1:1234";
			const callback = `${base}/api/sync/google/callback?code=c&state=s`;
			assert.equal(proxy(new NextRequest(callback)).headers.get("x-middleware-next"), "1", mode);
			assert.equal(proxy(new NextRequest(callback, { method: "POST" })).status, 403, mode);
			for (const other of ["/api/sync", "/api/sync/google", "/api/sync/google/callback/", "/api/sync/google/callback/x", "/api/sync/google/callbackx", "/api/sync/conflicts", "/api/settings"]) {
				assert.equal(proxy(new NextRequest(`${base}${other}`)).status, 403, `${mode} ${other}`);
			}
		}
	} finally {
		for (const key of keys) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
	}
});

test("the callback route refuses requests without a valid pending state and returns no tokens", async () => {
	const data = fs.mkdtempSync(path.join(os.tmpdir(), "lh-google-callback-"));
	process.env.LH_DATA_DIR = data;
	after(() => { fs.rmSync(data, { recursive: true, force: true }); });
	const { syncGoogleCallbackResponse } = await import("../src/server/sync.ts");
	const response = await syncGoogleCallbackResponse(new Request("http://127.0.0.1:1234/api/sync/google/callback?code=c&state=s"));
	assert.equal(response.status, 400);
	assert.equal(response.headers.get("cache-control"), "no-store");
	assert.match(await response.text(), /not valid/);
	assert.equal((await syncGoogleCallbackResponse(new Request("http://127.0.0.1:1234/api/sync/google/callback", { method: "POST" }))).status, 405);
});
