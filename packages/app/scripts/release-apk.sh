#!/usr/bin/env bash
#
# Build the APK that goes on a GitHub release.
#
#     bun run apk
#
# Output: packages/app/dist/joggles-<version>.apk, one file for every handset.
#
# ARM only, which is the whole reason for the architectures flag: the default build
# carries x86 and x86_64 too and weighs 70 MB against 38 MB (measured). Those two ABIs
# only exist on emulators here, and an emulator has no BLE passthrough on macOS, so
# nothing that could run this app needs them.
#
# **Signing, and why a keystore sits in the repo.** Android will only install an update
# over an install signed by the same key, so the key has to outlive any one build. The
# Expo template signs release builds with the standard Android debug key, but it writes
# that keystore into `android/`, which is gitignored and regenerated: delete the folder
# and a later template could hand out a different key, at which point every install in
# the field is stranded on its version with no error worth reading. So the key lives at
# `packages/app/release.keystore` and is copied in below. It is the public debug key,
# password `android`, and it is not a secret: it authenticates nothing and anyone can
# sign anything with it. That is acceptable for handing an APK to friends and is not
# acceptable for the Play Store, which wants a real key that then must never be lost.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
app="$(dirname "$here")"

# shellcheck source=./android-env.sh
source "$here/android-env.sh"

cd "$app"

# android/ is gitignored and regenerated from app.json, so a fresh clone has none.
[ -d android ] || npx expo prebuild -p android --no-install

cp release.keystore android/app/debug.keystore

cd android
./gradlew assembleRelease -PreactNativeArchitectures=armeabi-v7a,arm64-v8a

version="$(node -p "require('$app/app.json').expo.version")"
out="$app/dist"
mkdir -p "$out"
cp "$app/android/app/build/outputs/apk/release/app-release.apk" "$out/joggles-$version.apk"

echo
echo "built: $out/joggles-$version.apk"
echo "publish: gh release create v$version $out/joggles-$version.apk --title \"Joggles $version\""
