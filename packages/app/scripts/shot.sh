#!/usr/bin/env bash
# Screenshot the connected handset to a PNG an agent can open directly.
#
#     ./scripts/shot.sh [path]
#
# This is the whole reason the loop works without a human: edit TSX, let Fast Refresh
# push it, take a shot, look at it. `exec-out` streams binary straight through, unlike
# `adb shell screencap` which mangles it with CRLF translation on some hosts.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$DIR/android-env.sh"

OUT="${1:-/tmp/joggles-shot.png}"
adb exec-out screencap -p > "$OUT"
echo "$OUT"
