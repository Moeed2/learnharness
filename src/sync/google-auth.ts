/** Node-only OAuth credentials. Never import this module into a browser bundle. */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { PATHS } from "../../config.ts";

type Credentials = { access_token: string; refresh_token: string; expiresAt: number; accountId: string; accountLabel?: string; relayUrl?: string; clientId?: string };
type Pending = { verifier: string; expiresAt: number; relayUrl?: string; state?: string; redirectUri?: string; clientId?: string; used?: boolean };
type LocalClient = { id: string; secret: string };
type Store = { relayUrl?: string; mode?: "local" | "relay"; client?: LocalClient; credentials?: Credentials; pending?: Pending };
type Active = { mode: "relay"; relayUrl: string } | { mode: "local"; client: LocalClient };
export type GoogleSyncAuthStatus = { configured: boolean; connected: boolean; pending: boolean; mode?: "local"; accountId?: string; accountLabel?: string; relayUrl?: string };
export type GoogleCallbackResult = { ok: boolean; status: number; message: string };
type Options = { root?: string; fetch?: typeof fetch; now?: () => number; relayUrl?: () => string | undefined };
/** Desktop-app OAuth clients (installed-app flow). Google documents that their secret is not confidential. */
export const GOOGLE_AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
export const GOOGLE_CALLBACK_PATH = "/api/sync/google/callback";
const SCOPE = "https://www.googleapis.com/auth/drive.appdata openid email";
const CLIENT_ID_PATTERN = /^[0-9]{6,32}-[a-z0-9]{8,64}\.apps\.googleusercontent\.com$/i;
const CLIENT_SECRET_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
const safeEqual = (a: string, b: string) => timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());
const validSecret = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 8192 && !/[\r\n\0]/.test(v);

function normalizeRelay(value: string): string {
	let url: URL;
	try { url = new URL(value); } catch { throw new Error("Enter the HTTPS Google sync relay URL."); }
	if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) throw new Error("Google sync relay must be an HTTPS origin without credentials, path or query.");
	return url.origin;
}

/** Dependency seam for isolated tests; production uses the singleton exports below. */
export function createGoogleSyncAuth(options: Options = {}) {
	const directory = path.join(options.root ?? PATHS.data, ".sync");
	const file = path.join(directory, "google-auth.json");
	const now = options.now ?? Date.now;
	const request = options.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
	const environmentRelay = options.relayUrl ?? (() => process.env.LH_GOOGLE_SYNC_RELAY_URL);
	let polling: Promise<boolean> | undefined;
	let refreshing: Promise<string> | undefined;
	let generation = 0;

	function checkDirectory(): void {
		mkdirSync(directory, { recursive: true, mode: 0o700 });
		if (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink()) throw new Error("Google sync credential directory is unsafe.");
		chmodSync(directory, 0o700);
	}
	function read(): Store {
		checkDirectory();
		if (!existsSync(file)) return {};
		const stat = lstatSync(file);
		if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32_768) throw new Error("Google sync credential file is unsafe.");
		chmodSync(file, 0o600);
		try {
			const value = JSON.parse(readFileSync(file, "utf8"));
			if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
			return value as Store;
		} catch { throw new Error("Google sync credential file is unreadable. Disconnect and configure sync again."); }
	}
	function write(value: Store): void {
		checkDirectory();
		const temp = path.join(directory, `.google-auth-${randomBytes(12).toString("hex")}.tmp`);
		const fd = openSync(temp, "wx", 0o600);
		try { writeFileSync(fd, JSON.stringify(value)); fsyncSync(fd); } finally { closeSync(fd); }
		try { renameSync(temp, file); chmodSync(file, 0o600); } finally { if (existsSync(temp)) unlinkSync(temp); }
	}
	function relay(store: Store): string | undefined {
		const value = environmentRelay() || store.relayUrl;
		return value ? normalizeRelay(value) : undefined;
	}
	/** Relay mode when the environment or an explicit choice says so; local Desktop-client mode is the default. */
	function active(store: Store): Active | undefined {
		if (environmentRelay() || store.mode === "relay" || (!store.mode && store.relayUrl)) {
			const url = relay(store);
			return url ? { mode: "relay", relayUrl: url } : undefined;
		}
		return store.client ? { mode: "local", client: store.client } : undefined;
	}
	const owns = (credentials: Credentials | undefined, scope: Active | undefined): credentials is Credentials =>
		!!credentials && !!scope && (scope.mode === "relay" ? !credentials.clientId && credentials.relayUrl === scope.relayUrl : credentials.clientId === scope.client.id);
	const ownsPending = (pending: Pending | undefined, scope: Active | undefined): pending is Pending =>
		!!pending && !!scope && (scope.mode === "relay" ? !pending.clientId && pending.relayUrl === scope.relayUrl : pending.clientId === scope.client.id);
	async function send(url: string, init: RequestInit, failure: string): Promise<{ status: number; value: Record<string, unknown> }> {
		let response: Response;
		try {
			response = await request(url, { ...init, method: "POST", redirect: "error", headers: { ...(init.headers as Record<string, string>), Accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
		} catch { throw new Error(failure); }
		if (response.status === 202) return { status: 202, value: {} };
		// Never include provider response bodies (which may contain credentials) in errors.
		if (!response.ok) return { status: response.status, value: {} };
		let value: Record<string, unknown>;
		try {
			const text = await response.text();
			if (text.length > 32_768) throw new Error();
			value = JSON.parse(text);
			if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
		} catch { throw new Error(failure.includes("relay") ? "Google sync relay returned an invalid response." : "Google returned an invalid response."); }
		return { status: response.status, value };
	}
	const post = (url: string, body: object) => send(url, { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }, "Google sync relay is unavailable. Try again when online.");
	const form = (params: Record<string, string>) => send(GOOGLE_TOKEN_ENDPOINT, { headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(params).toString() }, "Google is unavailable. Try again when online.");
	function access(value: Record<string, unknown>): { access_token: string; expiresAt: number } {
		if (!validSecret(value.access_token) || typeof value.expires_in !== "number" || !Number.isFinite(value.expires_in) || value.expires_in <= 0 || value.expires_in > 86400) throw new Error("Google sync relay returned invalid credentials.");
		return { access_token: value.access_token, expiresAt: now() + value.expires_in * 1000 };
	}
	function getGoogleSyncAuthStatus(): GoogleSyncAuthStatus {
		const store = read();
		const scope = active(store);
		const credentials = owns(store.credentials, scope) ? store.credentials : undefined;
		const pending = ownsPending(store.pending, scope) && store.pending.expiresAt > now();
		return { configured: !!scope, connected: !!credentials, pending: !!pending, ...(scope?.mode === "local" ? { mode: "local" as const } : {}), ...(scope?.mode === "relay" ? { relayUrl: scope.relayUrl } : {}), ...(credentials ? { accountId: credentials.accountId, ...(credentials.accountLabel ? { accountLabel: credentials.accountLabel } : {}) } : {}) };
	}
	function configureGoogleSyncRelay(url: string): void {
		const normalized = normalizeRelay(url);
		const store = read();
		const env = environmentRelay();
		if (env && normalizeRelay(env) !== normalized) throw new Error("The Google sync relay is controlled by LH_GOOGLE_SYNC_RELAY_URL.");
		if (store.credentials && !owns(store.credentials, { mode: "relay", relayUrl: normalized })) throw new Error("Disconnect Google sync before changing the relay.");
		generation++;
		write({ ...store, mode: "relay" === store.mode ? "relay" : undefined, relayUrl: normalized, pending: undefined });
	}
	function configureGoogleSyncClient(clientId: string, clientSecret: string): void {
		const id = typeof clientId === "string" ? clientId.trim() : "", secret = typeof clientSecret === "string" ? clientSecret.trim() : "";
		if (!CLIENT_ID_PATTERN.test(id)) throw new Error("Enter the Google OAuth client ID (ends with .apps.googleusercontent.com).");
		if (!CLIENT_SECRET_PATTERN.test(secret)) throw new Error("Enter the Google OAuth client secret.");
		const store = read();
		if (environmentRelay()) throw new Error("The Google sync relay is controlled by LH_GOOGLE_SYNC_RELAY_URL.");
		if (store.credentials && store.credentials.clientId !== id) throw new Error("Disconnect Google sync before changing the Google client.");
		generation++;
		write({ ...store, mode: "local", client: { id, secret }, pending: undefined });
	}
	function localRedirect(value: unknown): string {
		try {
			const url = new URL(String(value));
			if (url.protocol === "http:" && url.hostname === "127.0.0.1" && url.port && url.pathname === GOOGLE_CALLBACK_PATH && !url.search && !url.hash && !url.username && !url.password) return url.href;
		} catch { /* fall through */ }
		throw new Error("Start Google sign-in from the LearnHarness app on this device.");
	}
	async function beginGoogleSyncSignIn(options: { redirectUri?: string } = {}): Promise<{ url: string }> {
		const store = read();
		if (store.credentials) throw new Error("Disconnect Google sync before starting another sign-in.");
		const scope = active(store);
		if (!scope) throw new Error(store.mode === "relay" || store.relayUrl ? "Configure the Google sync HTTPS relay first." : "Save your Google OAuth client ID and secret first.");
		const verifier = randomBytes(32).toString("base64url");
		const challenge = createHash("sha256").update(verifier).digest("base64url");
		if (scope.mode === "relay") {
			generation++;
			write({ ...store, pending: { verifier, relayUrl: scope.relayUrl, expiresAt: now() + 10 * 60_000 } });
			return { url: `${scope.relayUrl}/authorize?challenge=${challenge}` };
		}
		const redirectUri = localRedirect(options.redirectUri);
		const state = randomBytes(32).toString("base64url");
		generation++;
		write({ ...store, pending: { verifier, state, redirectUri, clientId: scope.client.id, expiresAt: now() + 10 * 60_000 } });
		const url = new URL(GOOGLE_AUTH_ENDPOINT);
		url.search = new URLSearchParams({ client_id: scope.client.id, redirect_uri: redirectUri, response_type: "code", scope: SCOPE, access_type: "offline", prompt: "consent", state, code_challenge: challenge, code_challenge_method: "S256" }).toString();
		return { url: url.href };
	}
	/** Decodes the ID token received directly from Google's token endpoint over TLS (no signature check, by design). */
	function identity(idToken: unknown, clientId: string): { accountId: string; accountLabel?: string } {
		try {
			if (typeof idToken !== "string" || idToken.length > 16_384) throw new Error();
			const parts = idToken.split(".");
			if (parts.length !== 3) throw new Error();
			const claims = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as Record<string, unknown>;
			const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
			if ((claims.iss !== "https://accounts.google.com" && claims.iss !== "accounts.google.com") || !audience.includes(clientId)
				|| typeof claims.exp !== "number" || claims.exp * 1000 <= now()
				|| typeof claims.sub !== "string" || !claims.sub || claims.sub.length > 255
				|| (claims.email !== undefined && (typeof claims.email !== "string" || claims.email.length > 320))) throw new Error();
			return { accountId: claims.sub, ...(typeof claims.email === "string" ? { accountLabel: claims.email } : {}) };
		} catch { throw new Error("Google returned invalid account details."); }
	}
	/** Handles the browser redirect from Google. Single-use state; never returns tokens. */
	async function completeGoogleSyncCallback(params: URLSearchParams, host: string | null): Promise<GoogleCallbackResult> {
		const refused = { ok: false, status: 400, message: "This sign-in link is not valid. Start sign-in again from LearnHarness." };
		const store = read();
		const scope = active(store);
		const pending = store.pending;
		if (scope?.mode !== "local" || !ownsPending(pending, scope) || !pending.state || !pending.redirectUri || pending.used || pending.expiresAt <= now()) return refused;
		if (!host || host !== new URL(pending.redirectUri).host) return refused;
		for (const key of ["state", "code", "error"]) if (params.getAll(key).length > 1) return refused;
		const supplied = params.get("state");
		if (!supplied || supplied.length > 256 || !safeEqual(supplied, pending.state)) return refused;
		const version = generation;
		// Consume the state before any network call so a replay cannot start a second exchange.
		const code = params.get("code");
		if (params.has("error") || !code || code.length > 2048) {
			write({ ...store, pending: undefined });
			return { ok: false, status: 200, message: "Google sign-in was cancelled or denied. Return to LearnHarness to try again." };
		}
		write({ ...store, pending: { ...pending, used: true } });
		const fail = (message: string): GoogleCallbackResult => {
			const latest = read();
			if (generation === version && latest.pending?.state === pending.state) write({ ...latest, pending: undefined });
			return { ok: false, status: 200, message };
		};
		let result;
		try {
			result = await form({ grant_type: "authorization_code", code, code_verifier: pending.verifier, client_id: scope.client.id, client_secret: scope.client.secret, redirect_uri: pending.redirectUri });
		} catch (error) { return fail(error instanceof Error ? error.message : "Google sign-in could not complete. Start sign-in again."); }
		const latest = read();
		if (version !== generation || latest.pending?.state !== pending.state || latest.client?.id !== scope.client.id) return { ok: false, status: 200, message: "Google sign-in changed or was cancelled." };
		const bad = "Google sign-in could not complete. Start sign-in again.";
		if (result.status !== 200) return fail(bad);
		try {
			const value = result.value;
			const scopes = typeof value.scope === "string" ? value.scope.split(/\s+/) : [];
			if (!scopes.includes("https://www.googleapis.com/auth/drive.appdata") || !validSecret(value.refresh_token) || (value.token_type !== undefined && String(value.token_type).toLowerCase() !== "bearer")) throw new Error();
			const who = identity(value.id_token, scope.client.id);
			write({ ...latest, pending: undefined, credentials: { ...access(value), refresh_token: value.refresh_token, ...who, clientId: scope.client.id } });
		} catch { return fail(bad); }
		return { ok: true, status: 200, message: "Google sign-in complete." };
	}
	async function complete(): Promise<boolean> {
		const store = read();
		const pending = store.pending;
		const scope = active(store);
		if (!pending) return owns(store.credentials, scope);
		if (pending.expiresAt <= now() || !ownsPending(pending, scope)) return false;
		// Local mode completes in the loopback callback; polling only observes it.
		if (scope?.mode !== "relay") return false;
		const version = generation;
		const result = await post(`${scope.relayUrl}/token`, { verifier: pending.verifier });
		const latest = read();
		if (version !== generation || latest.pending?.verifier !== pending.verifier || relay(latest) !== scope.relayUrl) throw new Error("Google sync sign-in changed or was cancelled.");
		if (result.status === 202) return false;
		if (result.status !== 200) {
			if (result.status === 400 || result.status === 410) write({ ...latest, pending: undefined });
			throw new Error("Google sign-in could not complete. Start sign-in again.");
		}
		const value = result.value;
		if (!validSecret(value.refresh_token) || typeof value.accountId !== "string" || !value.accountId || value.accountId.length > 255 || (value.accountLabel !== undefined && (typeof value.accountLabel !== "string" || value.accountLabel.length > 320))) throw new Error("Google sync relay returned invalid account details.");
		write({ ...latest, pending: undefined, credentials: { ...access(value), refresh_token: value.refresh_token, accountId: value.accountId, ...(typeof value.accountLabel === "string" ? { accountLabel: value.accountLabel } : {}), relayUrl: scope.relayUrl } });
		return true;
	}
	function completeGoogleSyncSignIn(): Promise<boolean> {
		if (!polling) polling = complete().finally(() => { polling = undefined; });
		return polling;
	}
	async function disconnectGoogleSync(): Promise<void> {
		const store = read();
		generation++;
		write({ relayUrl: store.relayUrl, mode: store.mode, client: store.client });
		// Google revocation can invalidate the shared client grant on other
		// devices. Per-device disconnect must only remove local credentials.
	}
	async function token(): Promise<string> {
		const store = read();
		const credentials = store.credentials;
		const scope = active(store);
		if (!scope || !owns(credentials, scope)) throw new Error("Please sign in to Google sync.");
		if (credentials.expiresAt > now() + 60_000) return credentials.access_token;
		const version = generation;
		const result = scope.mode === "local"
			? await form({ grant_type: "refresh_token", refresh_token: credentials.refresh_token, client_id: scope.client.id, client_secret: scope.client.secret })
			: await post(`${scope.relayUrl}/refresh`, { refresh_token: credentials.refresh_token });
		const latest = read();
		if (generation !== version || latest.credentials?.refresh_token !== credentials.refresh_token || !owns(latest.credentials, active(latest))) throw new Error("Google sync account changed. Please sign in again.");
		if (result.status !== 200) {
			if (result.status === 400 || result.status === 401) write({ ...latest, credentials: undefined });
			throw new Error(result.status === 400 || result.status === 401 ? "Please sign in to Google sync again." : "Google sync refresh unavailable. Try again later.");
		}
		const updated = { ...credentials, ...access(result.value) };
		if (result.value.refresh_token !== undefined) {
			if (!validSecret(result.value.refresh_token)) throw new Error("Google sync relay returned invalid credentials.");
			updated.refresh_token = result.value.refresh_token;
		}
		write({ ...latest, credentials: updated });
		return updated.access_token;
	}
	function getGoogleDriveAccessToken(): Promise<string> {
		if (!refreshing) refreshing = token().finally(() => { refreshing = undefined; });
		return refreshing;
	}
	return { getGoogleSyncAuthStatus, configureGoogleSyncRelay, configureGoogleSyncClient, beginGoogleSyncSignIn, completeGoogleSyncCallback, completeGoogleSyncSignIn, disconnectGoogleSync, getGoogleDriveAccessToken };
}

const auth = createGoogleSyncAuth();
export const { getGoogleSyncAuthStatus, configureGoogleSyncRelay, configureGoogleSyncClient, beginGoogleSyncSignIn, completeGoogleSyncCallback, completeGoogleSyncSignIn, disconnectGoogleSync, getGoogleDriveAccessToken } = auth;
