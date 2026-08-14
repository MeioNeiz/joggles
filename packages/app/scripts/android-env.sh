#!/usr/bin/env bash
# Source this before any Android build or adb work:
#
#     source packages/app/scripts/android-env.sh
#
# Homebrew's openjdk@17 is keg-only and the SDK lives under the cask prefix, so neither
# is on PATH by default. Kept in the repo rather than in ~/.zshrc so the toolchain is
# described where the project is, and so an agent shell gets the same environment as a
# human one without depending on anyone's profile.
#
# The Homebrew paths are applied **only when they exist**. A CI image already exports
# JAVA_HOME, ANDROID_HOME and ANDROID_SDK_ROOT at its own locations, and hardcoding
# /opt/homebrew there pointed the build at a JDK and an SDK that are not present, which
# fails inside Gradle rather than here. Guarded with `if` rather than `&&` because the
# callers run under `set -e`, where a failing test as a compound command aborts the
# script that sourced this.
brew_jdk=/opt/homebrew/opt/openjdk@17
brew_sdk=/opt/homebrew/share/android-commandlinetools

if [ -d "$brew_jdk" ]; then
  export JAVA_HOME="$brew_jdk"
fi
if [ -d "$brew_sdk" ]; then
  export ANDROID_HOME="$brew_sdk"
fi

# Either name is enough to have set: Gradle and the Android plugin read ANDROID_HOME,
# some tooling still reads the deprecated ANDROID_SDK_ROOT, so mirror whichever exists.
if [ -z "${ANDROID_HOME:-}" ] && [ -n "${ANDROID_SDK_ROOT:-}" ]; then
  export ANDROID_HOME="$ANDROID_SDK_ROOT"
fi
if [ -n "${ANDROID_HOME:-}" ]; then
  export ANDROID_SDK_ROOT="$ANDROID_HOME"
fi

# Built up piecewise so an unset JAVA_HOME or ANDROID_HOME contributes nothing instead
# of putting a bare "/bin:" on PATH.
if [ -n "${JAVA_HOME:-}" ]; then
  export PATH="$JAVA_HOME/bin:$PATH"
fi
if [ -n "${ANDROID_HOME:-}" ]; then
  export PATH="$ANDROID_HOME/platform-tools:$ANDROID_HOME/cmdline-tools/latest/bin:$PATH"
fi
