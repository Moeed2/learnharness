import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SyncEngine } from "../src/sync/engine.ts";
import { capture, fingerprint } from "../src/sync/local.ts";
import type { Revision, SyncRemote } from "../src/sync/types.ts";

const old = () => new Date(Date.now() - 60_000);
function tree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sync-perf-"));
  const write = (p: string, v: unknown, age = true) => {
    const file = path.join(root, p);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(v));
    if (age) fs.utimesSync(file, old(), old());
    return file;
  };
  return { root, write };
}
function countReads<T>(fn: () => T): { value: T; reads: number } {
  const original = fs.readFileSync;
  let reads = 0;
  fs.readFileSync = ((...args: Parameters<typeof fs.readFileSync>) => {
    reads++;
    return Reflect.apply(original, fs, args);
  }) as typeof fs.readFileSync;
  try {
    return { value: fn(), reads };
  } finally {
    fs.readFileSync = original;
  }
}
const decode = (b64: string) => JSON.parse(Buffer.from(b64, "base64").toString());

test("capture reuses cleaned content of unchanged files and invalidates on edit", () => {
  const t = tree();
  t.write("chats/a.json", { id: "a" });
  const file = t.write("chats/b.json", { id: "b", n: 1 });
  const first = countReads(() => capture(t.root, { includeBlobs: false }));
  assert.equal(first.reads, 2);
  const second = countReads(() => capture(t.root, { includeBlobs: false }));
  assert.equal(second.reads, 0);
  assert.deepEqual(second.value, first.value);
  // Same mtime restored after a rewrite: only size and ctime reveal the edit.
  const before = fs.statSync(file);
  fs.writeFileSync(file, JSON.stringify({ id: "b", n: 1, extra: "longer" }));
  fs.utimesSync(file, before.atime, before.mtime);
  const third = countReads(() => capture(t.root, { includeBlobs: false }));
  assert.equal(third.reads, 1);
  assert.notDeepEqual(third.value, first.value);
  assert.equal(decode(third.value["chat/b"]!["chats/b.json"]!).extra, "longer");
});

test("recently modified files are never served from the cache", () => {
  const t = tree();
  const file = t.write("chats/a.json", { id: "a", v: 1 }, false);
  capture(t.root, { includeBlobs: false });
  assert.equal(countReads(() => capture(t.root, { includeBlobs: false })).reads, 1);
  fs.writeFileSync(file, JSON.stringify({ id: "a", v: 2 }));
  const next = countReads(() => capture(t.root, { includeBlobs: false }));
  assert.equal(next.reads, 1);
  assert.equal(decode(next.value["chat/a"]!["chats/a.json"]!).v, 2);
});

test("vanished files leave the cache and symlinks are still refused", () => {
  const t = tree();
  const file = t.write("chats/a.json", { id: "a" });
  capture(t.root, { includeBlobs: false });
  fs.rmSync(file);
  assert.deepEqual(capture(t.root, { includeBlobs: false }), {});
  fs.writeFileSync(path.join(t.root, "real.json"), "{}");
  fs.symlinkSync(path.join(t.root, "real.json"), file);
  assert.throws(() => capture(t.root, { includeBlobs: false }), /Symlink refused/);
});

test("fingerprint only stats allowlisted files and tracks stamps", () => {
  const t = tree();
  const file = t.write("chats/a.json", { id: "a" });
  t.write("auth.json", { secret: 1 });
  const first = countReads(() => fingerprint(t.root));
  assert.equal(first.reads, 0);
  assert.equal(first.value.hot, false);
  assert.equal(fingerprint(t.root).hash, first.value.hash);
  fs.utimesSync(file, new Date(), old());
  assert.notEqual(fingerprint(t.root).hash, first.value.hash);
  const base = fingerprint(t.root);
  t.write("auth.json", { secret: 2 });
  assert.equal(fingerprint(t.root).hash, base.hash);
  t.write("chats/b.json", {}, false);
  assert.equal(fingerprint(t.root).hot, true);
});

function engineSetup() {
  const t = tree();
  const revisions = new Map<string, Revision>();
  let lists = 0;
  const remote: SyncRemote = {
    async list() {
      lists++;
      return [...revisions.values()].map((r) => r.meta);
    },
    async download(m) {
      return structuredClone(revisions.get(m.id)!);
    },
    async upload(r) {
      revisions.set(r.meta.id, structuredClone(r));
    },
    async remove(m) {
      revisions.delete(m.id);
    },
  };
  const clock = { t: Date.now() };
  const engine = new SyncEngine({
    root: t.root,
    stateDir: fs.mkdtempSync(path.join(os.tmpdir(), "sync-perf-state-")),
    remote,
    accountId: "a",
    now: () => clock.t,
  });
  return { ...t, remote, engine, clock, lists: () => lists, revisions };
}

test("idle background runs skip the Drive listing until the listing is stale", async () => {
  const s = engineSetup();
  s.write("chats/a.json", { id: "a" });
  await s.engine.sync({ reason: "timer" });
  assert.equal(s.lists(), 1, "first run always lists");
  const uploaded = s.revisions.size;
  s.clock.t += 30_000;
  assert.equal((await s.engine.sync({ reason: "timer" })).skipped, true);
  assert.equal((await s.engine.sync({ reason: "event" })).skipped, true);
  assert.equal(s.lists(), 1);
  assert.equal((await s.engine.sync({ reason: "foreground" })).skipped, undefined);
  assert.equal(s.lists(), 2);
  assert.equal((await s.engine.sync({ reason: "manual" })).skipped, undefined);
  assert.equal(s.lists(), 3);
  assert.equal((await s.engine.sync({ reason: "timer" })).skipped, true);
  s.clock.t += 5 * 60_000 + 1;
  assert.equal((await s.engine.sync({ reason: "timer" })).skipped, undefined);
  assert.equal(s.lists(), 4);
  assert.equal(s.revisions.size, uploaded);
});

test("a local change ends the idle skip and is uploaded by a background run", async () => {
  const s = engineSetup();
  const file = s.write("chats/a.json", { id: "a" });
  await s.engine.sync({ reason: "timer" });
  s.clock.t += 1000;
  fs.writeFileSync(file, JSON.stringify({ id: "a", edited: true }));
  fs.utimesSync(file, old(), old());
  const result = await s.engine.sync({ reason: "event" });
  assert.equal(result.skipped, undefined);
  assert.equal(result.uploaded, 1);
  assert.equal(s.lists(), 2);
});

test("a run that applied remote files is not skipped next time", async () => {
  const s = engineSetup();
  s.write("chats/a.json", { id: "a" });
  await s.engine.sync({ reason: "timer" });
  const other = new SyncEngine({
    root: fs.mkdtempSync(path.join(os.tmpdir(), "sync-perf-b-")),
    stateDir: fs.mkdtempSync(path.join(os.tmpdir(), "sync-perf-bs-")),
    remote: s.remote,
    accountId: "a",
  });
  assert.equal((await other.sync({ reason: "timer" })).downloaded, 1);
  assert.equal((await other.sync({ reason: "timer" })).skipped, undefined);
});

test("unchanged() trusts matching stamps, but a touch without content change does not defer", async () => {
  const s = engineSetup();
  const file = s.write("chats/a.json", { id: "a" });
  const list = s.remote.list.bind(s.remote);
  let mode: "none" | "touch" | "edit" = "none";
  s.remote.list = async () => {
    if (mode === "touch") fs.utimesSync(file, new Date(), old());
    if (mode === "edit") fs.writeFileSync(file, JSON.stringify({ id: "a", changed: 1 }));
    return list();
  };
  assert.equal((await s.engine.sync({ reason: "manual" })).deferred, false);
  mode = "touch";
  assert.equal((await s.engine.sync({ reason: "manual" })).deferred, false);
  mode = "edit";
  assert.equal((await s.engine.sync({ reason: "manual" })).deferred, true);
});
