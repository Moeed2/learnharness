import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { Revision, RevisionMeta } from "./types.ts";
import { isValidSegmentPath } from "../core/prompt-segments.ts";
import {
  sanitizeUserSettings,
  CURRENT_SETTINGS_VERSION,
} from "../core/settings.ts";
import { CURRENT_CHAT_VERSION } from "../core/contracts/chat.ts";
import { CURRENT_GRAPH_FORMAT_VERSION } from "../core/contracts/graph.ts";
import { validateBrowserPreferences } from "./browser-preferences.ts";
import { isDeepStrictEqual } from "node:util";
import { parseSourceOrganization } from "../core/source-organization.ts";
export const MAX_BYTES = 64 * 1024 * 1024;
export function digest(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
export function filesHash(files: Record<string, string>): string {
  return digest(
    JSON.stringify(
      Object.keys(files)
        .sort()
        .map((p) => [p, files[p]]),
    ),
  );
}
export function unitFor(p: string): string | undefined {
  if (/^documents\/blobs\/[a-f0-9]{64}$/.test(p)) return p;
  const chat = /^chats\/([A-Za-z0-9_-]+)\.json$/.exec(p);
  if (chat) return "chat/" + chat[1];
  const job = /^jobs\/([A-Za-z0-9_-]+)\.json$/.exec(p);
  if (job) return "job/" + job[1];
  const document = /^documents\/records\/([a-f0-9]{64})\.json$/.exec(p);
  if (document) return "document/" + document[1];
  if (p === "settings.json") return "preferences/settings";
  if (p === "browser-preferences.json") return "preferences/browser";
  if (p.startsWith("prompts/") && isValidSegmentPath(p.slice(8)))
    return "preferences/prompt/" + p.slice(8);
  if (
    /^graph\/(nodes\.jsonl|chains\.jsonl|sessions\.jsonl|coverage\.jsonl|sources\.json|positions\.json|format\.json|render-settings\.json|source-organization\.json)$/.test(
      p,
    )
  )
    return "workspace";
}
export function safePath(root: string, relative: string): string {
  if (
    !relative ||
    relative.includes("\\") ||
    relative.split("/").some((s) => !s || s === "." || s === "..") ||
    path.isAbsolute(relative)
  )
    throw Error("Unsafe path");
  const base = path.resolve(root),
    target = path.resolve(base, relative);
  if (!target.startsWith(base + path.sep)) throw Error("Unsafe path");
  let current = path.parse(target).root;
  for (const part of target.slice(current.length).split(path.sep)) {
    current = path.join(current, part);
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink())
      throw Error("Symlink refused");
  }
  return target;
}
export function atomicJSON(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + "." + randomUUID() + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(value));
  fs.renameSync(tmp, file);
}
function object(text: string): Record<string, unknown> {
  const x = JSON.parse(text);
  if (!x || typeof x !== "object" || Array.isArray(x))
    throw Error("Invalid JSON record");
  return x;
}
type Schema = { [key: string]: Schema | true };
const role: Schema = {
  model: { provider: true, id: true },
  thinkingLevel: true,
  cacheRetention: true,
};
const settingsSchema: Schema = {
  version: true,
  general: { autoUpdate: true },
  dictation: { language: true },
  claudeCode: { enabled: true },
  agent: {
    models: {
      researcher: role,
      demoBuilder: role,
      visualMaker: role,
      extractor: role,
      auditor: role,
    },
    tools: { "*": true },
    prompts: { "*": true },
    search: { engine: true },
    graphTools: { enabled: true },
  },
  models: { strong: role, cheap: role, vision: role },
  customProvider: {
    authMode: true,
    baseUrl: true,
    manualModels: true,
    models: {
      "[]": {
        id: true,
        image: true,
        reasoning: true,
        context: true,
        maxTokens: true,
      },
    },
    overrides: { "*": { context: true, maxTokens: true, reasoning: true } },
  },
  appearance: {
    mode: true,
    background: true,
    fontFamily: true,
    proseFontSize: true,
    sessionNameSerif: true,
    mdRendering: { headingWeight: true, boldColor: true, italicColor: true },
  },
  graph: { enabled: true, rendering: true, extractionChunkTokens: true },
  compaction: { thresholdTokens: true },
};
function project(value: unknown, schema: Schema): unknown {
  if (Array.isArray(value) && schema["[]"] && schema["[]"] !== true)
    return value.map((v) => project(v, schema["[]"] as Schema));
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  return Object.fromEntries(
    Object.entries(value).flatMap(([k, v]) => {
      const rule = Object.hasOwn(schema, k) ? schema[k] : schema["*"];
      if (!rule) return [];
      const cleaned =
        rule === true
          ? Array.isArray(v)
            ? k === "manualModels"
              ? v.filter((item) => typeof item === "string")
              : undefined
            : v !== null && typeof v === "object"
              ? undefined
              : v
          : project(v, rule);
      return cleaned === undefined ? [] : [[k, cleaned]];
    }),
  );
}
export function clean(
  p: string,
  data: Buffer,
  incoming = false,
): Buffer | undefined {
  if (data.length > MAX_BYTES) throw Error("Content too large");
  if (p.startsWith("documents/blobs/")) {
    if (data.length > 25 * 1024 * 1024) throw Error("Blob too large");
    if (digest(data) !== p.split("/").pop()) throw Error("Invalid blob hash");
    return data;
  }
  const text = data.toString("utf8");
  if (!Buffer.from(text).equals(data)) throw Error("Invalid UTF-8");
  if (p.endsWith(".jsonl")) {
    for (const line of text.split("\n")) if (line.trim()) object(line);
    return data;
  }
  if (p.endsWith(".md")) return data;
  const record = object(text);
  const supportedVersion = p.startsWith("chats/")
    ? CURRENT_CHAT_VERSION
    : p === "graph/format.json"
      ? CURRENT_GRAPH_FORMAT_VERSION
      : p === "settings.json"
        ? CURRENT_SETTINGS_VERSION
        : undefined;
  // Refuse newer records before stripping fields an older build cannot understand.
  if (supportedVersion !== undefined && Object.hasOwn(record, "version")) {
    const version = record.version;
    if (
      typeof version !== "number" ||
      !Number.isSafeInteger(version) ||
      version < 1
    )
      throw Error("Invalid schema version: " + p);
    if (version > supportedVersion)
      throw Error("Unsupported schema version: " + p);
  }
  if (p === "graph/source-organization.json") parseSourceOrganization(record);
  if (p === "browser-preferences.json") validateBrowserPreferences(record);
  if (p.startsWith("documents/records/")) {
    const { id, name, hash, textHash, size, mimeType, importedAt } = record;
    if (
      typeof name !== "string" ||
      !name ||
      name.length > 1024 ||
      /[\\:\x00-\x1f]/.test(name) ||
      name.split("/").some((s) => !s || s === "." || s === "..") ||
      typeof hash !== "string" ||
      !/^[a-f0-9]{64}$/.test(hash) ||
      id !== digest(name + "\0" + hash) ||
      p !== "documents/records/" + id + ".json" ||
      (textHash !== undefined &&
        (typeof textHash !== "string" || !/^[a-f0-9]{64}$/.test(textHash))) ||
      typeof size !== "number" ||
      !Number.isSafeInteger(size) ||
      size < 0 ||
      size > 25 * 1024 * 1024 ||
      typeof mimeType !== "string" ||
      !/^[\w.+-]+\/[\w.+-]+$/.test(mimeType) ||
      typeof importedAt !== "string" ||
      !Number.isFinite(Date.parse(importedAt)) ||
      Object.keys(record).some(
        (k) =>
          ![
            "id",
            "name",
            "hash",
            "textHash",
            "size",
            "mimeType",
            "importedAt",
          ].includes(k),
      )
    )
      throw Error("Invalid document record");
  }
  if (
    p.startsWith("jobs/") &&
    !["done", "error"].includes(String(record.status))
  ) {
    if (incoming) throw Error("Non-terminal job");
    return;
  }
  if (p === "settings.json") {
    const provider = record.customProvider;
    if (provider && typeof provider === "object") {
      if (incoming && "credentialBindingId" in provider)
        throw Error("Remote credential binding");
      delete (provider as Record<string, unknown>).credentialBindingId;
    }
    const projected = project(record, settingsSchema) as Record<
      string,
      unknown
    >;
    const sanitized = project(
      sanitizeUserSettings({ ...projected, graph: projected.graph ?? {} }),
      settingsSchema,
    ) as Record<string, unknown>;
    if (!Object.hasOwn(projected, "graph")) delete sanitized.graph;
    const comparable = Object.hasOwn(record, "version")
      ? record
      : { ...record, version: CURRENT_SETTINGS_VERSION };
    if (incoming && !isDeepStrictEqual(comparable, sanitized))
      throw Error("Invalid remote settings");
    return Buffer.from(JSON.stringify(sanitized));
  }
  return data;
}
const WALKED_DIRS = [
  "chats",
  "graph",
  "jobs",
  "documents",
  "prompts",
  "documents/blobs",
  "documents/records",
  "prompts/shared",
  "prompts/teacher",
  "prompts/prober",
  "prompts/practice",
];
/** Files modified this recently are never served from a cache or trusted by stamp. */
const HOT_MS = 2000;
function statStamp(stat: fs.Stats): string {
  return [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(":");
}
const isHot = (stat: fs.Stats, now: number) =>
  Math.abs(now - stat.mtimeMs) < HOT_MS;
/** Process-local: absolute file path to the cleaned content of an unchanged file. */
const captured = new Map<
  string,
  { stamp: string; data: string | null; bytes: number }
>();
/** Walk the allowlisted tree (refusing symlinks) and visit each synced file. */
function walkFiles(
  root: string,
  options: { includeBlobs?: boolean },
  visit: (p: string, unit: string, file: string) => void,
): void {
  function walk(rel: string) {
    const dir = rel ? safePath(root, rel) : path.resolve(root);
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = rel ? rel + "/" + entry.name : entry.name;
      const unit = unitFor(p);
      if (entry.isSymbolicLink()) {
        if (unit || WALKED_DIRS.includes(p)) throw Error("Symlink refused");
        continue;
      }
      if (entry.isDirectory()) {
        if (p === "documents/blobs" && options.includeBlobs === false) continue;
        if (WALKED_DIRS.includes(p)) walk(p);
        continue;
      }
      if (!unit || unit.startsWith("documents/blobs/")) continue;
      visit(p, unit, safePath(root, p));
    }
  }
  walk("");
}
function pruneCaptured(root: string, seen: Set<string>): void {
  const prefix = path.resolve(root) + path.sep;
  for (const key of captured.keys())
    if (key.startsWith(prefix) && !seen.has(key)) captured.delete(key);
}
/**
 * Stat-only change detector over the same files capture() reads. When `hot`
 * is set a file was modified within the last two seconds, so equal stamps
 * prove nothing and callers must compare content.
 */
export function fingerprint(
  root: string,
  options: { now?: () => number } = {},
): { hash: string; hot: boolean } {
  const now = (options.now ?? Date.now)();
  const entries: [string, string][] = [];
  let hot = false;
  walkFiles(root, { includeBlobs: false }, (p, _unit, file) => {
    const stat = fs.statSync(file);
    if (isHot(stat, now)) hot = true;
    entries.push([p, statStamp(stat)]);
  });
  entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return { hash: digest(JSON.stringify(entries)), hot };
}
export function capture(
  root: string,
  options: { includeBlobs?: boolean; now?: () => number } = {},
): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  const sizes: Record<string, number> = {};
  const seen = new Set<string>();
  const now = (options.now ?? Date.now)();
  walkFiles(root, options, (p, unit, file) => {
    const before = fs.statSync(file);
    if (before.size > MAX_BYTES) throw Error("Content too large");
    seen.add(file);
    const stamp = statStamp(before),
      hit = captured.get(file);
    let entry: { data: string | null; bytes: number };
    if (hit && hit.stamp === stamp && !isHot(before, now)) {
      entry = hit;
    } else {
      captured.delete(file);
      const data = clean(p, fs.readFileSync(file));
      entry = {
        data: data ? data.toString("base64") : null,
        bytes: data?.length ?? 0,
      };
      // Cache only a file that was quiet and unchanged across the read.
      if (!isHot(before, now) && statStamp(fs.statSync(file)) === stamp)
        captured.set(file, { stamp, ...entry });
    }
    if (entry.data === null) return;
    sizes[unit] = (sizes[unit] ?? 0) + entry.bytes;
    if (sizes[unit]! > MAX_BYTES) throw Error("Unit too large");
    (out[unit] ??= {})[p] = entry.data;
  });
  pruneCaptured(root, seen);
  if (options.includeBlobs === false) return out;
  const refs = new Set(
    Object.values(out).flatMap((files) => blobReferences(files)),
  );
  for (const ref of refs) {
    const file = safePath(root, ref);
    if (fs.statSync(file).size > 25 * 1024 * 1024)
      throw Error("Blob too large");
    const data = clean(ref, fs.readFileSync(file))!;
    out[ref] = { [ref]: data.toString("base64") };
  }
  return out;
}
interface VerifiedBlob {
  stamp: string;
  rawHash: string;
  revisionHash: string;
}
const verifiedBlobs = new Map<string, VerifiedBlob>();
function blobStamp(stat: fs.Stats): string {
  return [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(":");
}
/** Trust only process-local verification of an unchanged immutable file identity. */
export function localBlobHash(root: string, ref: string): string | null {
  const file = safePath(root, ref);
  if (!fs.existsSync(file)) {
    verifiedBlobs.delete(file);
    return null;
  }
  const fd = fs.openSync(file, "r");
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > 25 * 1024 * 1024)
      throw Error("Blob too large or invalid");
    const stamp = blobStamp(stat),
      cached = verifiedBlobs.get(file);
    if (cached?.stamp === stamp && cached.rawHash === ref.split("/").pop())
      return cached.revisionHash;
    verifiedBlobs.delete(file);
    const raw = createHash("sha256"),
      revision = createHash("sha256");
    revision.update("[[" + JSON.stringify(ref) + ',"');
    // A multiple of three keeps independently encoded chunks canonical.
    const chunk = Buffer.alloc(192 * 1024);
    let position = 0;
    while (position < stat.size) {
      const wanted = Math.min(chunk.length, stat.size - position);
      let filled = 0;
      while (filled < wanted) {
        const n = fs.readSync(
          fd,
          chunk,
          filled,
          wanted - filled,
          position + filled,
        );
        if (!n) throw Error("Blob changed while reading");
        filled += n;
      }
      raw.update(chunk.subarray(0, filled));
      revision.update(chunk.subarray(0, filled).toString("base64"));
      position += filled;
    }
    revision.update('"]]');
    if (
      blobStamp(fs.fstatSync(fd)) !== stamp ||
      blobStamp(fs.statSync(safePath(root, ref))) !== stamp
    )
      throw Error("Blob changed while reading");
    const rawHash = raw.digest("hex");
    if (rawHash !== ref.split("/").pop()) return null;
    const revisionHash = revision.digest("hex");
    verifiedBlobs.set(file, { stamp, rawHash, revisionHash });
    return revisionHash;
  } finally {
    fs.closeSync(fd);
  }
}
export function writeBlob(root: string, revision: Revision): void {
  const ref = revision.meta.unit,
    target = safePath(root, ref);
  const tmp = safePath(root, ref + ".sync-" + randomUUID());
  fs.mkdirSync(path.dirname(target), { recursive: true });
  try {
    fs.writeFileSync(tmp, Buffer.from(revision.files[ref]!, "base64"));
    fs.renameSync(tmp, target);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}
export function validateMeta(m: RevisionMeta): void {
  if (
    !m ||
    typeof m.id !== "string" ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(m.id) ||
    (!["workspace", "preferences/settings", "preferences/browser"].includes(
      m.unit,
    ) &&
      !(
        typeof m.unit === "string" &&
        m.unit.startsWith("preferences/prompt/") &&
        isValidSegmentPath(m.unit.slice("preferences/prompt/".length))
      ) &&
      !/^(chat|job)\/[A-Za-z0-9_-]+$/.test(m.unit) &&
      !/^document\/[a-f0-9]{64}$/.test(m.unit) &&
      !/^documents\/blobs\/[a-f0-9]{64}$/.test(m.unit)) ||
    !Array.isArray(m.parents) ||
    m.parents.length > 1000 ||
    m.parents.some(
      (p) =>
        typeof p !== "string" ||
        !/^[A-Za-z0-9_-]{1,128}$/.test(p) ||
        p === m.id,
    ) ||
    new Set(m.parents).size !== m.parents.length ||
    typeof m.deleted !== "boolean" ||
    !/^[a-f0-9]{64}$/.test(m.hash) ||
    (Object.hasOwn(m, "at") && !(Number.isSafeInteger(m.at) && m.at! > 0))
  )
    throw Error("Invalid revision metadata");
  if (m.unit.startsWith("documents/blobs/") && m.deleted)
    throw Error("Blob tombstone refused");
}
export function validateRevision(r: Revision, expected: RevisionMeta): void {
  validateMeta(r.meta);
  if (JSON.stringify(r.meta) !== JSON.stringify(expected))
    throw Error("Metadata mismatch");
  if (
    !r.files ||
    typeof r.files !== "object" ||
    Array.isArray(r.files) ||
    Object.keys(r.files).length > 10000
  )
    throw Error("Invalid files");
  let total = 0;
  for (const [p, b64] of Object.entries(r.files)) {
    if (
      unitFor(p) !== r.meta.unit ||
      typeof b64 !== "string" ||
      b64.length > MAX_BYTES * 1.34
    )
      throw Error("Invalid remote path/content");
    const data = Buffer.from(b64, "base64");
    if (data.toString("base64") !== b64) throw Error("Invalid base64");
    total += data.length;
    if (total > MAX_BYTES) throw Error("Content too large");
    clean(p, data, true);
  }
  if (
    (r.meta.deleted && Object.keys(r.files).length) ||
    filesHash(r.files) !== r.meta.hash
  )
    throw Error("Invalid revision hash");
  if (
    r.meta.unit.startsWith("documents/blobs/") &&
    (Object.keys(r.files).length !== 1 || !Object.hasOwn(r.files, r.meta.unit))
  )
    throw Error("Invalid blob revision");
}
export function blobReferences(files: Record<string, string>): string[] {
  const refs = new Set<string>();
  for (const [p, v] of Object.entries(files))
    if (p.startsWith("documents/records/")) {
      const record = object(Buffer.from(v, "base64").toString("utf8"));
      for (const hash of [record.hash, record.textHash])
        if (hash !== undefined) {
          if (typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash))
            throw Error("Invalid document hash");
          refs.add("documents/blobs/" + hash);
        }
    }
  return [...refs];
}
interface Journal {
  before: Record<string, string | null>;
  after?: Record<string, string | null>;
}
export function recover(root: string, stateDir: string, accountId = ""): void {
  const file = safePath(stateDir, "transaction.json");
  if (!fs.existsSync(file)) return;
  const journal = JSON.parse(fs.readFileSync(file, "utf8")) as Journal;
  const divergent = new Set<string>();
  const current: Record<string, Record<string, string>> = {};
  // A crash may be followed by offline editing. Preserve edits which match
  // neither the old snapshot nor the transaction's expected replacement.
  for (const [p, before] of Object.entries(journal.before)) {
    const unit = unitFor(p);
    if (!unit) throw Error("Invalid recovery path");
    const target = safePath(root, p);
    const data = fs.existsSync(target)
      ? fs.readFileSync(target).toString("base64")
      : null;
    if (data !== before && (!journal.after || data !== journal.after[p]))
      divergent.add(unit);
    if (data !== null) (current[unit] ??= {})[p] = data;
  }
  for (const unit of divergent) {
    let files = current[unit] ?? {};
    try {
      files = capture(root, { includeBlobs: false })[unit] ?? files;
    } catch {
      /* Keep partial recovery bytes if a torn snapshot cannot be parsed. */
    }
    const id = randomUUID();
    const revision: Revision = {
      meta: {
        id,
        unit,
        parents: [],
        deleted: !Object.keys(files).length,
        hash: filesHash(files),
      },
      files,
    };
    atomicJSON(safePath(stateDir, "conflicts/" + id + ".json"), {
      accountId,
      revision,
      recovery: true,
    });
  }
  for (const [p, data] of Object.entries(journal.before)) {
    if (!unitFor(p)) throw Error("Invalid recovery path");
    const target = safePath(root, p);
    if (data === null) {
      fs.rmSync(target, { force: true });
    } else {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, Buffer.from(data, "base64"));
    }
  }
  fs.unlinkSync(file);
}
export function apply(
  root: string,
  stateDir: string,
  old: Record<string, string>,
  next: Record<string, string>,
): string[] {
  const paths = [...new Set([...Object.keys(old), ...Object.keys(next)])];
  const before: Journal["before"] = {};
  const after: NonNullable<Journal["after"]> = {};
  const staged: Record<string, string> = {};
  try {
    for (const p of paths) {
      const target = safePath(root, p);
      before[p] = fs.existsSync(target)
        ? fs.readFileSync(target).toString("base64")
        : null;
      if (next[p] !== undefined) {
        let data = Buffer.from(next[p], "base64");
        if (p === "settings.json" && before[p]) {
          const binding = (
            object(Buffer.from(before[p]!, "base64").toString())
              .customProvider as Record<string, unknown> | undefined
          )?.credentialBindingId;
          if (binding !== undefined) {
            const record = object(data.toString());
            record.customProvider = {
              ...((record.customProvider as object) ?? {}),
              credentialBindingId: binding,
            };
            data = Buffer.from(JSON.stringify(record));
          }
        }
        fs.mkdirSync(path.dirname(target), { recursive: true });
        const tmp = safePath(root, p + ".sync-" + randomUUID());
        fs.writeFileSync(tmp, data);
        staged[p] = tmp;
        after[p] = data.toString("base64");
      } else {
        after[p] = null;
      }
    }
    atomicJSON(safePath(stateDir, "transaction.json"), { before, after });
    for (const p of paths) {
      const target = safePath(root, p);
      if (staged[p]) fs.renameSync(staged[p], target);
      else fs.rmSync(target, { force: true });
    }
    fs.unlinkSync(path.join(stateDir, "transaction.json"));
    return paths;
  } catch (e) {
    recover(root, stateDir);
    throw e;
  } finally {
    for (const tmp of Object.values(staged)) fs.rmSync(tmp, { force: true });
  }
}
