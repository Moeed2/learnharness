import assert from "node:assert/strict";
import { test } from "node:test";
import { GoogleDriveRemote } from "../src/sync/google-drive.ts";

const meta = { id: "revision-a", unit: "workspace", parents: [], deleted: false, hash: "a".repeat(64) };
const revision = { meta, files: { "chats/chat_a.json": Buffer.from("{}").toString("base64") } };

test("Drive lists every page of the app's private revisions and deduplicates retries", async () => {
	const calls: URL[] = [];
	const remote = new GoogleDriveRemote(async () => "private-token", async (input, init) => {
		const url = new URL(String(input)); calls.push(url);
		assert.equal(new Headers(init?.headers).get("authorization"), "Bearer private-token");
		assert.equal(url.searchParams.get("spaces"), "appDataFolder");
		return Response.json({ files: [{ id: "drive-file", description: JSON.stringify(meta) }], ...(calls.length === 1 ? { nextPageToken: "page-2" } : {}) });
	});
	assert.deepEqual(await remote.list(), [meta]);
	assert.equal(calls.length, 2);
	assert.equal(calls[1]?.searchParams.get("pageToken"), "page-2");
});

test("Drive download checks the listed revision identity before returning data", async () => {
	const remote = new GoogleDriveRemote(async () => "secret", async (input) => new URL(String(input)).searchParams.get("alt") === "media"
		? Response.json({ ...revision, meta: { ...meta, unit: "other" } })
		: Response.json({ files: [{ id: "drive-file", description: JSON.stringify(meta) }] }));
	await remote.list();
	await assert.rejects(remote.download(meta), /revision|match/i);
});

test("Drive uploads use resumable uploads and reject a hostile session URL", async () => {
	const remote = new GoogleDriveRemote(async () => "secret", async () => new Response(null, { status: 200, headers: { location: "https://attacker.example/upload" } }));
	await assert.rejects(remote.upload(revision), /upload|session/i);
});

test("Drive errors do not echo remote bodies or credentials", async () => {
	const remote = new GoogleDriveRemote(async () => "secret", async () => new Response("private-token arbitrary-provider-error", { status: 403 }));
	await assert.rejects(remote.list(), (error: Error) => !error.message.includes("private-token") && /permission|Google Drive|quota/i.test(error.message));
});
