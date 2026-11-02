// Standalone Cloudflare Worker. No app dependencies and no credential logging.
const GOOGLE_TOKEN = "https://oauth2.googleapis.com/token";
const SCOPES = "https://www.googleapis.com/auth/drive.appdata openid email";
const TTL = 600;
const encoder = new TextEncoder();
const secret = v => typeof v === "string" && v.length > 0 && v.length <= 8192 && !/[\r\n\0]/.test(v);
const b64 = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes))).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
function unb64(value) {
	if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("invalid");
	return Uint8Array.from(atob(value.replaceAll("-", "+").replaceAll("_", "/")), c => c.charCodeAt(0));
}
const digest = async value => b64(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
async function key(value) { return crypto.subtle.importKey("raw", encoder.encode(value), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]); }
async function sign(value, stateSecret) { return b64(await crypto.subtle.sign("HMAC", await key(stateSecret), encoder.encode(value))); }
const headers = { "Cache-Control": "no-store", "Pragma": "no-cache", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'", "Strict-Transport-Security": "max-age=31536000" };
const json = (value, status = 200) => Response.json(value, { status, headers });
const fail = (status, error) => json({ error }, status);

async function boundedJson(request) {
	if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) throw { status: 415 };
	if (Number(request.headers.get("content-length")) > 12_288) throw { status: 413 };
	const reader = request.body?.getReader();
	if (!reader) throw { status: 400 };
	const chunks = [];
	let size = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > 12_288) { await reader.cancel(); throw { status: 413 }; }
			chunks.push(value);
		}
	} finally { reader.releaseLock(); }
	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
	let value;
	try { value = JSON.parse(new TextDecoder().decode(bytes)); } catch { throw { status: 400 }; }
	if (!value || typeof value !== "object" || Array.isArray(value)) throw { status: 400 };
	return value;
}

/** Test seam keeps all network calls stubbed; production exports the default below. */
export function createRelay({ fetch: request = globalThis.fetch, now = Date.now } = {}) {
	// An optimization within one isolate, not a cross-region KV lock. Stores
	// challenge strings only and never retains tokens or completed responses.
	const exchanging = new Set();
	async function exchange(env, form) {
		let response;
		try {
			response = await request(GOOGLE_TOKEN, { method: "POST", redirect: "error", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ ...form, client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET }).toString(), signal: AbortSignal.timeout(15_000) });
		} catch { return { status: 503 }; }
		let value;
		try { value = await response.json(); } catch { return { status: 502 }; }
		if (!response.ok) return { status: value?.error === "invalid_grant" ? 401 : 503 };
		if (!secret(value?.access_token) || value.token_type && value.token_type.toLowerCase() !== "bearer" || !Number.isFinite(value?.expires_in) || value.expires_in <= 0 || value.expires_in > 86400) return { status: 502 };
		if (value.scope && !value.scope.split(" ").includes("https://www.googleapis.com/auth/drive.appdata")) return { status: 400 };
		const tokens = { access_token: value.access_token, expires_in: value.expires_in };
		if (value.refresh_token !== undefined) {
			if (!secret(value.refresh_token)) return { status: 502 };
			tokens.refresh_token = value.refresh_token;
		}
		return { status: 200, value, tokens };
	}
	async function handle(req, env) {
		const url = new URL(req.url);
		if (!secret(env.GOOGLE_CLIENT_ID) || !secret(env.GOOGLE_CLIENT_SECRET) || typeof env.STATE_SECRET !== "string" || env.STATE_SECRET.length < 32 || !env.AUTH_CODES) return fail(503, "relay_not_configured");
		let origin;
		try { const base = new URL(env.RELAY_URL); if (base.protocol !== "https:" || base.origin !== env.RELAY_URL) throw new Error(); origin = base.origin; } catch { return fail(503, "relay_not_configured"); }
		if (url.origin !== origin || url.protocol !== "https:" || req.url.length > 12_288) return fail(400, "invalid_request");
		// This API is for the local Node runtime, not browser JavaScript. No CORS.
		if (req.headers.has("origin") && req.headers.get("origin") !== origin) return fail(403, "origin_not_allowed");
		if (req.method === "GET" && url.pathname === "/authorize") {
			const challenge = url.searchParams.get("challenge");
			if (!challenge || !/^[A-Za-z0-9_-]{43}$/.test(challenge) || url.searchParams.getAll("challenge").length !== 1) return fail(400, "invalid_challenge");
			const payload = b64(encoder.encode(JSON.stringify({ challenge, exp: Math.floor(now() / 1000) + TTL })));
			const state = `${payload}.${await sign(payload, env.STATE_SECRET)}`;
			const google = new URL("https://accounts.google.com/o/oauth2/v2/auth");
			google.search = new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, redirect_uri: `${origin}/callback`, response_type: "code", scope: SCOPES, access_type: "offline", prompt: "consent", code_challenge: challenge, code_challenge_method: "S256", state }).toString();
			return new Response(null, { status: 302, headers: { ...headers, Location: google.href } });
		}
		if (req.method === "GET" && url.pathname === "/callback") {
			let state;
			try {
				const parts = (url.searchParams.get("state") ?? "").split(".");
				if (parts.length !== 2 || parts[0].length > 1024 || !await crypto.subtle.verify("HMAC", await key(env.STATE_SECRET), unb64(parts[1]), encoder.encode(parts[0]))) throw new Error();
				state = JSON.parse(new TextDecoder().decode(unb64(parts[0])));
				const seconds = Math.floor(now() / 1000);
				if (!/^[A-Za-z0-9_-]{43}$/.test(state.challenge) || !Number.isInteger(state.exp) || state.exp <= seconds || state.exp > seconds + TTL) throw new Error();
			} catch { return fail(400, "invalid_state"); }
			if (url.searchParams.has("error")) return new Response("Google sign-in was not approved. Return to the app and start sign-in again.", { status: 400, headers });
			const code = url.searchParams.get("code");
			if (!secret(code) || url.searchParams.getAll("code").length !== 1 || url.searchParams.getAll("state").length !== 1) return fail(400, "invalid_code");
			await env.AUTH_CODES.put(`code:${state.challenge}`, JSON.stringify({ code, exp: state.exp }), { expirationTtl: TTL });
			return new Response("Google sign-in approved. Return to LearnHarness to finish connecting.", { headers });
		}
		if (req.method !== "POST" || !["/token", "/refresh"].includes(url.pathname)) return fail(404, "not_found");
		const body = await boundedJson(req);
		if (url.pathname === "/refresh") {
			if (!secret(body.refresh_token) || Object.keys(body).some(k => k !== "refresh_token")) return fail(400, "invalid_request");
			const result = await exchange(env, { grant_type: "refresh_token", refresh_token: body.refresh_token });
			return result.status === 200 ? json(result.tokens) : fail(result.status, result.status === 401 ? "sign_in_required" : "refresh_unavailable");
		}
		if (typeof body.verifier !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(body.verifier) || Object.keys(body).some(k => k !== "verifier")) return fail(400, "invalid_verifier");
		const challenge = await digest(body.verifier);
		if (exchanging.has(challenge)) return json({ pending: true }, 202);
		exchanging.add(challenge);
		try {
		const storageKey = `code:${challenge}`;
		const stored = await env.AUTH_CODES.get(storageKey);
		if (!stored) return json({ pending: true }, 202);
		let record;
		try { record = JSON.parse(stored); } catch { return fail(410, "sign_in_required"); }
		if (!secret(record.code) || !Number.isInteger(record.exp) || record.exp <= Math.floor(now() / 1000)) { await env.AUTH_CODES.delete(storageKey); return fail(410, "sign_in_expired"); }
		// KV is eventually consistent: it cannot lock or atomically consume a code.
		// Google enforces single redemption. Keep the code on transient failures;
		// never delete on invalid_grant (a concurrent winning exchange may exist).
		const result = await exchange(env, { grant_type: "authorization_code", code: record.code, code_verifier: body.verifier, redirect_uri: `${origin}/callback` });
		if (result.status !== 200) return fail(result.status === 401 ? 410 : result.status, result.status === 401 ? "sign_in_required" : "exchange_unavailable");
		let claims;
		try {
			// This ID token came directly from Google's authenticated HTTPS token
			// endpoint, never from a browser/device. Decode only in this trust context.
			const parts = result.value.id_token.split(".");
			if (parts.length !== 3) throw new Error();
			claims = JSON.parse(new TextDecoder().decode(unb64(parts[1])));
			if (!["https://accounts.google.com", "accounts.google.com"].includes(claims.iss) || claims.aud !== env.GOOGLE_CLIENT_ID || !Number.isFinite(claims.exp) || claims.exp <= now() / 1000 || typeof claims.sub !== "string" || !claims.sub || claims.sub.length > 255 || !result.tokens.refresh_token) throw new Error();
		} catch { return fail(502, "invalid_google_identity"); }
		// Deleting is best-effort: a KV failure must not lose already-issued tokens.
		try { await env.AUTH_CODES.delete(storageKey); } catch { /* TTL and Google's one-use code still enforce expiry/redemption. */ }
		return json({ ...result.tokens, accountId: claims.sub, ...(claims.email_verified === true && typeof claims.email === "string" && claims.email.length <= 320 ? { accountLabel: claims.email } : {}) });
		} finally { exchanging.delete(challenge); }
	}
	return { async fetch(req, env) {
		try { return await handle(req, env); } catch (error) { return fail([400, 413, 415].includes(error?.status) ? error.status : 503, "request_failed"); }
	} };
}

export default createRelay();
