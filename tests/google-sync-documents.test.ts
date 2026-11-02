import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { saveDocument, listDocuments, readDocument } from "../src/store/documents.ts";

const roots: string[] = [];
function root() { const value = fs.mkdtempSync(path.join(os.tmpdir(), "lh-documents-")); roots.push(value); return value; }
afterEach(() => roots.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

test("original bytes are retained and equal uploads deduplicate without filename collisions", () => {
	const dir = root();
	const first = saveDocument({ name: "course/notes.pdf", mimeType: "application/pdf", bytes: Buffer.from("%PDF-example"), text: "reading text" }, dir);
	const same = saveDocument({ name: "course/notes.pdf", mimeType: "application/pdf", bytes: Buffer.from("%PDF-example"), text: "reading text" }, dir);
	const different = saveDocument({ name: "course/notes.pdf", mimeType: "application/pdf", bytes: Buffer.from("%PDF-other") }, dir);
	assert.equal(first.id, same.id);
	assert.notEqual(first.id, different.id);
	assert.equal(listDocuments(dir).length, 2);
	assert.equal(readDocument(first.id, dir)?.bytes.toString(), "%PDF-example");
});

test("document identifiers and source names cannot traverse directories", () => {
	const dir = root();
	assert.throws(() => saveDocument({ name: "../secret", mimeType: "text/plain", bytes: Buffer.from("x") }, dir), /name|path/i);
	assert.equal(readDocument("../../secret", dir), null);
});

test("corrupt or missing content is not served as a valid document", () => {
	const dir = root();
	const doc = saveDocument({ name: "notes.txt", mimeType: "text/plain", bytes: Buffer.from("valid") }, dir);
	fs.writeFileSync(path.join(dir, "documents", "blobs", doc.hash), "bad");
	assert.equal(readDocument(doc.id, dir), null);
});
