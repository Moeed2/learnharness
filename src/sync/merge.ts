import { parseSourceOrganization } from "../core/source-organization.ts";
type Files = Record<string, string>;
type Map_ = Record<string, unknown>;
const decode = (b64: string) => Buffer.from(b64, "base64").toString("utf8");
const encode = (text: string) => Buffer.from(text, "utf8").toString("base64");
function record(text: string | undefined): Map_ {
  if (text === undefined) return {};
  const x = JSON.parse(text);
  if (!x || typeof x !== "object" || Array.isArray(x))
    throw Error("Invalid JSON record");
  return x;
}
const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
/** Append-only ledger: first head's lines, then unseen lines of the others. */
function mergeLedger(heads: string[]): string {
  const seen = new Set<string>(),
    out: string[] = [];
  for (const text of heads)
    for (const line of text.split("\n"))
      if (line.trim() && !seen.has(line)) {
        seen.add(line);
        out.push(line);
      }
  return out.map((line) => line + "\n").join("");
}
/** 3-way per-key merge; later heads win ties, a change beats a deletion. */
function mergeMap(base: Map_, heads: Map_[]): Map_ {
  const keys = new Set<string>();
  for (const m of [...heads, base]) for (const k of Object.keys(m)) keys.add(k);
  const out: Map_ = {};
  for (const key of keys) {
    const had = Object.hasOwn(base, key);
    const changed = heads.filter((h) =>
      Object.hasOwn(h, key) ? !had || !same(h[key], base[key]) : had,
    );
    const present = changed.filter((h) => Object.hasOwn(h, key));
    if (present.length) out[key] = present[present.length - 1]![key];
    else if (!changed.length && had) out[key] = base[key];
  }
  return out;
}
const inner = (m: Map_, key: string): Map_ => {
  const x = m[key];
  return x && typeof x === "object" && !Array.isArray(x) ? (x as Map_) : {};
};
function mergeFile(
  p: string,
  base: string | undefined,
  texts: (string | undefined)[],
): string {
  const last = texts.filter((t) => t !== undefined).pop()!;
  const b = record(base);
  const parsed = texts.map((t) => record(t));
  if (p === "graph/sources.json" || p === "graph/render-settings.json")
    return JSON.stringify(mergeMap(b, parsed), null, "\t");
  if (p === "graph/positions.json") {
    const stamps = parsed
      .map((m) => m.updatedAt)
      .filter((v): v is string => typeof v === "string");
    const merged = {
      ...parsed[parsed.length - 1],
      positions: mergeMap(
        inner(b, "positions"),
        parsed.map((m) => inner(m, "positions")),
      ),
      updatedAt: stamps.length
        ? stamps.reduce((x, y) => (Date.parse(y) > Date.parse(x) ? y : x))
        : undefined,
    };
    return JSON.stringify(merged, null, "\t");
  }
  if (p === "graph/source-organization.json") {
    const folders = (m: Map_) =>
      Object.fromEntries(
        (Array.isArray(m.folders) ? m.folders : []).map((f: { id: string }) => [
          f.id,
          f,
        ]),
      );
    const merged = {
      ...parsed[parsed.length - 1],
      folders: Object.values(
        mergeMap(
          folders(b),
          parsed.map((m) => folders(m)),
        ),
      ),
      placements: mergeMap(
        inner(b, "placements"),
        parsed.map((m) => inner(m, "placements")),
      ),
    };
    try {
      parseSourceOrganization(merged);
    } catch {
      // e.g. a placement into a folder another device deleted: keep the preferred head.
      return last;
    }
    return JSON.stringify(merged, null, "\t") + "\n";
  }
  return last;
}
/**
 * Merge the workspace unit's files. `heads` must be ordered so the preferred
 * head is last; `base` is their common ancestor (or null).
 */
export function mergeWorkspace(base: Files | null, heads: Files[]): Files {
  const paths = new Set<string>();
  for (const h of heads) for (const p of Object.keys(h)) paths.add(p);
  const out: Files = {};
  for (const p of [...paths].sort()) {
    const texts = heads.map((h) => (p in h ? decode(h[p]!) : undefined));
    const present = texts.filter((t): t is string => t !== undefined);
    const baseText = base && p in base ? decode(base[p]!) : undefined;
    let merged: string;
    if (p.endsWith(".jsonl")) merged = mergeLedger(present);
    else if (
      p === "graph/format.json" ||
      !/^graph\/(sources|positions|source-organization|render-settings)\.json$/.test(
        p,
      )
    )
      merged = present[present.length - 1]!;
    else {
      try {
        merged = mergeFile(p, baseText, texts);
      } catch {
        merged = present[present.length - 1]!;
      }
    }
    out[p] = encode(merged);
  }
  return out;
}
