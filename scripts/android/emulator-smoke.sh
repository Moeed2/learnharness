#!/usr/bin/env bash
# Emulator smoke test, run INSIDE reactivecircus/android-emulator-runner
# (one `script:` line: `bash scripts/android/emulator-smoke.sh <apk> <outdir>`).
#
# Installs the debug APK, starts the app, waits for (1) the server port
# (LH_PORT in logcat), (2) HTTP 200 through `adb forward`, (3) the WebView
# finishing its load (LH_WEBVIEW_LOADED) and (4) LH_DIAGNOSTICS, then takes
# landscape + portrait screenshots. Exits non-zero if the server never answers.
set -uo pipefail

apk="${1:?usage: emulator-smoke.sh <apk> <outdir>}"
out="${2:?usage: emulator-smoke.sh <apk> <outdir>}"
timeout_s="${SMOKE_TIMEOUT_S:-300}"
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
pkg="$(sed -n 's/^lh.applicationId=//p' "$root/android/gradle.properties" | tr -d '\r')"
activity="ai.learnharness.tablet.MainActivity"
mkdir -p "$out"

adb logcat -c || true
adb install -r -g "$apk" || { echo "install failed"; exit 1; }
adb shell settings put system accelerometer_rotation 0 || true
adb shell settings put system user_rotation 1 || true   # landscape first
adb shell am start -W -n "$pkg/$activity" || { echo "start failed"; exit 1; }

shot() { adb exec-out screencap -p > "$out/$1.png" || true; }
finish() {
  adb logcat -d > "$out/logcat.txt" 2>&1 || true
  adb shell run-as "$pkg" cat files/diagnostics.json > "$out/diagnostics.json" 2>/dev/null || true
}
fail() { echo "SMOKE FAILED: $*"; shot failure; finish; exit 1; }

port="" http="" loaded="" diag=""
deadline=$((SECONDS + timeout_s))
while (( SECONDS < deadline )); do
  log="$(adb logcat -d 2>/dev/null)"
  [[ -z "$port" ]] && port="$(grep -o 'LH_PORT [0-9]*' <<<"$log" | tail -1 | cut -d' ' -f2)"
  if [[ -n "$port" && -z "$http" ]]; then
    adb forward "tcp:18080" "tcp:$port" >/dev/null
    code="$(curl -s -m 10 -o /dev/null -w '%{http_code}' http://127.0.0.1:18080/ || true)"
    echo "t+${SECONDS}s port=$port http=$code"
    [[ "$code" == 200 ]] && http=1
  fi
  [[ -z "$loaded" ]] && grep -q 'LH_WEBVIEW_LOADED' <<<"$log" && loaded=1
  [[ -z "$diag" ]] && grep -q 'LH_DIAGNOSTICS' <<<"$log" && diag=1
  grep -q 'FATAL EXCEPTION' <<<"$log" && fail "app crashed"
  [[ -n "$http" && -n "$loaded" && -n "$diag" ]] && break
  sleep 3
done

shot landscape
adb shell settings put system user_rotation 0 || true
sleep 5
shot portrait
finish

echo "port=${port:-none} http200=${http:-no} webview_loaded=${loaded:-no} diagnostics=${diag:-no}"
grep -h 'LH_DIAGNOSTICS' "$out/logcat.txt" | tail -1 | cut -c1-3000 || true
[[ -n "$http" ]] || { echo "SMOKE FAILED: server never answered 200"; exit 1; }
[[ -n "$loaded" ]] || echo "WARNING: WebView load marker not seen"
[[ -n "$diag" ]] || echo "WARNING: diagnostics line not seen"
exit 0
