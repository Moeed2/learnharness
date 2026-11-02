import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type {
  Revision,
  RevisionMeta,
  SyncEngineOptions,
  SyncReason,
  SyncResult,
} from "./types.ts";
import {
  apply,
  atomicJSON,
  blobReferences,
  capture,
  fingerprint as statFingerprint,
  localBlobHash,
  writeBlob,
  filesHash,
  recover,
  safePath,
  validateMeta,
  validateRevision,
} from "./local.ts";
import { mergeWorkspace } from "./merge.ts";
interface Baseline {
  hash: string;
  heads: string[];
  /** Newest `at` among the heads, so restores stay later than their parents. */
  at?: number;
}
/** Superseded history older than this is pruned from the remote. */
const GRACE = 30 * 24 * 3600 * 1000;
const COMPACT_EVERY = 24 * 3600 * 1000;
const MAX_DELETES = 500;
const MAX_LISTED = 200_000;
/** While idle, remote changes are looked for at most this often. */
const IDLE_LIST_INTERVAL = 5 * 60 * 1000;
/** Oldest first: by creation time (legacy = 0), id as a stable tiebreaker. */
const byAge = (a: RevisionMeta, b: RevisionMeta) =>
  (a.at ?? 0) - (b.at ?? 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
interface State {
  accountId: string;
  baseline: Record<string, Baseline>;
  pending: Revision[];
  pendingBlob?: Revision;
  /** A workspace merge persisted before upload; never a local edit. */
  pendingMerge?: Revision;
  /** Last remote history cleanup (ms), at most one per day per device. */
  lastCompactedAt?: number;
}
const flights = new Map<string, Promise<SyncResult>>();
export class SyncEngine {
  /** Stat fingerprint after the last fully successful run (memory only). */
  private lastFingerprint?: string;
  private lastListedAt?: number;
  constructor(private readonly options: SyncEngineOptions) {}
  /** Creation time, never earlier than the newest parent (clock-skew safe). */
  private stamp(parentAts: (number | undefined)[]): { at: number } {
    const floor = Math.max(0, ...parentAts.map((a) => a ?? 0)) + 1;
    return { at: Math.max((this.options.now ?? Date.now)(), floor) };
  }
  sync(options: { reason?: SyncReason } = {}): Promise<SyncResult> {
    const key = path.resolve(this.options.root);
    const active = flights.get(key);
    if (active) return active;
    const run = this.run(options.reason ?? "manual").finally(() => {
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
        ...this.stamp([state.baseline[r.meta.unit]?.at, r.meta.at]),
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
      at: state.baseline[r.meta.unit]?.at,
      hash: "restored",
    };
    atomicJSON(stateFile, state);
    o.onApplied?.(changed);
  }
  private async run(reason: SyncReason): Promise<SyncResult> {
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
    const clock = o.now ?? Date.now;
    // Taken before capture so an edit in between shows up as a difference.
    const stamps = statFingerprint(o.root, { now: clock });
    const settled = this.lastFingerprint;
    this.lastFingerprint = undefined;
    if (
      (reason === "timer" || reason === "event") &&
      settled !== undefined &&
      !stamps.hot &&
      stamps.hash === settled &&
      this.lastListedAt !== undefined &&
      clock() - this.lastListedAt < IDLE_LIST_INTERVAL &&
      !state.pending.length &&
      !state.pendingBlob &&
      !state.pendingMerge
    ) {
      this.lastFingerprint = settled;
      result.skipped = true;
      return result;
    }
    const initial = capture(o.root, { includeBlobs: false, now: clock });
    const fullHash = (snapshot: Record<string, Record<string, string>>) =>
      filesHash(
        Object.fromEntries(
          Object.entries(snapshot).map(([u, f]) => [u, filesHash(f)]),
        ),
      );
    const fingerprint = fullHash(initial);
    const unchanged = () => {
      if (o.isBusy?.()) return false;
      const now = statFingerprint(o.root, { now: clock });
      if (!now.hot && !stamps.hot && now.hash === stamps.hash) return true;
      // Stamps differ (or cannot be trusted): compare content.
      return (
        fingerprint ===
        fullHash(capture(o.root, { includeBlobs: false, now: clock }))
      );
    };
    let listed = await o.remote.list();
    const listedAt = clock();
    if (listed.length > MAX_LISTED) throw Error("Too many revisions");
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
      ...(state.pendingMerge ? [state.pendingMerge] : []),
    ]) {
      validateRevision(r, r.meta);
      const m = metas.get(r.meta.id);
      if (m && JSON.stringify(m) !== JSON.stringify(r.meta))
        throw Error("Pending metadata mismatch");
      metas.set(r.meta.id, r.meta);
    }
    const visiting = new Set<string>(),
      visited = new Set<string>();
    // Iterative so a very long history cannot overflow the stack.
    function visit(root: RevisionMeta) {
      const stack: { m: RevisionMeta; next: number }[] = [{ m: root, next: 0 }];
      if (visited.has(root.id)) return;
      visiting.add(root.id);
      while (stack.length) {
        const top = stack[stack.length - 1]!;
        const id = top.m.parents[top.next++];
        if (id === undefined) {
          visiting.delete(top.m.id);
          visited.add(top.m.id);
          stack.pop();
          continue;
        }
        const p = metas.get(id);
        // A pruned parent is an already-superseded ancestor.
        if (!p) continue;
        if (p.unit !== top.m.unit) throw Error("Cross-unit parent");
        if (visiting.has(p.id)) throw Error("Cyclic parents");
        if (visited.has(p.id)) continue;
        visiting.add(p.id);
        stack.push({ m: p, next: 0 });
      }
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
    const publishMerge = async (revision: Revision) => {
      validateRevision(revision, revision.meta);
      state.pendingMerge = revision;
      atomicJSON(stateFile, state);
      if (!listed.some((m) => m.id === revision.meta.id)) {
        await o.remote.upload(revision);
        result.uploaded++;
        listed = [...listed, revision.meta];
      }
      metas.set(revision.meta.id, revision.meta);
      delete state.pendingMerge;
      atomicJSON(stateFile, state);
    };
    // A crash after persisting a merge: publish it, then it is just the head.
    if (state.pendingMerge) {
      await publishMerge(state.pendingMerge);
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
          ...this.stamp([]),
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
        .sort(byAge);
      const meta = candidates.at(-1);
      if (!meta) {
        // Pruned remotely: a valid local copy is enough, otherwise unavailable.
        if (localBlobHash(o.root, ref)) return true;
        throw Error("Missing referenced blob");
      }
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
          ...this.stamp(
            (pending ? [pending.meta.id] : (base?.heads ?? [])).map(
              (id) => metas.get(id)?.at,
            ),
          ),
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
        .sort(byAge);
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
    // A unit whose blob was pruned remotely is skipped until its publisher
    // re-uploads the blob; other units still sync.
    const skipped = new Set<string>();
    for (const [unit, { heads }] of selected) {
      for (const head of heads)
        for (const ref of blobReferences(cache.get(head.id)!.files)) {
          if (
            !skipped.has(unit) &&
            ![...metas.values()].some((m) => m.unit === ref) &&
            !localBlobHash(o.root, ref)
          ) {
            skipped.add(unit);
            result.deferred = true;
          }
          if (skipped.has(unit)) continue;
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
    // Concurrent workspace heads are merged (learning progress must not be
    // pushed out of the active map); other units keep winner + conflict copies.
    const ws = selected.get("workspace");
    if (ws && ws.heads.length > 1) {
      const ancestors = (m: RevisionMeta) => {
        const out = new Set<string>(),
          todo = [...m.parents];
        while (todo.length) {
          const id = todo.pop()!;
          if (out.has(id)) continue;
          out.add(id);
          todo.push(...(metas.get(id)?.parents ?? []));
        }
        return out;
      };
      const sets = ws.heads.map(ancestors);
      const common = [...sets[0]!].filter(
        (id) => metas.has(id) && sets.every((x) => x.has(id)),
      );
      const shadowed = new Set(
        common.flatMap((id) => [...ancestors(metas.get(id)!)]),
      );
      const lca = common
        .filter((id) => !shadowed.has(id))
        .sort()
        .at(-1);
      const base = lca ? (await get(metas.get(lca)!)).files : null;
      const files = mergeWorkspace(
        base,
        ws.heads.map((m) => cache.get(m.id)!.files),
      );
      const hash = filesHash(files);
      // Always publish, even when the result equals a head, so the DAG
      // collapses to a single head instead of re-merging on every sync.
      const revision: Revision = {
        meta: {
          id: randomUUID(),
          unit: "workspace",
          parents: ws.heads.map((m) => m.id),
          deleted: false,
          hash,
          ...this.stamp(ws.heads.map((m) => m.at)),
        },
        files,
      };
      await publishMerge(revision);
      cache.set(revision.meta.id, revision);
      selected.set("workspace", {
        heads: [revision.meta],
        winner: revision.meta,
      });
      if (!unchanged()) {
        result.deferred = true;
        return result;
      }
    }
    const ordered = [...selected.entries()].sort(
      ([a], [b]) =>
        Number(!a.startsWith("documents/blobs/")) -
        Number(!b.startsWith("documents/blobs/")),
    );
    const changed: string[] = [];
    for (const [unit, { heads, winner }] of ordered) {
      if (skipped.has(unit)) continue;
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
        at: Math.max(0, ...heads.map((m) => m.at ?? 0)) || undefined,
      };
    }
    state.pending = [];
    atomicJSON(stateFile, state);
    if (changed.length) o.onApplied?.(changed);
    // Applied files changed the tree, so the next run must look at everything.
    if (!result.deferred && !changed.length && !stamps.hot) {
      this.lastFingerprint = stamps.hash;
      this.lastListedAt = listedAt;
    }
    await this.compact(state, stateFile, metas, cache, references);
    return result;
  }
  /** Prune superseded history from the remote; best effort, never fails a sync. */
  private async compact(
    state: State,
    stateFile: string,
    metas: Map<string, RevisionMeta>,
    cache: Map<string, Revision>,
    references: Set<string>,
  ): Promise<void> {
    const now = (this.options.now ?? Date.now)();
    if (now - (state.lastCompactedAt ?? -Infinity) < COMPACT_EVERY) return;
    try {
      const cutoff = now - GRACE,
        old = (m: RevisionMeta) => (m.at ?? 0) < cutoff,
        doomed = new Map<string, RevisionMeta>();
      const byUnit = new Map<string, RevisionMeta[]>();
      for (const m of metas.values()) {
        const group = byUnit.get(m.unit) ?? [];
        group.push(m);
        byUnit.set(m.unit, group);
      }
      const heads: RevisionMeta[] = [];
      for (const [unit, group] of byUnit) {
        if (unit.startsWith("documents/blobs/")) continue;
        const parents = new Set(group.flatMap((m) => m.parents)),
          unitHeads = group.filter((m) => !parents.has(m.id));
        heads.push(...unitHeads);
        if (unitHeads.length !== 1) continue;
        const todo = [...unitHeads[0]!.parents],
          seen = new Set<string>();
        while (todo.length) {
          const m = metas.get(todo.pop()!);
          if (!m || seen.has(m.id)) continue;
          seen.add(m.id);
          if (old(m)) doomed.set(m.id, m);
          todo.push(...m.parents);
        }
      }
      // Blob garbage collection needs every head's files without downloading.
      const headFiles = heads.map((m) => cache.get(m.id)?.files);
      if (headFiles.every((f) => f)) {
        const live = new Set(references);
        for (const f of headFiles)
          for (const ref of blobReferences(f!)) live.add(ref);
        for (const [unit, group] of byUnit) {
          if (!unit.startsWith("documents/blobs/")) continue;
          const sorted = [...group].sort(byAge);
          if (live.has(unit)) sorted.pop();
          for (const m of sorted) if (old(m)) doomed.set(m.id, m);
        }
      }
      for (const m of [...doomed.values()].sort(byAge).slice(0, MAX_DELETES)) {
        try {
          await this.options.remote.remove(m);
        } catch {
          // Retried by the next daily cleanup.
        }
      }
    } catch {
      // Cleanup must never fail a sync that already succeeded.
    }
    state.lastCompactedAt = now;
    atomicJSON(stateFile, state);
  }
}
