import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SyncEngine } from "../src/sync/engine.ts";
import { mergeWorkspace } from "../src/sync/merge.ts";
import type { Revision, SyncRemote } from "../src/sync/types.ts";
const enc = (t: string) => Buffer.from(t).toString("base64");
const dec = (t: string | undefined) =>
  Buffer.from(t ?? "", "base64").toString("utf8");
const json = (v: unknown) => enc(JSON.stringify(v, null, "\t"));
test("mergeWorkspace unions ledgers and keeps first head order", () => {
  const out = mergeWorkspace({ "graph/nodes.jsonl": enc('{"id":"a"}\n') }, [
    { "graph/nodes.jsonl": enc('{"id":"a"}\n{"id":"b"}') },
    { "graph/nodes.jsonl": enc('{"id":"c"}\n\n{"id":"a"}\n') },
  ]);
  assert.equal(
    dec(out["graph/nodes.jsonl"]),
    '{"id":"a"}\n{"id":"b"}\n{"id":"c"}\n',
  );
});
test("mergeWorkspace merges sources 3-way", () => {
  const base = { "graph/sources.json": json({ a: 1, b: 1, c: 1, d: 1 }) };
  const out = mergeWorkspace(base, [
    { "graph/sources.json": json({ a: 2, b: 1, c: 2, e: 1 }) },
    { "graph/sources.json": json({ a: 3, b: 2, d: 1, f: 1 }) },
  ]);
  // a: both changed -> last; b: changed by one; c: changed vs deleted -> kept;
  // d: deleted by one, unchanged by other -> deleted.
  assert.deepEqual(JSON.parse(dec(out["graph/sources.json"])), {
    a: 3,
    b: 2,
    c: 2,
    e: 1,
    f: 1,
  });
});
test("mergeWorkspace merges positions and takes latest updatedAt", () => {
  const p = (positions: object, updatedAt: string) =>
    json({ positions, updatedAt });
  const out = mergeWorkspace(
    { "graph/positions.json": p({ n: [0, 0] }, "2026-01-01T00:00:00.000Z") },
    [
      {
        "graph/positions.json": p(
          { n: [1, 1], x: [2, 2] },
          "2026-03-01T00:00:00.000Z",
        ),
      },
      {
        "graph/positions.json": p(
          { n: [0, 0], y: [3, 3] },
          "2026-02-01T00:00:00.000Z",
        ),
      },
    ],
  );
  assert.deepEqual(JSON.parse(dec(out["graph/positions.json"])), {
    positions: { n: [1, 1], x: [2, 2], y: [3, 3] },
    updatedAt: "2026-03-01T00:00:00.000Z",
  });
});
test("mergeWorkspace merges source organization folders and placements", () => {
  const folder = (id: string) => ({
    id,
    name: id,
    parentId: null,
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  const org = (folders: object[], placements: object) =>
    enc(JSON.stringify({ version: 1, folders, placements }, null, "\t") + "\n");
  const f = "graph/source-organization.json";
  const out = mergeWorkspace({ [f]: org([], {}) }, [
    { [f]: org([folder("f1")], { s1: { folderId: "f1" } }) },
    { [f]: org([folder("f2")], { s2: { folderId: "f2" } }) },
  ]);
  const text = dec(out[f]);
  assert.ok(text.endsWith("\n"));
  const parsed = JSON.parse(text);
  assert.deepEqual(
    parsed.folders.map((x: { id: string }) => x.id),
    ["f1", "f2"],
  );
  assert.deepEqual(Object.keys(parsed.placements), ["s1", "s2"]);
});
test("mergeWorkspace drops files deleted everywhere and takes the last head otherwise", () => {
  const out = mergeWorkspace(
    {
      "graph/format.json": json({ version: 1 }),
      "graph/sources.json": json({}),
    },
    [{}, { "graph/render-settings.json": json({ a: 1 }) }],
  );
  assert.deepEqual(Object.keys(out), ["graph/render-settings.json"]);
  const f = mergeWorkspace(null, [
    { "graph/format.json": json({ version: 1, n: 1 }) },
    { "graph/format.json": json({ version: 1, n: 2 }) },
  ]);
  assert.equal(JSON.parse(dec(f["graph/format.json"])).n, 2);
});
function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sync-merge-"));
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
    async remove(m) {
      revisions.delete(m.id);
    },
  };
  const device = (name: string) => {
    const root = path.join(dir, name);
    fs.mkdirSync(root, { recursive: true });
    return {
      root,
      engine: new SyncEngine({
        root,
        stateDir: path.join(dir, name + "-state"),
        remote,
        accountId: "a",
      }),
    };
  };
  return { dir, device };
}
test("concurrent graph edits on two devices merge without conflict copies", async () => {
  const s = setup(),
    a = s.device("a"),
    b = s.device("b");
  const put = (root: string, p: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true });
    fs.writeFileSync(path.join(root, p), text);
  };
  const read = (root: string, p: string) =>
    fs.readFileSync(path.join(root, p), "utf8");
  put(a.root, "graph/nodes.jsonl", '{"id":"n0"}\n');
  put(a.root, "graph/sources.json", JSON.stringify({ s0: 0 }, null, "\t"));
  await a.engine.sync();
  await b.engine.sync();
  fs.appendFileSync(path.join(a.root, "graph/nodes.jsonl"), '{"id":"na"}\n');
  fs.appendFileSync(path.join(b.root, "graph/nodes.jsonl"), '{"id":"nb"}\n');
  put(
    a.root,
    "graph/sources.json",
    JSON.stringify({ s0: 0, sa: 1 }, null, "\t"),
  );
  put(
    b.root,
    "graph/sources.json",
    JSON.stringify({ s0: 0, sb: 2 }, null, "\t"),
  );
  await a.engine.sync();
  assert.equal((await b.engine.sync()).conflicts, 0);
  await a.engine.sync();
  for (const p of ["graph/nodes.jsonl", "graph/sources.json"])
    assert.equal(read(a.root, p), read(b.root, p));
  const lines = read(a.root, "graph/nodes.jsonl").split("\n").filter(Boolean);
  assert.deepEqual(lines.sort(), ['{"id":"n0"}', '{"id":"na"}', '{"id":"nb"}']);
  assert.deepEqual(JSON.parse(read(a.root, "graph/sources.json")), {
    s0: 0,
    sa: 1,
    sb: 2,
  });
  for (const d of ["a", "b"]) {
    const conflicts = path.join(s.dir, d + "-state/conflicts");
    assert.ok(!fs.existsSync(conflicts) || !fs.readdirSync(conflicts).length);
  }
  assert.equal((await a.engine.sync()).uploaded, 0);
  assert.equal((await b.engine.sync()).uploaded, 0);
  assert.equal((await a.engine.sync()).uploaded, 0);
});
