# Joggles

LED glasses, app Funky Glasses+. Protocol solved, verified on hardware.

Docs: `notes/protocol.md` for key, frames, geometry, command table.
`research/README.md` indexes the firmware/OTA teardown, the saved-content
subsystem and the full opcode inventory. Read `research/` before touching firmware.

**Adding to the docs: follow `notes/WRITING.md`.** It sets the confidence markers,
the lean-file rule, and why corrections are recorded rather than deleted.

- Bun + TS only. No Python, no Go
- `packages/core` pure TS, zero deps. `packages/cli` noble/CoreBluetooth
- `bun test` | `bun cli <text|edge|off|bench|stress>` | `bun run ota-check <image>`

## Mental model

Renders on-device. Upload once, let it animate; don't stream. The saved store is
separate from the DIY live buffer, and the `MODE` family shows the saved store.
Wide buffers work: the app uploads ~200 cols and scrolls them unattended, with a
1.5 KB flash buffer behind it. App limits are not device limits.

## Protocol quick reference

Service `fff0`, not `fee9`. Channels: `9600` cmds | `9601` notify | `960a` DATS
upload stream | `960b` live per-column and rhythm.

Save: `DATS <type> <len16>` -> `DATSOK` -> 15-byte blocks on `960a` -> `DATCP` ->
`DATCPOK`. type 1 text (2-byte cols), 2 image (3-byte cols). One buffer per type,
no slot index. `SMVEW 02` also saves (device honours it, app never sends it).

Banks are read-only: `IMAG 0-10`, `ANIM 20-29`. Mind the offset, `animation(3)` is
wrong and 23 is what you want.

## Code state

- Send-side `DATS`/`DATCP` **is implemented** and verified: `Glasses.upload()`
  does the full handshake and the device returns `DATCPOK`. `glasses.ts` now
  subscribes to `CHAR_NOTIFY`. Our own bitmap has been uploaded and left scrolling
  unattended. Receive side also exists: `dats.ts`, `decode-{dats,snoop}.ts`
- `protocol.ts` `scrollLeft`/`scrollRight` are **misnamed**. The live form is
  `MODE <kind> <dir>`: kind 1 static, 2 horizontal, 3 vertical, dir 0 or 1. The
  argument is not speed (`SPEED n` is separate) and `MODE 04` is dead in the app
- `CHAR_BULK_A`/`_B` are not interchangeable: A is the DATS stream, B is live

## Gotchas

- ONE 16-byte block per ATT write. Panel decodes first only, drops rest silently
- Write-without-response has no flow control. Pace writes or columns go stale
- Pacing-bound not hardware-bound. Safe floor unknown. Streamed full frames always
  sweep visibly (24 x pacing to fill, 58ms even at 2ms); use DATS for clean motion
- `SMVEW 00` restores the saved image, looks like stray pixels. Default `end('keep')`
- `MODE` while in DIY switches to saved content, discards the live buffer
- BLE = one connection. Close phone app first
- Env setup (macOS BT permission, noble `trustedDependencies`): README

## Geometry

9 rows x 24 cols/lens. row 0 bottom, col 0 left. Dead: top-row mid-6, nose notch.
`display.alive()`.

Packing differs per channel. Live and DIY-image columns are 3 bytes at 2 bits per
pixel (row r -> bit 2r). DATS text columns are 2 bytes at 1 bit per pixel, 14 rows
in a 7+7 split (bits 0-6, then 8-14; bit 7 unused), of which our panel lights 9.

## Unverified

`MODE` 2nd byte (direction in app, but n=0..7 differ on hardware), `DATS` type 2
over 72 bytes, `LEDFIRST`/`LEDSECOND`, `COLR`/`LEVL`/`POWR`, `STYPE`, and whether
DATS rows 7-8 reach the panel (vendor font uses only rows 0-6).

Settled since: the odd bit is **brightness** - 4-level greyscale, confirmed on
hardware and used by `getAnim19`.

## Don't

- Send any image that has not passed `ota.check()` (`bun run ota-check <image>`).
  It is the gate, and it already encodes every limit below
- Relink firmware, exceed 66 KB, or send OTA `type 2`. Flashing a *patched stock*
  app image over BLE is safe: the OTA stages at `0x29400` and never erases the
  running app, so an aborted transfer costs nothing and we can re-flash stock
  ourselves. What is not safe is shipping an image that fails to bring up BLE (the
  OTA service lives in the app), and images over ~84 KB, which erase the bootloader.
  Read `research/firmware-flashing.md` before writing any flash
- Commit vendor binaries: `apk/`, `decompiled/`, `native/`, `firmware/`
