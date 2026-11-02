# Google Drive Sync Implementation Plan

> Agent execution: independent work on disjoint files, followed by integration and security review.

Goal: sync the user's complete learning workspace through personal Google Drive while keeping offline operation and credentials private.
Architecture: local-first immutable per-unit revisions, causal parents, deterministic conflict handling, private appDataFolder transport; PKCE-bound HTTPS callback relay and per-device token store.
Tech stack: existing TypeScript/Next.js/Node server, React settings, fetch, Google Drive REST, standalone Cloudflare Worker + KV relay.
Spec: docs/superpowers/specs/2026-11-02-google-drive-sync-design.md

## Global constraints
Never sync credentials, env, debug, model caches or live-job state. Preserve conflicting revisions. Google secret is relay-only. No deployment or account actions in this implementation round. Existing Android API guard must apply to all new local endpoints. Use public server barrel from app routes.

## Review focus
Account changes; concurrent local edits during a download; malicious symlink/path payloads; partially written revision state; token expiry and pending authorization replay.

## Tasks
- [x] Storage engine + tests: src/sync/types.ts, engine.ts, local.ts; tests/google-sync-engine.test.ts. Define immutable RevisionMeta {id,unit,parents,deleted,hash}, Revision {meta,files:Record<string,string>} (base64 relative files), SyncRemote {list,download,upload}. SyncEngine({root,stateDir,remote,accountId,isBusy?,onApplied?}).sync() -> uploaded/downloaded/conflicts/deferred. Allowlist, causal heads, tombstones, conflict recovery, single-flight, race recheck, fail-closed account binding. Write failure tests first.
- [x] Authorization + relay + tests: src/sync/google-auth.ts; cloud/google-drive-relay/worker.mjs and wrangler.toml; tests/google-sync-auth.test.ts. Expose getGoogleSyncAuthStatus, configureGoogleSyncRelay, beginGoogleSyncSignIn, completeGoogleSyncSignIn, disconnectGoogleSync, getGoogleDriveAccessToken. Configure relay URL locally; poll PKCE-bound token exchange; refresh local-only tokens; no credential data in status.
- [x] Original documents + tests: src/store/documents.ts and import integration; authenticated /api/documents endpoints. Retain bytes and metadata for accepted imports; support download; no absolute source paths; documents are allowlisted in sync engine.
- [x] Drive transport + tests: src/sync/google-drive.ts implements SyncRemote using immutable metadata summaries, pagination, duplicate revision dedupe, resumable upload and bounded download integrity verification. Google-specific fetch failures give safe actionable errors.
- [x] Service + routes + UI + tests: src/server/sync.ts, API /api/sync, background status/start/poll, protected same-origin mutations, safe idle gate and notifications. Settings section connects via browser URL, polls sign-in, sync now, disconnect and exports conflict copies. Auto-start while app is open; offline failures stay non-blocking.
- [x] Verify: new tests, typecheck, lint changed files, regression tests, production build. Independently review credentials, remote validation and conflict/race handling. Record pre-existing build blockers separately. Write docs/google-drive-sync.md with exact free relay/Google Cloud setup, limits and recovery; guide user after tested code is ready.

## Verification outcome
189 targeted tests pass; TypeScript, scoped lint, production web build and debug Android build pass. Desktop and tablet-sized browser UI checked with no page errors. Local sync mutation without app header returns 403. Existing resvg bundler and Kotlin comment build blockers fixed. Large-library blobs are transferred individually with cached verification. APK installed successfully without clearing app data; stock tablet WebView launches and all built-in diagnostics pass. Unauthenticated forwarded sync API returns 403. Google Cloud/Cloudflare setup and real three-device consent remain pending. No deployment or account upload performed.


