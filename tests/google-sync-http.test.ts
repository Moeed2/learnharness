import assert from "node:assert/strict";
import { test } from "node:test";
import { syncMutationAuthorized, readSyncCommand } from "../src/server/sync-http.ts";

test("sync mutations require app header, same-origin request and JSON", async () => {
	const make = (headers: Record<string, string>) => new Request("http://localhost:3000/api/sync", { method: "POST", headers });
	assert.equal(syncMutationAuthorized(make({ "content-type": "application/json" })), false);
	assert.equal(syncMutationAuthorized(make({ "x-learnharness-sync": "1", origin: "https://attacker.example", "content-type": "application/json" })), false);
	assert.equal(syncMutationAuthorized(make({ "x-learnharness-sync": "1", origin: "http://localhost:3000", "content-type": "application/json" })), true);
});

test("sync commands are bounded while streaming, not only by their advertised size", async () => {
	const request = new Request("http://localhost/api/sync", { method: "POST", body: JSON.stringify({ action: "configure", relayUrl: "x".repeat(70_000) }) });
	await assert.rejects(readSyncCommand(request), /large/i);
});
