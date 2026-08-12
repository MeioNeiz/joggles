# Android dev loop

Set up 2026-08-09, extended 2026-08-11. Every claim is *verified* by having been run on
this machine unless the sentence says otherwise, and three entries carry in-place
corrections of what this file used to say.

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
  timeout, just silence. `adb shell wm dismiss-keyguard` clears it, see the keyguard
  bullet below. *Corrected 2026-08-11: this said to unlock it by hand, the third place in
  this file that assumed only a human can.*
- **Piping a long build through `tail` hides everything until it exits**, and
  `expo run:android` does not exit because it goes on to run Metro. Do not pipe it.
- **A manually installed APK cannot reach Metro** without `adb reverse tcp:8081 tcp:8081`,
  which **does not survive a session** and **only ever covers `localhost`**, so re-run it
  first thing every time. LAN is a working fallback needing no tunnel: with the reverse
  removed, the launcher discovered this Mac's LAN address by itself and marked it
  reachable, but that dies whenever the Mac changes network, so prefer localhost plus the
  reverse.
- **The dev launcher remembers one server and keeps asking for it**, so a stale LAN IP in
  there is unreachable whatever the tunnel does, the reverse covering only `localhost`.
  Before diagnosing anything else, read the address the phone will actually ask for:
  `adb shell run-as com.joggles.app cat
  /data/data/com.joggles.app/shared_prefs/expo.modules.devlauncher.recentyopenedapps.xml`.
  One remembered address from a network the Mac had since left cost a whole session on
  2026-08-10, diagnosed 2026-08-11.
- **Re-point it with one deep link**, after which plain launcher taps auto-connect for as
  long as that entry stays most-recent:
  `adb shell am start -a android.intent.action.VIEW -d
  "exp+joggles://expo-development-client/?url=http%3A%2F%2Flocalhost%3A8081"`. The scheme
  is `exp+<slug>`, which `expo-dev-client`'s config plugin derives from `app.json`'s
  `slug` and writes into the manifest itself, **not** the package name:
  `com.joggles.app://` is not registered and fails with `unable to resolve Intent`, which
  the 2026-08-10 attempt read as a missing scheme rather than a wrong one. So **do not add
  a `scheme` key to `app.json`, and no native rebuild is needed**: the intent
  filter is already in `packages/app/android/app/src/main/AndroidManifest.xml` and in the
  installed package (`adb shell dumpsys package com.joggles.app`, Activity Resolver
  Table).
- **Ignore `ClassNotFoundException: expo.modules.splashscreen.SplashScreenManager`.** It
  fires on **every** launch, logged as `E DevLauncherController: Failed to hide splash
  screen`, and `logs.sh` passes `*:E`, so every session sees it. It is caught and
  harmless: the launcher renders its full home screen with it still firing, and
  **`expo-splash-screen` does not need installing.** It was a 2026-08-10 suspect for the
  blank screen and is refuted, so do not spend a native rebuild on it.
- Grant the BLE permissions without touching the screen:
  `adb shell pm grant com.joggles.app android.permission.BLUETOOTH_SCAN` and the same for
  `BLUETOOTH_CONNECT`.
- `npx tsc` installs a squatter package called `tsc`. Use `node_modules/.bin/tsc`.
- **`metro.config.js` changes need Metro restarted**; JS changes do not. And its `.js` to
  TypeScript rewrite must try **both `.ts` and `.tsx`**: `.ts` alone resolves core fine
  and silently fails on every component, which shows up as a blank screen rather than an
  error because Fast Refresh keeps serving the last bundle that built. `expo export` is
  the way to see the real message.
- **Read the background colour before diagnosing a blank screen**, because four faults
  look alike and the colour is what separates them. **White** is the dev launcher's own
  home, which is Compose and paints nothing for about a second after launch, so it is not
  a dead app at all and a fast screencap reproduces the symptom on a perfectly healthy
  install: wait ~10s before capturing. **Dark `#111`** is our own `App.tsx` root, so the
  JS is running and the fault is above it. **A screen that never changes** is the
  `.ts`-without-`.tsx` resolution trap in the bullet above. **A bundle that never loads**
  is the remembered-server problem above.
- The `[ReferenceError: Property 'useRef' doesn't exist]` lines in
  `packages/app/.expo/dev/logs/start.log` are 2026-08-09 21:51 and 22:15 by their own
  timestamps, not a live fault; that log is append-only and the root `CLAUDE.md` sends
  readers into it for wire evidence. Healthy JS logs one `ReactNativeJS: Running "main"`
  and no error.
- The phone re-locks after dozing even with `stay_on_while_plugged_in=7`.
  `adb shell dumpsys power | grep mWakefulness` tells you. **`adb shell wm
  dismiss-keyguard` gets past it** once the human has unlocked once since boot, which
  `adb shell dumpsys trust` reports as `strongAuthRequired=0x0`. *derived* that it stops
  working after a reboot, where strong auth is required until that first human unlock.
  *Corrected 2026-08-11: this said only a human can unlock it, which is too strong and
  cost an agent a stop it did not need.*

## The loop

| Command | Does |
| --- | --- |
| `bun run --cwd packages/app android` | build and install. First build ~10 min, later ~1 min |
| `adb reverse tcp:8081 tcp:8081` | **every session, before Metro**; dies with the session |
| `bun run --cwd packages/app start` | Metro. TSX edits Fast Refresh with no rebuild |
| the `exp+joggles://` deep link, in the gotchas | when the phone ignores a healthy Metro |
| `packages/app/scripts/shot.sh <path>` | screenshot to PNG, which an agent can read |
| `packages/app/scripts/logs.sh [-c\|-f]` | JS console and native BLE errors |
| `adb shell input tap X Y` / `input text FOO` | drive the UI unattended |

Native rebuild only when a native dependency changes. Everything else is edit, refresh,
screenshot.

## What an agent still cannot do

See the glasses. Every hardware verify item in `notes/app-plan.md` ends in a human looking
at a 9x24 LED panel, and no amount of `adb` reaches that.

The app itself an agent can drive unattended, end to end: `wm dismiss-keyguard` past the
lock screen, the deep link above to point it at Metro, `input tap`/`input text` to use it,
and `screencap` read back as a PNG to see what happened. *Corrected 2026-08-11: this
section used to lead with "unlock the phone", which stopped a session that could have
carried on.*

## iOS

Not set up. Needs Xcode (App Store, ~10 GB) and CocoaPods; the machine has Command Line
Tools only.
