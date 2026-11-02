/** Node-only OAuth credentials. Never import this module into a browser bundle. */
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { PATHS } from "../../config.ts";

type Credentials = { access_token: string; refresh_token: string; expiresAt: number; accountId: string; accountLabel?: string; relayUrl: string };
type Pending = { verifier: string; expiresAt: number; relayUrl: string };
type Store = { relayUrl?: string; credentials?: Credentials; pending?: Pending };
export type GoogleSyncAuthStatus = { configured: boolean; connected: boolean; pending: boolean; accountId?: string; accountLabel?: string; relayUrl?: string };
type Options = { root?: string; fetch?: typeof fetch; now?: () => number; relayUrl?: () => string | undefined };
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
	async function post(url: string, body: object): Promise<{ status: number; value: Record<string, unknown> }> {
		let response: Response;
		try {
			response = await request(url, { method: "POST", redirect: "error", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
		} catch { throw new Error("Google sync relay is unavailable. Try again when online."); }
		if (response.status === 202) return { status: 202, value: {} };
		// Never include provider response bodies (which may contain credentials) in errors.
		if (!response.ok) return { status: response.status, value: {} };
		let value: Record<string, unknown>;
		try {
			const text = await response.text();
			if (text.length > 32_768) throw new Error();
			value = JSON.parse(text);
			if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
		} catch { throw new Error("Google sync relay returned an invalid response."); }
		return { status: response.status, value };
	}
	function access(value: Record<string, unknown>): { access_token: string; expiresAt: number } {
		if (!validSecret(value.access_token) || typeof value.expires_in !== "number" || !Number.isFinite(value.expires_in) || value.expires_in <= 0 || value.expires_in > 86400) throw new Error("Google sync relay returned invalid credentials.");
		return { access_token: value.access_token, expiresAt: now() + value.expires_in * 1000 };
	}
	function getGoogleSyncAuthStatus(): GoogleSyncAuthStatus {
		const store = read();
		const url = relay(store);
		const credentials = store.credentials && store.credentials.relayUrl === url ? store.credentials : undefined;
		const pending = store.pending && store.pending.relayUrl === url && store.pending.expiresAt > now();
		return { configured: !!url, connected: !!credentials, pending: !!pending, ...(url ? { relayUrl: url } : {}), ...(credentials ? { accountId: credentials.accountId, ...(credentials.accountLabel ? { accountLabel: credentials.accountLabel } : {}) } : {}) };
	}
	function configureGoogleSyncRelay(url: string): void {
		const normalized = normalizeRelay(url);
		const store = read();
		const env = environmentRelay();
		if (env && normalizeRelay(env) !== normalized) throw new Error("The Google sync relay is controlled by LH_GOOGLE_SYNC_RELAY_URL.");
		if (store.credentials && store.credentials.relayUrl !== normalized) throw new Error("Disconnect Google sync before changing the relay.");
		generation++;
		write({ ...store, relayUrl: normalized, pending: undefined });
	}
	async function beginGoogleSyncSignIn(): Promise<{ url: string }> {
		const store = read();
		if (store.credentials) throw new Error("Disconnect Google sync before starting another sign-in.");
		const url = relay(store);
		if (!url) throw new Error("Configure the Google sync HTTPS relay first.");
		generation++;
		const verifier = randomBytes(32).toString("base64url");
		write({ ...store, pending: { verifier, relayUrl: url, expiresAt: now() + 10 * 60_000 } });
		const challenge = createHash("sha256").update(verifier).digest("base64url");
		return { url: `${url}/authorize?challenge=${challenge}` };
	}
	async function complete(): Promise<boolean> {
		const store = read();
		const pending = store.pending;
		if (!pending) return !!store.credentials && store.credentials.relayUrl === relay(store);
		if (pending.expiresAt <= now() || pending.relayUrl !== relay(store)) return false;
		const version = generation;
		const result = await post(`${pending.relayUrl}/token`, { verifier: pending.verifier });
		const latest = read();
		if (version !== generation || latest.pending?.verifier !== pending.verifier || relay(latest) !== pending.relayUrl) throw new Error("Google sync sign-in changed or was cancelled.");
		if (result.status === 202) return false;
		if (result.status !== 200) {
			if (result.status === 400 || result.status === 410) write({ ...latest, pending: undefined });
			throw new Error("Google sign-in could not complete. Start sign-in again.");
		}
		const value = result.value;
		if (!validSecret(value.refresh_token) || typeof value.accountId !== "string" || !value.accountId || value.accountId.length > 255 || (value.accountLabel !== undefined && (typeof value.accountLabel !== "string" || value.accountLabel.length > 320))) throw new Error("Google sync relay returned invalid account details.");
		write({ ...latest, pending: undefined, credentials: { ...access(value), refresh_token: value.refresh_token, accountId: value.accountId, ...(typeof value.accountLabel === "string" ? { accountLabel: value.accountLabel } : {}), relayUrl: pending.relayUrl } });
		return true;
	}
	function completeGoogleSyncSignIn(): Promise<boolean> {
		if (!polling) polling = complete().finally(() => { polling = undefined; });
		return polling;
	}
	async function disconnectGoogleSync(): Promise<void> {
		const store = read();
		generation++;
		write({ relayUrl: store.relayUrl });
		// Google revocation can invalidate the shared client grant on other
		// devices. Per-device disconnect must only remove local credentials.
	}
	async function token(): Promise<string> {
		const store = read();
		const credentials = store.credentials;
		if (!credentials || credentials.relayUrl !== relay(store)) throw new Error("Please sign in to Google sync.");
		if (credentials.expiresAt > now() + 60_000) return credentials.access_token;
		const version = generation;
		const result = await post(`${credentials.relayUrl}/refresh`, { refresh_token: credentials.refresh_token });
		const latest = read();
		if (generation !== version || latest.credentials?.refresh_token !== credentials.refresh_token || relay(latest) !== credentials.relayUrl) throw new Error("Google sync account changed. Please sign in again.");
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
	return { getGoogleSyncAuthStatus, configureGoogleSyncRelay, beginGoogleSyncSignIn, completeGoogleSyncSignIn, disconnectGoogleSync, getGoogleDriveAccessToken };
}

const auth = createGoogleSyncAuth();
export const { getGoogleSyncAuthStatus, configureGoogleSyncRelay, beginGoogleSyncSignIn, completeGoogleSyncSignIn, disconnectGoogleSync, getGoogleDriveAccessToken } = auth;
