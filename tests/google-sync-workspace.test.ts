import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { SyncEngine } from "../src/sync/engine.ts";
import type { Revision, SyncRemote } from "../src/sync/types.ts";
import { listDocuments, readDocument, saveDocument } from "../src/store/documents.ts";

const tempRoots: string[] = [];
afterEach(() => tempRoots.splice(0).forEach((root) => fs.rmSync(root, { recursive: true, force: true })));
function setup() {
	const temp = fs.mkdtempSync(path.join(os.tmpdir(), "lh-workspace-sync-")); tempRoots.push(temp);
	const data = new Map<string, Revision>();
	const remote: SyncRemote = {
		async list() { return [...data.values()].map((revision) => structuredClone(revision.meta)); },
		async download(meta) { return structuredClone(data.get(meta.id)!); },
		async upload(revision) { data.set(revision.meta.id, structuredClone(revision)); },
		async remove(meta) { data.delete(meta.id); },
	};
	const device = (name: string) => {
		const root = path.join(temp, name); fs.mkdirSync(root);
		return { root, sync: new SyncEngine({ root, stateDir: path.join(root, ".sync", "engine"), remote, accountId: "one-account" }) };
	};
	return { device, data };
}
function write(root: string, file: string, value: unknown) {
	const location = path.join(root, file); fs.mkdirSync(path.dirname(location), { recursive: true }); fs.writeFileSync(location, JSON.stringify(value));
}

test("a fresh second device receives original documents, folders, settings and chats together", async () => {
	const { device, data } = setup(), a = device("laptop"), b = device("tablet");
	const original = saveDocument({ name: "Course/notes.pdf", mimeType: "application/pdf", bytes: Buffer.from("original PDF"), text: "reading text" }, a.root);
	write(a.root, "chats/chat_a.json", { id: "chat_a", messages: [], title: "Saved lesson" });
	write(a.root, "graph/source-organization.json", { version: 1, folders: [], placements: {} });
	write(a.root, "settings.json", { version: 1, appearance: { mode: "light" }, access_token: "must-not-upload" });
	write(a.root, "auth.json", { secret: "must-not-upload" });
	await a.sync.sync(); await b.sync.sync();
	assert.equal(listDocuments(b.root).length, 1);
	assert.equal(readDocument(original.id, b.root)?.bytes.toString(), "original PDF");
	assert.equal(fs.existsSync(path.join(b.root, "graph/source-organization.json")), true);
	assert.equal(fs.existsSync(path.join(b.root, "chats/chat_a.json")), true);
	assert.equal(JSON.stringify([...data.values()]).includes(Buffer.from("must-not-upload").toString("base64")), false);
	assert.equal(fs.readFileSync(path.join(b.root, "settings.json"), "utf8").includes("must-not-upload"), false);
	assert.equal((await b.sync.sync()).downloaded, 0, "unchanged sync must not redownload the library");
});

test("independent offline chats and documents from two devices remain in the active library", async () => {
	const { device } = setup(), a = device("pc"), b = device("laptop");
	write(a.root, "chats/chat_a.json", { id: "chat_a", messages: [] });
	write(b.root, "chats/chat_b.json", { id: "chat_b", messages: [] });
	saveDocument({ name: "A.txt", mimeType: "text/plain", bytes: Buffer.from("A") }, a.root);
	saveDocument({ name: "B.txt", mimeType: "text/plain", bytes: Buffer.from("B") }, b.root);
	await a.sync.sync(); await b.sync.sync(); await a.sync.sync();
	for (const device of [a, b]) {
		assert.equal(fs.existsSync(path.join(device.root, "chats/chat_a.json")), true);
		assert.equal(fs.existsSync(path.join(device.root, "chats/chat_b.json")), true);
		assert.deepEqual(listDocuments(device.root).map((document) => document.name), ["A.txt", "B.txt"]);
	}
});
