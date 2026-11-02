# LearnHarness for Android tablets (step 1: standalone shell)

Status: **step 1 of the Android plan.** The app boots the real LearnHarness
Next.js server inside the app process and shows the same GUI as the desktop
app in a WebView. Steps 2-8 (see "Known limitations") are not done yet.

## Architecture

```
APK
 |- lib/<abi>/libnode.so        nodejs-mobile (digidem fork, Node 24.20, "full" flavor, ICU)
 |- lib/<abi>/liblhnode.so      JNI glue (android/app/src/main/cpp/lh_node.cpp)
 |- assets/server.zip           Next standalone + android addons (the ONLY asset)
 `- classes.dex                 Kotlin: MainActivity, NodeService, PayloadInstaller

MainActivity --starts--> NodeService (foreground, type specialUse)
   |                        1. extract server.zip -> filesDir/server  (only if payload-version.txt changed;
   |                           extract to server.tmp, then rename)
   |                        2. mkdir filesDir/data, filesDir/home
   |                        3. pick a free 127.0.0.1 port, set env, chdir, node::Start(server.js)
   |                           on a 16 MB-stack pthread; stdout/stderr -> logcat + in-app log
   `--polls http://127.0.0.1:PORT/ until 200, then loads it in a WebView
```

* **No Capacitor / React Native**: their Node plugins embed Node 18, which cannot run Next 16.
* **Environment** given to the server: `PORT`, `HOSTNAME=127.0.0.1`, `NODE_ENV=production`,
  `HOME=filesDir/home`, `TMPDIR=cacheDir`, `LH_DATA_DIR=filesDir/data`,
  `LH_AUTH_FILE=filesDir/auth.json`. `LH_DESKTOP_SERVER` / `LH_DESKTOP_API_SECRET` are
  deliberately **not** set: the server runs in its "web" mode, which is what in-app ChatGPT
  sign-in will use (step 2 adds a cookie guard because any local app can reach loopback).
* **Node starts once per process.** If the server dies the UI offers "Restart app", which
  relaunches into a fresh process.
* **WebView**: user agent gets the suffix ` LearnHarnessAndroid/<versionName>`. Cleartext HTTP is
  allowed only for `127.0.0.1` and `localhost` (`res/xml/network_security_config.xml`). Links to
  other origins open in the system browser. A native screen is shown if the system WebView's
  Chromium major version is below `AppConfig.MIN_WEBVIEW_MAJOR` (111; change it in
  `android/app/src/main/java/ai/learnharness/tablet/AppConfig.kt`).
* **Changing the package id**: edit `lh.applicationId` in `android/gradle.properties` (one place).
  Kotlin/JNI keep the `ai.learnharness.tablet` namespace.
* **Diagnostics spike**: `scripts/android/diagnostics.mjs` is shipped as `lh-diagnostics.mjs` and
  loaded with `node --import` before `server.js`. It probes `@napi-rs/canvas`,
  `@resvg/resvg-js`, photon WASM, `worker_threads`, `module.registerHooks`, Unicode property
  regexes, `Intl.Segmenter`, `crypto.subtle`, `fetch`, `os.homedir()`; writes
  `filesDir/diagnostics.json` and logs one `LH_DIAGNOSTICS {json}` line. It never crashes the server.
  Read it on a device with: `adb shell run-as ai.learnharness.tablet cat files/diagnostics.json`
  or `adb logcat -s LH-Node | grep LH_DIAGNOSTICS`.

## Building (GitHub Actions only)

The Android SDK cannot be installed in the sandbox this was written in, so everything is built and
tested by `.github/workflows/android.yml` (push to `claude/**` / `main` touching Android or app
code, pull requests, or manual dispatch):

1. `npm ci`, `npm run build`, `node scripts/build-server.mjs`
2. `node scripts/android/build-payload.mjs`: copies `.next/standalone`, adds the
   `android-arm64` N-API addons at the versions in `package-lock.json` (from the npm registry,
   integrity-checked), prunes host binaries, adds diagnostics and `payload-version.txt`, and writes
   `android/app/src/main/assets/server.zip`.
3. `scripts/android/fetch-libnode.sh`: downloads nodejs-mobile `v24.20.0-0` (full, Android) with `gh`,
   places `libnode.so` per ABI under `android/libnode/`. Prints the archive sha256; pin it in the
   script (`PINNED_SHA256`, marked TODO) after the first run.
4. `./gradlew assembleDebug` (AGP 8.13.0, Kotlin 2.2.20, Gradle 8.14.3, JDK 17, NDK 27, CMake 3.22.1;
   ABIs `arm64-v8a` and `x86_64`), then upload artifact **learnharness-tablet-debug-apk**.
5. `emulator-smoke` job: API 34 x86_64 `google_apis` `pixel_tablet` emulator installs the APK, starts it,
   waits for the server to answer HTTP 200 (via `adb forward`), the WebView load, and the diagnostics line,
   takes landscape + portrait screenshots, and uploads **learnharness-tablet-smoke**
   (screenshots, `diagnostics.json`, `logcat.txt`). The job fails if the server never answers 200.

Local build (on a machine with the Android SDK/NDK): run steps 1-3 above, then
`cd android && ./gradlew assembleDebug`. The APK is large (~250 MB: two libnode copies plus the payload).

## Installing on a tablet (sideloading)

1. Download **learnharness-tablet-debug-apk** from the workflow run (Actions tab -> run -> Artifacts)
   and unzip it to get `app-debug.apk`.
2. Copy it to the tablet (USB, cloud drive, or `adb install -r app-debug.apk`).
3. Open it in a file manager. When prompted, allow **Install unknown apps** for that file manager
   (Settings -> Apps -> Special access -> Install unknown apps; on Huawei/HarmonyOS it may also ask to
   turn off "Pure mode" or confirm an install-risk dialog).
4. Allow notifications when asked (needed for the persistent "LearnHarness is running" notification;
   the app still works if you decline).
5. The first launch unpacks ~160 MB and can take a minute; later launches take a few seconds.
   If you see "System WebView needs an update", update Android System WebView / Chrome.

## Known limitations (step 1)

* Debug-signed APK only; no release signing, no auto-update.
* Desktop-only features do not exist on Android: Claude Code CLI provider, browser-service / HTML demo
  rendering (no `child_process`, no Chromium helper), Electron IPC bridges, dictation.
* The settings/setup UI is still the desktop one (API-key rows, Copilot/Grok rows, etc.). Hiding
  non-ChatGPT providers, touch/tablet layout work, and a ChatGPT sign-in via Custom Tab are later steps.
* No access guard yet: any app on the device can reach `127.0.0.1:PORT` (step 2 adds a cookie guard).
* Native addons (`@napi-rs/canvas`, `@resvg/resvg-js`) are prebuilt `android-arm64` binaries that do not
  link `libnode.so` and (resvg) are 4 KB-aligned. Whether they load is exactly what the diagnostics spike
  measures; the app works without them (PDF page rendering / SVG rasterisation will fail lazily).
* Android may kill the process under memory pressure; there is no in-process Node restart.
* `x86_64` is shipped only so the CI emulator can run the app; real devices use `arm64-v8a`.

## Render service (step 5: demo verification)

Android has no Chrome/CDP, so sub-agent demo verification (`run_demo`) runs in an offscreen system
WebView owned by the Kotlin shell.

* `RenderService.kt`: hand-rolled HTTP/1.1 server on `127.0.0.1:<random port>`, started by `NodeService`
  **before** Node. Node gets `LH_ANDROID_RENDER_URL` and `LH_ANDROID_RENDER_TOKEN` (random 256-bit hex).
  Every request needs `Authorization: Bearer <token>` (401 otherwise). Only `POST`, JSON bodies up to 16 MB.
  Jobs run one at a time.
* `OffscreenWebView.kt`: one throwaway WebView per job with a real fixed layout (CSS viewport = width x height),
  placed behind the UI with alpha 0.01 when the activity is resumed (`RenderHost`, set in `MainActivity.onResume`),
  always destroyed, with hard timeouts.
* `POST /demo` `{html | url, settleMs=2000, probe?, width=1024, height=768, screenshot?}` returns JSON
  `{consoleErrors[], pageErrors[], failedRequests[], probeResult?, ok, screenshotPng? (base64)}`.
  HTML loads with base URL `https://learnharness-demo.invalid/`. "Uncaught ..." console errors (exceptions and
  unhandled rejections) go to `pageErrors`, other console errors to `consoleErrors`; subresource load errors and
  HTTP >= 400 go to `failedRequests`. The probe is evaluated after settle (global eval, promises awaited, 10 s cap).
* `POST /svg` `{svg, width=900, height=700}` returns `image/png` (white page, WebView draw into a Bitmap).
  Node uses it only when resvg fails.
* Errors: non-200 with `{"error": "..."}`.
* Node client: `src/agent/subagents/headless-android.ts`; `getHeadless()` returns it when `LH_ANDROID=1` and both
  env vars exist (`available()` is then always true). PDF pages still use pdfjs + canvas.
