# Patching the vendor APK

Rebuilding a modified `com.pinkysinyeeho.funkyglassesplus` needs no Android SDK.
`tools/patch_apk.sh` does decode, build, sign and diff with two jars fetched from
GitHub releases. *verified*: apktool 2.12.0 and uber-apk-signer 1.3.0 both run
against JDK 21 with nothing else installed.

The harness itself is *verified* end to end. The vendor app is not: see
"What the harness run did and did not prove".

## Why this and not the obvious alternatives

| Approach | Outcome |
| --- | --- |
| jadx output, recompiled | does not work. jadx is a decompiler for reading, its Java does not rebuild |
| apktool smali | works. this is the only editable-and-rebuildable form |
| `jarsigner` | installs on nothing modern. v1-only signature, refused from Android 11 |
| `apksigner` from build-tools | fine, but pulls the whole SDK from Google |
| uber-apk-signer | one jar, bundles zipalign, emits v1+v2+v3 |

apktool carries its own aapt2 and uber-apk-signer its own zipalign, which is why
the SDK never enters the picture.

## Workflow

    tools/android_pull.sh <pkg>      # or export the APK on-device
    tools/decompile.sh <pkg>         # jadx, readable Java, to FIND the target
    tools/patch_apk.sh decode <pkg>  # apktool, smali, to CHANGE it
    ...edit patched/<pkg>/...
    tools/patch_apk.sh build <pkg>
    tools/patch_apk.sh diff <pkg>    # patches/<pkg>.patch, the committable bit
    tools/patch_apk.sh apply <pkg>   # replay that patch onto a fresh decode

Read in jadx, edit in smali. The two trees are different representations of the
same classes, so locate a method by name in the jadx output and then find the
same method under `patched/<pkg>/smali*/`.

`apply` exists because a patch nobody has replayed is not yet an artefact. Run it
before trusting a committed patch: it reconstructs the edit on a pristine tree,
which is exactly what a reader holding their own copy of the APK has to do.

## What the harness run did and did not prove

*verified* against KeePassDX 4.1.0 (GPLv3, 13 MB, 13,807 smali files, two dex).
A third-party app was used because the sandbox had no copy of the vendor APK. The
full cycle ran: decode, edit, build, sign, diff, apply to a pristine tree, rebuild.

Both edit kinds were checked in the built artefact rather than assumed from a
clean exit code:

- Edited a smali `const-string` to a marker, then grepped the marker in the
  signed APK's `classes.dex`. Present, and absent from the store APK as control.
- Changed a layout `android:maxLength` from 3 to 8, then re-decoded the build and
  read the attribute back. `8`, against `3` in the store APK.
- Added a whole new smali class, replayed the patch onto a pristine tree, rebuilt
  and grepped its string. Present, so injecting a class works, not only editing.

Timings on this machine: decode 11 s, build plus sign 15 s, 169 MB per tree.

Not proved, and needing a device:

- **Installing.** No `adb`, no USB and no Bluetooth in the sandbox, so
  `adb install -r` was never run. That a resigned rebuild installs and launches
  is *unverified*.
- **The vendor app specifically.** Whether `com.pinkysinyeeho.funkyglassesplus`
  decodes and rebuilds cleanly is *unverified*. Obfuscated or unusual apps can
  fail where KeePassDX succeeds.
- **Whether it is a split install.** Still unchecked, and it changes everything
  downstream.

## Corrections: three ways the script was wrong before it was ever run

Each of these was written confidently, was syntax-clean, and was wrong. Recorded
because a future session will otherwise reintroduce them.

1. **`apktool b --use-aapt2` is not a flag.** In 2.12.0 aapt2 is unconditional
   and the only related option is `--use-aapt1`, which opts out. Passing
   `--use-aapt2` makes apktool print its usage screen and exit non-zero, so the
   build could never have worked. The old comment claimed the flag was stated
   explicitly "so a version bump does not silently change the resource compiler",
   which is the reverse of what it did.
2. **`apktool b` writes `build/` and `dist/` inside the project tree**, and the
   old `diff` compared whole trees. After one build the patch filled with
   compiled aapt2 output. Worse, `diff -N` reports a file that exists on one side
   only as "Binary files ... differ" rather than as an addition, and the summary
   counted `^+++` lines, so a 1175-line patch of pure build noise was announced
   as "0 files changed". Both intermediates are now cleared from each side before
   diffing; they are disposable and the next build regenerates them.
3. **Failures were hidden behind `| tail -n`.** The line naming the cause sits
   above the last 15 lines of an apktool usage dump, so the script reported a
   help screen instead of a reason. Output now goes to `tools/bin/last-run.log`
   and failures print the lines matching error patterns.

Smaller ones fixed in the same pass: signing success was never checked, so a
failed sign still printed install instructions; `mv ... 2>/dev/null` could fail
silently and leave the script exiting 0 with no APK; the `.idsig` that
uber-apk-signer emits alongside was orphaned under the old name; and `decode` did
`rm -rf` on an existing tree without asking, which would discard hand-edited
smali.

## Raising the 40-character text cap

`tools/raise_text_cap.sh <pkg>` reports candidate sites and changes nothing.
`--apply [newcap]` rewrites the high-confidence ones, default 200.

`tools/joggles-raise-text-cap.sh` does the whole thing in one command: pull,
decode, locate, patch, rebuild, resign, install. It is deliberately
self-contained, duplicating the other two scripts, so it can be downloaded on
its own and run on a machine with no clone of this repo. It fetches its own
apktool and signer, handles split installs by resigning every split with the
same key, prompts before the uninstall that clears app data, and writes a
committable patch beside its output. `--locate-only` and `--no-install` make it
safe to run before committing to anything.

Being standalone, it needs the macOS toolchain rather than the GNU one: BSD sed
does not expand `\t` in a regex, BSD awk does not take `delete arr` for a whole
array, and macOS bash is 3.2, where an empty array under `set -u` is a hazard.
It uses a literal tab, `split("", arr)`, and a plain counter instead.

The viability question is already settled, so this does not need a hardware check
first. `research/vendor-app-protocol.md` records "Text input: 40 half-width units,
an app-side UI cap" and "the 40-character cap is a UI limit rather than a protocol
or firmware one", both *verified*, against a device that scrolls ~200 uploaded
columns unattended.

40 is `const/16 <reg>, 0x28` in smali, because `const/4` tops out at 7. Anything
up to 32767 also fits `const/16`, so raising it keeps the instruction width and
moves no registers. The script searches three ways:

- **A**, `android:maxLength="40"` in `res/`. The cheapest form, no smali needed.
- **B**, a `const/16` of `0x28` that loads the argument register of an
  `InputFilter$LengthFilter;-><init>(I)V`. Rewritten in place, anchored to that
  one line number.
- **C**, other `0x28` constants in classes named for text input. Reported as
  leads and never auto-changed, because the cap may be a plain length comparison
  or a half-width counting loop rather than a filter. CJK counting as 2 means
  such a loop almost certainly exists somewhere.

*verified* mechanically against KeePassDX with both forms planted, including a
decoy `0x28` in the same method: the decoy survived, the real site became `0xc8`,
and both changes round-tripped out of the rebuilt signed APK. *unverified* on the
vendor app, which has never been available in this sandbox.

A wider field is not the same as a wider upload. The app rasterises phone-side,
so if it still truncates at 40 after patching, the cap is enforced in more than
one place and section C is where to look next.

### Corrections: two ways the locator was wrong

1. **Proximity matching flags the wrong constant.** The first version accepted any
   `const/16 0x28` within eight lines of a `LengthFilter`, which matched an
   unrelated constant sitting above it, and `sed` would then have rewritten that.
   Bind the constant's register to the filter's `<init>` argument register instead.
2. **`NR` is cumulative under `find -exec awk {} +`.** One awk process sees many
   files and `NR` keeps counting across them, so the reported line numbers pointed
   into the wrong file entirely. Use `FNR`.

## Patch format

Headers are normalised to `a/` and `b/` with the mtimes stripped, so
`patch -p1` inside `patched/<pkg>/` is exact. Raw `diff -ruN` output leaves both
tree names in every header, which leaves the target tree up to GNU patch's
filename heuristic. It picked the `+++` name when tested, but relying on that is
not worth it, and the timestamps churned the artefact on every re-diff.

Binary files are excluded (`*.png *.jpg *.arsc *.dex *.so`). `diff` reports
binary changes with no content, so they cannot be replayed by `apply`; the script
warns and counts them separately if any appear. Anything binary that genuinely
must change gets described here in prose instead.

## What gets committed

The patch, not the binary. `patched/` and `tools/bin/` are gitignored alongside
the existing `apk/` and `decompiled/` rules. `patches/*.patch` is text, is
reviewable, and is meaningless without a copy of the app, so it carries none of
the redistribution problem the APK does.

## Gotchas

- Resigning changes the signature, so the patched build will not upgrade over
  the store install. Uninstall first, which clears app data. Content saved on
  the glasses themselves survives: the device store is separate from the app.
- Split installs (`base.apk` plus `split_config.*`) need every split signed with
  the same key and installed as a set (`adb install-multiple`). Patching base
  alone and installing it alone fails. *unverified* for this app: whether it is
  distributed as a split bundle has not been checked.
- One connection at a time over BLE. The patched app and `bun cli` cannot both
  hold the glasses.
- A decode is about 170 MB and the pristine copy doubles it. Two apps in
  `patched/` is most of a gigabyte.
- Editing `res/` works as well as editing `smali/`, and is the easier route when
  the limit is an XML attribute such as `android:maxLength`. Check the layout
  before hunting through smali. A UI cap is often backed by a second clamp in
  code, so finding one does not mean there is not another.

## Unverified

Everything about the app-side limits. The working hypothesis from `CLAUDE.md` is
that the ~200 column upload ceiling and the text length cap are enforced in the
app rather than the panel, which would make them patchable. Neither has been
traced to a specific method yet, and if either turns out to be firmware-side no
APK patch will move it.

Settle that before writing smali, not after. `bun cli` drives the hardware
directly, so send the thing the app refuses to send and watch the panel. If the
device refuses it too the limit is firmware and no APK patch will move it.
