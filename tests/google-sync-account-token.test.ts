import assert from "node:assert/strict";
import { test } from "node:test";
import { bindAccountToken } from "../src/sync/account-token.ts";

test("a sync started under one account cannot obtain another account's token", async () => {
	let account = "a", generation = 1;
	const token = bindAccountToken("a", 1, () => ({ accountId: account, connected: true, generation }), async () => `token-${account}`);
	assert.equal(await token(), "token-a");
	account = "b"; generation++;
	await assert.rejects(token(), /account|cancel/i);
});

test("account changes while refreshing reject the newly returned token", async () => {
	let account = "a";
	const token = bindAccountToken("a", 1, () => ({ accountId: account, connected: true, generation: 1 }), async () => { account = "b"; return "token-b"; });
	await assert.rejects(token(), /account|cancel/i);
});
