import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SyncEngine } from "../src/sync/engine.ts";
import type { Revision, SyncRemote } from "../src/sync/types.ts";

const DAY = 24 * 3600 * 1000;
const T0 = 1_700_000_000_000;

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sync-history-"));
  const revisions = new Map<string, Revision>();
  const removed: string[] = [];
  const control = { failRemove: false };
  const remote: SyncRemote = {
    async list() {
      return [...revisions.values()].map((r) => r.meta);
    },
    async download(m) {
      return structuredClone(revisions.get(m.id)!);
    },
    async upload(r) {
      revisions.set(r.meta.id, structuredClone(r));
    },
    async remove(m) {
      if (control.failRemove) throw Error("drive unavailable");
      removed.push(m.id);
      revisions.delete(m.id);
    },
  };
  const device = (name: string, start = T0) => {
    const root = path.join(dir, name),
      clock = { t: start };
    fs.mkdirSync(root, { recursive: true });
    return {
      root,
      clock,
      engine: new SyncEngine({
        root,
        stateDir: path.join(dir, name + "-state"),
        remote,
        accountId: "a",
        now: () => clock.t,
      }),
    };
  };
  const write = (root: string, p: string, v: unknown) => {
    fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true });
    fs.writeFileSync(path.join(root, p), JSON.stringify(v));
  };
  const read = (root: string, p: string) =>
    JSON.parse(fs.readFileSync(path.join(root, p), "utf8"));
  const ofUnit = (unit: string) =>
    [...revisions.values()].filter((r) => r.meta.unit === unit);
  /** Hang `n` ancient fake ancestors (a chain) under the unit's single head. */
  const addAncestors = (unit: string, n: number) => {
    const head = ofUnit(unit)[0]!;
    for (let i = 0; i < n; i++)
      revisions.set("fake" + i, {
        meta: {
          id: "fake" + i,
          unit,
          parents: i ? ["fake" + (i - 1)] : [],
          deleted: false,
          hash: "b".repeat(64),
          at: 1,
        },
        files: {},
      });
    head.meta.parents.push("fake" + (n - 1));
  };
  return { dir, revisions, removed, control, device, write, read, ofUnit, addAncestors };
}

test("compaction prunes old ancestors down to one revision per unit", async () => {
  const s = setup(),
    a = s.device("a");
  for (let i = 0; i < 12; i++) {
    a.clock.t = T0 + i * 1000;
    s.write(a.root, "chats/c.json", { n: i });
    s.write(a.root, "graph/sources.json", { n: i });
    await a.engine.sync();
  }
  assert.equal(s.ofUnit("chat/c").length, 12);
  assert.equal(s.ofUnit("workspace").length, 12);
  a.clock.t = T0 + 31 * DAY;
  await a.engine.sync();
  assert.equal(s.ofUnit("chat/c").length, 1);
  assert.equal(s.ofUnit("workspace").length, 1);
  assert.equal(s.revisions.size, 2);
  const b = s.device("b", T0 + 31 * DAY);
  await b.engine.sync();
  assert.deepEqual(s.read(b.root, "chats/c.json"), { n: 11 });
});

test("history inside the grace period is kept", async () => {
  const s = setup(),
    a = s.device("a");
  for (let i = 0; i < 5; i++) {
    a.clock.t = T0 + i * 1000;
    s.write(a.root, "chats/c.json", { n: i });
    await a.engine.sync();
  }
  a.clock.t = T0 + 29 * DAY;
  await a.engine.sync();
  assert.equal(s.ofUnit("chat/c").length, 5);
});

test("a stale device whose baseline was pruned syncs and converges", async () => {
  const s = setup(),
    a = s.device("a"),
    b = s.device("b"),
    c = s.device("c");
  s.write(a.root, "chats/c.json", { n: 0 });
  s.write(a.root, "graph/sources.json", { who: "a", base: 1 });
  await a.engine.sync();
  await b.engine.sync();
  await c.engine.sync();
  for (let i = 1; i < 6; i++) {
    a.clock.t = T0 + i * 1000;
    s.write(a.root, "chats/c.json", { n: i });
    s.write(a.root, "graph/sources.json", { who: "a", base: 1, i });
    await a.engine.sync();
  }
  a.clock.t = T0 + 40 * DAY;
  await a.engine.sync();
  assert.equal(s.ofUnit("chat/c").length, 1);
  // b edits offline on top of a pruned parent; c never edited anything.
  b.clock.t = T0 + 41 * DAY;
  s.write(b.root, "chats/c.json", { n: "b" });
  s.write(b.root, "graph/sources.json", { who: "a", base: 1, extra: "b" });
  await b.engine.sync();
  c.clock.t = T0 + 41 * DAY;
  await c.engine.sync();
  a.clock.t = T0 + 41 * DAY;
  await a.engine.sync();
  await b.engine.sync();
  await c.engine.sync();
  for (const d of [a, b, c]) assert.deepEqual(s.read(d.root, "chats/c.json"), { n: "b" });
  const ws = s.read(a.root, "graph/sources.json");
  assert.deepEqual(s.read(b.root, "graph/sources.json"), ws);
  assert.deepEqual(s.read(c.root, "graph/sources.json"), ws);
});

test("units with several heads are never compacted", async () => {
  const s = setup(),
    a = s.device("a"),
    b = s.device("b");
  s.write(a.root, "chats/c.json", { n: 0 });
  await a.engine.sync();
  await b.engine.sync();
  s.write(a.root, "chats/c.json", { n: 1 });
  s.write(b.root, "chats/c.json", { n: 2 });
  a.clock.t = T0 + 1000;
  b.clock.t = T0 + 2000;
  await a.engine.sync();
  await b.engine.sync();
  assert.equal(s.ofUnit("chat/c").length, 3);
  a.clock.t = T0 + 40 * DAY;
  await a.engine.sync();
  assert.equal(s.removed.length, 0);
  assert.equal(s.ofUnit("chat/c").length, 3);
});

test("blobs are kept while referenced and pruned once unreferenced and old", async () => {
  const s = setup(),
    a = s.device("a");
  const bytes = Buffer.from("original"),
    text = Buffer.from("text"),
    orphan = Buffer.from("orphan");
  const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
  const hash = sha(bytes),
    textHash = sha(text);
  fs.mkdirSync(path.join(a.root, "documents/blobs"), { recursive: true });
  fs.writeFileSync(path.join(a.root, "documents/blobs", hash), bytes);
  fs.writeFileSync(path.join(a.root, "documents/blobs", textHash), text);
  fs.writeFileSync(path.join(a.root, "documents/blobs", sha(orphan)), orphan);
  const id = sha(Buffer.from("doc.pdf\0" + hash));
  const record = "documents/records/" + id + ".json";
  s.write(a.root, record, {
    id,
    size: bytes.length,
    mimeType: "application/pdf",
    importedAt: new Date(T0).toISOString(),
    name: "doc.pdf",
    hash,
    textHash,
  });
  await a.engine.sync();
  const blobUnits = () =>
    [...s.revisions.values()]
      .map((r) => r.meta.unit)
      .filter((u) => u.startsWith("documents/blobs/"));
  assert.equal(blobUnits().length, 2);
  // Edit the record so the document unit has history too.
  a.clock.t = T0 + 1000;
  s.write(a.root, record, {
    ...s.read(a.root, record),
    importedAt: new Date(T0 + 1000).toISOString(),
  });
  await a.engine.sync();
  a.clock.t = T0 + 31 * DAY;
  await a.engine.sync();
  assert.equal(blobUnits().length, 2, "referenced blobs survive");
  assert.equal(s.ofUnit("document/" + id).length, 1);
  // Delete the document: its tombstone head stays, the blobs become garbage.
  fs.rmSync(path.join(a.root, record));
  a.clock.t = T0 + 31 * DAY + 1000;
  await a.engine.sync();
  assert.equal(blobUnits().length, 2, "recent cleanup already ran today");
  a.clock.t = T0 + 33 * DAY;
  await a.engine.sync();
  assert.equal(blobUnits().length, 0);
  const tomb = s.ofUnit("document/" + id);
  assert.equal(tomb.length, 1);
  assert.equal(tomb[0]!.meta.deleted, true);
});

test("compaction runs at most once per 24 hours", async () => {
  const s = setup(),
    a = s.device("a");
  s.write(a.root, "chats/c.json", { n: 0 });
  await a.engine.sync();
  s.addAncestors("chat/c", 3);
  a.clock.t = T0 + 31 * DAY;
  await a.engine.sync();
  assert.equal(s.removed.length, 3);
  s.addAncestors("chat/c", 2);
  a.clock.t += 23 * 3600 * 1000;
  await a.engine.sync();
  assert.equal(s.removed.length, 3);
  a.clock.t += 2 * 3600 * 1000;
  await a.engine.sync();
  assert.equal(s.removed.length, 5);
});

test("a failing remove never fails the sync or touches local files", async () => {
  const s = setup(),
    a = s.device("a");
  s.write(a.root, "chats/c.json", { n: 0 });
  await a.engine.sync();
  s.addAncestors("chat/c", 3);
  s.control.failRemove = true;
  a.clock.t = T0 + 31 * DAY;
  await a.engine.sync();
  assert.deepEqual(s.read(a.root, "chats/c.json"), { n: 0 });
  assert.equal(s.revisions.size, 4);
  s.control.failRemove = false;
  a.clock.t += 25 * 3600 * 1000;
  await a.engine.sync();
  assert.equal(s.revisions.size, 1);
});

test("more than 10,000 remote revisions no longer stops sync and cleanup is bounded", async () => {
  const s = setup(),
    a = s.device("a");
  s.write(a.root, "chats/c.json", { n: 0 });
  await a.engine.sync();
  s.addAncestors("chat/c", 10_001);
  a.clock.t = T0 + 31 * DAY;
  s.write(a.root, "chats/c.json", { n: 1 });
  await a.engine.sync();
  assert.deepEqual(s.read(a.root, "chats/c.json"), { n: 1 });
  assert.equal(s.removed.length, 500);
  assert.equal(s.revisions.size, 10_003 - 500);
});

test("a present parent from another unit is still rejected", async () => {
  const s = setup(),
    a = s.device("a"),
    b = s.device("b");
  s.write(a.root, "chats/c.json", { n: 0 });
  s.write(a.root, "chats/d.json", { n: 0 });
  await a.engine.sync();
  const [x, y] = [s.ofUnit("chat/c")[0]!, s.ofUnit("chat/d")[0]!];
  x.meta.parents = [y.meta.id];
  await assert.rejects(b.engine.sync(), /parent/i);
});
