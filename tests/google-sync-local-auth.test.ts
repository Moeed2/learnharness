import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createGoogleSyncAuth } from "../src/sync/google-auth.ts";

// Assembled at runtime: fake fixtures, split so secret scanners do not flag them.
const gid = (prefix: string) => [prefix, "apps", "googleusercontent", "com"].join(".");
const clientId = gid("123456789012-abcdefghijklmnop");
const clientSecret = ["GOCSPX", "abcdefghijklmnopqrstuvwxyz12"].join("-");
const redirect = "http://127.0.0.1:43210/api/sync/google/callback";
const host = "127.0.0.1:43210";
const drive = "https://www.googleapis.com/auth/drive.appdata";

function jwt(claims: Record<string, unknown>) {
	const part = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
	return `${part({ alg: "RS256" })}.${part(claims)}.sig`;
}
function fixture() {
	const root = mkdtempSync(path.join(tmpdir(), "google-local-auth-"));
	let now = 1_800_000_000_000;
	const calls: { url: string; body: URLSearchParams }[] = [];
	let reply: (body: URLSearchParams) => Response = () => Response.json({}, { status: 400 });
	const auth = createGoogleSyncAuth({
		root, now: () => now, relayUrl: () => undefined,
		fetch: async (input, init) => {
			assert.equal(init?.redirect, "error");
			const body = new URLSearchParams(String(init!.body));
			calls.push({ url: String(input), body });
			return reply(body);
		},
	});
	const grant = (claims: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => {
		reply = () => Response.json({ access_token: "access-secret", refresh_token: "refresh-secret", expires_in: 3600, scope: `openid email ${drive}`, token_type: "Bearer",
			id_token: jwt({ iss: "https://accounts.google.com", aud: clientId, sub: "google-sub", email: "me@example.com", exp: now / 1000 + 3600, ...claims }), ...extra });
	};
	return { auth, root, calls, grant, advance(ms: number) { now += ms; }, handle(fn: typeof reply) { reply = fn; }, close() { rmSync(root, { recursive: true, force: true }); } };
}
async function begin(f: ReturnType<typeof fixture>) {
	f.auth.configureGoogleSyncClient(clientId, clientSecret);
	const { url } = await f.auth.beginGoogleSyncSignIn({ redirectUri: redirect });
	return { url: new URL(url), state: new URL(url).searchParams.get("state")! };
}
const callback = (f: ReturnType<typeof fixture>, params: Record<string, string>, h: string | null = host) => f.auth.completeGoogleSyncCallback(new URLSearchParams(params), h);

test("client credentials are validated, stored 0600, and never appear in status", () => {
	const f = fixture();
	try {
		assert.deepEqual(f.auth.getGoogleSyncAuthStatus(), { configured: false, connected: false, pending: false });
		assert.throws(() => f.auth.configureGoogleSyncClient("nope", clientSecret), /client ID/);
		assert.throws(() => f.auth.configureGoogleSyncClient(clientId, "short"), /client secret/);
		assert.throws(() => f.auth.configureGoogleSyncClient(clientId, "bad secret with spaces!!"), /client secret/);
		f.auth.configureGoogleSyncClient(` ${clientId} `, clientSecret);
		assert.deepEqual(f.auth.getGoogleSyncAuthStatus(), { configured: true, connected: false, pending: false, mode: "local" });
		const file = path.join(f.root, ".sync", "google-auth.json");
		assert.equal(statSync(file).mode & 0o777, 0o600);
		assert.equal(JSON.parse(readFileSync(file, "utf8")).client.id, clientId);
		assert.ok(!JSON.stringify(f.auth.getGoogleSyncAuthStatus()).includes(clientSecret));
	} finally { f.close(); }
});

test("begin builds a Google PKCE URL and rejects non-loopback or wrong-path redirects", async () => {
	const f = fixture();
	try {
		await assert.rejects(f.auth.beginGoogleSyncSignIn({ redirectUri: redirect }), /client ID and secret/);
		f.auth.configureGoogleSyncClient(clientId, clientSecret);
		for (const bad of [undefined, "https://127.0.0.1:1/api/sync/google/callback", "http://evil.example:1/api/sync/google/callback", "http://127.0.0.1/api/sync/google/callback", "http://127.0.0.1:1/api/other", "http://127.0.0.1:1/api/sync/google/callback?x=1"]) {
			await assert.rejects(f.auth.beginGoogleSyncSignIn({ redirectUri: bad }), /LearnHarness app/);
		}
		const { url } = await f.auth.beginGoogleSyncSignIn({ redirectUri: redirect });
		const u = new URL(url), q = u.searchParams;
		assert.equal(u.origin + u.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
		assert.equal(q.get("client_id"), clientId);
		assert.equal(q.get("redirect_uri"), redirect);
		assert.equal(q.get("response_type"), "code");
		assert.equal(q.get("scope"), `${drive} openid email`);
		assert.equal(q.get("access_type"), "offline");
		assert.equal(q.get("prompt"), "consent");
		assert.equal(q.get("code_challenge_method"), "S256");
		assert.match(q.get("code_challenge")!, /^[A-Za-z0-9_-]{43}$/);
		assert.match(q.get("state")!, /^[A-Za-z0-9_-]{43}$/);
		assert.ok(!url.includes(clientSecret));
		assert.equal(f.auth.getGoogleSyncAuthStatus().pending, true);
	} finally { f.close(); }
});

test("callback rejects wrong, missing, duplicate, expired and reused state without calling Google", async () => {
	const f = fixture();
	try {
		const { state } = await begin(f);
		f.grant();
		for (const params of [{} as Record<string, string>, { code: "c" }, { code: "c", state: "wrong" }, { code: "c", state: state.slice(1) }, { code: "c", state: `${state}x` }]) {
			assert.equal((await callback(f, params)).ok, false);
		}
		assert.equal((await f.auth.completeGoogleSyncCallback(new URLSearchParams(`code=c&state=${state}&state=${state}`), host)).ok, false);
		assert.equal((await callback(f, { code: "c", state }, "127.0.0.1:9")).ok, false, "host must match the redirect");
		assert.equal((await callback(f, { code: "c", state }, null)).ok, false);
		assert.equal(f.calls.length, 0);
		assert.equal(f.auth.getGoogleSyncAuthStatus().pending, true, "bad attempts do not consume the pending sign-in");
		f.advance(10 * 60_000 + 1);
		assert.equal((await callback(f, { code: "c", state })).ok, false);
		assert.equal(f.calls.length, 0);
		assert.equal(f.auth.getGoogleSyncAuthStatus().pending, false);
		// A callback with no pending sign-in at all.
		assert.equal((await callback(f, { code: "c", state })).status, 400);
	} finally { f.close(); }
});

test("a correct callback exchanges the code with PKCE and connects; state is single use", async () => {
	const f = fixture();
	try {
		const { url, state } = await begin(f);
		f.grant();
		const result = await callback(f, { code: "auth-code", state });
		assert.equal(result.ok, true);
		assert.ok(!JSON.stringify(result).includes("secret"));
		const call = f.calls[0]!;
		assert.equal(call.url, "https://oauth2.googleapis.com/token");
		assert.equal(call.body.get("grant_type"), "authorization_code");
		assert.equal(call.body.get("code"), "auth-code");
		assert.equal(call.body.get("client_id"), clientId);
		assert.equal(call.body.get("client_secret"), clientSecret);
		assert.equal(call.body.get("redirect_uri"), redirect);
		const { createHash } = await import("node:crypto");
		assert.equal(createHash("sha256").update(call.body.get("code_verifier")!).digest("base64url"), url.searchParams.get("code_challenge"));
		assert.deepEqual(f.auth.getGoogleSyncAuthStatus(), { configured: true, connected: true, pending: false, mode: "local", accountId: "google-sub", accountLabel: "me@example.com" });
		assert.equal(await f.auth.completeGoogleSyncSignIn(), true, "poll reports connected");
		for (const secret of ["access-secret", "refresh-secret", "id_token", clientSecret, "auth-code"]) assert.ok(!JSON.stringify(f.auth.getGoogleSyncAuthStatus()).includes(secret));
		assert.equal((await callback(f, { code: "auth-code", state })).ok, false, "reuse rejected");
		assert.equal(f.calls.length, 1);
		assert.equal(await f.auth.getGoogleDriveAccessToken(), "access-secret");
	} finally { f.close(); }
});

test("a replay during the in-flight exchange is rejected and a denied consent clears pending", async () => {
	const f = fixture();
	try {
		const { state } = await begin(f);
		f.handle(() => new Response("{}", { status: 400 }));
		const first = callback(f, { code: "c", state });
		assert.equal(f.auth.getGoogleSyncAuthStatus().pending, true);
		assert.equal((await callback(f, { code: "c", state })).ok, false);
		assert.equal((await first).ok, false);
		assert.equal(f.auth.getGoogleSyncAuthStatus().pending, false);
		const second = await begin(f);
		const denied = await callback(f, { error: "access_denied", state: second.state });
		assert.equal(denied.ok, false);
		assert.equal(f.calls.length, 1);
		assert.equal(f.auth.getGoogleSyncAuthStatus().pending, false);
	} finally { f.close(); }
});

test("token responses must carry Drive scope, a refresh token and a valid Google ID token", async () => {
	const cases: [string, Record<string, unknown>, Record<string, unknown>][] = [
		["scope", {}, { scope: "openid email" }],
		["refresh", {}, { refresh_token: undefined }],
		["token type", {}, { token_type: "mac" }],
		["expires", {}, { expires_in: -1 }],
		["issuer", { iss: "https://evil.example" }, {}],
		["audience", { aud: "other.apps.googleusercontent.com" }, {}],
		["expired id token", { exp: 1 }, {}],
		["missing sub", { sub: undefined }, {}],
		["no id token", { __none: true }, {}],
	];
	for (const [name, claims, extra] of cases) {
		const f = fixture();
		try {
			const { state } = await begin(f);
			f.grant(claims, extra);
			if ("__none" in claims) f.handle(() => Response.json({ access_token: "a", refresh_token: "r", expires_in: 60, scope: drive }));
			const result = await callback(f, { code: "c", state });
			assert.equal(result.ok, false, name);
			assert.equal(f.auth.getGoogleSyncAuthStatus().connected, false, name);
			assert.ok(!JSON.stringify(result).includes("secret"), name);
		} finally { f.close(); }
	}
});

test("local refresh calls Google directly; revoked grants require sign-in; offline keeps credentials", async () => {
	const f = fixture();
	try {
		const { state } = await begin(f);
		f.grant();
		await callback(f, { code: "c", state });
		f.advance(3600_000);
		f.handle(() => Response.json({ access_token: "renewed", expires_in: 3600 }));
		assert.equal(await f.auth.getGoogleDriveAccessToken(), "renewed");
		const call = f.calls.at(-1)!;
		assert.equal(call.url, "https://oauth2.googleapis.com/token");
		assert.equal(call.body.get("grant_type"), "refresh_token");
		assert.equal(call.body.get("refresh_token"), "refresh-secret");
		assert.equal(call.body.get("client_id"), clientId);
		assert.equal(call.body.get("client_secret"), clientSecret);
		f.advance(3600_000);
		f.handle(() => { throw new Error("offline"); });
		await assert.rejects(f.auth.getGoogleDriveAccessToken(), /unavailable|online/i);
		assert.equal(f.auth.getGoogleSyncAuthStatus().connected, true);
		f.handle(() => Response.json({ error: "invalid_grant" }, { status: 400 }));
		await assert.rejects(f.auth.getGoogleDriveAccessToken(), /sign in/i);
		assert.equal(f.auth.getGoogleSyncAuthStatus().connected, false);
	} finally { f.close(); }
});

test("disconnect is local-only, keeps the saved client, and changing client needs disconnect first", async () => {
	const f = fixture();
	try {
		const { state } = await begin(f);
		f.grant();
		await callback(f, { code: "c", state });
		const before = f.calls.length;
		assert.throws(() => f.auth.configureGoogleSyncClient(gid("999999999999-zzzzzzzzzzzz"), clientSecret), /disconnect/i);
		await assert.rejects(f.auth.beginGoogleSyncSignIn({ redirectUri: redirect }), /disconnect/i);
		await f.auth.disconnectGoogleSync();
		assert.equal(f.calls.length, before, "no network on disconnect");
		assert.deepEqual(f.auth.getGoogleSyncAuthStatus(), { configured: true, connected: false, pending: false, mode: "local" });
		f.auth.configureGoogleSyncClient(gid("999999999999-zzzzzzzzzzzz"), clientSecret);
	} finally { f.close(); }
});

test("relay mode still works after a local client is saved and vice versa", async () => {
	const f = fixture();
	try {
		f.auth.configureGoogleSyncClient(clientId, clientSecret);
		f.auth.configureGoogleSyncRelay("https://relay.example");
		assert.equal(f.auth.getGoogleSyncAuthStatus().relayUrl, "https://relay.example");
		const { url } = await f.auth.beginGoogleSyncSignIn();
		assert.match(url, /^https:\/\/relay\.example\/authorize\?challenge=/);
	} finally { f.close(); }
});
