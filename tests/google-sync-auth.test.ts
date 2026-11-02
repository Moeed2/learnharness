import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { createGoogleSyncAuth } from "../src/sync/google-auth.ts";
import { createRelay } from "../cloud/google-drive-relay/worker.mjs";

const relayUrl = "https://relay.example";
function fixture() {
	const root = mkdtempSync(path.join(tmpdir(), "google-auth-"));
	let now = 1_800_000_000_000;
	let handler: typeof fetch = async () => Response.json({}, { status: 202 });
	const auth = createGoogleSyncAuth({ root, now: () => now, fetch: (input, init) => handler(input, init), relayUrl: () => undefined });
	return { auth, root, advance(ms: number) { now += ms; }, handle(fn: typeof fetch) { handler = fn; }, close() { rmSync(root, { recursive: true, force: true }); } };
}
const tokens = { access_token: "access-secret", refresh_token: "refresh-secret", expires_in: 3600, accountId: "google-sub", accountLabel: "me@example.com" };

test("offline disconnect is local-only and preserves another device's credentials", async () => {
	const laptop = fixture();
	const tablet = fixture();
	try {
		for (const [device, label] of [[laptop, "laptop"], [tablet, "tablet"]] as const) {
			device.auth.configureGoogleSyncRelay(relayUrl);
			await device.auth.beginGoogleSyncSignIn();
			device.handle(async () => Response.json({ ...tokens, access_token: `${label}-access`, refresh_token: `${label}-refresh` }));
			await device.auth.completeGoogleSyncSignIn();
		}
		const tabletFile = path.join(tablet.root, ".sync", "google-auth.json");
		const before = readFileSync(tabletFile, "utf8");
		let networkCalls = 0;
		laptop.handle(async () => { networkCalls++; throw new Error("offline"); });
		await laptop.auth.disconnectGoogleSync();
		await laptop.auth.disconnectGoogleSync();
		assert.equal(networkCalls, 0, "Disconnect must never call Google revocation or the relay");
		assert.deepEqual(laptop.auth.getGoogleSyncAuthStatus(), { configured: true, connected: false, pending: false, relayUrl });
		assert.deepEqual(JSON.parse(readFileSync(path.join(laptop.root, ".sync", "google-auth.json"), "utf8")), { relayUrl });
		assert.equal(readFileSync(tabletFile, "utf8"), before);
		assert.equal(tablet.auth.getGoogleSyncAuthStatus().connected, true);
		tablet.advance(3600_000);
		tablet.handle(async (url, init) => {
			assert.equal(String(url), `${relayUrl}/refresh`);
			assert.deepEqual(JSON.parse(init!.body as string), { refresh_token: "tablet-refresh" });
			return Response.json({ access_token: "tablet-renewed", expires_in: 3600 });
		});
		assert.equal(await tablet.auth.getGoogleDriveAccessToken(), "tablet-renewed");
	} finally { laptop.close(); tablet.close(); }
});

test("local PKCE pending/status, persistence, completion and refresh never expose credentials", async () => {
	const f = fixture();
	try {
		assert.deepEqual(f.auth.getGoogleSyncAuthStatus(), { configured: false, connected: false, pending: false });
		assert.throws(() => f.auth.configureGoogleSyncRelay("http://localhost:3000"));
		assert.throws(() => f.auth.configureGoogleSyncRelay("https://user:secret@relay.example"));
		f.auth.configureGoogleSyncRelay(relayUrl);
		const { url } = await f.auth.beginGoogleSyncSignIn();
		const challenge = new URL(url).searchParams.get("challenge");
		assert.match(challenge!, /^[A-Za-z0-9_-]{43}$/);
		f.handle(async (_url, init) => {
			const { verifier } = JSON.parse(init!.body as string);
			assert.equal(Buffer.from(verifier, "base64url").length, 32);
			assert.equal(createHash("sha256").update(verifier).digest("base64url"), challenge);
			return Response.json({}, { status: 202 });
		});
		assert.equal(await f.auth.completeGoogleSyncSignIn(), false);
		assert.equal(f.auth.getGoogleSyncAuthStatus().pending, true);
		f.handle(async () => Response.json(tokens));
		assert.equal(await f.auth.completeGoogleSyncSignIn(), true);
		assert.equal(await f.auth.completeGoogleSyncSignIn(), true, "completion is idempotent after success");
		const restarted = createGoogleSyncAuth({ root: f.root, relayUrl: () => undefined });
		assert.equal(restarted.getGoogleSyncAuthStatus().connected, true);
		assert.equal(await f.auth.getGoogleDriveAccessToken(), tokens.access_token);
		const status = f.auth.getGoogleSyncAuthStatus();
		assert.equal(status.accountId, tokens.accountId);
		assert.equal(status.pending, false);
		assert(!JSON.stringify(status).includes("secret"));
		const saved = readFileSync(path.join(f.root, ".sync", "google-auth.json"), "utf8");
		assert(!saved.includes("verifier"));
		if (process.platform !== "win32") assert.equal(statSync(path.join(f.root, ".sync", "google-auth.json")).mode & 0o777, 0o600);
		f.advance(3600_000);
		let calls = 0;
		f.handle(async (url, init) => {
			calls++;
			assert.equal(String(url), `${relayUrl}/refresh`);
			assert.deepEqual(JSON.parse(init!.body as string), { refresh_token: tokens.refresh_token });
			return Response.json({ access_token: "new-access", expires_in: 3600 });
		});
		assert.deepEqual(await Promise.all([f.auth.getGoogleDriveAccessToken(), f.auth.getGoogleDriveAccessToken()]), ["new-access", "new-access"]);
		assert.equal(calls, 1);
		f.handle(async () => { throw new Error("offline secret"); });
		await f.auth.disconnectGoogleSync();
		assert.equal(f.auth.getGoogleSyncAuthStatus().connected, false);
		assert(!readFileSync(path.join(f.root, ".sync", "google-auth.json"), "utf8").includes("secret"));
	} finally { f.close(); }
});

test("expired pending, failed refresh and disconnect during in-flight sign-in fail closed", async () => {
	const f = fixture();
	try {
		f.auth.configureGoogleSyncRelay(relayUrl);
		await f.auth.beginGoogleSyncSignIn();
		f.advance(11 * 60_000);
		assert.equal(f.auth.getGoogleSyncAuthStatus().pending, false);
		assert.equal(await f.auth.completeGoogleSyncSignIn(), false);
		await f.auth.beginGoogleSyncSignIn();
		let resolve!: (r: Response) => void;
		f.handle(async () => new Promise<Response>(r => { resolve = r; }));
		const pending = f.auth.completeGoogleSyncSignIn();
		await f.auth.disconnectGoogleSync();
		resolve(Response.json(tokens));
		await assert.rejects(pending, /changed|cancel/i);
		assert.equal(f.auth.getGoogleSyncAuthStatus().connected, false);
		await f.auth.beginGoogleSyncSignIn();
		f.handle(async () => Response.json(tokens));
		await f.auth.completeGoogleSyncSignIn();
		f.advance(3600_000);
		f.handle(async () => Response.json({ error: "invalid_grant", description: "secret" }, { status: 401 }));
		await assert.rejects(f.auth.getGoogleDriveAccessToken(), /sign in/i);
		assert.equal(f.auth.getGoogleSyncAuthStatus().connected, false);
	} finally { f.close(); }
});

function workerFixture() {
	let now = 1_800_000_000_000;
	const values = new Map<string, string>();
	const env = { GOOGLE_CLIENT_ID: "client", GOOGLE_CLIENT_SECRET: "server-secret", STATE_SECRET: "x".repeat(48), RELAY_URL: relayUrl,
		AUTH_CODES: { async get(k: string) { return values.get(k) ?? null; }, async put(k: string, v: string) { values.set(k, v); }, async delete(k: string) { values.delete(k); } } };
	let calls = 0;
	let used = false;
	const relay = createRelay({ now: () => now, fetch: async (_url, init) => {
		calls++;
		await new Promise(resolve => setTimeout(resolve, 10));
		const form = new URLSearchParams(init!.body as string);
		assert.equal(form.get("client_secret"), env.GOOGLE_CLIENT_SECRET);
		if (form.get("grant_type") === "refresh_token") return Response.json({ access_token: "refreshed", expires_in: 3600, id_token: "never-return" });
		if (used) return Response.json({ error: "invalid_grant" }, { status: 400 });
		used = true;
		assert.equal(form.get("code_verifier"), "v".repeat(43));
		const id = Buffer.from(JSON.stringify({ iss: "https://accounts.google.com", aud: "client", exp: now / 1000 + 3600, sub: "trusted-sub", email: "me@example.com", email_verified: true })).toString("base64url");
		return Response.json({ ...tokens, id_token: `header.${id}.signature`, token_type: "Bearer" });
	} });
	const request = (route: string, body?: unknown) => relay.fetch(new Request(relayUrl + route, body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }), env);
	return { request, values, advance(ms: number) { now += ms; }, get calls() { return calls; } };
}

test("worker signed state, PKCE, callback, one-use race and refresh whitelist", async () => {
	const f = workerFixture();
	const verifier = "v".repeat(43);
	const challenge = createHash("sha256").update(verifier).digest("base64url");
	const auth = await f.request(`/authorize?challenge=${challenge}`);
	assert.equal(auth.status, 302);
	assert.equal(auth.headers.get("access-control-allow-origin"), null);
	const google = new URL(auth.headers.get("location")!);
	assert.equal(google.searchParams.get("code_challenge"), challenge);
	assert.equal(google.searchParams.get("code_challenge_method"), "S256");
	assert.equal(google.searchParams.get("prompt"), "consent");
	assert.equal(google.searchParams.get("access_type"), "offline");
	assert(google.searchParams.get("scope")!.includes("drive.appdata"));
	const state = google.searchParams.get("state")!;
	assert.equal((await f.request(`/callback?code=code&state=${state}x`)).status, 400);
	assert.equal(f.values.size, 0);
	assert.equal((await f.request("/token", { verifier })).status, 202);
	assert.equal((await f.request(`/callback?code=code&state=${state}`)).status, 200);
	assert(!JSON.stringify([...f.values]).includes("access-secret"));
	assert.equal((await f.request("/token", { verifier: "w".repeat(43) })).status, 202);
	const results = await Promise.all([f.request("/token", { verifier }), f.request("/token", { verifier })]);
	assert.equal(results.filter(r => r.status === 200).length, 1);
	assert.equal(f.calls, 1, "same-isolate duplicate polls must not concurrently redeem a Google code");
	const result = await results.find(r => r.status === 200)!.json();
	assert.equal(result.accountId, "trusted-sub");
	assert.equal(result.id_token, undefined);
	assert.equal((await f.request("/token", { verifier })).status, 202);
	const refreshed = await (await f.request("/refresh", { refresh_token: "device-secret" })).json();
	assert.deepEqual(refreshed, { access_token: "refreshed", expires_in: 3600 });
	assert.equal((await f.request("/refresh", { refresh_token: "x".repeat(20_000) })).status, 413);
	assert.equal((await f.request("/token", { verifier: "bad" })).status, 400);
	f.advance(11 * 60_000);
	assert.equal((await f.request(`/callback?code=code&state=${state}`)).status, 400);
});

test("relay configuration cannot silently redirect existing refresh credentials", async () => {
	const f = fixture();
	try {
		f.auth.configureGoogleSyncRelay(relayUrl);
		await f.auth.beginGoogleSyncSignIn();
		f.handle(async () => Response.json(tokens));
		await f.auth.completeGoogleSyncSignIn();
		assert.throws(() => f.auth.configureGoogleSyncRelay("https://other.example"), /disconnect/i);
		await assert.rejects(f.auth.beginGoogleSyncSignIn(), /disconnect/i);
		let calls = 0;
		const changed = createGoogleSyncAuth({ root: f.root, relayUrl: () => "https://other.example", fetch: async () => { calls++; throw new Error(); } });
		assert.equal(changed.getGoogleSyncAuthStatus().connected, false);
		await assert.rejects(changed.getGoogleDriveAccessToken(), /sign in/i);
		assert.equal(calls, 0);
	} finally { f.close(); }
});

test("worker rejects cross-origin, malformed, expired code and untrusted identity", async () => {
	const f = workerFixture();
	const verifier = "v".repeat(43);
	const challenge = createHash("sha256").update(verifier).digest("base64url");
	const authorize = await f.request(`/authorize?challenge=${challenge}`);
	const state = new URL(authorize.headers.get("location")!).searchParams.get("state");
	await f.request(`/callback?code=code&state=${state}`);
	f.advance(11 * 60_000);
	assert.equal((await f.request("/token", { verifier })).status, 410);
	assert.equal(f.calls, 0);
	const env = { GOOGLE_CLIENT_ID: "client", GOOGLE_CLIENT_SECRET: "secret", STATE_SECRET: "x".repeat(48), RELAY_URL: relayUrl, AUTH_CODES: {
		async get() { return JSON.stringify({ code: "code", exp: Math.floor(Date.now() / 1000) + 600 }); }, async put() {}, async delete() {},
	} };
	const relay = createRelay({ fetch: async () => Response.json({ ...tokens, id_token: "forged" }) });
	const request = (body: string, extra: Record<string, string> = {}) => relay.fetch(new Request(`${relayUrl}/token`, { method: "POST", headers: { "Content-Type": "application/json", ...extra }, body }), env);
	assert.equal((await request(JSON.stringify({ verifier }), { Origin: "https://evil.example" })).status, 403);
	assert.equal((await request("{" )).status, 400);
	assert.equal((await request(JSON.stringify({ verifier }))).status, 502);
});

test("worker transient exchange retry preserves code and failures never echo provider secrets", async () => {
	const values = new Map<string, string>();
	const env = { GOOGLE_CLIENT_ID: "client", GOOGLE_CLIENT_SECRET: "server-secret", STATE_SECRET: "s".repeat(48), RELAY_URL: relayUrl, AUTH_CODES: {
		async get(k: string) { return values.get(k) ?? null; }, async put(k: string, v: string) { values.set(k, v); }, async delete(k: string) { values.delete(k); },
	} };
	let calls = 0;
	const relay = createRelay({ fetch: async () => {
		calls++;
		if (calls === 1) return Response.json({ error: "server_error", code: "private-code", access_token: "private-token" }, { status: 503 });
		const identity = Buffer.from(JSON.stringify({ sub: "account", aud: "client", iss: "https://accounts.google.com", exp: Date.now() / 1000 + 3600 })).toString("base64url");
		return Response.json({ ...tokens, id_token: `a.${identity}.c` });
	} });
	const verifier = "v".repeat(43);
	const challenge = createHash("sha256").update(verifier).digest("base64url");
	const authorization = await relay.fetch(new Request(`${relayUrl}/authorize?challenge=${challenge}`), env);
	const state = new URL(authorization.headers.get("location")!).searchParams.get("state");
	await relay.fetch(new Request(`${relayUrl}/callback?state=${state}&code=private-code`), env);
	const poll = () => relay.fetch(new Request(`${relayUrl}/token`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ verifier }) }), env);
	const failed = await poll();
	assert.equal(failed.status, 503);
	assert.equal(await failed.text(), JSON.stringify({ error: "exchange_unavailable" }));
	assert.equal(values.size, 1, "transient failures retain the code for retry");
	assert.equal((await poll()).status, 200);
	assert.equal(values.size, 0);
});

test("temporary refresh failure keeps the connection usable for a later retry", async () => {
	const f = fixture();
	try {
		f.auth.configureGoogleSyncRelay(relayUrl);
		await f.auth.beginGoogleSyncSignIn();
		f.handle(async () => Response.json(tokens));
		await f.auth.completeGoogleSyncSignIn();
		f.advance(3600_000);
		f.handle(async () => Response.json({ token: "private" }, { status: 503 }));
		await assert.rejects(f.auth.getGoogleDriveAccessToken(), /try again later/i);
		assert.equal(f.auth.getGoogleSyncAuthStatus().connected, true);
		f.handle(async () => Response.json({ access_token: "retried", expires_in: 3600 }));
		assert.equal(await f.auth.getGoogleDriveAccessToken(), "retried");
	} finally { f.close(); }
});
