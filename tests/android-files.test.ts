import assert from "node:assert/strict";
import { test } from "node:test";
import { describeProgress, importFolderFiles, summarizePick } from "../lib/android-files.ts";
import { notesPath } from "../components/notes-import-queue.ts";

test("describeProgress formats megabytes and unknown totals", () => {
	assert.equal(describeProgress({ done: 0, total: 0 }), "Copying…");
	assert.equal(describeProgress({ done: 12 * 1024 * 1024, total: 120 * 1024 * 1024 }), "Copying 12 of 120 MB…");
	assert.equal(describeProgress({ done: 100, total: 5 * 1024 * 1024 }), "Copying <1 of 5 MB…");
	assert.equal(describeProgress({ done: 9e9, total: 2 * 1024 * 1024 }), "Copying 2 of 2 MB…");
});

test("summarizePick reports paths and skipped files", () => {
	const file = { name: "a.pdf", path: "/data/a.pdf", size: 1 };
	assert.deepEqual(summarizePick({ id: "x", files: [file], skipped: 0 }), { paths: ["/data/a.pdf"], notice: "" });
	assert.match(summarizePick({ id: "x", files: [file], skipped: 1 }).notice, /1 chosen file was skipped/);
	assert.match(summarizePick({ id: "x", files: [file], skipped: 3 }).notice, /3 chosen files were skipped/);
	assert.equal(summarizePick({ id: "x", files: [], skipped: 0 }).notice, "");
	assert.match(summarizePick({ id: "x", files: [], skipped: 2 }).notice, /None of the chosen/);
	assert.equal(summarizePick({ id: "x", files: [], skipped: 0, error: "Too much data" }).notice, "Too much data");
});

test("importFolderFiles rebuilds webkitRelativePath files and counts failures", async () => {
	const bodies: Record<string, string | undefined> = { "/__lh_import/i/Notes/a.md": "# a", "/__lh_import/i/Notes/sub/b.txt": "b" };
	const { files, failed } = await importFolderFiles(
		{
			id: "i", name: "Notes", skipped: 0,
			files: [
				{ path: "Notes/a.md", size: 3, url: "/__lh_import/i/Notes/a.md" },
				{ path: "Notes/sub/b.txt", size: 1, url: "/__lh_import/i/Notes/sub/b.txt" },
				{ path: "Notes/gone.md", size: 1, url: "/__lh_import/i/Notes/gone.md" },
			],
		},
		async (url) => bodies[url] === undefined ? new Response("", { status: 404 }) : new Response(bodies[url]),
	);
	assert.equal(failed, 1);
	assert.deepEqual(files.map((f) => [f.name, f.webkitRelativePath, notesPath(f)]), [
		["a.md", "Notes/a.md", "Notes/a.md"],
		["b.txt", "Notes/sub/b.txt", "Notes/sub/b.txt"],
	]);
	assert.equal(await files[0]!.text(), "# a");
});
