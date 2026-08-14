# Changing this project from a phone

The route that works: push to a branch carrying `.github/workflows/app-apk.yml`,
let GitHub Actions build the APK, then open the prerelease on the phone and tap
it. No Mac, no cable, no Terminal. Everything else in this file is what that
route cannot do, and the one class of bug it lets through.

Written after a session that tried to do it the other ways first and wasted the
time. If you are an agent in a cloud container, read "What the container cannot
do" before promising anybody a build.

## The route, end to end

| Step | Where | Note |
| --- | --- | --- |
| Edit code | agent container or the GitHub web editor | no toolchain needed |
| Push | branch with the workflow on it | the push is the trigger |
| Build | GitHub Actions, `app apk` | ~7 minutes, ARM only, ~36 MB |
| Download | the prerelease page | plain URL, no login needed |
| Install | tap the `.apk`, allow the browser to install | see "Installing" below |

The workflow triggers on push to `claude/app-apk-release`, plus
`workflow_dispatch`. **`workflow_dispatch` only appears once the workflow file is
on the default branch**, so from a feature branch the push is the only trigger.

It runs the same `bun run apk` a human runs, so the build logic stays in
`packages/app/scripts/release-apk.sh` and CI cannot drift from a local build.

A docs-only push does **not** build: `**/*.md`, `notes/**` and `research/**` are in
`paths-ignore`, because prose cannot change the APK and the build is seven minutes
of a runner. Push any code file, or re-run the last build from the Actions tab, if
you want one anyway.

Release tags are `app-v<version>-build<run number>`, so re-running never collides
with an existing tag. The version comes from `packages/app/app.json`, which is the
only place it is written; `release-apk.sh` syncs it into the generated `android/`.

## What the container cannot do

*verified 2026-08-14* by checking rather than assuming, in a Claude Code cloud
container:

| Wanted | State |
| --- | --- |
| `adb`, USB | absent. No `adb` binary, no `/dev/bus/usb` |
| Bluetooth | absent. No `/sys/class/bluetooth` |
| Android SDK | absent, and `dl.google.com/android/repository` returns `000` |
| `maven.google.com` | reachable, which is not enough on its own |
| JDK 21, `gradle`, `node`, `bun` | present |
| `github.com` release downloads | reachable |
| `api.github.com` | 403 for direct `curl`; use the GitHub MCP tools |
| Play Store, APKPure, APKMirror, F-Droid | all `000` |

Two consequences worth stating plainly:

- **The APK cannot be built in the container.** The Gradle build needs the Android
  SDK and the host serving it is blocked. CI can, because GitHub's runners ship
  the SDK and can reach Google. A Mac with the Homebrew toolchain can, which is
  what `packages/app/scripts/android-env.sh` points at.
- **Nothing can be verified against the glasses from here.** No Bluetooth means
  `bun cli` cannot run, so any claim about what the panel does stays *unverified*
  until somebody with the hardware looks at it.

## The gap this leaves, and the bug that already came through it

A phone-only loop can ship a change that every test passes and that is visibly
wrong on the panel. This has happened once and it is worth knowing the shape of
it.

On 2026-08-14 Jacob read "JACOB" on the glasses and saw the `C` and the `O` join
into one shape. The whole suite was green. `kern.tuckLimit` compared row *r* of
one glyph against row *r* of the next, which bounds ink that would land side by
side and says nothing about ink that lands **diagonally** adjacent; on round LEDs
a diagonal touch closes the gap just as completely. The kerning test asserted
per-row clearance and was satisfied throughout. A legibility tool written the same
week reported "0 touching pairs" for the same font, because its author counted
diagonal contact at first and then removed it as "ordinary in bitmap type".

The lesson is not "write more tests". It is that **a rendering property has to be
looked at**, and the two cheap ways to look need no hardware at all:

    bun run packages/cli/src/fontsheet.ts "JACOB"   # glyphs on real geometry
    bun run packages/cli/src/legibility.ts          # collisions, contacts, counters

`fontsheet` prints dead LEDs as spaces, so a glyph that loses a stroke to the nose
notch shows as a hole rather than as a plausible letter. Paste the output into the
conversation and let a human read it. That is the closest thing to the panel that
exists without the panel.

## Installing on the phone

- **The app is `com.joggles.app`, named "Joggles".** It is ours and it is a
  separate icon from the vendor's `com.pinkysinyeeho.funkyglassesplus`. Installing
  one never replaces the other, and looking for our changes in the vendor app is
  the easiest way to think a build did nothing.
- **A release asset is a plain URL a phone browser can fetch.** A workflow run
  artifact is not: it needs a GitHub login and arrives as a zip. That is the whole
  reason the workflow attaches the APK to a prerelease as well as uploading it.
- **Builds from this repo upgrade over each other.** `packages/app/release.keystore`
  is committed on purpose so the signing key outlives any one build. No uninstall
  is needed between our own builds.
- **Uninstalling is only needed when the signature differs**, which means moving
  between our build and something signed by anyone else. That clears app data;
  content saved on the glasses survives, because the device store is separate.
- **Split installs cannot be sideloaded by tapping.** If a package arrives as
  `base.apk` plus `split_config.*` it needs an installer like SAI. Ours is a single
  APK, so this only matters for the vendor app.

*verified*: the app has been installed and used from a handset, since the "JACOB"
report above came off the panel through it. Which build was in use at that moment
is not recorded, so treat "this exact APK installs and launches" as *derived*
rather than witnessed for any given build number.

## Getting an APK off the phone without a computer

Only needed for the vendor app, and it is possible: a free APK-extractor app
(App Manager, SAI, APK Extractor) exports an installed package to Downloads with
no root and no adb. From there it can be attached to a conversation. *unverified*
for this handset: nobody has done it yet.

## Because the repo is public

`MeioNeiz/joggles` is public, so **workflow artefacts and release assets are
downloadable by anyone with the link**. That is fine for our own app and is why
the APK is published that way. It is not fine for anything of the vendor's:

- Do not attach a vendor APK, patched or otherwise, to a release or an artifact.
  Patching your own copy of an app on your own device is one thing; publishing a
  patched build of somebody's proprietary app is another.
- The existing rule still holds: no vendor binaries in the tree at all. `apk/`,
  `decompiled/`, `patched/`, `native/`, `firmware/` and `tools/bin/` are gitignored
  for that reason, and a patch file is the committable artefact.

## Tests, from a machine that has nothing

`bun test` **exits 1 on a clean checkout**, and it is not your change. Six suites
under `research/tools` read firmware images from `firmware/`, which is gitignored
and therefore absent from any fresh clone, and `describe.if(existsSync(STOCK))`
does not save them because bun still evaluates the describe body and the
`readFileSync` inside it throws during collection.

What passes anywhere:

    bun test packages/core packages/app/src

which is what CI runs, and what the `bun test` line in `CLAUDE.md` means in
practice on a machine without the firmware dumps.

## Still needs somebody holding the glasses

Nothing below can be closed from a phone or a container, and each is currently
*unverified*:

- Whether any given APK build installs and launches, per build.
- Everything in `notes/app-plan.md`, "Verify before building".
- Any change to how text looks: kerning, a glyph, a font default. `fontsheet` and
  `legibility` narrow it down, and only the panel settles it.
- Anything touching flash. One BLE connection at a time, so the app and `bun cli`
  cannot both hold a pair; close one first.
