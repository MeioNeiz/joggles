#!/usr/bin/env bash
# App logs, filtered to what is actually ours.
#
#     ./scripts/logs.sh          dump what is buffered, then exit
#     ./scripts/logs.sh -f       follow
#     ./scripts/logs.sh -c       clear the buffer first (do this before reproducing)
#
# ReactNativeJS carries console.* from the JS side, which is where our own logging
# lands. Errors from everything else are kept because a native BLE failure surfaces
# there and nowhere else.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$DIR/android-env.sh"

FOLLOW="-d"
for arg in "$@"; do
  case "$arg" in
    -f) FOLLOW="" ;;
    -c) adb logcat -c ;;
  esac
done

adb logcat $FOLLOW -s ReactNativeJS:V ReactNative:V BluetoothLeScanner:V "*:E"
