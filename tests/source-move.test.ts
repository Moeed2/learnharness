import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { moveDestinations } from "../components/source-move";
import type { SourceOrganization } from "../src/core";

const org: SourceOrganization = {
	version: 1,
	folders: [
		{ id: "a", name: "Alpha", parentId: null, createdAt: "2026-01-01" },
		{ id: "b", name: "Beta", parentId: "a", createdAt: "2026-01-01" },
		{ id: "c", name: "Gamma", parentId: null, createdAt: "2026-01-01" },
	],
	placements: { s1: { folderId: "b" } },
};

describe("moveDestinations", () => {
	it("lists top level then folders depth-first and marks the current parent", () => {
		const d = moveDestinations(org, "source", "s1");
		assert.deepEqual(d.map((x) => [x.parentId, x.depth, x.current]), [
			[null, 0, false], ["a", 0, false], ["b", 1, true], ["c", 0, false],
		]);
	});
	it("unplaced sources are at top level", () => {
		assert.equal(moveDestinations(org, "source", "zzz")[0]!.current, true);
	});
	it("a folder cannot move into itself or its descendants", () => {
		const d = moveDestinations(org, "folder", "a");
		assert.deepEqual(d.map((x) => x.parentId), [null, "c"]);
		assert.equal(d[0]!.current, true);
	});
});
