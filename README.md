# Joggles

Reverse engineering and driving app-controlled LED glasses (vendor app: Funky
Glasses+, `com.pinkysinyeeho.funkyglassesplus`) from our own code.

The protocol is **solved** and verified against live hardware. See
`notes/protocol.md` for the full findings, including the AES key, command table,
pixel format and panel geometry.

## Layout

    packages/core    protocol, display, font,   pure TS, zero dependencies
                     BLE sequencing, flash budget
    packages/cli     noble adapter and scripts  Bun + CoreBluetooth
    tools/           APK pull and decompile     shell
    notes/           protocol reference         solved, verified on hardware
    research/        firmware and OTA teardown  plus a runnable image codec

## Quick start

    bun install
    bun test                    # incl. FIPS-197 vectors and stock-firmware bytes
    bun cli probe               # what firmware is this unit running?
    bun cli text "HELLO"
    bun cli edge                # trace the panel silhouette
    bun cli bench               # measure throughput
    bun cli off
    bun cli ledger              # flash saves counted against each unit, no connection

## Getting the app onto a phone

`INSTALL.md`. Android is an APK on the
[Releases page](https://github.com/MeioNeiz/joggles/releases), built with `bun run apk`.
iPhone has no free route that lasts, and the options are ranked there.

## Our own firmware

    # rebuild rather than trusting the file on disk: it goes stale silently
    bun run build-firmware firmware/joggles-v2.bin \
      --from-donor firmware/dump-12E69E-2026-08-19-a.bin \
      --from-donor firmware/dump-12E69E-2026-08-19-b.bin --into-fill
    bun run ota-check firmware/joggles-v2.bin --reference <a dump of the target>

Stock plus a `JGX1` extension in free flash, reached by one four-byte hook in the command
dispatcher. It adds a single opcode whose first payload byte is a sub-command, so later
features cost no further edits to the vendor's code, and the extension can **replace its
own feature half over Bluetooth** afterwards: a resident block only a probe can rewrite,
plus two alternating slots. Built and gated, and **still not flashed to hardware**.

`firmware/joggles-v1.bin` is **barred from every unit**, not merely undelivered: it is
built on the phone APK's application, which no pair here runs, and it bricked a unit on
2026-08-08. `joggles-v2.bin` is the rebase onto a real unit's dump and is the only one
that passes the gate. Architecture and the safety envelope: `notes/firmware-design.md`,
`notes/patch-over-bt.md`, and read `notes/swd-flashing.md` before flashing anything.

### macOS Bluetooth permission

BLE from a terminal requires the *terminal app* to hold Bluetooth permission.
Without it the process dies with SIGABRT and no message.
System Settings > Privacy & Security > Bluetooth.

### Note on `bun install`

`@abandonware/noble` needs a native build, so it is listed in
`trustedDependencies`. Without that Bun skips the build script and the binding
fails to load at runtime.

## Hardware summary

| Property | Value |
| --- | --- |
| Advertised name | `GLASSES-{MAC}`, 14 fixed bytes: an 8-byte prefix plus the last six of the MAC, so a rename prefix must be **exactly** 8 bytes |
| SoC | ARM Cortex-M, 16 KB SRAM, **16 MHz crystal** (was recorded as 26 MHz; the part on our board is marked `16.000MHz`) |
| Firmware | **`TR1906R04-12` on every unit here**, 73,616 bytes in a 76,800-byte application region. The phone APK carries `TR1906R04-10`, which is 7,532 bytes smaller and **is not the application these units run**: that mismatch is the 2026-08-08 brick |
| OTA | service `fd00`, Panchip-style profile (no vendor name in the binaries) |
| Panel | 9 rows x 24 columns in total, spanning both lenses (*derived*), two bits per pixel |
| Encryption | AES-128-ECB, one 16-byte block per write; OTA is **not** encrypted |

The OTA image format is solved and both stock images round-trip byte-identically:

    bun research/ota-codec.ts verify firmware/*.bin

**Staging a patched stock app image over BLE is safe. Committing one is not.** The OTA
stages to a separate bank at `abs 0x29400` and never erases the running application, so
an aborted transfer costs nothing, and `bun run flash stage` has run on hardware with no
harm. The commit is the other half: on 2026-08-08 a *stock over stock* commit bricked
`GLASSES-12C3EF`, staging fine and the device's own CRC matching, and it never came back.
**It was repaired on 2026-08-20** over SWD, by writing a healthy pair's application
region onto it: `research/aprom-write-2026-08-20.md`. The commit stays barred; what
changed is that there is now a proven way to undo one.
`bun run flash commit` now refuses without `--ldrom-verified`, which nobody can honestly
pass until LDROM has been dumped over SWD. `research/firmware-flashing.md` has the
evidence and the size envelope, `research/brick-2026-08-08.md` the postmortem. Every
image must still pass `bun run ota-check <image> firmware/TR1906R04-10_OTA.bin`.

*Corrected 2026-08-11: this said flashing was "now judged reasonably safe" and that we
could re-flash stock ourselves at any time. Re-flashing stock is precisely the capability
the brick took away, and the image that bricked it was byte-identical stock.*

Two physical gaps in the panel: the middle of the top row, and a triangular
nose-bridge notch. `display.alive()` maps them.

## Prior art

- [jrd3n/ble_hacks](https://github.com/jrd3n/ble_hacks) - partial capture of this
  device; `reference/ble_hacks/data.csv` is retained as a test vector.
- [gsuberland/ChemionHacking](https://github.com/gsuberland/ChemionHacking) -
  same class of hardware.
