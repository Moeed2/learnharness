import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { PATHS } from "../../config.ts";

export interface StoredDocument {
	id: string;
	name: string;
	mimeType: string;
	size: number;
	hash: string;
	textHash?: string;
	importedAt: string;
}
const HASH = /^[a-f0-9]{64}$/;
const MAX_BYTES = 25 * 1024 * 1024;
const digest = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

function safeName(name: string): boolean {
	return name.length > 0 && name.length <= 1024 && !/[\\:\x00-\x1f]/.test(name)
		&& name.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

function documentPath(root: string, ...parts: string[]): string {
	const base = path.resolve(root);
	let current = base;
	for (const part of ["documents", ...parts]) {
		current = path.join(current, part);
		if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error("Document storage cannot contain symbolic links.");
	}
	return current;
}

function atomicWrite(file: string, data: string | Uint8Array): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const tmp = `${file}.${randomUUID()}.tmp`;
	try { fs.writeFileSync(tmp, data, { mode: 0o600, flag: "wx" }); fs.renameSync(tmp, file); }
	finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
}

/** Store originals before extraction: a failed model call must not discard the upload. */
export function saveDocument(input: { name: string; mimeType: string; bytes: Uint8Array; text?: string }, root = PATHS.data): StoredDocument {
	if (!safeName(input.name)) throw new Error("Invalid document name or relative path.");
	if (input.bytes.byteLength > MAX_BYTES) throw new Error("Document exceeds the 25 MB import limit.");
	const hash = digest(input.bytes);
	const id = digest(`${input.name}\0${hash}`);
	const existing = readMetadata(id, root);
	const record: StoredDocument = {
		id, name: input.name, mimeType: /^[\w.+-]+\/[\w.+-]+$/.test(input.mimeType) ? input.mimeType : "application/octet-stream",
		size: input.bytes.byteLength, hash,
		...(input.text !== undefined ? { textHash: digest(input.text) } : {}),
		importedAt: existing?.importedAt ?? new Date().toISOString(),
	};
	atomicWrite(documentPath(root, "blobs", hash), input.bytes);
	if (input.text !== undefined) atomicWrite(documentPath(root, "blobs", record.textHash!), Buffer.from(input.text));
	atomicWrite(documentPath(root, "records", `${id}.json`), JSON.stringify(record));
	return record;
}

function readMetadata(id: string, root: string): StoredDocument | null {
	if (!HASH.test(id)) return null;
	try {
		const record = JSON.parse(fs.readFileSync(documentPath(root, "records", `${id}.json`), "utf8")) as StoredDocument;
		if (record.id !== id || !HASH.test(record.hash) || !safeName(record.name) || digest(`${record.name}\0${record.hash}`) !== id
			|| !Number.isSafeInteger(record.size) || record.size < 0 || record.size > MAX_BYTES
			|| typeof record.mimeType !== "string" || (record.textHash !== undefined && !HASH.test(record.textHash))) return null;
		return record;
	} catch { return null; }
}

export function listDocuments(root = PATHS.data): StoredDocument[] {
	try {
		return fs.readdirSync(documentPath(root, "records")).filter((name) => /^[a-f0-9]{64}\.json$/.test(name))
			.map((name) => readMetadata(name.slice(0, -5), root)).filter((record): record is StoredDocument => record !== null)
			.sort((a, b) => a.name.localeCompare(b.name));
	} catch { return []; }
}

export function readDocument(id: string, root = PATHS.data): { record: StoredDocument; bytes: Buffer } | null {
	const record = readMetadata(id, root);
	if (!record) return null;
	try {
		const bytes = fs.readFileSync(documentPath(root, "blobs", record.hash));
		return bytes.length === record.size && digest(bytes) === record.hash ? { record, bytes } : null;
	} catch { return null; }
}
