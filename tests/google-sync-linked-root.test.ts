import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { capture, safePath } from "../src/sync/local.ts";

// Android reaches the app data folder through a linked parent (/data/user/0 -> /data/data).
function linkedRoot() {
  const real = fs.mkdtempSync(path.join(os.tmpdir(), "sync-real-"));
  const outer = fs.mkdtempSync(path.join(os.tmpdir(), "sync-link-"));
  const link = path.join(outer, "user0");
  fs.symlinkSync(real, link, "dir");
  const root = path.join(link, "data");
  fs.mkdirSync(path.join(root, "chats"), { recursive: true });
  fs.writeFileSync(path.join(root, "chats", "a.json"), JSON.stringify({ id: "a" }));
  return root;
}

test("a data folder reached through a linked parent folder still syncs", () => {
  const root = linkedRoot();
  assert.equal(safePath(root, "chats/a.json"), path.join(root, "chats", "a.json"));
  assert.ok(capture(root, { includeBlobs: false })["chat/a"]);
});

test("links inside the data folder are still refused", () => {
  const root = linkedRoot();
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "sync-out-"));
  fs.symlinkSync(elsewhere, path.join(root, "jobs"), "dir");
  assert.throws(() => safePath(root, "jobs/x.json"), /Symlink refused/);
  fs.symlinkSync(path.join(elsewhere), path.join(root, "chats", "b.json"));
  assert.throws(() => capture(root, { includeBlobs: false }), /Symlink refused/);
});
