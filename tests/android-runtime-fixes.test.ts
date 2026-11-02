import assert from "node:assert/strict";
import { test } from "node:test";

await import("../scripts/android/runtime-fixes.mjs");

test("Android Intl.Segmenter replacement segments words", () => {
	const parts = [...new Intl.Segmenter("en", { granularity: "word" }).segment("Hello, world")];
	assert.deepEqual(parts.map((p) => [p.segment, p.index, p.isWordLike]), [
		["Hello", 0, true], [",", 5, false], [" ", 6, false], ["world", 7, true],
	]);
});

test("Android Intl.Segmenter replacement keeps graphemes and sentences intact", () => {
	assert.deepEqual([...new Intl.Segmenter("en").segment("éx")].map((p) => p.segment), ["é", "x"]);
	assert.deepEqual([...new Intl.Segmenter("en", { granularity: "sentence" }).segment("A b. C?")].map((p) => p.segment), ["A b. ", "C?"]);
	assert.equal(new Intl.Segmenter("en", { granularity: "word" }).segment("ab cd").containing(4)?.segment, "cd");
});
