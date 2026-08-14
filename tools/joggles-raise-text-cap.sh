#!/usr/bin/env bash
# One-shot: raise the Funky Glasses+ 40-character text input cap.
#
#   chmod +x joggles-raise-text-cap.sh
#   ./joggles-raise-text-cap.sh
#
# Pulls the app off the phone, finds the cap, raises it, rebuilds, resigns and
# installs. Needs a JDK and adb; fetches apktool and uber-apk-signer itself, so
# no Android SDK.
#
# Deliberately self-contained: it duplicates tools/patch_apk.sh and
# tools/raise_text_cap.sh so it can be downloaded on its own and run on a
# machine that has no clone of this repo. See notes/apk-patching.md.
#
# The cap is app-side, not firmware-side. research/vendor-app-protocol.md has
# "Text input: 40 half-width units, an app-side UI cap" as verified, against a
# device that scrolls ~200 uploaded columns unattended.
set -uo pipefail

PKG="com.pinkysinyeeho.funkyglassesplus"
CAP=200
WORK="./joggles-patch-work"
APK_IN=""
DO_INSTALL=1
LOCATE_ONLY=0
ASSUME_YES=0

APKTOOL_VER="2.12.0"
SIGNER_VER="1.3.0"

usage() {
  cat <<'EOF'
Usage: ./joggles-raise-text-cap.sh [options]

  --cap N          raise the cap to N (default 200, max 32767)
  --apk FILE       patch this APK file instead of pulling from a phone
  --pkg NAME       package name (default com.pinkysinyeeho.funkyglassesplus)
  --locate-only    report the cap sites and stop, change nothing
  --no-install     build and sign, but do not touch the phone
  --yes            do not prompt before uninstalling the store build
  --workdir DIR    scratch directory (default ./joggles-patch-work)

Needs: a JDK (21 tested), and adb unless --apk and --no-install are both used.
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --cap) CAP="${2:-}"; shift 2 ;;
    --apk) APK_IN="${2:-}"; shift 2 ;;
    --pkg) PKG="${2:-}"; shift 2 ;;
    --workdir) WORK="${2:-}"; shift 2 ;;
    --locate-only) LOCATE_ONLY=1; shift ;;
    --no-install) DO_INSTALL=0; shift ;;
    --yes) ASSUME_YES=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1"; usage; exit 1 ;;
  esac
done

die() { echo; echo "!!! $*"; exit 1; }
step() { echo; echo "=== $* ==="; }

# 40 is const/16 <reg>, 0x28 in smali: const/4 tops out at 7. Any replacement up
# to 32767 also fits const/16, so the instruction width is unchanged and no
# registers move.
case "$CAP" in *[!0-9]*|"") die "--cap must be a number";; esac
[ "$CAP" -ge 1 ] && [ "$CAP" -le 32767 ] || die "--cap must be 1..32767 to stay inside const/16"
NEW_HEX=$(printf '0x%x' "$CAP")
OLD_HEX="0x28"

BIN="$WORK/bin"
DEC="$WORK/decoded"
OUTAPK="$WORK/out"
mkdir -p "$BIN" "$OUTAPK" || die "Cannot create $WORK"

need_adb() {
  command -v adb >/dev/null 2>&1 || die "adb not on PATH. Install platform-tools, or use --apk FILE --no-install"
  adb get-state >/dev/null 2>&1 || die "No phone in 'device' state. Enable USB debugging and accept the prompt, then rerun."
}

step "Checking prerequisites"
command -v java >/dev/null 2>&1 || die "No JDK on PATH. Install one (21 is tested) and rerun."
java -version 2>&1 | grep -v "^Picked up" | head -1
if [ -z "$APK_IN" ] || [ "$DO_INSTALL" -eq 1 ]; then need_adb; fi

step "Fetching tools"
# apktool bundles aapt2 and uber-apk-signer bundles zipalign, which is why no
# Android SDK is needed.
APKTOOL="$BIN/apktool.jar"
SIGNER="$BIN/uber-apk-signer.jar"
if [ ! -f "$APKTOOL" ]; then
  echo "apktool $APKTOOL_VER"
  curl -sfL -o "$APKTOOL" \
    "https://github.com/iBotPeaches/Apktool/releases/download/v${APKTOOL_VER}/apktool_${APKTOOL_VER}.jar" \
    || die "apktool download failed"
else echo "apktool cached"; fi
if [ ! -f "$SIGNER" ]; then
  echo "uber-apk-signer $SIGNER_VER"
  curl -sfL -o "$SIGNER" \
    "https://github.com/patrickfav/uber-apk-signer/releases/download/v${SIGNER_VER}/uber-apk-signer-${SIGNER_VER}.jar" \
    || die "signer download failed"
else echo "signer cached"; fi

# Never hide a failure behind `| tail -n`: the line naming the cause sits above
# the window, so a broken run reports a help screen instead of a reason.
LOG="$WORK/last-run.log"
run_java() {
  java "$@" 2>&1 | grep -v '^Picked up JAVA_TOOL_OPTIONS' | tee "$LOG" >/dev/null
  local rc="${PIPESTATUS[0]}"
  [ "$rc" -eq 0 ] || {
    echo "--- error lines ---"
    grep -iE 'error|exception|invalid|unrecognized|cannot|failed|no such' "$LOG" | head -20
    echo "--- full log: $LOG ---"
  }
  return "$rc"
}

# ---------------------------------------------------------------- get the APK
# Splits are tracked by filename on disk rather than in a bash array: macOS
# ships bash 3.2, where empty arrays under `set -u` are a minefield.
SPLIT_COUNT=0
if [ -n "$APK_IN" ]; then
  step "Using $APK_IN"
  [ -f "$APK_IN" ] || die "No such file: $APK_IN"
  BASE="$WORK/base.apk"
  cp "$APK_IN" "$BASE" || die "Could not copy $APK_IN"
else
  step "Pulling $PKG off the phone"
  PATHS=$(adb shell pm path "$PKG" | sed 's/^package://' | tr -d '\r' | grep -v '^$')
  [ -n "$PATHS" ] || die "$PKG is not installed on this phone. Check: adb shell pm list packages -3 | grep -i glass"
  BASE=""
  i=0
  while IFS= read -r remote; do
    [ -z "$remote" ] && continue
    case "$remote" in
      *"/base.apk") local_name="$WORK/base.apk" ;;
      *) local_name="$WORK/split_$(basename "$remote")" ;;
    esac
    # First path is base when nothing is named base.apk (older platforms).
    if [ "$i" -eq 0 ] && [ "$local_name" != "$WORK/base.apk" ] && ! echo "$PATHS" | grep -q '/base.apk$'; then
      local_name="$WORK/base.apk"
    fi
    echo "  $remote"
    adb pull "$remote" "$local_name" >/dev/null 2>&1 || die "adb pull failed for $remote"
    if [ "$local_name" = "$WORK/base.apk" ]; then
      BASE="$local_name"
    else
      SPLIT_COUNT=$((SPLIT_COUNT + 1))
    fi
    i=$((i + 1))
  done <<< "$PATHS"
  [ -n "$BASE" ] || die "No base APK among the pulled paths"
  if [ "$SPLIT_COUNT" -gt 0 ]; then
    echo
    echo "This is a SPLIT install: $SPLIT_COUNT split(s) beside the base."
    echo "All of them get resigned with the same key and installed as a set."
  else
    echo "Single APK, no splits."
  fi
fi
ls -lh "$BASE" | awk '{print "  base: "$5}'

# ------------------------------------------------------------------- decode
step "Decoding the base APK"
rm -rf "$DEC"
run_java -jar "$APKTOOL" d -f -o "$DEC" "$BASE" || die "Decode failed. This app may resist apktool; the log above says why."
[ -d "$DEC" ] || die "Decode produced no tree"
echo "  $(find "$DEC" -name '*.smali' | wc -l | tr -d ' ') smali files"

# ------------------------------------------------------------------- locate
step "Looking for the $CAP-unit cap (currently 40 / $OLD_HEX)"
FOUND=0

echo "-- A. android:maxLength=\"40\" in res/"
RES_HITS=$(grep -rln 'android:maxLength="40"' "$DEC/res" 2>/dev/null || true)
if [ -n "$RES_HITS" ]; then echo "$RES_HITS" | sed 's|^|   |'; FOUND=1; else echo "   none"; fi

echo "-- B. const/16 0x28 feeding an InputFilter\$LengthFilter"
# Matched by register, not proximity: take the argument register from the
# LengthFilter <init> and find the const/16 that last loaded it. Proximity alone
# flags any unrelated 0x28 a few lines above, and sed would rewrite that instead.
# FNR not NR: find hands many files to one awk and NR counts across all of them.
LF_HITS=$(find "$DEC" -name '*.smali' -exec awk -v hex="$OLD_HEX" '
  FNR == 1 { split("", cl) }
  $0 ~ ("const/16 [vp][0-9]+, " hex "$") { r = $2; sub(/,$/, "", r); cl[r] = FNR }
  /LengthFilter;-><init>\(I\)V/ {
    if (match($0, /\{[^}]*\}/)) {
      inner = substr($0, RSTART + 1, RLENGTH - 2)
      n = split(inner, a, /, */); arg = a[n]
      if (arg in cl && FNR - cl[arg] <= 8) print FILENAME ":" cl[arg]
    }
  }
' {} + 2>/dev/null || true)
if [ -n "$LF_HITS" ]; then echo "$LF_HITS" | sed 's|^|   |'; FOUND=1; else echo "   none"; fi

echo "-- C. leads, not changed automatically"
INT_HITS=$(grep -rn '>40<' "$DEC/res/values/integers.xml" 2>/dev/null || true)
[ -n "$INT_HITS" ] && echo "$INT_HITS" | sed 's|^|   integers.xml |'
LEADS=$(find "$DEC" -name '*.smali' \
  \( -iname '*text*' -o -iname '*input*' -o -iname '*edit*' -o -iname '*diy*' \
     -o -iname '*custom*' -o -iname '*scroll*' -o -iname '*marquee*' \) \
  -exec grep -ln "const/16 v[0-9]*, $OLD_HEX" {} + 2>/dev/null | head -15 || true)
[ -n "$LEADS" ] && echo "$LEADS" | sed 's|^|   |'
[ -z "$INT_HITS" ] && [ -z "$LEADS" ] && echo "   none"

if [ "$FOUND" -eq 0 ]; then
  cat <<EOF

No high-confidence site found, so nothing was changed.

The cap may be a plain length comparison or a half-width counting loop rather
than a filter. CJK counting as 2 units means such a loop very likely exists.
Next steps, in order:
  1. Read section C above.
  2. Decompile to Java and grep there, where the check is readable:
       jadx --no-debug-info -d jadx-out "$BASE"
       grep -rn '40' jadx-out/sources --include=*.java | grep -iE 'length|limit|max'
  3. Send me the matching method and I will write the smali.

Decoded tree kept at $DEC
EOF
  exit 1
fi

if [ "$LOCATE_ONLY" -eq 1 ]; then
  echo; echo "Locate only, nothing changed. Rerun without --locate-only to patch."
  exit 0
fi

# -------------------------------------------------------------------- patch
step "Raising the cap to $CAP"
cp -r "$DEC" "${DEC}.orig" 2>/dev/null || true
CHANGED=0
if [ -n "$RES_HITS" ]; then
  while IFS= read -r f; do
    [ -z "$f" ] && continue
    sed -i.bak "s|android:maxLength=\"40\"|android:maxLength=\"$CAP\"|g" "$f" && rm -f "${f}.bak"
    echo "  res   $f"
    CHANGED=$((CHANGED + 1))
  done <<< "$RES_HITS"
fi
if [ -n "$LF_HITS" ]; then
  while IFS= read -r hit; do
    [ -z "$hit" ] && continue
    f="${hit%:*}"; n="${hit##*:}"
    # Anchored to the exact matched line, so no other 0x28 in the file moves.
    sed -i.bak "${n}s|, $OLD_HEX|, $NEW_HEX|" "$f" && rm -f "${f}.bak"
    echo "  smali $f:$n"
    CHANGED=$((CHANGED + 1))
  done <<< "$LF_HITS"
fi
[ "$CHANGED" -gt 0 ] || die "Nothing was rewritten despite candidates being found"
echo "  $CHANGED site(s) changed"

# Self-check: prove the edit landed rather than trusting sed's exit code.
if [ -n "$LF_HITS" ]; then
  while IFS= read -r hit; do
    [ -z "$hit" ] && continue
    f="${hit%:*}"; n="${hit##*:}"
    sed -n "${n}p" "$f" | grep -q "$NEW_HEX" || die "Edit did not land at $f:$n"
  done <<< "$LF_HITS"
fi

# --------------------------------------------------------------------- build
step "Rebuilding"
UNSIGNED="$OUTAPK/base.apk"
rm -f "$OUTAPK"/*.apk "$OUTAPK"/*.idsig
# aapt2 is unconditional in apktool 2.12.0. There is no --use-aapt2 flag; the
# opt-out is --use-aapt1. Passing --use-aapt2 makes apktool print usage and exit.
run_java -jar "$APKTOOL" b -o "$UNSIGNED" "$DEC" || die "Rebuild failed. See the error lines above."
[ -f "$UNSIGNED" ] || die "Rebuild reported success but produced no APK"
echo "  built $(ls -lh "$UNSIGNED" | awk '{print $5}')"

# Splits are not patched, only resigned, and with the same key as the base or
# the install is rejected as inconsistent.
if [ "$SPLIT_COUNT" -gt 0 ]; then
  cp "$WORK"/split_*.apk "$OUTAPK"/ 2>/dev/null || die "Could not stage splits for signing"
fi

step "Signing"
# One invocation over the whole directory, so base and splits share a key.
# Debug key, embedded in the signer. v1+v2+v3: a v1-only signature is refused
# from Android 11 on.
run_java -jar "$SIGNER" -a "$OUTAPK" --allowResign --overwrite || die "Signing failed"
grep -E 'signature verified|Successfully processed' "$LOG" | tail -3
grep -q 'signature verified' "$LOG" || die "APK did not verify after signing"
rm -f "$OUTAPK"/*.idsig

# ------------------------------------------------------------------- artefact
PATCHFILE="$WORK/${PKG}.patch"
if [ -d "${DEC}.orig" ]; then
  # apktool writes build/ and dist/ inside the tree, and this diff runs after the
  # rebuild, so they are present on one side only. Left in, they add ~1175 lines
  # of compiled aapt2 output that diff -N reports as "Binary files differ" rather
  # than as additions. They are disposable; the next build regenerates them.
  rm -rf "${DEC}/build" "${DEC}/dist" "${DEC}.orig/build" "${DEC}.orig/dist"
  # Headers normalised to a/ and b/ with mtimes stripped, so patch -p1 inside
  # the decoded tree is exact and the file does not churn between runs.
  # A literal tab, not \t: BSD sed on macOS does not expand \t in a regex, so
  # the mtime stripping would silently do nothing there.
  TAB=$(printf '\t')
  diff -ruN -x '*.png' -x '*.jpg' -x '*.arsc' -x '*.dex' -x '*.so' \
    "${DEC}.orig" "$DEC" 2>/dev/null \
    | sed -E -e "s|^--- ${DEC}\.orig/([^${TAB}]*)${TAB}.*$|--- a/\1|" \
             -e "s|^\+\+\+ ${DEC}/([^${TAB}]*)${TAB}.*$|+++ b/\1|" \
             -e "s|^diff (.*) ${DEC}\.orig/(.*) ${DEC}/(.*)$|diff \1 a/\2 b/\3|" \
    > "$PATCHFILE" || true
fi

# -------------------------------------------------------------------- install
if [ "$DO_INSTALL" -eq 0 ]; then
  step "Done, not installing"
  ls -lh "$OUTAPK"/*.apk
  echo
  echo "Install by hand:"
  if [ "$SPLIT_COUNT" -gt 0 ]; then
    echo "  adb uninstall $PKG && adb install-multiple $OUTAPK/*.apk"
  else
    echo "  adb uninstall $PKG && adb install $OUTAPK/base.apk"
  fi
  exit 0
fi

step "Installing"
cat <<EOF
Resigning changes the signature, so this cannot upgrade over the store build.
The store copy has to be uninstalled first, and that CLEARS THE APP'S DATA.

Anything saved on the glasses themselves survives: the device store is separate
from the app. Anything saved only inside the app is lost.
EOF
if [ "$ASSUME_YES" -eq 0 ]; then
  printf '\nUninstall %s and install the patched build? [y/N] ' "$PKG"
  read -r reply
  case "$reply" in
    y|Y|yes|YES) ;;
    *) echo "Stopped. The signed APKs are in $OUTAPK if you want them later."; exit 0 ;;
  esac
fi

echo "Closing the app so it releases the BLE connection..."
adb shell am force-stop "$PKG" >/dev/null 2>&1 || true
adb uninstall "$PKG" >/dev/null 2>&1 || echo "  (was not installed)"
if [ "$SPLIT_COUNT" -gt 0 ]; then
  adb install-multiple "$OUTAPK"/*.apk || die "install-multiple failed. Every split must be signed with the same key; try: adb install-multiple -r $OUTAPK/*.apk"
else
  adb install "$OUTAPK/base.apk" || die "install failed. See the adb output above."
fi

step "Installed"
cat <<EOF
Open the app and type into the text field. It should now accept $CAP units
instead of 40.

If it still stops at 40, the cap is enforced in more than one place. Rerun with
--locate-only and read section C: a wider field is not the same as a wider
upload, since the app rasterises phone-side.

One BLE connection at a time. The app and 'bun cli' cannot both hold the
glasses, so close the app before running the CLI.

Artefacts:
  signed APK(s)   $OUTAPK/
  decoded tree    $DEC/
  patch to commit $PATCHFILE
EOF
