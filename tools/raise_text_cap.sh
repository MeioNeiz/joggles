#!/usr/bin/env bash
# Find and raise the vendor app's 40-character text input cap.
#
#   tools/raise_text_cap.sh <package.name>              # locate only, no writes
#   tools/raise_text_cap.sh <package.name> --apply [N]   # raise it to N (default 200)
#
# The cap is app-side, not firmware-side: research/vendor-app-protocol.md has
# "Text input: 40 half-width units, an app-side UI cap" as verified, and the
# device is documented as scrolling ~200 uploaded columns unattended. So this is
# worth patching. See notes/apk-patching.md for the harness this builds on.
set -uo pipefail

cd "$(dirname "$0")/.."

PKG="${1:-}"
MODE="${2:-locate}"
NEWCAP="${3:-200}"

[ -n "$PKG" ] || {
  cat <<'EOF'
Usage: tools/raise_text_cap.sh <package.name> [--apply [newcap]]

  (no flag)          report every candidate site, change nothing
  --apply [newcap]   rewrite the high-confidence sites, default newcap 200

Needs apk/<pkg>.apk and a decode. Run tools/patch_apk.sh decode <pkg> first.
EOF
  exit 1
}

OUT="patched/${PKG}"
[ -d "$OUT" ] || { echo "Missing $OUT - run: tools/patch_apk.sh decode $PKG"; exit 1; }

# 40 half-width units is the documented cap. In smali it is const/16 <reg>, 0x28
# because const/4 tops out at 7. The replacement must also fit const/16, which
# holds a signed 16-bit value, so anything up to 32767 keeps the instruction
# width and no registers move.
OLD_HEX="0x28"
OLD_DEC=40
if [ "$NEWCAP" -lt 1 ] || [ "$NEWCAP" -gt 32767 ]; then
  echo "newcap must be 1..32767 to stay inside const/16"; exit 1
fi
NEW_HEX=$(printf '0x%x' "$NEWCAP")

echo "=== Target: raise a $OLD_DEC-unit cap to $NEWCAP ($OLD_HEX -> $NEW_HEX) ==="
echo

FOUND=0

# --- A. resource attribute -------------------------------------------------
# The cheapest form. If the cap is only here, no smali work is needed at all.
echo "--- A. android:maxLength=\"$OLD_DEC\" in res/ ---"
RES_HITS=$(grep -rln "android:maxLength=\"$OLD_DEC\"" "$OUT/res" 2>/dev/null || true)
if [ -n "$RES_HITS" ]; then
  echo "$RES_HITS" | sed "s|^|  |"
  FOUND=1
else
  echo "  none"
fi
echo

# --- B. InputFilter.LengthFilter(40) --------------------------------------
# The usual programmatic form. Matched by register, not by proximity: take the
# argument register from the LengthFilter <init> and find the const/16 that last
# loaded it. Proximity alone flags any unrelated 0x28 that happens to sit a few
# lines above, and sed would then rewrite the wrong constant.
# FNR, not NR: find passes many files to one awk, and NR keeps counting across
# them, so NR line numbers point into the wrong file entirely.
echo "--- B. const/16 $OLD_HEX feeding an InputFilter\$LengthFilter ---"
LF_HITS=$(find "$OUT" -name '*.smali' -exec awk -v hex="$OLD_HEX" '
  FNR == 1 { delete cl }
  $0 ~ ("const/16 [vp][0-9]+, " hex "$") {
    r = $2; sub(/,$/, "", r); cl[r] = FNR
  }
  /LengthFilter;-><init>\(I\)V/ {
    if (match($0, /\{[^}]*\}/)) {
      inner = substr($0, RSTART + 1, RLENGTH - 2)
      n = split(inner, a, /, */)
      arg = a[n]
      if (arg in cl && FNR - cl[arg] <= 8) print FILENAME ":" cl[arg]
    }
  }
' {} + 2>/dev/null || true)
if [ -n "$LF_HITS" ]; then
  echo "$LF_HITS" | sed "s|^|  |"
  FOUND=1
else
  echo "  none"
fi
echo

# --- C. leads, never auto-changed ----------------------------------------
# 0x28 is a common unrelated constant, so these are for a human to read. They
# are reported because the cap may be enforced by a plain length comparison
# rather than by a LengthFilter.
echo "--- C. leads: $OLD_HEX in classes whose name suggests text input ---"
LEADS=$(find "$OUT" -name '*.smali' \
  \( -iname '*text*' -o -iname '*input*' -o -iname '*edit*' -o -iname '*diy*' \
     -o -iname '*custom*' -o -iname '*scroll*' -o -iname '*marquee*' \) \
  -exec grep -ln "const/16 v[0-9]*, $OLD_HEX" {} + 2>/dev/null | head -20 || true)
if [ -n "$LEADS" ]; then
  echo "$LEADS" | sed "s|^|  |"
  echo "  (not auto-changed: read these before trusting them)"
else
  echo "  none"
fi
echo

if [ "$FOUND" -eq 0 ]; then
  cat <<EOF
No high-confidence site found.

That does not mean the cap is not there. Things to try, in order:
  1. grep the jadx output instead, where the check is readable Java:
       grep -rn "40" decompiled/$PKG/sources --include=*.java | grep -iE 'length|limit|max'
  2. The cap may be stored as a resource integer rather than a literal:
       grep -rn '>40<' $OUT/res/values/integers.xml
  3. It may count half-width units in a loop rather than capping the field,
     in which case the constant is the loop bound. CJK counting as 2 (per
     research/vendor-app-protocol.md) means such a loop almost certainly exists.
EOF
  exit 1
fi

[ "$MODE" = "--apply" ] || {
  echo "Locate only. Re-run with --apply [newcap] to rewrite A and B."
  exit 0
}

echo "=== Applying ==="
CHANGED=0
if [ -n "$RES_HITS" ]; then
  while IFS= read -r f; do
    [ -z "$f" ] && continue
    sed -i "s|android:maxLength=\"$OLD_DEC\"|android:maxLength=\"$NEWCAP\"|g" "$f"
    echo "  res  $f"
    CHANGED=$((CHANGED + 1))
  done <<< "$RES_HITS"
fi
if [ -n "$LF_HITS" ]; then
  while IFS= read -r hit; do
    [ -z "$hit" ] && continue
    f="${hit%:*}"; n="${hit##*:}"
    # Anchored to the exact line the locator matched, so no other 0x28 in the
    # file is touched.
    sed -i "${n}s|, $OLD_HEX|, $NEW_HEX|" "$f"
    echo "  smali $f:$n"
    CHANGED=$((CHANGED + 1))
  done <<< "$LF_HITS"
fi

cat <<EOF

$CHANGED site(s) rewritten.

  tools/patch_apk.sh diff  $PKG    # review, and commit patches/$PKG.patch
  tools/patch_apk.sh build $PKG    # signed APK in apk/$PKG.patched.apk

Uninstall the store build before installing: resigning breaks the upgrade path.

Then check the real thing on hardware. A wider field is not the same as a wider
upload: the app rasterises phone-side, so if it still truncates at 40 the cap is
enforced somewhere else too and section C above is where to look next.
EOF
