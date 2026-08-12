# Installing Joggles on a phone

Joggles drives app-controlled LED glasses (the ones sold with **Funky Glasses+**) over
Bluetooth. It is not on any app store, so installing it means taking a file from the
[Releases page](https://github.com/MeioNeiz/joggles/releases).

It talks Bluetooth to hardware, so it cannot run in Expo Go or in a browser. It has to
be a real installed app.

## Android

1. On the phone, open the [Releases page](https://github.com/MeioNeiz/joggles/releases)
   and download `joggles-<version>.apk`, about 38 MB.
2. Open the downloaded file. Android asks whether to allow installs from the app you
   downloaded with (Chrome, or Files). Allow it, then press Install.
3. Play Protect may warn that the app is from an unknown developer. That is expected:
   the APK is not signed by a Play Store account. Choose "Install anyway".
4. Open Joggles. It asks for **Nearby devices** the first time you scan. It never asks
   for location, and it does not use the internet.
5. Turn the glasses on, go to the **Glasses** tab, and tap your pair.

Works on Android 7.0 and newer. One APK covers every handset.

To update, download the newer APK and open it. It installs over the top and keeps your
saved content, because every release is signed with the same key.

## iPhone

There is no free, tidy way to hand someone an iPhone app outside the App Store. This is
Apple's rule, not ours, and every route below is a way around the same wall. Pick by how
many people want it.

| Route | Cost | What the installer has to do | Lasts |
| --- | --- | --- | --- |
| **TestFlight** | Apple Developer Program, about £79 a year, paid once by whoever publishes | Tap a link, install TestFlight, install Joggles | Until the build expires, 90 days, then a new one lands automatically |
| **Sideload with AltStore or Sideloadly** | free | Install AltServer/Sideloadly on a Mac or PC, plug the phone in once, load the `.ipa` with their own Apple ID | **7 days**, then it must be refreshed. AltStore can refresh over wifi while the computer is on |
| **Build it themselves** | free | A Mac with Xcode, then the steps below | **7 days**, then re-run from Xcode |

**If more than one or two people want it, pay the £79.** TestFlight is the only route
where a person installs from a link and it keeps working; everything else costs them a
computer and a weekly reminder. Publishing to it is `eas build -p ios` then
`eas submit -p ios`, both from `packages/app`.

### Building it yourself on a Mac

Needs Xcode and a free Apple ID. The 7 day expiry is a limit of free Apple accounts.

    git clone https://github.com/MeioNeiz/joggles.git
    cd joggles
    bun install
    cd packages/app
    npx expo prebuild -p ios
    open ios/Joggles.xcworkspace

In Xcode: select the Joggles target, **Signing & Capabilities**, tick "Automatically
manage signing" and pick your own Apple ID team. Change the bundle identifier to
something unique to you, for example `com.yourname.joggles`, because `com.joggles.app`
is already claimed. Plug the phone in, choose it as the run destination, press Run.

The first launch fails with "Untrusted Developer" until you go to Settings > General >
VPN & Device Management on the phone and trust your own account.

## What it does to the glasses

Worth knowing before you install someone else's app on hardware you own.

- **It never touches firmware.** The over-the-air update code is deliberately kept out
  of the app's reach, so the app cannot flash or brick a pair.
- **Showing things is free; saving one is a flash write.** The glasses have a small
  amount of flash with a finite number of erases, so the app counts every save, refuses
  duplicates, and stops you at 30 an hour or 200 a day. Drawing, live effects and the
  built-in patterns write nothing at all.
- **Nothing leaves the phone.** No accounts, no network, no telemetry.

## Publishing a release (maintainer)

    bun run apk
    gh release create v0.1.0 packages/app/dist/joggles-0.1.0.apk --title "Joggles 0.1.0"

`bun run apk` needs the Android toolchain from `.claude/context/android-dev.md`.

Before building, bump **both** keys in `packages/app/app.json`: `version`, which names
the file and the tag, and `android.versionCode`, which is the only one Android itself
compares. A release that leaves `versionCode` behind the installed one will not install
over it, and the phone says nothing more useful than "App not installed".
