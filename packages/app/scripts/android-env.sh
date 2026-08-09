#!/usr/bin/env bash
# Source this before any Android build or adb work:
#
#     source packages/app/scripts/android-env.sh
#
# Homebrew's openjdk@17 is keg-only and the SDK lives under the cask prefix, so neither
# is on PATH by default. Kept in the repo rather than in ~/.zshrc so the toolchain is
# described where the project is, and so an agent shell gets the same environment as a
# human one without depending on anyone's profile.
export JAVA_HOME=/opt/homebrew/opt/openjdk@17
export ANDROID_HOME=/opt/homebrew/share/android-commandlinetools
export ANDROID_SDK_ROOT="$ANDROID_HOME"
export PATH="$JAVA_HOME/bin:$ANDROID_HOME/platform-tools:$ANDROID_HOME/cmdline-tools/latest/bin:$PATH"
