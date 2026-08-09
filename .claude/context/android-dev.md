# Android dev loop

Set up 2026-08-09. Everything here is *verified* by having been run on this machine.

## Toolchain

Homebrew put both somewhere not on `PATH`, so nothing works until the shim is sourced:

- JDK 17 `/opt/homebrew/opt/openjdk@17` (keg-only)
- SDK `/opt/homebrew/share/android-commandlinetools`: platform 36, build-tools 36,
  platform-tools
- `source packages/app/scripts/android-env.sh` sets `JAVA_HOME`, `ANDROID_HOME`, `PATH`

## Handset

Pixel 10 Pro, serial `57141FDCH006BF`, Android 16 (API 36), which matches the installed
platform exactly. Screen stays awake on USB:
`adb shell settings put global stay_on_while_plugged_in 7`.

**No emulator, ever, for protocol work.** Android emulators have no BLE passthrough on
macOS, so the physical device is the only way to reach the glasses.

## Gotchas, each of which cost time once

- **`expo run:android --device <serial>` does not accept a serial.** It wants a name, and
  fails with `Could not find device with name:` *after* a successful build. Omit the flag
  when one device is attached.
- **`adb install` hangs with no output while the phone is locked.** Not an error, not a
  timeout, just silence. Unlock it and it completes.
- **Piping a long build through `tail` hides everything until it exits**, and
  `expo run:android` does not exit because it goes on to run Metro. Do not pipe it.
- **A manually installed APK cannot reach Metro** without `adb reverse tcp:8081 tcp:8081`.
- Grant the BLE permissions without touching the screen:
  `adb shell pm grant com.joggles.app android.permission.BLUETOOTH_SCAN` and the same for
  `BLUETOOTH_CONNECT`.
- `npx tsc` installs a squatter package called `tsc`. Use `node_modules/.bin/tsc`.
- **`metro.config.js` changes need Metro restarted**; JS changes do not. And its `.js` to
  TypeScript rewrite must try **both `.ts` and `.tsx`**: `.ts` alone resolves core fine
  and silently fails on every component, which shows up as a blank screen rather than an
  error because Fast Refresh keeps serving the last bundle that built. `expo export` is
  the way to see the real message.
- The phone re-locks after dozing even with `stay_on_while_plugged_in=7`, and only a
  human can unlock it. `adb shell dumpsys power | grep mWakefulness` tells you.

## The loop

| Command | Does |
| --- | --- |
| `bun run --cwd packages/app android` | build and install. First build ~10 min, later ~1 min |
| `bun run --cwd packages/app start` | Metro. TSX edits Fast Refresh with no rebuild |
| `packages/app/scripts/shot.sh <path>` | screenshot to PNG, which an agent can read |
| `packages/app/scripts/logs.sh [-c\|-f]` | JS console and native BLE errors |
| `adb shell input tap X Y` / `input text FOO` | drive the UI unattended |

Native rebuild only when a native dependency changes. Everything else is edit, refresh,
screenshot.

## What an agent still cannot do

Unlock the phone, or see the glasses. Every hardware verify item in `notes/app-plan.md`
ends in a human looking at a 9x24 LED panel.

## iOS

Not set up. Needs Xcode (App Store, ~10 GB) and CocoaPods; the machine has Command Line
Tools only.
