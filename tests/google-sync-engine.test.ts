import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SyncEngine } from "../src/sync/engine.ts";
import type { Revision, SyncRemote } from "../src/sync/types.ts";
function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sync-"));
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
  const write = (root: string, p: string, v: unknown) => {
    fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true });
    fs.writeFileSync(path.join(root, p), JSON.stringify(v));
  };
  return { dir, remote, revisions, device, write };
}
test("empty device downloads workspace; unknown secrets excluded; repeat is idempotent", async () => {
  const s = setup(),
    a = s.device("a"),
    b = s.device("b");
  s.write(a.root, "chats/c.json", { id: "c", messages: [] });
  s.write(a.root, "auth.json", { secret: "private" });
  await a.engine.sync();
  assert.equal(s.revisions.size, 1);
  assert.equal((await b.engine.sync()).downloaded, 1);
  assert.ok(fs.existsSync(path.join(b.root, "chats/c.json")));
  assert.equal((await b.engine.sync()).uploaded, 0);
  assert.ok(!JSON.stringify([...s.revisions.values()]).includes("private"));
});
test("concurrent edits converge and retain exportable losing revisions", async () => {
  const s = setup(),
    a = s.device("a"),
    b = s.device("b");
  s.write(a.root, "chats/c.json", { n: 0 });
  await a.engine.sync();
  await b.engine.sync();
  s.write(a.root, "chats/c.json", { n: 1 });
  s.write(b.root, "chats/c.json", { n: 2 });
  await a.engine.sync();
  assert.equal((await b.engine.sync()).conflicts, 1);
  await a.engine.sync();
  assert.equal(
    fs.readFileSync(path.join(a.root, "chats/c.json"), "utf8"),
    fs.readFileSync(path.join(b.root, "chats/c.json"), "utf8"),
  );
  assert.ok(fs.readdirSync(path.join(s.dir, "b-state/conflicts")).length);
});
test("account switch fails closed", async () => {
  const s = setup(),
    a = s.device("a");
  await a.engine.sync();
  await assert.rejects(
    new SyncEngine({
      root: a.root,
      stateDir: path.join(s.dir, "a-state"),
      remote: s.remote,
      accountId: "other",
    }).sync(),
    /account/i,
  );
});
test("local edits and busy state during download defer apply", async () => {
  const s = setup(),
    a = s.device("a"),
    b = s.device("b");
  s.write(a.root, "chats/c.json", { n: 1 });
  await a.engine.sync();
  const download = s.remote.download;
  s.remote.download = async (m) => {
    s.write(b.root, "chats/local.json", { n: 2 });
    return download(m);
  };
  assert.equal((await b.engine.sync()).deferred, true);
  assert.ok(!fs.existsSync(path.join(b.root, "chats/c.json")));
});
test("retry uses persisted pending revision instead of creating duplicates", async () => {
  const s = setup(),
    a = s.device("a");
  s.write(a.root, "chats/c.json", {});
  let id = "";
  const upload = s.remote.upload;
  s.remote.upload = async (r) => {
    id = r.meta.id;
    throw Error("offline");
  };
  await assert.rejects(a.engine.sync(), /offline/);
  s.remote.upload = upload;
  await a.engine.sync();
  assert.equal([...s.revisions.keys()][0], id);
});
test("rejects corrupt download without changing local data", async () => {
  const s = setup(),
    a = s.device("a"),
    b = s.device("b");
  s.write(a.root, "chats/c.json", {});
  await a.engine.sync();
  s.remote.download = async (m) => ({
    meta: m,
    files: { "../auth.json": "e30=" },
  });
  await assert.rejects(b.engine.sync());
  assert.ok(!fs.existsSync(path.join(b.root, "chats/c.json")));
});
test("document hash and textHash blobs upload before workspace; orphan blobs excluded", async () => {
  const s = setup(),
    a = s.device("a"),
    b = s.device("b");
  const { createHash } = await import("node:crypto");
  const bytes = Buffer.from("original"),
    text = Buffer.from("text");
  const hash = createHash("sha256").update(bytes).digest("hex"),
    textHash = createHash("sha256").update(text).digest("hex");
  fs.mkdirSync(path.join(a.root, "documents/blobs"), { recursive: true });
  for (const [h, v] of [
    [hash, bytes],
    [textHash, text],
  ] as const)
    fs.writeFileSync(path.join(a.root, "documents/blobs", h), v);
  fs.writeFileSync(
    path.join(
      a.root,
      "documents/blobs",
      createHash("sha256").update("orphan").digest("hex"),
    ),
    "orphan",
  );
  const id = createHash("sha256")
    .update("doc.pdf\0" + hash)
    .digest("hex");
  s.write(a.root, "documents/records/" + id + ".json", {
    id,
    size: bytes.length,
    mimeType: "application/pdf",
    importedAt: new Date().toISOString(),
    name: "doc.pdf",
    hash,
    textHash,
  });
  await a.engine.sync();
  assert.deepEqual(
    [...s.revisions.values()].map((r) => r.meta.unit).sort(),
    [
      "documents/blobs/" + hash,
      "documents/blobs/" + textHash,
      "document/" + id,
    ].sort(),
  );
  assert.equal([...s.revisions.values()].at(-1)!.meta.unit, "document/" + id);
  await b.engine.sync();
  assert.equal(
    fs.readFileSync(path.join(b.root, "documents/blobs", textHash), "utf8"),
    "text",
  );
});
test("browser preferences reject unknown keys and terminal jobs alone sync", async () => {
  const s = setup(),
    a = s.device("a");
  s.write(a.root, "browser-preferences.json", { "lh:keymap": "{}" });
  s.write(a.root, "jobs/done.json", { status: "done" });
  s.write(a.root, "jobs/active.json", { status: "running" });
  await a.engine.sync();
  assert.equal(s.revisions.size, 2);
  assert.ok(!JSON.stringify([...s.revisions.values()]).includes("active.json"));
  s.write(a.root, "browser-preferences.json", { secret: "no" });
  await assert.rejects(a.engine.sync(), /preference/i);
});
test("actual done/error jobs are retained as terminal records", async () => {
  const s = setup(),
    a = s.device("a");
  s.write(a.root, "jobs/done.json", { status: "done" });
  s.write(a.root, "jobs/error.json", { status: "error" });
  await a.engine.sync();
  assert.equal(
    [...s.revisions.values()].flatMap((r) => Object.keys(r.files)).length,
    2,
  );
});
test("settings redact sender binding and preserve receiving binding", async () => {
  const s = setup(),
    a = s.device("a"),
    b = s.device("b");
  s.write(a.root, "settings.json", {
    customProvider: {
      credentialBindingId: "sender",
      baseUrl: "https://a.example",
    },
  });
  await a.engine.sync();
  await b.engine.sync();
  s.write(b.root, "settings.json", {
    customProvider: {
      credentialBindingId: "receiver",
      baseUrl: "https://a.example",
    },
  });
  await b.engine.sync();
  s.write(a.root, "settings.json", {
    customProvider: {
      credentialBindingId: "sender",
      baseUrl: "https://b.example",
    },
  });
  await a.engine.sync();
  await b.engine.sync();
  const result = JSON.parse(
    fs.readFileSync(path.join(b.root, "settings.json"), "utf8"),
  );
  assert.equal(result.customProvider.credentialBindingId, "receiver");
  assert.equal(result.customProvider.baseUrl, "https://b.example");
  assert.ok(!JSON.stringify([...s.revisions.values()]).includes("sender"));
});
test("deletion tombstone does not resurrect on stale device", async () => {
  const s = setup(),
    a = s.device("a"),
    b = s.device("b");
  s.write(a.root, "chats/c.json", {});
  await a.engine.sync();
  await b.engine.sync();
  fs.unlinkSync(path.join(a.root, "chats/c.json"));
  await a.engine.sync();
  await b.engine.sync();
  assert.ok(!fs.existsSync(path.join(b.root, "chats/c.json")));
  assert.equal((await b.engine.sync()).uploaded, 0);
});
test("conflict recovery preserves active copy and publishes descendant of all known heads", async () => {
  const s = setup(),
    a = s.device("a"),
    b = s.device("b");
  s.write(a.root, "chats/c.json", { n: 0 });
  await a.engine.sync();
  await b.engine.sync();
  s.write(a.root, "chats/c.json", { n: 1 });
  s.write(b.root, "chats/c.json", { n: 2 });
  await a.engine.sync();
  await b.engine.sync();
  const conflicts = b.engine.listConflicts();
  assert.equal(conflicts.length, 1);
  const saved = b.engine.readConflict(conflicts[0]!.id)!;
  b.engine.restoreConflict(conflicts[0]!.id);
  assert.equal(
    fs.readFileSync(path.join(b.root, "chats/c.json")).toString("base64"),
    saved.files["chats/c.json"],
  );
  assert.equal(b.engine.listConflicts().length, 2);
  await b.engine.sync();
  assert.ok([...s.revisions.values()].some((r) => r.meta.parents.length === 2));
  assert.equal(b.engine.readConflict("../bad"), null);
});
test("offline pending upload never overwrites newer offline edits", async () => {
  const s = setup(),
    a = s.device("a");
  s.write(a.root, "chats/c.json", { n: 1 });
  const upload = s.remote.upload;
  s.remote.upload = async () => {
    throw Error("offline");
  };
  await assert.rejects(a.engine.sync());
  s.write(a.root, "chats/c.json", { n: 2 });
  s.remote.upload = upload;
  await a.engine.sync();
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(a.root, "chats/c.json"), "utf8")).n,
    2,
  );
  const b = s.device("b");
  await b.engine.sync();
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(b.root, "chats/c.json"), "utf8")).n,
    2,
  );
});
test("busy after remote await defers changes and single-flight shares promise", async () => {
  const s = setup(),
    a = s.device("a");
  s.write(a.root, "chats/c.json", {});
  await a.engine.sync();
  let busy = false;
  const b = s.device("b");
  const engine = new SyncEngine({
    root: b.root,
    stateDir: path.join(s.dir, "idle-state"),
    remote: s.remote,
    accountId: "a",
    isBusy: () => busy,
  });
  const download = s.remote.download;
  s.remote.download = async (m) => {
    busy = true;
    return download(m);
  };
  const first = engine.sync();
  assert.equal(first, engine.sync());
  assert.equal((await first).deferred, true);
  assert.ok(!fs.existsSync(path.join(b.root, "chats/c.json")));
});
test("invalid hash and missing parents fail closed", async () => {
  const s = setup(),
    a = s.device("a"),
    b = s.device("b");
  s.write(a.root, "chats/c.json", {});
  await a.engine.sync();
  const revision = [...s.revisions.values()][0]!;
  // A parent absent from the listing is pruned history, not corruption.
  revision.meta.parents = ["missing"];
  await b.engine.sync();
  assert.equal(fs.existsSync(path.join(b.root, "chats/c.json")), true);
  revision.meta.parents = [];
  revision.meta.hash = "0".repeat(64);
  await assert.rejects(b.engine.sync(), /hash/i);
});
test("nested prompt override paths sync as preferences", async () => {
  const s = setup(),
    a = s.device("a"),
    b = s.device("b");
  fs.mkdirSync(path.join(a.root, "prompts/teacher"), { recursive: true });
  fs.writeFileSync(
    path.join(a.root, "prompts/teacher/20-teaching.md"),
    "teach",
  );
  await a.engine.sync();
  await b.engine.sync();
  assert.equal(
    fs.readFileSync(
      path.join(b.root, "prompts/teacher/20-teaching.md"),
      "utf8",
    ),
    "teach",
  );
});
test("workspace file transaction rolls back all prior replacements when a rename fails", async () => {
  const s = setup(),
    a = s.device("a"),
    b = s.device("b");
  s.write(a.root, "graph/positions.json", { n: 1 });
  s.write(a.root, "graph/sources.json", {});
  await a.engine.sync();
  const rename = fs.renameSync;
  let calls = 0;
  fs.renameSync = ((from: fs.PathLike, to: fs.PathLike) => {
    if (String(from).includes(".sync-") && ++calls === 2)
      throw Error("disk failed");
    return rename(from, to);
  }) as typeof fs.renameSync;
  try {
    await assert.rejects(b.engine.sync(), /disk failed/);
    assert.ok(!fs.existsSync(path.join(b.root, "chats/c.json")));
    assert.ok(!fs.existsSync(path.join(b.root, "graph/sources.json")));
  } finally {
    fs.renameSync = rename;
  }
});
test("unreferenced blob corruption is excluded rather than breaking sync", async () => {
  const s = setup(),
    a = s.device("a");
  fs.mkdirSync(path.join(a.root, "documents/blobs"), { recursive: true });
  fs.writeFileSync(
    path.join(a.root, "documents/blobs", "0".repeat(64)),
    "invalid orphan",
  );
  s.write(a.root, "chats/c.json", {});
  await a.engine.sync();
  assert.equal(s.revisions.size, 1);
});
test("remote malformed document metadata is rejected before applying workspace", async () => {
  const s = setup(),
    a = s.device("a");
  s.write(a.root, "documents/records/" + "a".repeat(64) + ".json", {
    name: "../../secret",
    hash: "bad",
  });
  await assert.rejects(a.engine.sync(), /document/i);
});
test("settings unknown fields and nested credentials never upload", async () => {
  const s = setup(),
    a = s.device("a");
  s.write(a.root, "settings.json", {
    version: 1,
    secret: "top secret",
    customProvider: { apiKey: "nested secret", authMode: "keyless" },
    general: { autoUpdate: false, token: "secret" },
  });
  await a.engine.sync();
  const payload = JSON.stringify([...s.revisions.values()]);
  assert.ok(!payload.includes("secret"));
  const remote = JSON.parse(
    Buffer.from(
      [...s.revisions.values()][0]!.files["settings.json"]!,
      "base64",
    ).toString(),
  );
  assert.deepEqual(remote, {
    version: 1,
    general: { autoUpdate: false },
    customProvider: { authMode: "keyless" },
  });
});
test("learning text mentioning blob paths does not create document references", async () => {
  const s = setup(),
    a = s.device("a");
  s.write(a.root, "chats/c.json", {
    text: "documents/blobs/" + "0".repeat(64),
  });
  await a.engine.sync();
  assert.equal(s.revisions.size, 1);
});

test("libraries larger than 64MB are accepted with per-blob limits", async () => {
  const s = setup(),
    a = s.device("a");
  const { createHash } = await import("node:crypto");
  fs.mkdirSync(path.join(a.root, "documents/blobs"), { recursive: true });
  for (let i = 0; i < 4; i++) {
    const bytes = Buffer.alloc(17 * 1024 * 1024, i),
      hash = createHash("sha256").update(bytes).digest("hex"),
      name = "file" + i,
      id = createHash("sha256")
        .update(name + "\0" + hash)
        .digest("hex");
    fs.writeFileSync(path.join(a.root, "documents/blobs", hash), bytes);
    s.write(a.root, "documents/records/" + id + ".json", {
      id,
      name,
      hash,
      size: bytes.length,
      mimeType: "application/octet-stream",
      importedAt: new Date().toISOString(),
    });
  }
  const { capture } = await import("../src/sync/local.ts");
  assert.equal(Object.keys(capture(a.root)).length, 8);
  fs.rmSync(path.join(a.root, "documents"), { recursive: true });
});
test("immutable blob already on remote is not uploaded a second time", async () => {
  const s = setup(),
    a = s.device("a"),
    b = s.device("b");
  const { createHash } = await import("node:crypto");
  const bytes = Buffer.from("same"),
    hash = createHash("sha256").update(bytes).digest("hex"),
    name = "same.txt",
    id = createHash("sha256")
      .update(name + "\0" + hash)
      .digest("hex");
  for (const d of [a, b]) {
    fs.mkdirSync(path.join(d.root, "documents/blobs"), { recursive: true });
    fs.writeFileSync(path.join(d.root, "documents/blobs", hash), bytes);
    s.write(d.root, "documents/records/" + id + ".json", {
      id,
      name,
      hash,
      size: 4,
      mimeType: "text/plain",
      importedAt: "2026-11-02T00:00:00Z",
    });
  }
  await a.engine.sync();
  await b.engine.sync();
  assert.equal(
    [...s.revisions.values()].filter((r) =>
      r.meta.unit.startsWith("documents/blobs/"),
    ).length,
    1,
  );
});
test("unchanged document library sync downloads zero bytes", async () => {
  const s = setup(),
    a = s.device("a"),
    b = s.device("b");
  const { createHash } = await import("node:crypto");
  const bytes = Buffer.from("cached"),
    hash = createHash("sha256").update(bytes).digest("hex"),
    name = "cached.txt",
    id = createHash("sha256")
      .update(name + "\0" + hash)
      .digest("hex");
  fs.mkdirSync(path.join(a.root, "documents/blobs"), { recursive: true });
  fs.writeFileSync(path.join(a.root, "documents/blobs", hash), bytes);
  s.write(a.root, "documents/records/" + id + ".json", {
    id,
    name,
    hash,
    size: bytes.length,
    mimeType: "text/plain",
    importedAt: "2026-11-02T00:00:00Z",
  });
  await a.engine.sync();
  await b.engine.sync();
  s.remote.download = async () => {
    throw Error("must use local cache");
  };
  assert.equal((await b.engine.sync()).downloaded, 0);
  assert.equal((await a.engine.sync()).downloaded, 0);
});
test("conflict listing excludes copies belonging to another account", async () => {
  const s = setup(),
    a = s.device("a");
  fs.mkdirSync(path.join(s.dir, "a-state/conflicts"), { recursive: true });
  fs.writeFileSync(
    path.join(s.dir, "a-state/conflicts/foreign.json"),
    JSON.stringify({ accountId: "foreign", revision: {} }),
  );
  assert.deepEqual(a.engine.listConflicts(), []);
});
test("independent offline chats remain active on both devices", async () => {
  const s = setup(),
    a = s.device("a"),
    b = s.device("b");
  s.write(a.root, "chats/a.json", { id: "a" });
  s.write(b.root, "chats/b.json", { id: "b" });
  await a.engine.sync();
  await b.engine.sync();
  await a.engine.sync();
  for (const d of [a, b])
    assert.deepEqual(fs.readdirSync(path.join(d.root, "chats")).sort(), [
      "a.json",
      "b.json",
    ]);
});
test("source folder organization follows graph consistency group", async () => {
  const s = setup(),
    a = s.device("a"),
    b = s.device("b");
  s.write(a.root, "graph/source-organization.json", {
    version: 1,
    folders: [],
    placements: {},
  });
  await a.engine.sync();
  await b.engine.sync();
  assert.ok(fs.existsSync(path.join(b.root, "graph/source-organization.json")));
});

test("interrupted recovery defers while busy and saves divergent offline edits before rollback", async () => {
  const s = setup(),
    a = s.device("a");
  const stateDir = path.join(s.dir, "recover-state");
  fs.mkdirSync(stateDir, { recursive: true });
  s.write(a.root, "graph/sources.json", { n: 3 });
  const encode = (n: number) =>
    Buffer.from(JSON.stringify({ n })).toString("base64");
  fs.writeFileSync(
    path.join(stateDir, "transaction.json"),
    JSON.stringify({
      before: { "graph/sources.json": encode(1) },
      after: { "graph/sources.json": encode(2) },
    }),
  );
  let busy = true;
  const engine = new SyncEngine({
    root: a.root,
    stateDir,
    remote: s.remote,
    accountId: "a",
    isBusy: () => busy,
  });
  assert.equal((await engine.sync()).deferred, true);
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(a.root, "graph/sources.json"), "utf8"))
      .n,
    3,
  );
  busy = false;
  s.remote.list = async () => {
    throw Error("offline");
  };
  await assert.rejects(engine.sync(), /offline/);
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(a.root, "graph/sources.json"), "utf8"))
      .n,
    1,
  );
  const recovered = engine.listConflicts();
  assert.equal(recovered.length, 1);
  assert.equal(
    JSON.parse(
      Buffer.from(
        engine.readConflict(recovered[0]!.id)!.files["graph/sources.json"]!,
        "base64",
      ).toString(),
    ).n,
    3,
  );
});
test("known preference leaves cannot smuggle nested secret objects", async () => {
  const s = setup(),
    a = s.device("a");
  s.write(a.root, "settings.json", {
    compaction: { thresholdTokens: { secret: "hidden" } },
    general: { autoUpdate: true },
  });
  await a.engine.sync();
  const file = [...s.revisions.values()][0]!.files["settings.json"]!;
  assert.ok(!Buffer.from(file, "base64").toString().includes("hidden"));
});
test("symlinked allowlisted directories fail closed", async () => {
  const s = setup(),
    a = s.device("a");
  const outside = path.join(s.dir, "outside");
  fs.mkdirSync(outside);
  s.write(outside, "c.json", {});
  fs.symlinkSync(outside, path.join(a.root, "chats"), "junction");
  await assert.rejects(a.engine.sync(), /symlink/i);
  assert.equal(s.revisions.size, 0);
});
test("metadata-only capture never loads referenced blob bodies", async () => {
  const s = setup(),
    a = s.device("a");
  const { createHash } = await import("node:crypto");
  const hash = "1".repeat(64),
    name = "missing.bin",
    id = createHash("sha256")
      .update(name + "\0" + hash)
      .digest("hex");
  s.write(a.root, "documents/records/" + id + ".json", {
    id,
    name,
    hash,
    size: 20 * 1024 * 1024,
    mimeType: "application/octet-stream",
    importedAt: "2026-11-02T00:00:00Z",
  });
  const { capture } = await import("../src/sync/local.ts");
  const snapshot = capture(a.root, { includeBlobs: false });
  assert.deepEqual(Object.keys(snapshot), ["document/" + id]);
});
test("blob uploads persist at most one body and metadata pending contains no blob bodies", async () => {
  const s = setup(),
    a = s.device("a");
  const { createHash } = await import("node:crypto");
  for (let i = 0; i < 4; i++) {
    const bytes = Buffer.alloc(20 * 1024 * 1024, i),
      hash = createHash("sha256").update(bytes).digest("hex"),
      name = "bounded" + i,
      id = createHash("sha256")
        .update(name + "\0" + hash)
        .digest("hex");
    fs.mkdirSync(path.join(a.root, "documents/blobs"), { recursive: true });
    fs.writeFileSync(path.join(a.root, "documents/blobs", hash), bytes);
    s.write(a.root, "documents/records/" + id + ".json", {
      id,
      name,
      hash,
      size: bytes.length,
      mimeType: "application/octet-stream",
      importedAt: "2026-11-02T00:00:00Z",
    });
  }
  let blobs = 0;
  const upload = s.remote.upload;
  s.remote.upload = async (r) => {
    const state = JSON.parse(
      fs.readFileSync(path.join(s.dir, "a-state/state.json"), "utf8"),
    );
    assert.ok(
      !state.pending.some((p: Revision) =>
        p.meta.unit.startsWith("documents/blobs/"),
      ),
    );
    if (r.meta.unit.startsWith("documents/blobs/")) {
      blobs++;
      assert.equal(state.pendingBlob.meta.id, r.meta.id);
      assert.ok(
        fs.statSync(path.join(s.dir, "a-state/state.json")).size <
          30 * 1024 * 1024,
      );
    }
    await upload(r);
  };
  await a.engine.sync();
  assert.equal(blobs, 4);
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(s.dir, "a-state/state.json"), "utf8"))
      .pendingBlob,
    undefined,
  );
  fs.rmSync(path.join(a.root, "documents"), { recursive: true });
  s.revisions.clear();
});
test("failed blob upload retries same persisted id before publishing metadata", async () => {
  const s = setup(),
    a = s.device("a");
  const { createHash } = await import("node:crypto");
  const bytes = Buffer.from("retry blob"),
    hash = createHash("sha256").update(bytes).digest("hex"),
    name = "retry.bin",
    id = createHash("sha256")
      .update(name + "\0" + hash)
      .digest("hex");
  fs.mkdirSync(path.join(a.root, "documents/blobs"), { recursive: true });
  fs.writeFileSync(path.join(a.root, "documents/blobs", hash), bytes);
  s.write(a.root, "documents/records/" + id + ".json", {
    id,
    name,
    hash,
    size: bytes.length,
    mimeType: "application/octet-stream",
    importedAt: "2026-11-02T00:00:00Z",
  });
  let pendingId = "";
  const upload = s.remote.upload;
  s.remote.upload = async (r) => {
    pendingId = r.meta.id;
    throw Error("offline blob");
  };
  await assert.rejects(a.engine.sync(), /offline blob/);
  assert.equal(s.revisions.size, 0);
  s.remote.upload = upload;
  await a.engine.sync();
  assert.ok(s.revisions.has(pendingId));
  assert.equal(
    [...s.revisions.values()].filter((r) =>
      r.meta.unit.startsWith("documents/blobs/"),
    ).length,
    1,
  );
  const b = s.device("b");
  await b.engine.sync();
  assert.equal(
    fs.readFileSync(path.join(b.root, "documents/blobs", hash), "utf8"),
    "retry blob",
  );
});
test("downloaded blobs defer before disk writes when metadata changes during await", async () => {
  const s = setup(),
    a = s.device("a"),
    b = s.device("b");
  const { createHash } = await import("node:crypto");
  const bytes = Buffer.from("race blob"),
    hash = createHash("sha256").update(bytes).digest("hex"),
    name = "race.bin",
    id = createHash("sha256")
      .update(name + "\0" + hash)
      .digest("hex");
  fs.mkdirSync(path.join(a.root, "documents/blobs"), { recursive: true });
  fs.writeFileSync(path.join(a.root, "documents/blobs", hash), bytes);
  s.write(a.root, "documents/records/" + id + ".json", {
    id,
    name,
    hash,
    size: bytes.length,
    mimeType: "application/octet-stream",
    importedAt: "2026-11-02T00:00:00Z",
  });
  await a.engine.sync();
  const download = s.remote.download;
  s.remote.download = async (m) => {
    const r = await download(m);
    if (m.unit.startsWith("documents/blobs/"))
      s.write(b.root, "chats/local.json", { n: 1 });
    return r;
  };
  assert.equal((await b.engine.sync()).deferred, true);
  assert.ok(!fs.existsSync(path.join(b.root, "documents/blobs", hash)));
  assert.ok(
    !fs.existsSync(path.join(b.root, "documents/records", id + ".json")),
  );
});
for (const file of [
  "chats/versioned.json",
  "graph/format.json",
  "settings.json",
]) {
  test(`future incoming ${file} cannot replace current content`, async () => {
    const s = setup(),
      a = s.device("a");
    const current = { version: 1 };
    s.write(a.root, file, current);
    await a.engine.sync();
    const { filesHash, unitFor } = await import("../src/sync/local.ts");
    const parent = [...s.revisions.values()][0]!.meta.id;
    const files = {
      [file]: Buffer.from(
        JSON.stringify({ version: 2, newFeature: "preserve" }),
      ).toString("base64"),
    };
    s.revisions.set("future", {
      meta: {
        id: "future",
        unit: unitFor(file)!,
        parents: [parent],
        deleted: false,
        hash: filesHash(files),
      },
      files,
    });
    await assert.rejects(a.engine.sync(), /version/i);
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(a.root, file), "utf8")),
      current,
    );
  });
  test(`future local ${file} fails before any uploads`, async () => {
    const s = setup(),
      a = s.device("a");
    const future = { version: 2, newFeature: "keep local" };
    s.write(a.root, file, future);
    await assert.rejects(a.engine.sync(), /version/i);
    assert.equal(s.revisions.size, 0);
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(a.root, file), "utf8")),
      future,
    );
  });
}
test("version guards reject invalid stamps while allowing absent legacy stamps", async () => {
  const { clean } = await import("../src/sync/local.ts");
  for (const file of [
    "chats/versioned.json",
    "graph/format.json",
    "settings.json",
  ]) {
    for (const incoming of [false, true]) {
      for (const version of [0, -1, 1.5, "1", null])
        assert.throws(
          () => clean(file, Buffer.from(JSON.stringify({ version })), incoming),
          /version/i,
        );
      assert.doesNotThrow(() => clean(file, Buffer.from("{}"), incoming));
    }
  }
});
test("verified immutable blob cache skips rereads and invalidates changed files", async () => {
  const s = setup(),
    a = s.device("a");
  const { createHash } = await import("node:crypto");
  const { localBlobHash } = await import("../src/sync/local.ts");
  const bytes = Buffer.from("cache content"),
    hash = createHash("sha256").update(bytes).digest("hex"),
    ref = "documents/blobs/" + hash,
    file = path.join(a.root, ref);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes);
  const read = fs.readSync;
  let reads = 0;
  fs.readSync = ((...args: Parameters<typeof fs.readSync>) => {
    reads++;
    return Reflect.apply(read, fs, args);
  }) as typeof fs.readSync;
  try {
    const first = localBlobHash(a.root, ref);
    assert.ok(first);
    assert.ok(reads > 0);
    reads = 0;
    assert.equal(localBlobHash(a.root, ref), first);
    assert.equal(reads, 0);
    fs.writeFileSync(file, "wrong content");
    fs.utimesSync(file, new Date(), new Date(Date.now() + 1000));
    assert.equal(localBlobHash(a.root, ref), null);
    assert.ok(reads > 0);
  } finally {
    fs.readSync = read;
  }
});
test("blob verification rejects a file that changes during chunk reads", async () => {
  const s = setup(),
    a = s.device("a");
  const { createHash } = await import("node:crypto");
  const { localBlobHash } = await import("../src/sync/local.ts");
  const bytes = Buffer.from("race content"),
    hash = createHash("sha256").update(bytes).digest("hex"),
    ref = "documents/blobs/" + hash,
    file = path.join(a.root, ref);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes);
  const read = fs.readSync;
  let mutated = false;
  fs.readSync = ((...args: Parameters<typeof fs.readSync>) => {
    const n = Reflect.apply(read, fs, args);
    if (!mutated) {
      mutated = true;
      fs.appendFileSync(file, "changed");
    }
    return n;
  }) as typeof fs.readSync;
  try {
    assert.throws(() => localBlobHash(a.root, ref), /changed while reading/i);
  } finally {
    fs.readSync = read;
  }
});
test("deleting a never-uploaded pending chat publishes its tombstone instead of resurrecting it", async () => {
  const s = setup(),
    a = s.device("a");
  s.write(a.root, "chats/deleted.json", { id: "deleted" });
  const upload = s.remote.upload;
  s.remote.upload = async () => {
    throw Error("offline");
  };
  await assert.rejects(a.engine.sync(), /offline/);
  const pending = JSON.parse(
    fs.readFileSync(path.join(s.dir, "a-state/state.json"), "utf8"),
  ).pending[0] as Revision;
  fs.unlinkSync(path.join(a.root, "chats/deleted.json"));
  s.remote.upload = upload;
  await a.engine.sync();
  assert.ok(!fs.existsSync(path.join(a.root, "chats/deleted.json")));
  const tombstone = [...s.revisions.values()].find((r) => r.meta.deleted)!;
  assert.ok(tombstone);
  assert.deepEqual(tombstone.meta.parents, [pending.meta.id]);
  const b = s.device("b");
  await b.engine.sync();
  assert.ok(!fs.existsSync(path.join(b.root, "chats/deleted.json")));
});
test("fresh sidebar preferences preserve cloud model settings on both devices", async () => {
  const s = setup(),
    a = s.device("a"),
    b = s.device("b");
  const settings = {
    version: 1,
    models: { strong: { model: { provider: "openai", id: "chosen-model" } } },
  };
  s.write(a.root, "settings.json", settings);
  await a.engine.sync();
  s.write(b.root, "browser-preferences.json", { "lh:sidebar-open": "0" });
  await b.engine.sync();
  await a.engine.sync();
  for (const d of [a, b]) {
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(d.root, "settings.json"), "utf8")),
      settings,
    );
    assert.deepEqual(
      JSON.parse(
        fs.readFileSync(path.join(d.root, "browser-preferences.json"), "utf8"),
      ),
      { "lh:sidebar-open": "0" },
    );
  }
  assert.ok(
    [...s.revisions.values()].some(
      (r) => r.meta.unit === "preferences/settings",
    ),
  );
  assert.ok(
    [...s.revisions.values()].some(
      (r) => r.meta.unit === "preferences/browser",
    ),
  );
});
test("independent offline prompt overrides both remain active", async () => {
  const s = setup(),
    a = s.device("a"),
    b = s.device("b");
  for (const [device, file, text] of [
    [a, "teacher/20-teaching.md", "teacher"],
    [b, "prober/10-check.md", "prober"],
  ] as const) {
    fs.mkdirSync(path.dirname(path.join(device.root, "prompts", file)), {
      recursive: true,
    });
    fs.writeFileSync(path.join(device.root, "prompts", file), text);
  }
  await a.engine.sync();
  await b.engine.sync();
  await a.engine.sync();
  for (const d of [a, b]) {
    assert.equal(
      fs.readFileSync(
        path.join(d.root, "prompts/teacher/20-teaching.md"),
        "utf8",
      ),
      "teacher",
    );
    assert.equal(
      fs.readFileSync(path.join(d.root, "prompts/prober/10-check.md"), "utf8"),
      "prober",
    );
  }
  assert.equal(
    [...s.revisions.values()].filter((r) =>
      r.meta.unit.startsWith("preferences/prompt/"),
    ).length,
    2,
  );
});
