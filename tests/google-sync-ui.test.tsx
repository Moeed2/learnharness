import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { SyncCoordinator, safeSyncConnectUrl, type SyncStatus } from "../components/sync-coordinator.tsx";
import { SyncSection } from "../components/settings/sync-section.tsx";

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { window: dom.window, document: dom.document, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true });
const stored = new Map<string, string>();
Object.assign(window, { location: { origin: "http://localhost:3000", reload: () => { reloads++; } }, localStorage: { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => stored.set(key, value), removeItem: (key: string) => stored.delete(key) } });
let reloads = 0;
let serverPreferences: Record<string, string> = {};
let preferencePosts: Record<string, string>[] = [];
const originalFetch = globalThis.fetch;
let root: Root | undefined;
let host: HTMLDivElement | undefined;
const status: SyncStatus = { configured: true, connected: true, pending: false, phase: "idle", conflicts: 0, relayUrl: "https://relay.example" };
async function mount() {
 const mockedFetch = globalThis.fetch;
 globalThis.fetch = async (input, init) => {
  if (String(input) !== "/api/sync/preferences") return mockedFetch(input, init);
  if (init?.method === "POST") { assert.equal(new Headers(init.headers).get("x-learnharness-sync"), "1"); serverPreferences = JSON.parse(init.body as string).preferences; preferencePosts.push(serverPreferences); }
  return Response.json({ preferences: serverPreferences });
 };
 host = document.createElement("div"); document.body.append(host); root = createRoot(host);
 await act(async () => root!.render(<SyncCoordinator><SyncSection /></SyncCoordinator>));
}
afterEach(async () => { await act(async () => root?.unmount()); host?.remove(); root = undefined; globalThis.fetch = originalFetch; stored.clear(); serverPreferences = {}; preferencePosts = []; reloads = 0; });
test("section SSR explains local-first sync without requesting secrets", () => {
 const html = renderToStaticMarkup(<SyncSection />);
 assert.match(html, /personal Google Drive/); assert.match(html, /offline/); assert.match(html, /stay on this device/);
 assert.doesNotMatch(html, /type="password"/);
});
test("connect URLs must match the configured external HTTPS relay", () => {
 assert.equal(safeSyncConnectUrl("https://relay.example/start?a=1", status.relayUrl, "http://localhost:3000"), "https://relay.example/start?a=1");
 for (const url of ["javascript:alert(1)", "http://relay.example/start", "https://evil.example/start", "https://user:pass@relay.example/start", "/start"]) {
  assert.equal(safeSyncConnectUrl(url, status.relayUrl, "http://localhost:3000"), null);
 }
 assert.equal(safeSyncConnectUrl("https://relay.example/start", status.relayUrl, "https://relay.example"), null);
});
test("coordinator checks status, polls only pending sign-in, then offers explicit refresh", async () => {
 const calls: { url: string; init?: RequestInit }[] = []; let current = { ...status, pending: true, changedAt: "one" };
 globalThis.fetch = async (input, init) => {
  const url = String(input); calls.push({ url, init });
  if (url === "/api/documents") return Response.json({ documents: [] });
  if (init?.method === "POST") { current = { ...current, pending: false }; return Response.json({}); }
  return Response.json(current);
 };
 await mount();
 assert.equal(calls.filter(c => c.init?.method === "POST").length, 1);
 const post = calls.find(c => c.init?.method === "POST")!;
 assert.deepEqual(JSON.parse(post.init!.body as string), { action: "poll" });
 assert.equal(new Headers(post.init?.headers).get("x-learnharness-sync"), "1");
 assert.equal(new Headers(post.init?.headers).get("Content-Type"), "application/json");
 current = { ...current, changedAt: "two" };
 await act(async () => window.dispatchEvent(new window.Event("focus")));
 assert.match(host!.textContent!, /Changes from another device are ready/);
 assert.equal(calls.filter(c => c.init?.method === "POST").length, 1);
 assert([...host!.querySelectorAll("button")].some(button => button.textContent === "Refresh"));
});
test("unconfigured sync shows relay setup and offline-safe failure", async () => {
 globalThis.fetch = async (input) => String(input) === "/api/documents" ? Response.json({ documents: [] }) : Response.json({ ...status, configured: false, connected: false });
 await mount(); assert(host!.querySelector('input[type="url"]')); assert.match(host!.textContent!, /Set up later/);
 globalThis.fetch = async () => { throw new Error("secret-token-must-not-render"); };
 await act(async () => window.dispatchEvent(new window.Event("online")));
 assert.match(host!.textContent!, /try again/); assert.doesNotMatch(host!.textContent!, /secret-token/);
});


test("coordinator serializes requests and aborts in-flight work on unmount", async () => {
 let syncCalls = 0; let signal: AbortSignal | null | undefined;
 globalThis.fetch = async (input, init) => {
  if (String(input) === "/api/documents") return Response.json({ documents: [] });
  syncCalls++; signal = init?.signal;
  return new Promise<Response>((_resolve, reject) => signal?.addEventListener("abort", () => reject(new Error("aborted"))));
 };
 await mount();
 await act(async () => { window.dispatchEvent(new window.Event("focus")); window.dispatchEvent(new window.Event("online")); });
 assert.equal(syncCalls, 1); assert.equal(signal?.aborted, false);
 await act(async () => root!.unmount()); root = undefined;
 assert.equal(signal?.aborted, true);
 await act(async () => window.dispatchEvent(new window.Event("focus")));
 assert.equal(syncCalls, 1);
});

test("configured connect exposes only a validated relay link; exports encode opaque ids", async () => {
 const posts: RequestInit[] = [];
 globalThis.fetch = async (input, init) => {
  const url = String(input);
  if (url === "/api/documents") return Response.json({ documents: [{ id: "doc/name", name: "Notes.pdf", size: 1024, mimeType: "application/pdf" }] });
  if (url === "/api/sync/conflicts") return Response.json({ conflicts: [{ id: "conflict/id", name: "Chat copy" }] });
  if (init?.method === "POST") { posts.push(init); return Response.json({ url: "https://relay.example/login" }); }
  return Response.json({ ...status, connected: false, conflicts: 1, pending: posts.length > 0 });
 };
 await mount();
 const connect = [...host!.querySelectorAll("button")].find(button => button.textContent === "Connect Google Drive")!;
 await act(async () => connect.click());
 const link = host!.querySelector<HTMLAnchorElement>('a[href="https://relay.example/login"]');
 assert(link); assert.equal(link.target, "_blank"); assert.match(link.rel, /noopener/);
 assert.deepEqual(JSON.parse(posts[0]!.body as string), { action: "connect" });
 assert(host!.querySelector('a[href="/api/sync/conflicts/conflict%2Fid"]'));
 assert(host!.querySelector('a[href="/api/documents/doc%2Fname"]'));
 assert.doesNotMatch(host!.textContent!, /Google Cloud OAuth/);
});

test("status checks run every fifteen seconds only while visible and stop after cleanup", async () => {
 const originalInterval = window.setInterval, originalClear = window.clearInterval;
 let tick: (() => void) | undefined; let cleared = false; let requests = 0;
 window.setInterval = ((callback: () => void, ms: number) => { assert.equal(ms, 15000); tick = callback; return 42; }) as typeof window.setInterval;
 window.clearInterval = (() => { cleared = true; }) as typeof window.clearInterval;
 globalThis.fetch = async input => { if (String(input) === "/api/documents") return Response.json({ documents: [] }); requests++; return Response.json(status); };
 try {
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  await mount(); assert.equal(requests, 1);
  await act(async () => tick!()); assert.equal(requests, 2);
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
  await act(async () => tick!()); assert.equal(requests, 2);
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  await act(async () => document.dispatchEvent(new window.Event("visibilitychange"))); assert.equal(requests, 3);
  await act(async () => root!.unmount()); root = undefined; assert(cleared);
 } finally { window.setInterval = originalInterval; window.clearInterval = originalClear; }
});


test("browser preferences seed only an empty server and capture local changes", async () => {
 stored.set("lh:keymap", "{}"); stored.set("private-token", "never-upload");
 globalThis.fetch = async input => String(input) === "/api/documents" ? Response.json({ documents: [] }) : Response.json(status);
 await mount(); assert.deepEqual(preferencePosts, [{ "lh:keymap": "{}" }]);
 stored.set("lh:sidebar-open", "false");
 await act(async () => window.dispatchEvent(new window.Event("storage")));
 assert.deepEqual(serverPreferences, { "lh:keymap": "{}", "lh:sidebar-open": "false" });
});

test("remote preferences wait for Refresh and cannot be overwritten by stale browser data", async () => {
 stored.set("lh:sidebar-open", "true"); serverPreferences = { "lh:sidebar-open": "false", "lh:keymap": "{}" };
 globalThis.fetch = async input => String(input) === "/api/documents" ? Response.json({ documents: [] }) : Response.json(status);
 await mount(); assert.equal(stored.get("lh:sidebar-open"), "true"); assert.equal(preferencePosts.length, 0);
 stored.set("lh.graph.camera.v1", "local-edit");
 await act(async () => window.dispatchEvent(new window.Event("storage")));
 assert.equal(preferencePosts.length, 0);
 const refresh = [...host!.querySelectorAll("button")].find(button => button.textContent === "Refresh"); assert(refresh);
 await act(async () => refresh.click());
 assert.equal(stored.get("lh:sidebar-open"), "false"); assert.equal(stored.has("lh.graph.camera.v1"), false); assert.equal(reloads, 1);
});

test("new remote preferences take precedence over concurrent local capture after initialization", async () => {
 stored.set("lh:sidebar-open", "true"); serverPreferences = { "lh:sidebar-open": "true" };
 globalThis.fetch = async input => String(input) === "/api/documents" ? Response.json({ documents: [] }) : Response.json(status);
 await mount(); assert.equal(preferencePosts.length, 0);
 serverPreferences = { "lh:sidebar-open": "false" }; stored.set("lh:keymap", "local-rebind");
 await act(async () => window.dispatchEvent(new window.Event("lh:keymap-changed")));
 assert.equal(preferencePosts.length, 0); assert.equal(stored.get("lh:sidebar-open"), "true");
 assert.match(host!.textContent!, /Changes from another device are ready/);
});

function findButton(label: string): HTMLButtonElement {
 const found = [...host!.querySelectorAll("button")].find(button => button.textContent === label);
 assert(found, `Missing button: ${label}`); return found;
}
test("restore requires confirmation, supports cancel, and sends the selected saved id", async () => {
 const posts: RequestInit[] = [];
 globalThis.fetch = async (input, init) => {
  if (String(input) === "/api/documents") return Response.json({ documents: [] });
  if (String(input) === "/api/sync/conflicts") return Response.json({ conflicts: [{ id: "saved-copy", name: "My notes" }] });
  if (init?.method === "POST") { posts.push(init); return Response.json({}); }
  return Response.json({ ...status, conflicts: 1 });
 };
 await mount(); await act(async () => findButton("Restore saved copy").click());
 assert.equal(posts.length, 0); assert.match(host!.textContent!, /preserved/); assert.match(host!.textContent!, /next sync/);
 await act(async () => findButton("Cancel").click()); assert.equal(posts.length, 0);
 await act(async () => findButton("Restore saved copy").click());
 await act(async () => findButton("Confirm restore").click());
 assert.equal(posts.length, 1); assert.deepEqual(JSON.parse(posts[0]!.body as string), { action: "restore", id: "saved-copy" });
 assert.equal(new Headers(posts[0]!.headers).get("x-learnharness-sync"), "1");
 assert.equal(new Headers(posts[0]!.headers).get("Content-Type"), "application/json");
 assert.match(host!.textContent!, /Saved copy restored/);
});
test("safe backend restore errors stay actionable; unknown raw error details are hidden", async () => {
 let backendError = "Wait until learning and syncing have finished before restoring a copy.";
 globalThis.fetch = async (input, init) => {
  if (String(input) === "/api/documents") return Response.json({ documents: [] });
  if (String(input) === "/api/sync/conflicts") return Response.json({ conflicts: [{ id: "saved-copy", name: "My notes" }] });
  if (init?.method === "POST") return Response.json({ error: backendError }, { status: 409 });
  return Response.json({ ...status, conflicts: 1 });
 };
 await mount(); await act(async () => findButton("Restore saved copy").click());
 await act(async () => findButton("Confirm restore").click());
 assert.match(host!.textContent!, /Wait until learning and syncing have finished/);
 assert.doesNotMatch(host!.textContent!, /Saved copy restored/);
 backendError = "access_token=private-token-value /private/credentials.json";
 await act(async () => findButton("Confirm restore").click());
 assert.doesNotMatch(host!.textContent!, /private-token-value|credentials.json/);
 assert.match(host!.textContent!, /try again/);
});
test("safe status errors explain expired Google sessions", async () => {
 globalThis.fetch = async input => String(input) === "/api/documents" ? Response.json({ documents: [] }) : Response.json({ ...status, phase: "error", error: "Google Drive sign-in expired. Reconnect your account in Sync settings." });
 await mount(); assert.match(host!.textContent!, /Google Drive sign-in expired/);
});

test("newer learning data asks for an app update without exposing storage paths", async () => {
 globalThis.fetch = async input => String(input) === "/api/documents" ? Response.json({ documents: [] }) : Response.json({ ...status, phase: "error", error: "Unsupported schema version: chats/chat_a.json" });
 await mount(); assert.match(host!.textContent!, /Update the learning app/);
 assert.doesNotMatch(host!.textContent!, /chat_a.json/);
});

test("returning to the app triggers a real sync at most once every twenty seconds", async () => {
 const realNow = Date.now; let now = 1_000_000; Date.now = () => now;
 const posts: string[] = []; let gets = 0;
 globalThis.fetch = async (input, init) => {
  if (String(input) === "/api/documents") return Response.json({ documents: [] });
  if (init?.method === "POST") { posts.push(JSON.parse(init.body as string).action); return Response.json({}); }
  gets++; return Response.json(status);
 };
 try {
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  await mount();
  await act(async () => window.dispatchEvent(new window.Event("focus")));
  assert.deepEqual(posts, [], "the start-up read counts as the latest foreground sync");
  now += 20_000;
  await act(async () => window.dispatchEvent(new window.Event("focus")));
  assert.deepEqual(posts, ["sync"]);
  now += 5_000;
  const before = gets;
  await act(async () => { document.dispatchEvent(new window.Event("visibilitychange")); window.dispatchEvent(new window.Event("online")); });
  assert.deepEqual(posts, ["sync"]); assert(gets > before, "throttled triggers still read status");
  now += 20_000;
  await act(async () => document.dispatchEvent(new window.Event("visibilitychange")));
  assert.deepEqual(posts, ["sync", "sync"]);
  now += 20_000;
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
  await act(async () => document.dispatchEvent(new window.Event("visibilitychange")));
  assert.equal(posts.length, 2);
 } finally { Date.now = realNow; Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" }); }
});
