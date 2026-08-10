# Joggles

LED glasses, app Funky Glasses+. Protocol solved, verified on hardware.

## Where to look

| File | What it holds |
| --- | --- |
| `notes/plan-after-the-brick.md` | **the current plan**: three tracks, only firmware delivery is blocked, and the SWD order of operations |
| `notes/protocol.md` | key, frames, command table, panel geometry |
| `notes/app-plan.md` | the phone app, the flash-wear numbers, and the ordered "Verify before building" list |
| `notes/what-to-build.md` | delivery routes, ranked patches, festival ideas, what we decided against |
| `notes/firmware-design.md` | our own firmware: architecture, wire formats, roadmap, safety envelope |
| `research/README.md` | index of the teardown. `firmware-internals.md` is what the firmware actually is, tiered by trust in its Provenance section |

Findings go in `research/` with a confidence marker, judgement in `notes/`. **How to
write either: `notes/WRITING.md`.** **Working alongside other agents:
`notes/parallel-tracks.md`**, and `.claude/locks/` is where each track has got to.

**Every module in `packages/core/src` carries its reasoning in its own docblock**, which
is where the detail lives. This file is pointers plus the traps that bite everywhere.

## Working rules

- Bun + TS only. No Python, no Go. `packages/core` is pure TS with zero deps,
  `packages/cli` is noble/CoreBluetooth, `packages/app` is Expo and has its own
  `CLAUDE.md`. `bun test` green when you stop; the count only goes up
- **The `@joggles/core` barrel has no OTA in it.** `ota`/`dfu` sit behind
  `core/src/firmware.js`, so reaching `fd00` is an explicit import and the phone app
  cannot do it by accident. `safe-surface.test.ts` fails the build if that leaks, or if
  anything the barrel reaches imports Node (React Native has no `Buffer`)
- `bun cli <probe|text|edge|off|bench|stress|ledger>` needs a device. `bun run
  <ota-check|build-firmware|flash|dumpcheck>` is the firmware side. `bun run effects
  <name>` and `bun run packages/cli/src/fontsheet.ts` need nothing attached. Env setup
  (macOS Bluetooth permission, noble `trustedDependencies`): README
- Firmware analysis is `research/tools/fwtool.ts`, **not grep**: its header explains the
  two scanning traps that have already put wrong entries in the docs. Edits go through
  `research/tools/patch.ts`, which refuses any patch whose expected old bytes do not
  match. Pre-flash verification: `.claude/context/firmware-flash-readiness.md`

## Mental model

Renders on-device. Upload once, let it animate, radio off; don't stream. The saved store
and the DIY live buffer are separate things, and the `MODE` family shows the saved store.
Wide buffers work: app limits are not device limits.

**The MCU does not drive the LEDs.** The panel is a separate module on UART1 at 115200,
fed one atomic 74-byte frame at a time, so greyscale depth and the level-to-brightness
curve are the module's and unreachable by any firmware patch, and ~6.4ms per frame is
the real floor. There is an on-board button the firmware polls: short press cycles
built-in modes, 2s long press powers off (*derived*, pin unconfirmed).

Service `fff0`, not `fee9`. Channels: `9600` commands | `9601` notify | `960a` DATS
upload stream | `960b` live columns and rhythm. Save is `DATS <type> <len16>` ->
`DATSOK` -> 15-byte blocks on `960a` -> `DATCP` -> `DATCPOK`, one buffer per type and no
slot index. `IMAG` and `ANIM` banks are read-only built-ins.

9 rows x 24 columns spanning both lenses, row 0 bottom, col 0 left. Dead LEDs at the
top-row middle six and the nose notch (`display.alive()`). Rows 2-7 is the only band
alive in every column, which is why the scrolling font is 5 rows. Packing differs per
channel: `notes/protocol.md`, and the `dats.ts` docblock for the DATS row mapping.

## Code map

| File | What it is, and the thing not to get wrong |
| --- | --- |
| `core/src/session.ts` | `Glasses`, all sequencing, transport-agnostic through `transport.ts`. `Glasses.attach(transport, name)`; the CLI's `open()` lives in `cli/src/glasses.ts` |
| `core/src/budget.ts` | flash wear. `session.save()` is the only caller of `dats.datsComplete()` and `choke-point.test.ts` fails the build if a second appears. Duplicate payloads skip; 3s apart, 30/hour or 200/day **throw** rather than queue. `bun cli ledger` |
| `core/src/content.ts` | the one `Bitmap` plus both encoders. **Render to a `Bitmap`, never straight to bytes** |
| `core/src/viewport.ts` | the 24-column window, with `alive()` applied **at the window**: masking a wide bitmap draws a hole that travels with the glyph |
| `core/src/effects.ts` | wide seamless loops, computed in float and uploaded once. `fieldGap()` is the closure check with teeth; `seam()` cannot prove a loop closes |
| `core/src/font.ts` | two fonts. `band5` scrolls, `tall7` is static only because it steps glyphs around the notch |
| `core/src/sender.ts` | `LiveSender`: a desired grid and a believed-sent grid, never a queue of writes. Get one from `Glasses.live()`, never by constructing it, and never interleave `Glasses.show()` |
| `core/src/rhythm.ts` | all 24 columns in one write, bars only. Leave DIY first or the same frame corrupts a column. `research/rhythm-channel.md` |
| `core/src/protocol.ts` | frames. Several helpers build frames the firmware **ignores**, grouped and labelled in the file: never build a UI control on one |
| `app/src/draw/` | the draw canvas, wired into `App.tsx`. Writes no flash and sends no `MODE` |

**What has actually run on hardware.** The save path has: track 5's `bun run
packages/cli/src/type2.ts` drove `Glasses` on 2026-08-09, after the transport
extraction. `rhythm.ts` has not. **`LiveSender` and the draw screen have**, on
2026-08-09 from the Pixel: `SMVEW 01`/`LEDON`, then 210 live column writes over 49s
across 21 of the 24 columns and all 9 rows, then `CLRL` alone on a lit panel
(*Corrected: this said the draw screen had never been rendered on a handset. The wire
log is `packages/app/.expo/dev/logs/start.log`, and it decodes with the vendor key.*)
**What that proves is the wire, not the panel**: nobody has said what the drawing or
the clear looked like, so the row orientation, the greys and `CLRL`'s effect are all
still unwitnessed.

## Traps that fail silently

- ONE 16-byte block per ATT write. The panel decodes the first and drops the rest with
  no error, which reads as corruption
- Write-without-response has no flow control: pace the writes or columns go stale. One
  frame costs 6.42ms on the module's UART, so streamed full frames sweep visibly; use
  DATS for clean motion
- **Only DATS type 1 persists**, and `savedType()` picks the type from whether the
  content has grey in it, so **one grey pixel decides whether a save lasts**. Type 1
  holds 740 columns; type 2 is accepted to 383 and displays 24
- **A type 2 image displays on `DATCPOK` by itself, and `MODE` is a one-way door away
  from it**: `MODE 01`/`02` switch to the type 1 flash store and nothing switches back
- `MODE` sent while in DIY switches to saved content and discards the live buffer.
  `SMVEW 00` restores the saved image, which looks like stray pixels; default
  `end('keep')`
- `LEDOFF`/`LEDON` are **not implemented** and `LIGHT` floors at level 1. `CLRL` is the
  atomic clear, undocumented and never sent by the vendor app
- `CHAR_BULK_A`/`_B` are not interchangeable: A is the DATS stream, B is live
- BLE is one connection per device, but one phone can hold several devices

**What is still unproven, and the order to settle it in**: the seven-item list in
`notes/app-plan.md`, "Verify before building". The two *derived* claims the code already
leans on are `CLRL` clearing the panel, and type 2 showing only its first 24 columns
(one null observation by eye).

## Our firmware: built, not yet flashed

`bun run build-firmware` emits `firmware/joggles-v1.bin`: stock plus an 88-byte `JGX1`
extension at `abs 0x26a24`, one 28-byte dispatcher hook, the crew AES key and an advert
rename. One opcode, `J`, whose first payload byte is a sub-command, so every future
feature is a new sub-command in free flash and **no further edit to the vendor's code**.
v1 has `HELLO`; `bun cli probe` asks, and a stock unit and a wrong-keyed crew unit both
answer with silence.

`bun run flash` is the way on, and its subcommands are the safe procedure in order:
`info` writes nothing, `stage` streams but never commits, `commit --yes` is the one
barred below. Design and the first-flash procedure: `notes/firmware-design.md`. Wire
formats: `core/src/jgx.ts`, `core/src/dfu.ts`. Assembler: `research/tools/thumb.ts`.
The crew key is `firmware/crew-key.json`, generated on first build and gitignored.

## Don't

- **Send OTA ctrl `03` (commit) to anything.** On 2026-08-08 a *stock over stock* commit
  bricked `GLASSES-12C3EF`: staging fine, the device's own CRC matched, it reset itself
  and never came back, so the fault is the handoff into LDROM rather than the image.
  `bun run flash stage` is still safe and was run on that unit with no harm. The whole
  persistent change is `CONFIG0 = 0xFFFFFF3F` and the repair is one erase of the config
  page at `0x00300000`: `research/brick-2026-08-08.md`, and "Incident" in
  `research/firmware-flashing.md`. Lift this bar only once LDROM has been dumped
- Send any image that has not passed `ota.check()` (`bun run ota-check <image>`). It is
  the gate and it already encodes every limit here
- Relink the firmware, exceed **76,800 bytes** (the application region), or send OTA
  `type 2`. Flashing a *patched stock* app image over BLE is otherwise safe: the OTA
  stages at `0x29400` and never erases the running app. What is not safe is an image
  that fails to bring up BLE, since the OTA service lives in the app, and anything over
  ~84 KB, which erases the bootloader. Read `research/firmware-flashing.md` first
- **Overwrite a block of firmware without first scanning for branches into it.** The
  `LIGHT` arm at `abs 0x184a6` jumps into the middle of the `LOOP` block, and two of our
  own documents said that block had one entry point
- Commit vendor binaries: `apk/`, `decompiled/`, `native/`, `firmware/`
