import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SyncEngine } from "../src/sync/engine.ts";
import type { Revision, SyncRemote } from "../src/sync/types.ts";

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sync-at-"));
  const revisions = new Map<string, Revision>();
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
  };
  const device = (name: string, start: number) => {
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
  return { dir, remote, revisions, device, write, read };
}

test("the newest edit wins regardless of random revision ids or upload order", async () => {
  let sawNewerWithSmallerId = false;
  for (let trial = 0; trial < 60 && !sawNewerWithSmallerId; trial++) {
    const s = setup(),
      a = s.device("a", 1000),
      b = s.device("b", 1000);
    s.write(a.root, "chats/c.json", { n: 0 });
    await a.engine.sync();
    await b.engine.sync();
    s.write(a.root, "chats/c.json", { n: "old" });
    s.write(b.root, "chats/c.json", { n: "new" });
    a.clock.t = 2000;
    b.clock.t = 9000;
    // The newer edit reaches the remote first; the older one arrives last.
    await b.engine.sync();
    await a.engine.sync();
    await b.engine.sync();
    assert.deepEqual(s.read(a.root, "chats/c.json"), { n: "new" });
    assert.deepEqual(s.read(b.root, "chats/c.json"), { n: "new" });
    const edits = [...s.revisions.values()].filter(
      (r) => r.meta.at === 2000 || r.meta.at === 9000,
    );
    assert.equal(edits.length, 2);
    const newer = edits.find((r) => r.meta.at === 9000)!,
      older = edits.find((r) => r.meta.at === 2000)!;
    if (newer.meta.id < older.meta.id) sawNewerWithSmallerId = true;
  }
  assert.ok(
    sawNewerWithSmallerId,
    "never produced a newer revision with the smaller id",
  );
});

test("legacy revisions without at still sync and order before timed ones", async () => {
  const s = setup(),
    a = s.device("a", 5000),
    b = s.device("b", 5000);
  s.write(a.root, "chats/c.json", { n: 0 });
  await a.engine.sync();
  // Simulate a previous build: strip `at` from every uploaded revision.
  for (const r of s.revisions.values()) delete r.meta.at;
  assert.equal((await b.engine.sync()).downloaded, 1);
  assert.deepEqual(s.read(b.root, "chats/c.json"), { n: 0 });
  s.write(b.root, "chats/c.json", { n: 1 });
  await b.engine.sync();
  const child = [...s.revisions.values()].find((r) => r.meta.parents.length);
  assert.equal(child!.meta.at, 5000);
  await a.engine.sync();
  assert.deepEqual(s.read(a.root, "chats/c.json"), { n: 1 });
});

test("at is strictly greater than every parent even with a skewed clock", async () => {
  const s = setup(),
    a = s.device("a", 100_000),
    b = s.device("b", 5);
  s.write(a.root, "chats/c.json", { n: 0 });
  await a.engine.sync();
  await b.engine.sync();
  s.write(b.root, "chats/c.json", { n: 1 });
  await b.engine.sync();
  const child = [...s.revisions.values()].find((r) => r.meta.parents.length)!;
  const parent = s.revisions.get(child.meta.parents[0]!)!;
  assert.equal(parent.meta.at, 100_000);
  assert.equal(child.meta.at, 100_001);
  // An invalid at is rejected.
  const bad = structuredClone(child);
  bad.meta.id = "bad-at-revision";
  bad.meta.at = -1;
  s.revisions.set(bad.meta.id, bad);
  await assert.rejects(a.engine.sync());
  bad.meta.at = 1.5;
  await assert.rejects(a.engine.sync());
});

test("workspace merge equal to a head collapses to a single head", async () => {
  const s = setup(),
    a = s.device("a", 1000),
    b = s.device("b", 1000);
  s.write(a.root, "graph/sources.json", { x: 1 });
  await a.engine.sync();
  await b.engine.sync();
  // Both devices make the identical change: merged content equals each head.
  s.write(a.root, "graph/sources.json", { x: 2 });
  s.write(b.root, "graph/sources.json", { x: 2 });
  a.clock.t = 2000;
  b.clock.t = 3000;
  await a.engine.sync();
  await b.engine.sync();
  const merge = [...s.revisions.values()].find(
    (r) => r.meta.unit === "workspace" && r.meta.parents.length === 2,
  );
  assert.ok(merge, "expected a merge revision with two parents");
  assert.equal(merge.meta.at, 3001);
  assert.equal((await b.engine.sync()).uploaded, 0);
  assert.equal((await a.engine.sync()).uploaded, 0);
  const metas = [...s.revisions.values()]
    .map((r) => r.meta)
    .filter((m) => m.unit === "workspace");
  const parents = new Set(metas.flatMap((m) => m.parents));
  assert.equal(metas.filter((m) => !parents.has(m.id)).length, 1);
});
