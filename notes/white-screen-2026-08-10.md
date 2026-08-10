# The white screen on the Pixel, 2026-08-10

Stopped mid-diagnosis on usage grounds. Not fixed. This is where it got to, so the next
session does not repeat the elimination.

## Symptom

Handset shows a plain white screen with the status battery and nav bar and nothing else.
The app's own root `View` is `backgroundColor: '#111'` (`App.tsx`), so white means React
never painted at all, rather than a screen rendering wrong.

## What is ruled out

- **Not a bundling failure.** `bun x expo export --platform android` bundles clean: 640
  modules, one 1.7MB hbc, no resolver error. So `metro.config.js`'s `.js` -> `.ts`/`.tsx`
  rewrite is intact and this is not the blank-screen trap that `android-dev.md` warns
  about.
- **Not a dead app process.** `pidof com.joggles.app` returns, `MainActivity` is
  `topResumedActivity`, and logcat shows the window laid out at 1080x2410 with insets.
  The process is alive and drawing; it has no JS.
- **Not the `useRef` error.** `.expo/dev/logs/start.log` carries
  `[ReferenceError: Property 'useRef' doesn't exist]` twice, but both are from the
  2026-08-09 session (`_t` 1786308703675 and 1786310131185), not tonight. Every `useRef`
  in the tree imports it today: `screens/Connected.tsx:22`, `draw/Draw.tsx:37`. Keep it
  in mind only if the bundle starts loading and the screen stays white.

## What is actually wrong

**The handset never asks Metro for a bundle.** Metro was not running at all when this
session opened (`lsof -ti:8081` empty), which alone explains the white screen. It is
running now, `adb reverse tcp:8081 tcp:8081` is listed, and after a force-stop and
relaunch the dev server log shows `root:init` and then **no `metro:bundling:started` and
no `client_log`** for the handset. Metro is up and being ignored.

Two findings that probably explain why, neither confirmed as the cause:

- **There is no URI scheme to hand the dev client a server URL.** `app.json` has no
  `scheme` key, and
  `am start -a android.intent.action.VIEW -d "com.joggles.app://expo-development-client/?url=..."`
  fails with `Activity not started, unable to resolve Intent`. Launching through the
  LAUNCHER category starts MainActivity but nothing points it at localhost:8081.
- **`expo-dev-client` is installed, `expo-splash-screen` is not.** Every launch logs
  `DevLauncherController: Failed to hide splash screen` ->
  `ClassNotFoundException: expo.modules.splashscreen.SplashScreenManager`, thrown out of
  `DevLauncherController.initialize`. If the launcher aborts its own init there, it never
  renders the screen that would let a human pick the dev server, and white is exactly
  what that looks like. *Derived*: the exception is logged, its effect on the launcher UI
  is inferred.

## Next, in this order

1. Add `"scheme": "joggles"` to the `expo` block of `app.json`, `bun run --cwd
   packages/app android` to get the intent filter into the manifest (~1 min incremental),
   then `am start -a android.intent.action.VIEW -d
   "joggles://expo-development-client/?url=http%3A%2F%2Flocalhost%3A8081"`. This gives the
   dev client a server without needing its UI to work.
2. If the launcher UI is wanted, add `expo-splash-screen` at the SDK 57 version and
   rebuild, which should clear the `ClassNotFoundException`.
3. `adb shell input keyevent 82` is the cheap thing to try before either: on some dev
   builds it opens the RN dev menu, from which the server can be entered by hand.
4. Once JS loads, re-read `.expo/dev/logs/start.log` for a fresh `client_log` error
   before assuming the screen is right.

## Environment left behind

Metro was started by this session and then stopped again, so nothing is running. `adb
reverse tcp:8081 tcp:8081` is still set on the handset and survives until it is
unplugged. The phone was awake and unlocked throughout. No BLE work was done, no lock in
`.claude/locks/` was taken, and no glasses were touched.
