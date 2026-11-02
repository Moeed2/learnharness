#!/usr/bin/env bash
# Fetch nodejs-mobile (digidem fork) libnode.so + headers for Android and lay
# them out for CMake / Gradle:
#
#   android/libnode/bin/<abi>/libnode.so      (arm64-v8a, x86_64)
#   android/libnode/include/node/node.h ...   (headers)
#
# Usage:
#   scripts/android/fetch-libnode.sh                 # resolve asset via `gh`
#   LIBNODE_URL=https://.../asset.zip scripts/android/fetch-libnode.sh
#   LIBNODE_ASSET=<exact asset name>   scripts/android/fetch-libnode.sh
#
# Env:
#   LIBNODE_TAG      release tag            (default v24.20.0-0)
#   LIBNODE_REPO     GitHub repo            (default digidem/nodejs-mobile)
#   LIBNODE_ASSET    exact asset name to use (skips pattern matching)
#   LIBNODE_FLAVOR   full | lite            (default full)
#   LIBNODE_URL      direct download URL (skips `gh`)
#   LIBNODE_SHA256   expected sha256 of the downloaded archive (overrides the pin below)
#
# The exact asset names were not known when this was written (api.github.com
# was unreachable during research), so the asset is matched by pattern
# (*android*, flavor, *.zip) and, on any ambiguity/failure, the available
# assets are printed.
set -euo pipefail

TAG="${LIBNODE_TAG:-v24.20.0-0}"
REPO="${LIBNODE_REPO:-digidem/nodejs-mobile}"
FLAVOR="${LIBNODE_FLAVOR:-full}"
ABIS=(arm64-v8a x86_64)

# Pinned release asset for the default tag (verified 2026-11-02 against the
# GitHub release digest). Override with LIBNODE_URL/LIBNODE_SHA256 for other tags.
PINNED_ASSET="nodejs-mobile-android-24.20.0-0.zip"
PINNED_SHA256=""
if [[ "$TAG" == "v24.20.0-0" && "$FLAVOR" == full ]]; then
  PINNED_SHA256="f5ffbaf4f2679fa9180b0758c637c2f8fc8828300f95129badf213a028fb37bb"
  if [[ -z "${LIBNODE_URL:-}" && -z "${LIBNODE_ASSET:-}" ]]; then
    LIBNODE_URL="https://github.com/$REPO/releases/download/$TAG/$PINNED_ASSET"
  fi
fi

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
out="$(cd "$here/../../android" && pwd)/libnode"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

list_assets() {
  gh release view "$TAG" -R "$REPO" --json assets --jq '.assets[] | "\(.name)\t\(.size)\t\(.url)"' 2>&1 || true
}

archive=""
if [[ -n "${LIBNODE_URL:-}" ]]; then
  archive="$work/libnode.zip"
  echo "Downloading $LIBNODE_URL"
  curl -fL --retry 3 -o "$archive" "$LIBNODE_URL"
else
  command -v gh >/dev/null || { echo "gh CLI not found; set LIBNODE_URL instead" >&2; exit 1; }
  asset="${LIBNODE_ASSET:-}"
  if [[ -z "$asset" ]]; then
    mapfile -t matches < <(gh release view "$TAG" -R "$REPO" --json assets --jq '.assets[].name' \
      | grep -i 'android' | grep -i '\.zip$' | { if [[ "$FLAVOR" == lite ]]; then grep -i lite; else grep -vi lite; fi; } || true)
    if [[ ${#matches[@]} -ne 1 ]]; then
      echo "ERROR: expected exactly one Android $FLAVOR .zip asset in $REPO $TAG, found ${#matches[@]}." >&2
      echo "Available assets (name, size, url):" >&2
      list_assets >&2
      echo "Re-run with LIBNODE_ASSET=<name> or LIBNODE_URL=<url>." >&2
      exit 1
    fi
    asset="${matches[0]}"
  fi
  echo "Downloading $REPO $TAG asset: $asset"
  if ! gh release download "$TAG" -R "$REPO" -p "$asset" -D "$work" --clobber; then
    echo "ERROR: download failed. Available assets:" >&2
    list_assets >&2
    exit 1
  fi
  archive="$work/$asset"
fi

computed="$(sha256sum "$archive" | cut -d' ' -f1)"
echo "computed sha256: $computed  ($(basename "$archive"))"
expected="${LIBNODE_SHA256:-$PINNED_SHA256}"
if [[ -n "$expected" ]]; then
  if [[ "$computed" != "$expected" ]]; then
    echo "ERROR: sha256 mismatch (expected $expected)" >&2
    exit 1
  fi
  echo "sha256 verified"
else
  echo "WARNING: no pinned sha256 (see TODO(pin) in this script); archive integrity not enforced"
fi

# Unpack (the archive may itself contain nested zips).
ex="$work/ex"
mkdir -p "$ex"
unzip -q "$archive" -d "$ex"
while IFS= read -r nested; do
  unzip -q -o "$nested" -d "${nested%.zip}.d"
done < <(find "$ex" -name '*.zip' -type f)

rm -rf "$out"
mkdir -p "$out/bin"

# Place each libnode.so under bin/<abi>, detecting the ABI from the ELF header
# (robust against any directory naming inside the archive).
found=0
while IFS= read -r so; do
  machine="$(readelf -h "$so" | awk -F: '/Machine:/ {gsub(/^[ \t]+/,"",$2); print $2}')"
  case "$machine" in
    AArch64) abi=arm64-v8a ;;
    *X86-64*|*x86-64*) abi=x86_64 ;;
    ARM) abi=armeabi-v7a ;;
    *) echo "skipping $so (machine: $machine)"; continue ;;
  esac
  mkdir -p "$out/bin/$abi"
  cp "$so" "$out/bin/$abi/libnode.so"
  echo "libnode.so -> bin/$abi ($(du -h "$so" | cut -f1), $so)"
  found=$((found + 1))
done < <(find "$ex" -name 'libnode.so' -type f)

for abi in "${ABIS[@]}"; do
  [[ -f "$out/bin/$abi/libnode.so" ]] || { echo "ERROR: libnode.so for $abi not found in archive. Contents:" >&2; (cd "$ex" && find . -type f | head -100) >&2; exit 1; }
done

# Headers: the directory that contains node.h (and v8.h, uv.h ...).
nodeh="$(find "$ex" -name node.h -type f -print -quit)"
[[ -n "$nodeh" ]] || { echo "ERROR: node.h not found in archive" >&2; exit 1; }
mkdir -p "$out/include/node"
cp -R "$(dirname "$nodeh")/." "$out/include/node/"
[[ -f "$out/include/node/node.h" ]] || { echo "ERROR: header layout unexpected" >&2; exit 1; }

# Report 16 KB alignment of what we got (informational).
for abi in "${ABIS[@]}"; do
  readelf -lW "$out/bin/$abi/libnode.so" | awk -v a="$abi" '/LOAD/ {print a ": LOAD align " $NF}' | sort -u
done
echo "libnode ready in $out"
