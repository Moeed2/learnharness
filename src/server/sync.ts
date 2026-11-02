import fs from "node:fs";
import path from "node:path";
import { PATHS } from "../../config.ts";
import { emit, subscribe } from "../core/events.ts";
import { SyncEngine } from "../sync/engine.ts";
import type { SyncReason } from "../sync/types.ts";
import { GoogleDriveRemote } from "../sync/google-drive.ts";
import { bindAccountToken } from "../sync/account-token.ts";
import { getGoogleSyncAuthStatus, configureGoogleSyncRelay, configureGoogleSyncClient, beginGoogleSyncSignIn, completeGoogleSyncCallback, completeGoogleSyncSignIn, disconnectGoogleSync, getGoogleDriveAccessToken, GOOGLE_CALLBACK_PATH } from "../sync/google-auth.ts";
import { isAndroidServer } from "../../lib/platform.ts";
import { readBrowserPreferences, writeBrowserPreferences } from "../sync/browser-preferences.ts";
import { documentImportRunning } from "./sync-activity.ts";
import { readSyncCommand, syncMutationAuthorized, SYNC_HEADERS } from "./sync-http.ts";

type Phase = "disconnected" | "idle" | "syncing" | "offline" | "deferred" | "error";
interface SyncRuntime {
	phase: Phase; error?: string; lastSyncedAt?: string; changedAt?: string;
	engine?: SyncEngine; accountId?: string; running?: Promise<void>; timer?: ReturnType<typeof setInterval>;
	subscribed?: boolean; generation: number; lastKick: number;
}
const global = globalThis as typeof globalThis & {
	__lhGoogleSync?: SyncRuntime;
	__lhTurnRegistry?: Map<string, number>;
	__lhCompaction?: { inFlight: Map<string, unknown> };
	__lhExtractionRuns?: { running: Map<string, unknown>; inFlight: Set<string> };
};
function runtime(): SyncRuntime { return global.__lhGoogleSync ??= { phase: "disconnected", generation: 0, lastKick: 0 }; }

/** Raw registry sizes deliberately avoid the turn registry's read-time TTL eviction. */
function workspaceBusy(): boolean {
	if (documentImportRunning() || global.__lhTurnRegistry?.size || global.__lhCompaction?.inFlight.size
		|| global.__lhExtractionRuns?.running.size || global.__lhExtractionRuns?.inFlight.size) return true;
	try {
		const jobs = path.join(PATHS.data, "jobs");
		for (const file of fs.readdirSync(jobs)) {
			if (!/^[\w-]+\.json$/.test(file)) continue;
			const record = JSON.parse(fs.readFileSync(path.join(jobs, file), "utf8"));
			if (record.status === "running" || record.status === "queued") return true;
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") return true;
	}
	return false;
}

function engine(): SyncEngine | undefined {
	const state = runtime(), auth = getGoogleSyncAuthStatus();
	if (!auth.connected || !auth.accountId) return;
	if (!state.engine || state.accountId !== auth.accountId) {
		const generation = state.generation;
		state.accountId = auth.accountId;
		state.engine = new SyncEngine({
			root: PATHS.data, stateDir: path.join(PATHS.data, ".sync", "engine"), accountId: auth.accountId,
			remote: new GoogleDriveRemote(bindAccountToken(auth.accountId, generation,
				() => ({ ...getGoogleSyncAuthStatus(), generation: state.generation }), getGoogleDriveAccessToken)),
			isBusy: () => state.generation !== generation || !getGoogleSyncAuthStatus().connected || workspaceBusy(),
			onApplied: (paths) => {
				state.changedAt = new Date().toISOString();
				emit("chats-changed", {}); emit("sources-changed", {}); emit("activity-changed", {});
				for (const file of paths) {
					const chat = /^chats\/([\w-]+)\.json$/.exec(file);
					if (chat?.[1]) emit("record-changed", { chatId: chat[1] });
				}
			},
		});
	}
	return state.engine;
}

async function runSync(reason: SyncReason = "manual"): Promise<void> {
	const state = runtime();
	if (state.running) return state.running;
	const current = engine();
	if (!current) { state.phase = "disconnected"; return; }
	const generation = state.generation;
	state.phase = "syncing"; delete state.error; state.lastKick = Date.now();
	state.running = (async () => {
		try {
			const result = await current.sync({ reason });
			if (generation !== state.generation) return;
			state.phase = result.deferred ? "deferred" : "idle";
			if (!result.deferred) state.lastSyncedAt = new Date().toISOString();
		} catch (error) {
			if (generation !== state.generation) return;
			const message = error instanceof Error ? error.message : "Sync could not finish. Local changes are safe.";
			state.error = message;
			state.phase = /unreachable|unavailable|offline|network/i.test(message) ? "offline" : "error";
		} finally { state.running = undefined; }
	})();
	return state.running;
}

function ensureBackground(): void {
	const state = runtime();
	if (!state.timer) {
		state.timer = setInterval(() => { void runSync("timer").catch(() => {}); }, 30_000);
		state.timer.unref?.();
	}
	if (!state.subscribed) {
		state.subscribed = true;
		subscribe(() => {
			if (Date.now() - state.lastKick > 5_000) void runSync("event").catch(() => {});
		});
	}
	if (!state.running && Date.now() - state.lastKick > 30_000) void runSync("event").catch(() => {});
}

export function syncStatus(): Record<string, unknown> {
	const state = runtime(), auth = getGoogleSyncAuthStatus();
	ensureBackground();
	return { configured: auth.configured, connected: auth.connected, pending: auth.pending,
		accountLabel: auth.accountLabel, relayUrl: auth.relayUrl, mode: auth.mode ?? (auth.relayUrl ? "relay" : "local"),
		phase: auth.connected ? state.phase : "disconnected", error: state.error,
		lastSyncedAt: state.lastSyncedAt, changedAt: state.changedAt, conflicts: engine()?.listConflicts().length ?? 0 };
}

function json(body: unknown, status = 200): Response { return Response.json(body, { status, headers: SYNC_HEADERS }); }
export async function syncResponse(request: Request): Promise<Response> {
	try {
		if (request.method === "GET") return json(syncStatus());
		if (!syncMutationAuthorized(request)) return json({ error: "Open Sync settings in the learning app to change this connection." }, 403);
		const command = await readSyncCommand(request);
		switch (command.action) {
			case "configure":
				if (runtime().running) return json({ error: "Wait for the current sync to finish." }, 409);
				if (typeof command.clientId === "string" || typeof command.clientSecret === "string") {
					configureGoogleSyncClient(command.clientId as string, command.clientSecret as string); return json(syncStatus());
				}
				if (typeof command.relayUrl !== "string") return json({ error: "Enter your Google sync relay URL." }, 400);
				configureGoogleSyncRelay(command.relayUrl); return json(syncStatus());
			case "connect": return json(await beginGoogleSyncSignIn({ redirectUri: loopbackCallback(request) }));
			case "poll": {
				const complete = await completeGoogleSyncSignIn();
				if (complete) { runtime().engine = undefined; runtime().lastKick = 0; }
				return json(syncStatus());
			}
			case "sync": await runSync("foreground"); return json(syncStatus());
			case "disconnect": {
				const state = runtime(); state.generation++; state.engine = undefined; state.phase = "disconnected"; delete state.error;
				await disconnectGoogleSync(); return json(syncStatus());
			}
			case "restore": {
				const current = engine();
				if (!current || typeof command.id !== "string") return json({ error: "Choose a saved conflict while connected to its Google account." }, 400);
				if (runtime().running || workspaceBusy()) return json({ error: "Wait until learning and syncing have finished before restoring a copy." }, 409);
				current.restoreConflict(command.id); return json(syncStatus());
			}
			default: return json({ error: "Unknown sync action." }, 400);
		}
	} catch (error) {
		return json({ error: error instanceof Error ? error.message : "Sync could not finish. Your local data is safe." }, 400);
	}
}

/** The callback must come back to this very server: loopback address plus the port the request reached. */
function loopbackCallback(request: Request): string | undefined {
	try {
		const port = new URL(`http://${request.headers.get("host") ?? ""}`).port;
		return port ? `http://127.0.0.1:${port}${GOOGLE_CALLBACK_PATH}` : undefined;
	} catch { return undefined; }
}

const PAGE_HEADERS = { ...SYNC_HEADERS, "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'" };
const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
/** Public (guard-exempt) loopback redirect target for Google sign-in. Reveals nothing without a valid pending state. */
export async function syncGoogleCallbackResponse(request: Request): Promise<Response> {
	if (request.method !== "GET") return new Response("Method not allowed", { status: 405, headers: { ...SYNC_HEADERS, Allow: "GET" } });
	let result;
	try { result = await completeGoogleSyncCallback(new URL(request.url).searchParams, request.headers.get("host")); }
	catch { result = { ok: false, status: 400, message: "Google sign-in could not complete. Start sign-in again from LearnHarness." }; }
	if (result.ok) { const state = runtime(); state.engine = undefined; state.lastKick = 0; }
	const heading = result.ok ? "Google sign-in complete \u2014 return to LearnHarness" : "Google sign-in not completed";
	// Android: the system browser does not return to the app on its own, so hand control back through the
	// app's existing deep link (same as the ChatGPT callback page), with a button as a fallback.
	const android = isAndroidServer(process.env);
	const link = `learnharness://auth-done?status=${result.ok ? "ok" : "error"}`;
	const back = android ? `<p><a href="${link}">Return to LearnHarness</a></p>` : "";
	const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer">${android ? `<meta http-equiv="refresh" content="0;url=${link}">` : ""}<title>LearnHarness</title><style>body{font:18px/1.5 system-ui,sans-serif;margin:0;padding:48px 24px;text-align:center}</style></head><body><h1>${escapeHtml(heading)}</h1><p>${escapeHtml(result.ok ? "You can close this tab." : result.message)}</p>${back}</body></html>`;
	return new Response(html, { status: result.status, headers: PAGE_HEADERS });
}

export function syncConflictsResponse(id?: string): Response {
	try {
		const current = engine();
		if (!id) return json({ conflicts: (current?.listConflicts() ?? []).map((item) => {
			const revision = current?.readConflict(item.id);
			let name = revision?.meta.unit === "workspace" ? "Learning map and folders" : revision?.meta.unit.startsWith("preferences/") ? "Settings and preferences" : revision?.meta.unit ?? "Saved learning data";
			if (revision) {
				for (const [file, content] of Object.entries(revision.files)) {
					if (!file.startsWith("chats/") && !file.startsWith("documents/records/")) continue;
					try {
						const record = JSON.parse(Buffer.from(content, "base64").toString("utf8"));
						const label = file.startsWith("chats/") ? record.title : record.name;
						if (typeof label === "string") name = label.slice(0, 200);
					} catch { /* The validated revision can still contain an older record shape. */ }
				}
			}
			const at = revision?.meta.at;
			return { id: item.id, name: at ? `${name} \u2014 saved ${new Date(at).toLocaleString()}` : `${name} (${item.id.slice(-8)})` };
		}) });
		const revision = current?.readConflict(id);
		if (!revision) return json({ error: "Saved copy not found." }, 404);
		return new Response(JSON.stringify(revision, null, 2), { headers: { ...SYNC_HEADERS,
			"Content-Type": "application/json", "Content-Disposition": `attachment; filename="learning-conflict-${revision.meta.id}.json"` } });
	} catch { return json({ error: "The saved copy could not be read." }, 400); }
}

export async function syncPreferencesResponse(request: Request): Promise<Response> {
	if (request.method === "GET") return json({ preferences: readBrowserPreferences() });
	if (!syncMutationAuthorized(request)) return json({ error: "Change preferences from the learning app." }, 403);
	try { const body = await readSyncCommand(request); return json({ preferences: writeBrowserPreferences(body.preferences) }); }
	catch { return json({ error: "Invalid portable browser preferences." }, 400); }
}
