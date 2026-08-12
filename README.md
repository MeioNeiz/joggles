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

    bun run build-firmware      # firmware/joggles-v1.bin, then ota-check it

Stock plus an 88-byte extension appended in free flash, reached by one 28-byte hook in
the command dispatcher. It adds a single opcode whose first payload byte is a
sub-command, so later features cost no further edits to the vendor's code. Built and
gated, **not yet flashed to hardware**. Architecture and the safety envelope:
`notes/firmware-design.md`.

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
| Advertised name | `GLASSES-{MAC}` |
| SoC | ARM Cortex-M, 16 KB SRAM, **16 MHz crystal** (was recorded as 26 MHz; the part on our board is marked `16.000MHz`) |
| Firmware | `TR1906R04-10`, 66,084 bytes in a 76,800-byte application region |
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
