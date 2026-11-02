import type { Revision, RevisionMeta, SyncRemote } from "./types.ts";

const API = "https://www.googleapis.com/drive/v3/files";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3/files";
const MAX_REVISION_BYTES = 128 * 1024 * 1024;
const ID = /^[A-Za-z0-9_-]{1,128}$/;

function validMeta(value: unknown): value is RevisionMeta {
	if (!value || typeof value !== "object") return false;
	const v = value as RevisionMeta;
	return typeof v.id === "string" && ID.test(v.id) && typeof v.unit === "string" && v.unit.length <= 256
		&& Array.isArray(v.parents) && v.parents.length <= 256 && v.parents.every((id) => typeof id === "string" && ID.test(id))
		&& typeof v.deleted === "boolean" && typeof v.hash === "string" && /^[a-f0-9]{64}$/.test(v.hash);
}

/** Immutable revisions avoid a shared Drive index that two offline clients could overwrite. */
export class GoogleDriveRemote implements SyncRemote {
	private files = new Map<string, { id: string; meta: RevisionMeta }>();
	constructor(private readonly accessToken: () => Promise<string>, private readonly request: typeof fetch = fetch) {}

	private async call(url: string, init: RequestInit = {}): Promise<Response> {
		const headers = new Headers(init.headers);
		headers.set("Authorization", `Bearer ${await this.accessToken()}`);
		let response: Response;
		try { response = await this.request(url, { ...init, headers, redirect: "error", signal: AbortSignal.timeout(90_000) }); }
		catch { throw new Error("Google Drive is unreachable. Your local changes are safe; syncing will retry."); }
		if (response.ok) return response;
		if (response.status === 401) throw new Error("Google Drive sign-in expired. Reconnect your account in Sync settings.");
		if (response.status === 403 || response.status === 429) throw new Error("Google Drive permission or quota limit. Check your account and try syncing later.");
		throw new Error(`Google Drive request failed (${response.status}). Your local changes are safe.`);
	}

	async list(): Promise<RevisionMeta[]> {
		const entries = new Map<string, { id: string; meta: RevisionMeta }>();
		let pageToken: string | undefined;
		const seenPages = new Set<string>();
		do {
			const url = new URL(API);
			url.search = new URLSearchParams({ spaces: "appDataFolder", q: "trashed = false and appProperties has { key='lhSync' and value='v1' }", fields: "nextPageToken,files(id,description)", pageSize: "1000", ...(pageToken ? { pageToken } : {}) }).toString();
			const body = await (await this.call(url.toString())).json() as { nextPageToken?: string; files?: { id: string; description: string }[] };
			if (!Array.isArray(body.files)) throw new Error("Google Drive returned an invalid revision list.");
			for (const file of body.files) {
				let meta: unknown;
				try { meta = JSON.parse(file.description); } catch { throw new Error("A Google Drive sync revision is damaged."); }
				if (!validMeta(meta) || !ID.test(file.id)) throw new Error("A Google Drive sync revision has invalid metadata.");
				const previous = entries.get(meta.id);
				if (previous && JSON.stringify(previous.meta) !== JSON.stringify(meta)) throw new Error("Google Drive contains conflicting revision identities.");
				entries.set(meta.id, { id: file.id, meta });
			}
			pageToken = body.nextPageToken;
			if (pageToken && (seenPages.has(pageToken) || seenPages.size > 10_000)) throw new Error("Google Drive revision listing could not complete safely.");
			if (pageToken) seenPages.add(pageToken);
		} while (pageToken);
		this.files = entries;
		return [...entries.values()].map((entry) => entry.meta);
	}

	async download(meta: RevisionMeta): Promise<Revision> {
		const entry = this.files.get(meta.id);
		if (!entry) throw new Error("Google Drive revision is no longer in the sync listing. Retry syncing.");
		const response = await this.call(`${API}/${encodeURIComponent(entry.id)}?alt=media`);
		const length = Number(response.headers.get("content-length"));
		if (length > MAX_REVISION_BYTES) throw new Error("Google Drive sync revision is too large.");
		const reader = response.body?.getReader();
		if (!reader) throw new Error("Google Drive returned an empty revision.");
		const chunks: Uint8Array[] = []; let size = 0;
		try {
			for (;;) {
				const { done, value } = await reader.read(); if (done) break;
				size += value.byteLength;
				if (size > MAX_REVISION_BYTES) throw new Error("Google Drive sync revision is too large.");
				chunks.push(value);
			}
		} finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
		const revision = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Revision;
		if (!validMeta(revision.meta) || JSON.stringify(revision.meta) !== JSON.stringify(entry.meta)
			|| !revision.files || typeof revision.files !== "object" || Array.isArray(revision.files)) throw new Error("Google Drive revision content does not match its metadata.");
		return revision;
	}

	async upload(revision: Revision): Promise<void> {
		if (this.files.has(revision.meta.id)) return;
		if (!validMeta(revision.meta)) throw new Error("Invalid Google Drive revision metadata.");
		const bytes = Buffer.from(JSON.stringify(revision));
		if (bytes.length > MAX_REVISION_BYTES) throw new Error("Learning data exceeds the current per-revision sync limit (128 MB).");
		const session = await this.call(`${UPLOAD}?uploadType=resumable`, {
			method: "POST", headers: { "content-type": "application/json", "x-upload-content-type": "application/json", "x-upload-content-length": String(bytes.length) },
			body: JSON.stringify({ name: `${revision.meta.id}.json`, parents: ["appDataFolder"], mimeType: "application/json", description: JSON.stringify(revision.meta), appProperties: { lhSync: "v1" } }),
		});
		const location = session.headers.get("location");
		let target: URL;
		try { target = new URL(location ?? ""); } catch { throw new Error("Google Drive did not create an upload session."); }
		if (target.origin !== "https://www.googleapis.com" || !target.pathname.startsWith("/upload/drive/v3/files") || target.username || target.password) throw new Error("Google Drive returned an invalid upload session.");
		const result = await this.call(target.toString(), { method: "PUT", headers: { "content-type": "application/json" }, body: bytes });
		const file = await result.json() as { id?: string };
		if (!file.id || !ID.test(file.id)) throw new Error("Google Drive did not confirm the uploaded revision.");
		this.files.set(revision.meta.id, { id: file.id, meta: revision.meta });
	}
}
