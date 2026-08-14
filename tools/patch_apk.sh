#!/usr/bin/env bash
# Decode, patch and re-sign the vendor APK.
#
# Two steps, because the edit happens in between:
#   tools/patch_apk.sh decode <package.name>   -> patched/<pkg>/ smali + res
#   ...edit smali by hand...
#   tools/patch_apk.sh build  <package.name>   -> apk/<pkg>.patched.apk
#
# Everything it produces is gitignored. The committable artefact is the diff
# over patched/, not the binary: see notes/apk-patching.md.
set -uo pipefail

cd "$(dirname "$0")/.."

BIN="tools/bin"
APKTOOL_VER="2.12.0"
SIGNER_VER="1.3.0"
APKTOOL="$BIN/apktool.jar"
SIGNER="$BIN/uber-apk-signer.jar"

usage() {
  cat <<'EOF'
Usage: tools/patch_apk.sh <decode|build|diff> <package.name>

  decode   apk/<pkg>.apk        -> patched/<pkg>/
  build    patched/<pkg>/       -> apk/<pkg>.patched.apk   (zipaligned, signed)
  diff     patched/<pkg>/ vs a pristine decode -> patches/<pkg>.patch

Get the APK first with tools/android_pull.sh, or export it on-device.
For readable Java to find your target, use tools/decompile.sh (jadx). Patch
against the smali under patched/, not the jadx output: jadx output does not
recompile.
EOF
}

need_tools() {
  mkdir -p "$BIN"
  # apktool ships its own aapt2, and uber-apk-signer its own zipalign, so
  # neither needs the Android SDK. Both are fetched from GitHub releases.
  if [ ! -f "$APKTOOL" ]; then
    echo "Fetching apktool $APKTOOL_VER"
    curl -sfL -o "$APKTOOL" \
      "https://github.com/iBotPeaches/Apktool/releases/download/v${APKTOOL_VER}/apktool_${APKTOOL_VER}.jar" \
      || { echo "apktool download failed"; exit 1; }
  fi
  if [ ! -f "$SIGNER" ]; then
    echo "Fetching uber-apk-signer $SIGNER_VER"
    curl -sfL -o "$SIGNER" \
      "https://github.com/patrickfav/uber-apk-signer/releases/download/v${SIGNER_VER}/uber-apk-signer-${SIGNER_VER}.jar" \
      || { echo "signer download failed"; exit 1; }
  fi
  java -version >/dev/null 2>&1 || { echo "No JDK on PATH."; exit 1; }
}

[ $# -eq 2 ] || { usage; exit 1; }
CMD="$1"
PKG="$2"
APK="apk/${PKG}.apk"
OUT="patched/${PKG}"

need_tools

case "$CMD" in

decode)
  [ -f "$APK" ] || { echo "Missing $APK - run tools/android_pull.sh $PKG"; exit 1; }
  # Keep a pristine copy alongside so 'diff' has something to compare against.
  # Without it there is no way to produce a reviewable patch later.
  echo "=== Decoding $APK ==="
  rm -rf "$OUT" "${OUT}.orig"
  java -jar "$APKTOOL" d -f -o "$OUT" "$APK" 2>&1 | tail -5 || exit 1
  cp -r "$OUT" "${OUT}.orig"
  echo
  echo "Decoded to $OUT"
  echo "Pristine copy at ${OUT}.orig (used by 'diff', do not edit)"
  echo "Edit the smali, then: tools/patch_apk.sh build $PKG"
  ;;

build)
  [ -d "$OUT" ] || { echo "Missing $OUT - run 'decode' first"; exit 1; }
  echo "=== Building ==="
  UNSIGNED="apk/${PKG}.unsigned.apk"
  # --use-aapt2 is the default from 2.9 on, stated here so a version bump does
  # not silently change the resource compiler under us.
  java -jar "$APKTOOL" b --use-aapt2 -o "$UNSIGNED" "$OUT" 2>&1 | tail -15 || exit 1
  [ -f "$UNSIGNED" ] || { echo "Build produced no APK"; exit 1; }

  echo
  echo "=== Signing ==="
  # Debug key, auto-generated on first run. v1+v2+v3: a v1-only signature
  # (what plain jarsigner gives) is refused at install on Android 11+.
  java -jar "$SIGNER" -a "$UNSIGNED" --allowResign --overwrite 2>&1 | tail -8
  mv "$UNSIGNED" "apk/${PKG}.patched.apk" 2>/dev/null

  echo
  ls -lh apk/${PKG}.patched.apk 2>/dev/null
  cat <<EOF

Install: adb install -r apk/${PKG}.patched.apk

The signature has changed, so this will not upgrade over the store build.
Uninstall the original first. That clears its data, and any glasses content
saved only in the app is lost. The device keeps its own saved store.
EOF
  ;;

diff)
  [ -d "${OUT}.orig" ] || { echo "Missing ${OUT}.orig - run 'decode' first"; exit 1; }
  mkdir -p patches
  PATCH="patches/${PKG}.patch"
  # Binary resources would make the patch unreviewable and unappliable, so the
  # text tree only. Anything binary that must change gets described in notes.
  diff -ruN -x '*.png' -x '*.jpg' -x '*.arsc' -x '*.dex' -x '*.so' \
    "${OUT}.orig" "$OUT" > "$PATCH"
  if [ -s "$PATCH" ]; then
    echo "Wrote $PATCH ($(grep -c '^+++' "$PATCH") files changed)"
    echo "This is the committable artefact. The APK itself is not."
  else
    echo "No changes yet."
    rm -f "$PATCH"
  fi
  ;;

*)
  usage; exit 1 ;;
esac
