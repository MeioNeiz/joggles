# Patching the vendor APK

Rebuilding a modified `com.pinkysinyeeho.funkyglassesplus` needs no Android SDK.
`tools/patch_apk.sh` does decode, build and sign with two jars fetched from
GitHub releases. *verified*: apktool 2.12.0 and uber-apk-signer 1.3.0 both run
against JDK 21 with nothing else installed.

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

Read in jadx, edit in smali. The two trees are different representations of the
same classes, so locate a method by name in the jadx output and then find the
same method under `patched/<pkg>/smali*/`.

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

## Unverified

Everything about the app-side limits. The working hypothesis from `CLAUDE.md` is
that the ~200 column upload ceiling and the text length cap are enforced in the
app rather than the panel, which would make them patchable. Neither has been
traced to a specific method yet, and if either turns out to be firmware-side no
APK patch will move it.
