"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";

export type SyncStatus = {
 configured: boolean;
 connected: boolean;
 pending: boolean;
 accountLabel?: string;
 relayUrl?: string;
 mode?: "local" | "relay";
 phase: "disconnected" | "idle" | "syncing" | "offline" | "deferred" | "error";
 lastSyncedAt?: string;
 error?: string;
 conflicts: number;
 changedAt?: string;
};
type SyncAction = "configure" | "connect" | "poll" | "sync" | "disconnect" | "restore";
type SyncContextValue = {
 status: SyncStatus | null;
 busy: boolean;
 error: string | null;
 refresh: () => Promise<void>;
 action: (action: SyncAction, value?: string | { clientId: string; clientSecret: string }) => Promise<{ url?: string } | null>;
};
const SyncContext = createContext<SyncContextValue>({ status: null, busy: false, error: null, refresh: async () => {}, action: async () => null });
export const useSync = () => useContext(SyncContext);
const preferenceKeys = ["lh:keymap", "lh:sidebar-open", "lh:session-kind-filter", "lh.graph.camera.v1"] as const;
type Preferences = Record<string, string>;
function localPreferences(): Preferences {
 const values: Preferences = {};
 for (const key of preferenceKeys) {
  const value = window.localStorage.getItem(key);
  if (value !== null) values[key] = value;
 }
 return values;
}
function preferenceSignature(values: Preferences): string {
 return JSON.stringify(preferenceKeys.map(key => values[key] ?? null));
}
const headers = { "Content-Type": "application/json", "x-learnharness-sync": "1" };

const fallbackSyncError = "Sync could not finish. Your data is available offline; check your connection and try again.";
const publicSyncErrors = new Set([
 "Wait until learning and syncing have finished before restoring a copy.",
 "Choose a saved conflict while connected to its Google account.",
 "Wait for the current sync to finish.",
 "Open Sync settings in the learning app to change this connection.",
 "Enter your Google sync relay URL.",
 "Enter the HTTPS Google sync relay URL.",
 "Enter the Google OAuth client ID (ends with .apps.googleusercontent.com).",
 "Enter the Google OAuth client secret.",
 "Disconnect Google sync before changing the Google client.",
 "Save your Google OAuth client ID and secret first.",
 "Start Google sign-in from the LearnHarness app on this device.",
 "Google is unavailable. Try again when online.",
 "Google returned an invalid response.",
 "Google sync relay must be an HTTPS origin without credentials, path or query.",
 "Disconnect Google sync before changing the relay.",
 "Configure the Google sync HTTPS relay first.",
 "Google sync relay is unavailable. Try again when online.",
 "Google sync credential file is unreadable. Disconnect and configure sync again.",
 "Google sync sign-in changed or was cancelled.",
 "Google sign-in could not complete. Start sign-in again.",
 "Please sign in to Google sync.",
 "Please sign in to Google sync again.",
 "Google sync account changed. Please sign in again.",
 "Google sync refresh unavailable. Try again later.",
 "Google Drive is unreachable. Your local changes are safe; syncing will retry.",
 "Google Drive sign-in expired. Reconnect your account in Sync settings.",
 "Google Drive permission or quota limit. Check your account and try syncing later.",
 "Learning data exceeds the current per-revision sync limit (128 MB).",
]);
function safeSyncError(value: unknown): string {
 if (typeof value !== "string") return fallbackSyncError;
 if (publicSyncErrors.has(value)) return value;
 if (/^Unsupported schema version: (settings\.json|graph\/format\.json|chats\/[A-Za-z0-9_-]+\.json)$/.test(value)) return "Update the learning app on this device before syncing data saved by a newer version.";
 if (/^Google Drive request failed \([45]\d{2}\). Your local changes are safe\.$/.test(value)) return `${value} Try syncing again later.`;
 switch (value) {
  case "Workspace busy": return "Wait until learning and syncing have finished before restoring a copy.";
  case "Invalid conflict": return "This saved copy is no longer available. Reopen Sync and choose another copy.";
  case "Missing conflict blob": return "This saved copy is incomplete and could not be restored. Export another copy or try syncing again.";
  case "Account mismatch or pending sync": return "Wait for syncing to finish and connect the Google account that owns this saved copy.";
  case "Account binding mismatch: use a separate data root": return "This workspace belongs to a different Google account. Connect its original account before syncing.";
  default: return fallbackSyncError;
 }
}
class SyncRequestError extends Error {}

/** The browser only opens the relay we already configured, never an arbitrary API URL. */
export function safeSyncConnectUrl(value: unknown, relayUrl: string | undefined, appOrigin: string): string | null {
 try {
  if (typeof value !== "string" || !relayUrl) return null;
  const url = new URL(value), relay = new URL(relayUrl);
  if (url.protocol !== "https:" || relay.protocol !== "https:" || url.origin !== relay.origin || url.origin === appOrigin || url.username || url.password || relay.username || relay.password) return null;
  return url.href;
 } catch { return null; }
}

/** Local mode: the browser only opens Google's fixed authorization endpoint. */
export function safeGoogleSignInUrl(value: unknown): string | null {
 try {
  if (typeof value !== "string") return null;
  const url = new URL(value);
  if (url.origin !== "https://accounts.google.com" || url.pathname !== "/o/oauth2/v2/auth" || url.username || url.password || url.hash) return null;
  return url.href;
 } catch { return null; }
}

export function SyncCoordinator({ children }: { children: ReactNode }) {
 const [status, setStatus] = useState<SyncStatus | null>(null);
 const [busy, setBusy] = useState(false);
 const [error, setError] = useState<string | null>(null);
 const [remoteChanges, setRemoteChanges] = useState(false);
 const [preferenceError, setPreferenceError] = useState<string | null>(null);
 const preferenceBaseline = useRef<string | null>(null);
 const pendingPreferences = useRef<Preferences | null>(null);
 const baseline = useRef<string | undefined>(undefined);
 const controller = useRef<AbortController | null>(null);
 const mounted = useRef(false);
 const run = useCallback(async (action?: SyncAction, value?: string | { clientId: string; clientSecret: string }): Promise<{ url?: string } | null> => {
  if (!mounted.current || controller.current) return null;
  const request = new AbortController(); controller.current = request;
  setBusy(true);
  const read = async (action?: SyncAction) => {
   const response = await fetch("/api/sync", {
    method: action ? "POST" : "GET", headers, cache: "no-store", signal: request.signal,
    ...(action ? { body: JSON.stringify({ action, ...(action === "configure" ? (typeof value === "object" ? value : { relayUrl: value }) : action === "restore" ? { id: value } : {}) }) } : {}),
   });
   if (!response.ok) {
    const detail = await response.json().catch(() => null) as { error?: unknown } | null;
    throw new SyncRequestError(safeSyncError(detail?.error));
   }
   return response.json();
  };
  try {
   const result = action ? await read(action) as { url?: string } : null;
   let next = await read() as SyncStatus;
   if (!action && next.pending) { await read("poll"); next = await read() as SyncStatus; }
   if (request.signal.aborted) return null;
   if (next.changedAt) {
    if (baseline.current !== undefined && next.changedAt !== baseline.current) setRemoteChanges(true);
    baseline.current = next.changedAt;
   }
   setStatus(next); setError(next.error ? safeSyncError(next.error) : null);
   if (action === "restore") setRemoteChanges(true);
   // Read remote state before capturing browser changes so stale localStorage cannot echo it back.
   try {
    const response = await fetch("/api/sync/preferences", { headers, cache: "no-store", signal: request.signal });
    if (!response.ok) throw new Error();
    const body = await response.json() as { preferences: Preferences };
    if (!body.preferences || typeof body.preferences !== "object" || Array.isArray(body.preferences)) throw new Error();
    const remote: Preferences = {};
    for (const key of preferenceKeys) {
     const value = body.preferences[key];
     if (value !== undefined) { if (typeof value !== "string") throw new Error(); remote[key] = value; }
    }
    if (request.signal.aborted) return null;
    const local = localPreferences();
    const remoteSignature = preferenceSignature(remote), localSignature = preferenceSignature(local);
    const first = preferenceBaseline.current === null;
    if (pendingPreferences.current || (!first && remoteSignature !== preferenceBaseline.current) || (first && Object.keys(remote).length > 0 && remoteSignature !== localSignature)) {
     pendingPreferences.current = remote;
     setRemoteChanges(true);
    } else if ((first && Object.keys(remote).length === 0 && Object.keys(local).length > 0) || (!first && localSignature !== preferenceBaseline.current)) {
     const saved = await fetch("/api/sync/preferences", { method: "POST", headers, signal: request.signal, body: JSON.stringify({ preferences: local }) });
     if (!saved.ok) throw new Error();
     preferenceBaseline.current = localSignature;
    } else { preferenceBaseline.current = remoteSignature; }
    if (!request.signal.aborted) setPreferenceError(null);
   } catch {
    if (!request.signal.aborted) setPreferenceError("Browser preferences could not sync. Your local settings are safe; try again when connected.");
   }
   return result;
  } catch (failure) {
   if (!request.signal.aborted) setError(failure instanceof SyncRequestError ? failure.message : fallbackSyncError);
   return null;
  } finally {
   if (controller.current === request) controller.current = null;
   if (!request.signal.aborted) setBusy(false);
  }
 }, []);
 const refresh = useCallback(async () => { await run(); }, [run]);
 useEffect(() => {
  mounted.current = true;
  void refresh();
  const visibleRefresh = () => { if (document.visibilityState !== "hidden") void refresh(); };
  const timer = window.setInterval(visibleRefresh, 15_000);
  window.addEventListener("focus", visibleRefresh);
  window.addEventListener("online", visibleRefresh);
  window.addEventListener("storage", visibleRefresh);
  window.addEventListener("lh:keymap-changed", visibleRefresh);
  window.addEventListener("lh:settings-saved", visibleRefresh);
  document.addEventListener("visibilitychange", visibleRefresh);
  return () => {
   mounted.current = false;
   controller.current?.abort(); controller.current = null;
   window.clearInterval(timer);
   window.removeEventListener("focus", visibleRefresh);
   window.removeEventListener("online", visibleRefresh);
   window.removeEventListener("storage", visibleRefresh);
   window.removeEventListener("lh:keymap-changed", visibleRefresh);
   window.removeEventListener("lh:settings-saved", visibleRefresh);
   document.removeEventListener("visibilitychange", visibleRefresh);
  };
 }, [refresh]);
 return <SyncContext.Provider value={{ status, busy, error: error ?? preferenceError, refresh, action: run }}>
  {children}
  {remoteChanges && <div role="status" className="fixed bottom-4 right-4 z-40 max-w-[calc(100vw-2rem)] rounded-sm border border-border bg-card px-3 py-2 text-xs shadow-md">
   Changes from another device are ready. <button type="button" className="underline underline-offset-2" onClick={() => {
    try {
     if (pendingPreferences.current) {
      for (const key of preferenceKeys) {
       const value = pendingPreferences.current[key];
       if (value === undefined) window.localStorage.removeItem(key);
       else window.localStorage.setItem(key, value);
      }
     }
     window.location.reload();
    } catch { setPreferenceError("Browser settings could not be applied. Allow local storage and try Refresh again."); }
   }}>Refresh</button>
  </div>}
 </SyncContext.Provider>;
}
