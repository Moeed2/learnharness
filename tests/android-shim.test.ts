import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

const SHIM = readFileSync(new URL("../android/app/src/main/assets/lh-android-shim.js", import.meta.url), "utf8").replaceAll("__LH_TOKEN__", "tok");

/** Run the shim against a fake window + fake Java object. */
function boot(existingLh?: Record<string, unknown>) {
	const calls: unknown[][] = [];
	const saved: { id: string; chunks: string[] }[] = [];
	const native = {
		pickFiles: (...a: unknown[]) => calls.push(["pickFiles", ...a]),
		pickFolder: (...a: unknown[]) => calls.push(["pickFolder", ...a]),
		releaseImport: (...a: unknown[]) => calls.push(["releaseImport", ...a]),
		saveBegin: (t: string, name: string) => { if (t !== "tok") return null; saved.push({ id: name, chunks: [] }); return name; },
		saveChunk: (_t: string, id: string, b64: string) => { saved.find((s) => s.id === id)!.chunks.push(b64); return true; },
		saveEnd: () => JSON.stringify({ ok: true }),
		saveAbort: () => {},
	};
	const listeners: Record<string, ((e: unknown) => void)[]> = {};
	const anchorProto = { click() { (this as { clicked?: boolean }).clicked = true; } };
	class FakeReader {
		result: unknown; onload?: () => void;
		readAsDataURL(b: { text: string }) { this.result = "data:x;base64," + Buffer.from(b.text).toString("base64"); queueMicrotask(() => this.onload?.()); }
	}
	class FakeBlob { constructor(public text: string, public type = "") {} get size() { return this.text.length; } slice(a: number, b: number) { return new FakeBlob(this.text.slice(a, b)); } }
	const URLfake = { createObjectURL: (_: unknown) => "blob:http://x/1", revokeObjectURL: (_: string) => {} };
	const win: Record<string, unknown> = {
		__lhAndroidNative: native, URL: URLfake, Blob: FakeBlob, FileReader: FakeReader, HTMLAnchorElement: { prototype: anchorProto },
		CustomEvent: class { constructor(public type: string, public init: unknown) {} },
		dispatchEvent: (e: { type: string; init: { detail: unknown } }) => (listeners[e.type] ?? []).forEach((l) => l(e.init)),
		fetch: async () => { throw new Error("no fetch"); },
		document: { addEventListener() {} },
	};
	if (existingLh) win.lh = existingLh;
	win.window = win;
	vm.runInNewContext(SHIM, win);
	return { win, calls, saved, listeners, anchorProto, URLfake, FakeBlob };
}

test("shim defines only the file members and keeps an existing window.lh", () => {
	const { win } = boot({ subscriptionTransport: "web" });
	const lh = win.lh as Record<string, unknown>;
	assert.equal(lh.subscriptionTransport, "web");
	assert.deepEqual(Object.keys(lh).sort(), ["pickFiles", "pickFolder", "releaseImport", "saveFile", "subscriptionTransport"]);
});

test("shim never defines desktop-only members", () => {
	const lh = boot().win.lh as Record<string, unknown>;
	for (const key of ["platform", "getPathForFile", "expandWindow", "subscriptionTransport", "chatgpt", "subscriptions"]) assert.equal(key in lh, false, key);
});

test("pickFiles resolves from the native callback and sends the token", async () => {
	const { win, calls } = boot();
	const lh = win.lh as { pickFiles(o?: unknown): Promise<unknown> };
	const p = lh.pickFiles({ extensions: ["md"] });
	assert.deepEqual(calls[0]!.slice(0, 2), ["pickFiles", "tok"]);
	const callId = calls[0]![2] as string;
	(win.__lhNativeCb as { resolve(id: string, j: string): void }).resolve(callId, JSON.stringify({ id: "a", files: [], skipped: 0 }));
	assert.deepEqual(JSON.parse(JSON.stringify(await p)), { id: "a", files: [], skipped: 0 });
});

test("progress is re-dispatched as lh:import-progress", () => {
	const { win, listeners } = boot();
	const seen: unknown[] = [];
	listeners["lh:import-progress"] = [(d) => seen.push(d)];
	(win.__lhNativeCb as { progress(d: number, t: number): void }).progress(5, 10);
	assert.deepEqual(JSON.parse(JSON.stringify(seen)), [{ detail: { done: 5, total: 10 } }]);
});

test("a.download blob clicks are captured and streamed to the bridge in chunks", async () => {
	const { win, anchorProto, saved, URLfake, FakeBlob } = boot();
	const blob = new FakeBlob("x".repeat(400 * 1024));
	const url = (win.URL as typeof URLfake).createObjectURL(blob);
	const anchor = Object.assign(Object.create(anchorProto), {
		href: url, hasAttribute: (n: string) => n === "download", getAttribute: () => "notes.md",
	});
	anchor.click();
	assert.equal(anchor.clicked, undefined, "native click suppressed");
	await new Promise((r) => setTimeout(r, 20));
	assert.equal(saved[0]!.id, "notes.md");
	assert.equal(saved[0]!.chunks.length, 2);
	assert.equal(Buffer.from(saved[0]!.chunks.join(""), "base64").length, 400 * 1024);
});

test("plain anchors keep their normal click", () => {
	const { anchorProto } = boot();
	const anchor = Object.assign(Object.create(anchorProto), { href: "https://x", hasAttribute: () => false });
	anchor.click();
	assert.equal(anchor.clicked, true);
});

test("shim is idempotent", () => {
	const { win } = boot();
	const first = (win.lh as { pickFiles: unknown }).pickFiles;
	vm.runInNewContext(SHIM, win);
	assert.equal((win.lh as { pickFiles: unknown }).pickFiles, first);
});
