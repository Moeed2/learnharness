import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type {
  Revision,
  RevisionMeta,
  SyncEngineOptions,
  SyncResult,
} from "./types.ts";
import {
  apply,
  atomicJSON,
  blobReferences,
  capture,
  localBlobHash,
  writeBlob,
  filesHash,
  recover,
  safePath,
  validateMeta,
  validateRevision,
} from "./local.ts";
interface Baseline {
  hash: string;
  heads: string[];
}
interface State {
  accountId: string;
  baseline: Record<string, Baseline>;
  pending: Revision[];
  pendingBlob?: Revision;
}
const flights = new Map<string, Promise<SyncResult>>();
export class SyncEngine {
  constructor(private readonly options: SyncEngineOptions) {}
  sync(): Promise<SyncResult> {
    const key = path.resolve(this.options.root);
    const active = flights.get(key);
    if (active) return active;
    const run = this.run().finally(() => {
      flights.delete(key);
    });
    flights.set(key, run);
    return run;
  }
  listConflicts(): { id: string; name: string }[] {
    const dir = safePath(this.options.stateDir, "conflicts");
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter((name) => /^[A-Za-z0-9_-]{1,128}\.json$/.test(name))
      .map((name) => ({ id: name.slice(0, -5), name }))
      .filter(({ id }) => this.readConflict(id) !== null);
  }
  readConflict(id: string): Revision | null {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) return null;
    try {
      const saved = JSON.parse(
        fs.readFileSync(
          safePath(this.options.stateDir, "conflicts/" + id + ".json"),
          "utf8",
        ),
      );
      if (saved.accountId !== this.options.accountId) return null;
      const r = saved.revision as Revision;
      validateRevision(r, r.meta);
      if (r.meta.id !== id) return null;
      return r;
    } catch {
      return null;
    }
  }
  restoreConflict(id: string): void {
    const o = this.options;
    if (o.isBusy?.() || flights.has(path.resolve(o.root)))
      throw Error("Workspace busy");
    const r = this.readConflict(id);
    if (!r) throw Error("Invalid conflict");
    const stateFile = safePath(o.stateDir, "state.json"),
      state = JSON.parse(fs.readFileSync(stateFile, "utf8")) as State;
    if (
      state.accountId !== o.accountId ||
      state.pending.length ||
      state.pendingBlob
    )
      throw Error("Account mismatch or pending sync");
    recover(o.root, o.stateDir, o.accountId);
    const local = capture(o.root, { includeBlobs: false });
    for (const ref of blobReferences(r.files)) {
      if (!localBlobHash(o.root, ref))
        throw Error("Missing or corrupt conflict blob");
    }
    const files = local[r.meta.unit] ?? {};
    const current: Revision = {
      meta: {
        id: randomUUID(),
        unit: r.meta.unit,
        parents: state.baseline[r.meta.unit]?.heads ?? [],
        deleted: Object.keys(files).length === 0,
        hash: filesHash(files),
      },
      files,
    };
    atomicJSON(safePath(o.stateDir, "conflicts/" + current.meta.id + ".json"), {
      accountId: o.accountId,
      revision: current,
    });
    const changed = apply(o.root, o.stateDir, files, r.files);
    // Force publication even if the recovered content equals the active winner.
    state.baseline[r.meta.unit] = {
      heads: state.baseline[r.meta.unit]?.heads ?? [],
      hash: "restored",
    };
    atomicJSON(stateFile, state);
    o.onApplied?.(changed);
  }
  private async run(): Promise<SyncResult> {
    const o = this.options,
      result: SyncResult = {
        uploaded: 0,
        downloaded: 0,
        conflicts: 0,
        deferred: false,
      };
    if (!o.accountId) throw Error("Account required");
    fs.mkdirSync(o.root, { recursive: true });
    fs.mkdirSync(o.stateDir, { recursive: true });
    safePath(o.root, "settings.json");
    safePath(o.stateDir, "state.json");
    const stateFile = path.join(o.stateDir, "state.json");
    const state: State = fs.existsSync(stateFile)
      ? JSON.parse(fs.readFileSync(stateFile, "utf8"))
      : { accountId: o.accountId, baseline: {}, pending: [] };
    if (state.accountId !== o.accountId)
      throw Error("Account binding mismatch: use a separate data root");
    atomicJSON(stateFile, state);
    if (o.isBusy?.()) {
      result.deferred = true;
      return result;
    }
    recover(o.root, o.stateDir, o.accountId);
    const initial = capture(o.root, { includeBlobs: false }),
      fingerprint = filesHash(
        Object.fromEntries(
          Object.entries(initial).map(([u, f]) => [u, filesHash(f)]),
        ),
      );
    const unchanged = () =>
      !o.isBusy?.() &&
      fingerprint ===
        filesHash(
          Object.fromEntries(
            Object.entries(capture(o.root, { includeBlobs: false })).map(
              ([u, f]) => [u, filesHash(f)],
            ),
          ),
        );
    let listed = await o.remote.list();
    if (listed.length > 10000) throw Error("Too many revisions");
    const metas = new Map<string, RevisionMeta>();
    for (const meta of listed) {
      validateMeta(meta);
      const prior = metas.get(meta.id);
      if (prior && JSON.stringify(prior) !== JSON.stringify(meta))
        throw Error("Duplicate revision mismatch");
      metas.set(meta.id, meta);
    }
    for (const r of [
      ...state.pending,
      ...(state.pendingBlob ? [state.pendingBlob] : []),
    ]) {
      validateRevision(r, r.meta);
      const m = metas.get(r.meta.id);
      if (m && JSON.stringify(m) !== JSON.stringify(r.meta))
        throw Error("Pending metadata mismatch");
      metas.set(r.meta.id, r.meta);
    }
    const visiting = new Set<string>(),
      visited = new Set<string>();
    function visit(m: RevisionMeta) {
      if (visiting.has(m.id)) throw Error("Cyclic parents");
      if (visited.has(m.id)) return;
      visiting.add(m.id);
      for (const id of m.parents) {
        const p = metas.get(id);
        if (!p || p.unit !== m.unit)
          throw Error("Missing or cross-unit parent");
        visit(p);
      }
      visiting.delete(m.id);
      visited.add(m.id);
    }
    for (const m of metas.values()) visit(m);
    if (!unchanged()) {
      result.deferred = true;
      return result;
    }
    const publishBlob = async (revision: Revision) => {
      validateRevision(revision, revision.meta);
      state.pendingBlob = revision;
      atomicJSON(stateFile, state);
      if (!listed.some((m) => m.id === revision.meta.id)) {
        await o.remote.upload(revision);
        result.uploaded++;
        listed.push(revision.meta);
      }
      metas.set(revision.meta.id, revision.meta);
      delete state.pendingBlob;
      atomicJSON(stateFile, state);
    };
    if (state.pendingBlob) {
      await publishBlob(state.pendingBlob);
      if (!unchanged()) {
        result.deferred = true;
        return result;
      }
    }
    // Migrate pending blobs from older builds without adding any more bodies.
    for (const r of state.pending.filter((r) =>
      r.meta.unit.startsWith("documents/blobs/"),
    )) {
      await publishBlob(r);
      state.pending = state.pending.filter((p) => p.meta.id !== r.meta.id);
      atomicJSON(stateFile, state);
      if (!unchanged()) {
        result.deferred = true;
        return result;
      }
    }
    const references = new Set(
      [...Object.values(initial), ...state.pending.map((r) => r.files)].flatMap(
        blobReferences,
      ),
    );
    for (const ref of references) {
      if ([...metas.values()].some((m) => m.unit === ref)) continue;
      const hash = localBlobHash(o.root, ref);
      if (!hash) throw Error("Missing or corrupt referenced blob");
      // Only this blob body is retained across the upload await.
      const files = {
        [ref]: fs.readFileSync(safePath(o.root, ref)).toString("base64"),
      };
      await publishBlob({
        meta: {
          id: randomUUID(),
          unit: ref,
          parents: [],
          deleted: false,
          hash,
        },
        files,
      });
      if (!unchanged()) {
        result.deferred = true;
        return result;
      }
    }
    const ensureBlob = async (ref: string): Promise<boolean> => {
      const candidates = [...metas.values()]
        .filter((m) => m.unit === ref)
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      const meta = candidates.at(-1);
      if (!meta) throw Error("Missing referenced blob");
      if (localBlobHash(o.root, ref) === meta.hash) return true;
      const revision = await o.remote.download(meta);
      validateRevision(revision, meta);
      result.downloaded++;
      if (!unchanged()) return false;
      writeBlob(o.root, revision);
      return true;
    };
    for (const ref of references)
      if (!(await ensureBlob(ref))) {
        result.deferred = true;
        return result;
      }
    const units = new Set([
      ...Object.keys(initial),
      ...Object.keys(state.baseline),
      ...state.pending.map((revision) => revision.meta.unit),
    ]);
    for (const unit of units) {
      if (unit.startsWith("documents/blobs/")) continue;
      const pending = state.pending.filter((r) => r.meta.unit === unit).at(-1);
      const files = initial[unit] ?? {},
        hash = filesHash(files),
        base = state.baseline[unit];
      if (
        pending
          ? pending.meta.hash === hash
          : base?.hash === hash || (!base && !Object.keys(files).length)
      )
        continue;
      const revision: Revision = {
        meta: {
          id: randomUUID(),
          unit,
          parents: pending ? [pending.meta.id] : (base?.heads ?? []),
          deleted: !Object.keys(files).length,
          hash,
        },
        files,
      };
      validateRevision(revision, revision.meta);
      state.pending.push(revision);
      metas.set(revision.meta.id, revision.meta);
    }
    atomicJSON(stateFile, state);
    // All blob uploads complete before metadata revisions are published.
    const cache = new Map<string, Revision>(
      state.pending.map((r) => [r.meta.id, r]),
    );
    for (const revision of state.pending) {
      for (const ref of blobReferences(revision.files)) {
        if (![...metas.values()].some((m) => m.unit === ref && !m.deleted))
          throw Error("Missing referenced blob");
      }
      if (!listed.some((m) => m.id === revision.meta.id)) {
        await o.remote.upload(revision);
        result.uploaded++;
        listed = [...listed, revision.meta];
      }
    }
    const byUnit = new Map<string, RevisionMeta[]>();
    for (const m of metas.values()) {
      if (m.unit.startsWith("documents/blobs/")) continue;
      const group = byUnit.get(m.unit) ?? [];
      group.push(m);
      byUnit.set(m.unit, group);
    }
    const selected = new Map<
      string,
      { heads: RevisionMeta[]; winner: RevisionMeta }
    >();
    for (const [unit, group] of byUnit) {
      const parents = new Set(group.flatMap((m) => m.parents));
      const heads = group
        .filter((m) => !parents.has(m.id))
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      selected.set(unit, { heads, winner: heads[heads.length - 1]! });
    }
    const get = async (m: RevisionMeta) => {
      let r = cache.get(m.id);
      if (!r) {
        const files = initial[m.unit] ?? {};
        if (
          filesHash(files) === m.hash &&
          (!m.deleted || !Object.keys(files).length)
        ) {
          r = { meta: m, files };
        } else {
          const conflict = this.readConflict(m.id);
          if (conflict) r = conflict;
        }
        if (r) {
          validateRevision(r, m);
          cache.set(m.id, r);
        }
      }
      if (!r) {
        r = await o.remote.download(m);
        validateRevision(r, m);
        cache.set(m.id, r);
        result.downloaded++;
      }
      return r;
    };
    for (const { heads } of selected.values())
      for (const m of heads) await get(m);
    // Download/validate every referenced blob before any workspace file is replaced.
    for (const { heads } of selected.values()) {
      for (const head of heads)
        for (const ref of blobReferences(cache.get(head.id)!.files)) {
          if (!(await ensureBlob(ref))) {
            result.deferred = true;
            return result;
          }
        }
    }
    if (!unchanged()) {
      result.deferred = true;
      return result;
    }
    const ordered = [...selected.entries()].sort(
      ([a], [b]) =>
        Number(!a.startsWith("documents/blobs/")) -
        Number(!b.startsWith("documents/blobs/")),
    );
    const changed: string[] = [];
    for (const [unit, { heads, winner }] of ordered) {
      const r = cache.get(winner.id)!;
      for (const loser of heads.slice(0, -1)) {
        const conflict = safePath(
          o.stateDir,
          "conflicts/" + loser.id + ".json",
        );
        if (!fs.existsSync(conflict)) {
          atomicJSON(conflict, {
            accountId: o.accountId,
            revision: cache.get(loser.id)!,
          });
          result.conflicts++;
        }
      }
      if (filesHash(initial[unit] ?? {}) !== winner.hash)
        changed.push(
          ...apply(o.root, o.stateDir, initial[unit] ?? {}, r.files),
        );
      state.baseline[unit] = {
        hash: winner.hash,
        heads: heads.map((m) => m.id),
      };
    }
    state.pending = [];
    atomicJSON(stateFile, state);
    if (changed.length) o.onApplied?.(changed);
    return result;
  }
}
