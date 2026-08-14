#!/usr/bin/env bash
# Decode, patch and re-sign the vendor APK.
#
# Four steps, because the edit happens in the middle:
#   tools/patch_apk.sh decode <package.name>   -> patched/<pkg>/ smali + res
#   ...edit smali by hand...
#   tools/patch_apk.sh build  <package.name>   -> apk/<pkg>.patched.apk
#   tools/patch_apk.sh diff   <package.name>   -> patches/<pkg>.patch
#   tools/patch_apk.sh apply  <package.name>   -> replay that patch onto a decode
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
LOG="$BIN/last-run.log"

# apktool writes its own intermediates into the project tree. They are
# regenerated on every build, and they are binary, so they must never reach a
# patch. Anchored at the top level: a smali package really called build/ is
# left alone.
INTERMEDIATES="build dist"

usage() {
  cat <<'EOF'
Usage: tools/patch_apk.sh <decode|build|diff|apply> <package.name>

  decode   apk/<pkg>.apk        -> patched/<pkg>/   (+ pristine .orig copy)
  build    patched/<pkg>/       -> apk/<pkg>.patched.apk   (zipaligned, signed)
  diff     patched/<pkg>/ vs the pristine copy -> patches/<pkg>.patch
  apply    patches/<pkg>.patch  -> onto a fresh patched/<pkg>/

Get the APK first with tools/android_pull.sh, or export it on-device.
For readable Java to find your target, use tools/decompile.sh (jadx). Patch
against the smali under patched/, not the jadx output: jadx output does not
recompile.
EOF
}

# java writes JAVA_TOOL_OPTIONS to stderr on every invocation in some
# environments, which buries the line that actually matters.
run_java() {
  java "$@" 2>&1 | grep -v '^Picked up JAVA_TOOL_OPTIONS' | tee "$LOG"
  return "${PIPESTATUS[0]}"
}

# Never hide the reason for a failure behind `| tail -n`. On success show the
# tail, on failure show the lines that mention the problem.
died() {
  echo
  echo "!!! $1"
  echo "--- last run, error lines ---"
  grep -iE 'error|exception|invalid|unrecognized|cannot|failed|no such' "$LOG" \
    | head -20 || true
  echo "--- full output: $LOG ---"
  exit 1
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

drop_intermediates() {
  for d in $INTERMEDIATES; do
    rm -rf "${1:?}/$d"
  done
}

[ $# -eq 2 ] || { usage; exit 1; }
CMD="$1"
PKG="$2"
APK="apk/${PKG}.apk"
OUT="patched/${PKG}"
PATCH="patches/${PKG}.patch"

need_tools

case "$CMD" in

decode)
  [ -f "$APK" ] || { echo "Missing $APK - run tools/android_pull.sh $PKG"; exit 1; }
  # Decoding blows away the tree, and with it any hand-edited smali. Hours of
  # work is not worth a silent rm -rf, so an existing tree has to be cleared
  # deliberately.
  if [ -d "$OUT" ]; then
    echo "$OUT already exists. Decoding would discard any edits in it."
    echo "Save your work (tools/patch_apk.sh diff $PKG), then:"
    echo "  rm -rf $OUT ${OUT}.orig && tools/patch_apk.sh decode $PKG"
    exit 1
  fi
  echo "=== Decoding $APK ==="
  rm -rf "${OUT}.orig"
  run_java -jar "$APKTOOL" d -f -o "$OUT" "$APK" || died "Decode failed"
  tail -5 "$LOG"
  [ -d "$OUT" ] || died "Decode produced no output tree"

  # Keep a pristine copy alongside so 'diff' has something to compare against.
  # Without it there is no way to produce a reviewable patch later. It doubles
  # the tree on disk: these decodes run to a few hundred MB.
  cp -r "$OUT" "${OUT}.orig"
  echo
  echo "Decoded to $OUT   ($(find "$OUT" -name '*.smali' | wc -l | tr -d ' ') smali files, $(du -sh "$OUT" | cut -f1))"
  echo "Pristine copy at ${OUT}.orig (used by 'diff', do not edit)"
  echo "Edit the smali, then: tools/patch_apk.sh build $PKG"
  ;;

build)
  [ -d "$OUT" ] || { echo "Missing $OUT - run 'decode' first"; exit 1; }
  echo "=== Building ==="
  UNSIGNED="apk/${PKG}.unsigned.apk"
  rm -f "$UNSIGNED"
  # aapt2 is unconditional in 2.12.0; the opt-out is --use-aapt1. There is no
  # --use-aapt2 flag any more, and passing it makes apktool print its usage
  # screen and exit non-zero.
  run_java -jar "$APKTOOL" b -o "$UNSIGNED" "$OUT" || died "Build failed"
  tail -6 "$LOG"
  [ -f "$UNSIGNED" ] || died "Build reported success but produced no APK"

  echo
  echo "=== Signing ==="
  # Debug key, auto-generated on first run. v1+v2+v3: a v1-only signature
  # (what plain jarsigner gives) is refused at install on Android 11+.
  run_java -jar "$SIGNER" -a "$UNSIGNED" --allowResign --overwrite \
    || died "Signing failed"
  grep -E 'zipalign|signature verified|Successfully processed' "$LOG" || true
  grep -q 'signature verified' "$LOG" || died "APK did not verify after signing"

  # --overwrite signs in place, so the signed bytes are already at $UNSIGNED.
  # It also drops a v4 .idsig next to it; carry it along rather than leave a
  # stale one pointing at bytes that no longer exist.
  SIGNED="apk/${PKG}.patched.apk"
  mv "$UNSIGNED" "$SIGNED" || died "Could not move signed APK into place"
  rm -f "${SIGNED}.idsig"
  [ -f "${UNSIGNED}.idsig" ] && mv "${UNSIGNED}.idsig" "${SIGNED}.idsig"

  echo
  ls -lh "$SIGNED"
  cat <<EOF

Install: adb install -r $SIGNED

The signature has changed, so this will not upgrade over the store build.
Uninstall the original first. That clears its data, and any glasses content
saved only in the app is lost. The device keeps its own saved store.

Split installs need every split signed with this same key and pushed together
with adb install-multiple. Patching base alone and installing it alone fails.
EOF
  ;;

diff)
  [ -d "${OUT}.orig" ] || { echo "Missing ${OUT}.orig - run 'decode' first"; exit 1; }
  mkdir -p patches
  # apktool's own build/ and dist/ appear inside the tree after a build. Left
  # in, they swamp the patch with compiled aapt2 output, and -N renders them
  # as "Binary files differ" rather than additions. They are disposable, so
  # clear them from both sides; the next build regenerates them.
  drop_intermediates "$OUT"
  drop_intermediates "${OUT}.orig"
  # Binary resources would make the patch unreviewable and unappliable, so the
  # text tree only. Anything binary that must change gets described in notes.
  diff -ruN -x '*.png' -x '*.jpg' -x '*.arsc' -x '*.dex' -x '*.so' \
    "${OUT}.orig" "$OUT" > "${PATCH}.raw"
  # Normalise the headers to a/ and b/ and drop the mtimes. Raw diff leaves
  # both tree names in every header, so which tree `patch` targets comes down
  # to its filename heuristic, and the timestamps churn on every re-diff. With
  # a/ and b/ the artefact is stable and `patch -p1` inside $OUT is exact.
  sed -E \
    -e "s|^diff (.*) ${OUT}\.orig/(.*) ${OUT}/(.*)$|diff \1 a/\2 b/\3|" \
    -e "s|^--- ${OUT}\.orig/([^\t]*)\t.*$|--- a/\1|" \
    -e "s|^\+\+\+ ${OUT}/([^\t]*)\t.*$|+++ b/\1|" \
    -e "s|^Binary files ${OUT}\.orig/(.*) and ${OUT}/(.*) differ$|Binary files a/\1 and b/\2 differ|" \
    -e "s|^Only in ${OUT}\.orig/|Only in a/|" \
    -e "s|^Only in ${OUT}/|Only in b/|" \
    "${PATCH}.raw" > "$PATCH"
  rm -f "${PATCH}.raw"
  if [ -s "$PATCH" ]; then
    # Count real file headers, and separately anything diff could only report
    # as binary. The old '^+++' count silently read 0 on a patch full of
    # binary noise.
    TEXT=$(grep -c '^+++ ' "$PATCH" || true)
    BIN=$(grep -c '^Binary files ' "$PATCH" || true)
    echo "Wrote $PATCH"
    echo "  $TEXT text files changed, $BIN binary, $(wc -l < "$PATCH" | tr -d ' ') lines"
    if [ "$BIN" -gt 0 ]; then
      echo "  WARNING: binary entries cannot be replayed by 'apply'."
      echo "  Describe them in notes/ or add them to the -x list above."
    fi
    echo "This is the committable artefact. The APK itself is not."
    echo "Check it replays: tools/patch_apk.sh apply $PKG"
  else
    echo "No changes yet."
    rm -f "$PATCH"
  fi
  ;;

apply)
  # A patch nobody has replayed is not yet an artefact. This reconstructs the
  # edit from patches/<pkg>.patch onto a pristine tree, which is what a reader
  # with their own copy of the APK has to be able to do.
  [ -f "$PATCH" ] || { echo "Missing $PATCH - run 'diff' first"; exit 1; }
  [ -d "${OUT}.orig" ] || { echo "Missing ${OUT}.orig - run 'decode' first"; exit 1; }
  drop_intermediates "$OUT"
  echo "=== Dry run ==="
  # -p1 strips the b/ prefix, so paths land directly inside $OUT.
  if ! patch -p1 -d "$OUT" --dry-run -f < "$PATCH"; then
    echo
    echo "!!! Patch does not apply cleanly to $OUT"
    echo "If the tree already carries the edit, replay onto a fresh decode:"
    echo "  rm -rf $OUT && cp -r ${OUT}.orig $OUT"
    exit 1
  fi
  echo
  echo "=== Applying ==="
  patch -p1 -d "$OUT" -f < "$PATCH" || { echo "Apply failed"; exit 1; }
  echo
  echo "Applied. Rebuild with: tools/patch_apk.sh build $PKG"
  ;;

*)
  usage; exit 1 ;;
esac
