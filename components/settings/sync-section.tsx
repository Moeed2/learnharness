"use client";

import { useEffect, useState } from "react";
import { safeGoogleSignInUrl, safeSyncConnectUrl, useSync, type SyncStatus } from "../sync-coordinator";
import { SettingsGroup } from "./controls";

const buttonClass = "rounded-sm border border-border bg-background px-3 py-1.5 text-xs transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-40";
const linkClass = "underline underline-offset-2 hover:text-foreground";
const phases: Record<SyncStatus["phase"], string> = {
 disconnected: "Not connected", idle: "Up to date", syncing: "Syncing…", offline: "Offline — changes will sync when you reconnect",
 deferred: "Waiting for current work to finish", error: "Sync needs attention. Try syncing again or reconnect Google Drive.",
};
type ExportItem = { id: string; name: string };
type DocumentItem = ExportItem & { size: number; mimeType: string };

export function SyncSection() {
 const { status, busy, error, refresh, action } = useSync();
 const [relayUrl, setRelayUrl] = useState("");
 const [clientId, setClientId] = useState("");
 const [clientSecret, setClientSecret] = useState("");
 const [connectUrl, setConnectUrl] = useState<string | null>(null);
 const [localError, setLocalError] = useState<string | null>(null);
 const [later, setLater] = useState(false);
 const [restoreId, setRestoreId] = useState<string | null>(null);
 const [restored, setRestored] = useState(false);
 const [conflicts, setConflicts] = useState<ExportItem[]>([]);
 const [documents, setDocuments] = useState<DocumentItem[] | null>(null);
 const [listError, setListError] = useState<string | null>(null);
 useEffect(() => {
  const controller = new AbortController();
  setListError(null);
  const load = async () => {
   const response = await fetch("/api/documents", { signal: controller.signal, cache: "no-store" });
   if (!response.ok) throw new Error();
   const body = await response.json() as { documents: DocumentItem[] };
   if (!controller.signal.aborted) setDocuments(body.documents);
  };
  void load().catch(() => { if (!controller.signal.aborted) setListError("Documents could not be loaded. Reopen Sync to try again."); });
  return () => controller.abort();
 }, [status?.changedAt]);
 useEffect(() => {
  const controller = new AbortController();
  setConflicts([]);
  if (status?.conflicts) {
   void fetch("/api/sync/conflicts", { signal: controller.signal, cache: "no-store" })
    .then(async response => { if (!response.ok) throw new Error(); return response.json() as Promise<{ conflicts: ExportItem[] }>; })
    .then(body => { if (!controller.signal.aborted) setConflicts(body.conflicts); })
    .catch(() => { if (!controller.signal.aborted) setLocalError("Conflict copies could not be loaded. Reopen Sync to try again."); });
  }
  return () => controller.abort();
 }, [status?.conflicts, status?.changedAt]);
 useEffect(() => { if (!status?.pending) setConnectUrl(null); }, [status?.pending]);
 async function configure() {
  setLocalError(null);
  try {
   const url = new URL(relayUrl.trim());
   if (url.protocol !== "https:" || url.username || url.password || url.origin === window.location.origin) throw new Error();
   await action("configure", url.href);
  } catch { setLocalError("Enter the HTTPS address of your Google sign-in relay."); }
 }
async function saveClient() {
  setLocalError(null);
  if (await action("configure", { clientId: clientId.trim(), clientSecret: clientSecret.trim() })) { setClientSecret(""); setClientId(""); }
 }
 async function connect() {
  setLocalError(null); setConnectUrl(null);
  const result = await action("connect");
  if (!result) return;
  const local = status?.mode === "local" || (status?.mode !== "relay" && !status?.relayUrl);
  const url = local ? safeGoogleSignInUrl(result.url) : safeSyncConnectUrl(result.url, status?.relayUrl, window.location.origin);
  if (url) setConnectUrl(url);
  else setLocalError(local ? "The sign-in address was not a Google address. Try again." : "The sign-in address did not match your configured relay. Check your relay setup and try again.");
 }
 async function restore(id: string) {
  setLocalError(null); setRestored(false);
  const result = await action("restore", id);
  if (result) { setRestoreId(null); setRestored(true); }
 }
 return <div className="flex flex-col gap-3 text-xs">
  <p className="leading-relaxed text-muted-foreground">Sync all your learning data — documents, folders, notes, chats, settings and progress — through your personal Google Drive. Keep working offline; changes sync when you reconnect. Secrets and device sign-ins stay on this device.</p>
  {!status ? <p role="status">Loading sync status…</p> : <>
   <div role="status" aria-live="polite" className="space-y-1">
    <p>{status.pending ? "Waiting for Google sign-in…" : phases[status.phase]}</p>
    {status.accountLabel && <p className="break-all text-muted-foreground">{status.accountLabel}</p>}
    {status.lastSyncedAt && <p className="text-muted-foreground">Last synced: {new Date(status.lastSyncedAt).toLocaleString()}</p>}
   </div>
   {!status.configured ? <SettingsGroup label="Google Drive setup">
    <p className="leading-relaxed text-muted-foreground">Create a free Google Cloud OAuth client of type <strong>Desktop app</strong> and paste its client ID and secret here (see docs/google-drive-sync.md). Use the same client on desktop and Android. You can set up later and keep learning offline.</p>
    {later ? <button type="button" className={buttonClass} onClick={() => setLater(false)}>Set up sync</button> : <>
     <form className="flex flex-col gap-2" onSubmit={event => { event.preventDefault(); void saveClient(); }}>
      <label htmlFor="sync-client-id">Google OAuth client ID</label>
      <input id="sync-client-id" required autoComplete="off" spellCheck={false} placeholder="1234567890-abc.apps.googleusercontent.com" value={clientId} onChange={event => setClientId(event.target.value)} className="min-w-0 rounded-sm border border-border bg-background px-2 py-1.5 text-xs" />
      <label htmlFor="sync-client-secret">Google OAuth client secret</label>
      <input id="sync-client-secret" type="password" required autoComplete="off" spellCheck={false} value={clientSecret} onChange={event => setClientSecret(event.target.value)} className="min-w-0 rounded-sm border border-border bg-background px-2 py-1.5 text-xs" />
      <div className="flex flex-wrap gap-2"><button type="submit" disabled={busy} className={buttonClass}>Save</button><button type="button" className={buttonClass} onClick={() => setLater(true)}>Set up later</button></div>
     </form>
     <details className="mt-1">
      <summary className="cursor-pointer text-muted-foreground">Advanced: use a sign-in relay</summary>
      <form className="mt-2 flex flex-col gap-2" onSubmit={event => { event.preventDefault(); void configure(); }}>
       <label htmlFor="sync-relay-url">Sign-in relay URL</label>
       <input id="sync-relay-url" type="url" required placeholder="https://your-relay.example" value={relayUrl} onChange={event => setRelayUrl(event.target.value)} className="min-w-0 rounded-sm border border-border bg-background px-2 py-1.5 text-xs" />
       <div className="flex flex-wrap gap-2"><button type="submit" disabled={busy} className={buttonClass}>Save relay</button></div>
      </form>
     </details>
    </>}
   </SettingsGroup> : <div className="flex flex-wrap gap-2">
    {!status.connected && <button type="button" disabled={busy || status.pending} className={buttonClass} onClick={() => void connect()}>Connect Google Drive</button>}
    {status.connected && <button type="button" disabled={busy || status.phase === "syncing"} className={buttonClass} onClick={() => void action("sync")}>Sync now</button>}
    {(status.connected || status.pending) && <button type="button" disabled={busy} className={buttonClass} onClick={() => { setConnectUrl(null); void action("disconnect"); }}>Disconnect</button>}
   </div>}
   {connectUrl && <a href={connectUrl} target="_blank" rel="noopener noreferrer" className={linkClass}>Continue to Google sign-in ↗</a>}
   {status.conflicts > 0 && <SettingsGroup label={`${status.conflicts} conflict ${status.conflicts === 1 ? "copy" : "copies"}`}>
    <p className="text-muted-foreground">Both versions were kept. Export a copy to review it, or restore a saved version.</p>
    <ul className="space-y-2" aria-label="Conflict exports">{conflicts.map(item => <li key={item.id}><a className={linkClass} href={`/api/sync/conflicts/${encodeURIComponent(item.id)}`} download>Export {item.name}</a>
     {restoreId === item.id ? <div role="group" aria-label={`Confirm restoring ${item.name}`} className="mt-2 space-y-2 rounded-sm border border-border p-3">
      <p>Restore {item.name}? The active copy will be preserved as a saved conflict. The selected saved version replaces its part of your workspace and is shared on the next sync.</p>
      <div className="flex flex-wrap gap-2">
       <button type="button" className={buttonClass} disabled={busy || !status.connected || status.phase === "syncing"} onClick={() => void restore(item.id)}>Confirm restore</button>
       <button type="button" className={buttonClass} disabled={busy} onClick={() => setRestoreId(null)}>Cancel</button>
      </div>
     </div> : <button type="button" className={`${buttonClass} ml-2`} disabled={busy || !status.connected || status.phase === "syncing"} onClick={() => { setRestoreId(item.id); setRestored(false); setLocalError(null); }}>Restore saved copy</button>}
    </li>)}</ul>
   </SettingsGroup>}
  </>}
  {restored && <p role="status">Saved copy restored. The previous active copy was preserved. Refresh to view the restored data; it will be shared on the next sync.</p>}
  {(error || localError) && <p role="alert" className="text-destructive">{localError || error}</p>}
  {error && <button type="button" disabled={busy} className={buttonClass} onClick={() => void refresh()}>Retry sync status</button>}
  <SettingsGroup label="Original documents">
   <p className="text-muted-foreground">Retained uploads are available here. Older imports may not have an original file.</p>
   {listError ? <p role="alert">{listError}</p> : documents === null ? <p role="status">Loading documents…</p> : documents.length === 0 ? <p className="text-muted-foreground">No original documents saved yet.</p> : <ul aria-label="Original documents" className="space-y-2">{documents.map(item => <li key={item.id} className="break-words"><a href={`/api/documents/${encodeURIComponent(item.id)}`} download className={linkClass}>{item.name}</a><span className="ml-2 text-muted-foreground">{Math.ceil(item.size / 1024)} KB · {item.mimeType}</span></li>)}</ul>}
  </SettingsGroup>
 </div>;
}
