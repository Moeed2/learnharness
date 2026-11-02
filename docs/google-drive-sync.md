# Personal Google Drive sync: OAuth setup

This implementation uses your own Google Cloud OAuth client and a small HTTPS Cloudflare Worker relay. It works with the regular browser on Huawei/Android and desktop; it does not require Google Play Services, a desktop loopback callback, a custom Android URL scheme or a second device running a server. Each device must sign in separately to the same Google account, through the same relay/client.

No account or deployment has been created by this implementation. Real sign-in needs the setup below. Local automated tests use simulated Google/Cloudflare responses and never access an account.

## What follows you between devices

Documents and their converted reading text, chats, learning-map progress, source folders and display names, completed background results, model/appearance settings, prompt overrides, keyboard shortcuts and saved view preferences are included. Passwords, provider keys, sign-in sessions, running jobs, caches and debug logs remain on their device. Connect each device to the same Google account **and the same relay/OAuth client**.

The app keeps local data available offline. It checks Drive about every 30 seconds while its local server is running and reconciles on reopening. Closing the app does not promise continued background syncing. A notice offers Refresh when remote changes arrive; unsent text is not automatically discarded. Independent new documents and chats combine; conflicting edits to the same record retain alternate copies under **Settings → Sync**, where you can export or restore them. Restoring keeps the previously active copy and shares the restored version on the next sync.

Original files are retained for **new imports**. Earlier app versions discarded the original upload after extraction, so those originals must be imported again if you want the files themselves available everywhere. Existing extracted learning data still syncs.

Current safeguards limit individual imported documents/blobs to 25 MB, each metadata group to 64 MB, and the remote revision listing to 200,000 revisions. These are application limits, separate from your Google Drive allowance. Documents transfer one at a time and unchanged content is not downloaded again. Superseded history is kept for 30 days for recovery. After that, at most once a day and only after a successful sync, each device deletes older revisions that a newer revision has replaced, and document blobs that no current document references (up to 500 deletions per run; failures are retried the next day). The latest revision of every item is always kept, including deletion markers that prevent removed items from reappearing, and items with unresolved concurrent versions are not cleaned. A device that was offline longer than 30 days still syncs; its older edits are treated as concurrent changes. Your full 2 TB allowance is available to the account, but a 2 TB library has not been tested.

## 1. Choose a free Cloudflare Worker URL

Use a Cloudflare account with Workers Free and a workers.dev subdomain. No custom domain is required. In Cloudflare's Workers dashboard, choose your workers.dev subdomain. With the configured Worker name, the final origin will be:

```text
https://learnharness-google-drive-relay.YOUR-SUBDOMAIN.workers.dev
```

Use your actual origin everywhere below, with no trailing slash. This relay must be controlled by you: its operator necessarily sees tokens in transit during exchange and refresh. Never use an untrusted public relay.

## 2. Create the Google Web OAuth client

1. Open [Google Cloud Console](https://console.cloud.google.com/), create/select a project for your personal LearnHarness sync, and enable **Google Drive API** under **APIs & Services → Library**.
2. Open **Google Auth Platform**. Complete **Branding** with an app name and your support/developer email. For a personal Gmail account, choose **External** under **Audience**.
3. Initially leave the app in **Testing** and add your exact Google account email under **Test users**.
4. Under **Data Access**, add exactly these scopes: `https://www.googleapis.com/auth/drive.appdata`, `openid`, and `https://www.googleapis.com/auth/userinfo.email` (the request uses its equivalent `email` spelling). Do not add full Drive access.
5. Under **Clients**, create an OAuth client of type **Web application**. Do not choose Android or Desktop app. Add this exact **Authorized redirect URI**:

   ```text
   https://learnharness-google-drive-relay.YOUR-SUBDOMAIN.workers.dev/callback
   ```

6. Leave **Authorized JavaScript origins** empty: browser JavaScript does not exchange tokens. Save the client ID and client secret securely. The client ID goes into Worker configuration; the secret goes only into Cloudflare Worker secrets.

The Google client secret must never be put in the application environment, Android APK, renderer, local sync config, Git or a shared message. [Google's web OAuth flow](https://developers.google.com/identity/protocols/oauth2/web-server) requires the redirect URI to match exactly.

**Testing mode limitation:** because this app requests Drive access, refresh tokens issued while an External app is in Testing expire after seven days. Reconnect when needed, or move the consent app to **In production** in Audience and follow any Google requirements shown there. Production status does not prevent revocation or all token expiry. See [Google token expiration rules](https://developers.google.com/identity/protocols/oauth2#expiration).

## 3. Configure and deploy the relay yourself

In a terminal in `cloud/google-drive-relay` (Node.js and npm required), run:

```powershell
npx wrangler login
npx wrangler kv namespace create AUTH_CODES
```

Copy the returned namespace ID into the existing `[[kv_namespaces]]` block of `wrangler.toml`. Do not add a second block with the same binding. Set `[vars].RELAY_URL` to the HTTPS origin from step 1 and `[vars].GOOGLE_CLIENT_ID` to your Google Web client ID. Keep `observability.enabled = false`: invocation logs and callback URLs must not capture authorization codes. Do not add request-body logging, Logpush, tracing, proxy access logs or `wrangler tail` sessions containing credentials.

Create the two server secrets interactively, then deploy:

```powershell
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler secret put STATE_SECRET
npx wrangler deploy
```

For `GOOGLE_CLIENT_SECRET`, paste the Google Web client secret. For `STATE_SECRET`, use a new cryptographically random value with at least 32 bytes of entropy (for example, a password manager's random 64-character secret). These commands can create a draft Worker before first deployment. Neither secret belongs in `wrangler.toml`. Check that the URL printed by deploy matches `RELAY_URL` and your Google callback URI exactly. Keep these commands as manual setup; the application never invokes them.

See [Cloudflare KV setup](https://developers.cloudflare.com/kv/get-started/) and [Worker secrets](https://developers.cloudflare.com/workers/configuration/secrets/). Free quotas apply to requests, KV reads, writes and deletions; signing in/polling is the main KV traffic, while refresh does not use KV. Check the [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) and [KV limits](https://developers.cloudflare.com/kv/platform/limits/) rather than enabling paid upgrades automatically.

## 4. Connect each device

Configure the relay URL through the application's sync settings, or set the Node runtime environment variable:

```text
LH_GOOGLE_SYNC_RELAY_URL=https://learnharness-google-drive-relay.YOUR-SUBDOMAIN.workers.dev
```

The environment variable overrides persisted configuration. Only an HTTPS origin is accepted; paths, queries, credentials and HTTP localhost URLs are rejected. Restart the local application runtime after changing its environment. No Google secret is needed on a device.

Use **Connect Google**, open the provided URL in the normal browser, choose your intended personal Google account and approve access. Return to the application after the approval page. The local server polls the relay with its private PKCE verifier; browser JavaScript never receives credentials. Poll no faster than once every few seconds and stop after completion/expiry. An authorization attempt expires after ten minutes; start again if it expires. Repeat separately on each device.

Drive data uses the private `appDataFolder`, not a folder visible in My Drive. Your account's Drive storage quota still applies. Signing in only authorizes access; the separate sync service controls uploads. Changing Google accounts must pass that service's account-binding checks before uploading an existing local workspace.

## Credential and relay behavior

- Local config, pending verifier and device tokens live in `PATHS.data/.sync/google-auth.json`, relocated by `LH_DATA_DIR`. This directory is excluded from sync. Writes use a temporary file and atomic rename, directory mode `0700` and file mode `0600`. These POSIX modes do not replace Windows ACLs: use a private OS user/profile or Android app-private directory. This is a local credential file, not an encrypted hardware keystore.
- Public status includes only configured/connected/pending flags, relay URL and connected account ID/label. No access tokens, refresh tokens, verifiers or ID tokens are returned in status. `getGoogleDriveAccessToken()` is server-only.
- `/authorize` receives only a SHA-256 S256 challenge. Its signed state binds the challenge and expiry. Google receives the same PKCE challenge plus offline/consent requests. `/callback` validates state and puts only the short-lived authorization code and expiry in KV, keyed by the challenge.
- `/token` accepts the device's verifier in a bounded POST body, derives the challenge, and exchanges the code at Google's fixed HTTPS token endpoint with that verifier and the server client secret. An intercepted authorization URL or code alone cannot redeem tokens. Tokens are never persisted in KV. Responses are non-cacheable; cross-origin browser API access is rejected and no permissive CORS headers are emitted.
- The worker decodes `sub` and verified email from the ID token returned **directly by Google's authenticated HTTPS token endpoint**, checking issuer, audience and expiry. It does not accept device/browser ID tokens and does not claim to independently verify JWT signatures. This trust boundary depends on the fixed HTTPS endpoint and disabled redirects. Only the account ID/label and required access/refresh tokens leave the worker; ID tokens never enter the renderer.
- `/refresh` receives a device refresh token, exchanges it at Google with the server secret, and returns only access token, expiry and a replacement refresh token if supplied. Tokens are transient in Worker memory during requests; neither tokens nor request credentials are logged by this code. Refresh starts sixty seconds before access-token expiry. Network failures retain local credentials; a rejected/revoked refresh requires sign-in again.
- Local polling and refresh are single-flight. Starting another sign-in while connected requires an explicit disconnect first. Disconnect or relay/account changes invalidate pending in-flight writes. A relay configuration change cannot silently send an existing token to another relay.

### One-use codes, races and safe retries

Workers KV is eventually consistent and offers no atomic consume operation ([Cloudflare consistency model](https://developers.cloudflare.com/kv/concepts/how-kv-works/)). It is not used as a lock. Google enforces one-time authorization-code redemption. Concurrent relay requests can therefore produce one success and a retry/sign-in-required response, never two successful grants. The local app serializes polling to avoid this race in normal use.

An in-memory set of challenges prevents concurrent exchange within a single Worker isolate, without retaining tokens. It is not a cross-region lock. The code stays in KV after a transient exchange error so a later poll can retry; Google remains the redemption authority. A successful exchange deletes the code best-effort. Stale KV reads or a replayed callback can surface an already-used code, which Google rejects. The stored expiry is always checked, including when KV propagation is delayed. Polling before the callback or before KV propagation returns pending.

If Google's exchange succeeds but the response is lost, or the device cannot save credentials, the app must start a **new sign-in**. The relay intentionally cannot replay successful token responses because it stores no tokens. Strict atomic cross-region redemption or transparent recovery of lost successful responses would require a different coordination/storage design; KV alone cannot provide either guarantee.

## Disconnect and recovery

**Disconnect affects only this device:** it removes local credentials and cancels pending sign-in without contacting Google or the relay, including when offline. Other devices retain their own tokens and can continue syncing. Disconnect does not delete local documents or remote app data.

To explicitly revoke the **entire Google OAuth grant**, open [Google Account connections](https://myaccount.google.com/connections), select your LearnHarness OAuth app and remove its access. This can disconnect every device using the same OAuth client; reconnect each device if you later restore access. Ordinary per-device Disconnect never performs this account-wide action.

- **Redirect URI mismatch:** compare Google client's redirect URI with `RELAY_URL + /callback`, including spelling and HTTPS.
- **Access denied:** check the signed-in account is in the consent app's Test users and that the correct client/project is selected.
- **Not configured:** replace the client ID, relay URL and KV ID placeholders and set both Worker secrets.
- **Pending too long:** return to the app after consent; allow for KV propagation. Check connectivity and the configured origin. After ten minutes, reconnect.
- **Sign-in required after refresh:** revoked/expired grant or Testing's seven-day limit. Reconnect; never paste tokens into diagnostics.
- **Lost authorization response / already used code:** start a new sign-in. Do not retry the Google callback URL manually.
- **Different relay:** disconnect before reconfiguring. If an environment override is present, update it as well. Do not reuse credentials across unrelated OAuth clients.

## Local verification

```powershell
node --import tsx --test tests/google-sync-auth.test.ts
```

Tests use temporary credential directories and injected HTTP/KV substitutes. They cover PKCE binding, signed-state tampering/expiry, pending completion, code races, token field filtering, refresh expiry, local disconnect races, offline disconnect without network requests, preservation of another device's credentials, relay changes and non-leaking status. Final end-to-end verification still requires your deployed Worker, Google Web client and browser consent on desktop/Huawei. Nothing in this guide deploys or signs in automatically.
