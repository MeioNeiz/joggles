# Joggles

LED glasses, app Funky Glasses+. Protocol solved, verified on hardware.

Docs: `notes/protocol.md` for key, frames, geometry, command table.
`research/README.md` indexes the firmware/OTA teardown, the saved-content
subsystem and the full opcode inventory. Read `research/` before touching firmware.
**`notes/plan-after-the-brick.md` is the current plan**: three tracks, only firmware
delivery is blocked, and the SWD order of operations for when the probe arrives.
`research/firmware-internals.md` is what the firmware actually is, and it corrects
several entries below. `notes/what-to-build.md` is the plan: delivery routes, ranked
patches, festival ideas, and what we decided *not* to do. **`notes/app-plan.md` is the
phone app**: three features, the flash-wear budget that shapes them, the transport split
and the safety rules. `notes/firmware-design.md` is
the ground-up plan for our own firmware: the extension-framework architecture, wire
formats, staged roadmap and safety envelope. Keep findings in `research/` and judgement
in `notes/`.

**Adding to the docs: follow `notes/WRITING.md`.** It sets the confidence markers,
the lean-file rule, and why corrections are recorded rather than deleted.

**Working alongside other agents: `notes/parallel-tracks.md`.** One owner per file, a board
of open tracks, and the advisory locks for the two singletons (the glasses, the Pixel).
`.claude/locks/` is where every track has got to; the board is only what a track is. Read
it before touching anything if you were started as a track.

- Bun + TS only. No Python, no Go
- `packages/core` pure TS, zero deps. `packages/cli` noble/CoreBluetooth
- **The `@joggles/core` barrel has no OTA in it.** `ota`/`dfu` sit behind
  `core/src/firmware.js`, so reaching `fd00` is an explicit import and the phone app
  cannot do it by accident. `safe-surface.test.ts` fails the build if that leaks, or if
  anything the barrel reaches imports Node (React Native has no `Buffer`)
- `bun test` | `bun cli <probe|text|edge|off|bench|stress|ledger>` | `bun run ota-check
  <image>` | `bun run build-firmware` | `bun run flash <info|stage|commit>` | `bun run
  dumpcheck <dump>`
- Pre-flash verification, and the llvm-objdump recipe that produced it:
  `.claude/context/firmware-flash-readiness.md`
- Firmware analysis: `research/tools/fwtool.ts` (peek/xref/callers/modes/render/regions).
  **Use it instead of grepping the image**; its header explains the two scanning traps
  that have already put wrong entries in the docs. Patches: `research/tools/patch.ts`,
  which refuses any edit whose expected old bytes do not match
- **SWD, for when the probe lands:** `research/tools/swd-recon.sh <probe|ids|diag|dump>`
  is the read-only OpenOCD session and holds no write command by construction; `bun run
  dumpcheck` validates what it produces by diffing `abs 0x16800` against
  `ota.plaintext()` of a container, which proves the dump *and* the flash map at once.
  Order of operations: `notes/plan-after-the-brick.md`, Track B

## Our firmware: built, not yet flashed

`bun run build-firmware` emits `firmware/joggles-v1.bin`: stock plus an 88-byte `JGX1`
extension appended at `abs 0x26a24`, one 28-byte dispatcher hook, the crew AES key and an
advert rename. Design and reasoning: `notes/firmware-design.md`. Wire format:
`packages/core/src/jgx.ts`. Assembler: `research/tools/thumb.ts`.

The way onto the device is `bun run flash`, whose three subcommands are the safe
procedure in order: `info` (reads the version, writes nothing), `stage` (streams, never
commits), `commit --yes` (the one that writes). It runs `ota.check` against the stock
baseline before sending a byte and refuses on any fatal finding. `fd00` transport wire
format is `packages/core/src/dfu.ts`; **every `fd01` write starts with 2 bytes the
device discards**.

One opcode, `J`, whose first payload byte is a sub-command; every future feature is a new
sub-command in free flash and **no further edit to the vendor's code**. v1 has one,
`HELLO`, which reports version and capabilities. `bun cli probe` asks.

- The crew key lives in `firmware/crew-key.json`, generated on first build and gitignored.
  It is the credential for every unit flashed with it. Losing it is inconvenient, not
  fatal: the `fd00` OTA path is XOR-descrambled, not AES-encrypted, so stock can still be
  re-flashed (*derived*)
- **First flash should be `--stock-key --stock-name`**: extension only, 27 bytes of the
  vendor's code changed, vendor app and existing client still work. Separates "does the
  trampoline work" from "did the key swap work"
- A stock unit answers `HELLO` with **silence**, and so does a crew unit read with the
  wrong key. `probe` reports both as stock; check the key before believing it
- The hook costs `LOOP`: on our firmware any `L` opcode that is not `LIGHT` is ignored.
  It only did `set_mode(24)`, still reachable as `ANIM 19`

## Mental model

Renders on-device. Upload once, let it animate; don't stream. The saved store is
separate from the DIY live buffer, and the `MODE` family shows the saved store.
Wide buffers work: the app uploads ~200 cols and scrolls them unattended, with a
1.5 KB flash buffer behind it. App limits are not device limits.

**The MCU does not drive the LEDs.** The panel is a separate module on UART1 at
115200, fed one atomic 74-byte frame at a time. So greyscale depth and the
level-to-brightness curve are the module's, unreachable by any firmware patch, and
the ~6.4ms frame time is the real floor. There **is** an on-board button the firmware
polls: short press cycles built-in modes, 2s long press powers off (*derived*, pin and
addresses unconfirmed - re-derive before patching).

## Protocol quick reference

Service `fff0`, not `fee9`. Channels: `9600` cmds | `9601` notify | `960a` DATS
upload stream | `960b` live per-column and rhythm.

Save: `DATS <type> <len16>` -> `DATSOK` -> 15-byte blocks on `960a` -> `DATCP` ->
`DATCPOK`. type 1 text (2-byte cols), 2 image (3-byte cols). One buffer per type,
no slot index. `SMVEW 02` also saves (device honours it, app never sends it).

Banks are read-only: `IMAG 0-10`, `ANIM 20-29`. Mind the offset, `animation(3)` is
wrong and 23 is what you want.

## Code state

- **The sequencing is transport-agnostic.** `core/src/session.ts` is `Glasses`, driven
  through the `Transport`/`Scanner` interfaces in `core/src/transport.ts`;
  `cli/src/noble.ts` is the ~130-line noble adapter and `cli/src/glasses.ts` is only
  scan-connect-attach. `Glasses.open()` is gone: the CLI calls `open()` from
  `glasses.js`, anything else calls `Glasses.attach(transport, name)` with the
  connection already open. Tests run against `core/src/mock-transport.ts`.
  **Nothing since the extraction has touched hardware**: `bun cli text` is the
  regression gate and it has not been run. Run it before building on this
- **Saving writes flash, so `session.save()` is the choke point.** It is the only
  caller of `dats.datsComplete()` and `choke-point.test.ts` fails the build if a second
  appears. It goes through `core/src/budget.ts`: duplicate payload skips, and under 3s
  since the last save, 30/hour or 200/day **throws** rather than queues. The count is
  per device and persists (`.joggles/ledger.json` on the laptop); `bun cli ledger`
  prints it. Numbers and reasoning: "Flash wear" in `notes/app-plan.md`
- Send-side `DATS`/`DATCP` **is implemented** and verified: `Glasses.save()`
  does the full handshake and the device returns `DATCPOK`. It subscribes to
  `CHAR_NOTIFY`. Our own bitmap has been uploaded and left scrolling
  unattended. Receive side also exists: `dats.ts`, `decode-{dats,snoop}.ts`
- Use `protocol.mode(kind, dir)`: kind 1 static, 2 horizontal, 3 vertical, `dir` a
  boolean. *Corrected: `scrollLeft`/`scrollRight`/`modeStatic`/`modeFlash` were misnamed
  and are gone. `scrollLeft` sent `MODE 03` (vertical), `scrollRight` the dead `MODE 04`,
  and `modeFlash` implied a strobe rate where the byte is a direction*
- Several `protocol.ts` helpers build frames the firmware **ignores** (`queryType`,
  `invert`, `stopRhythm`, `leds`, `flashlight`, `lens`). Kept for decoding vendor
  traffic, grouped and labelled in the file. Never build a UI control on one
- `CHAR_BULK_A`/`_B` are not interchangeable: A is the DATS stream, B is live
- **Render to `content.Bitmap`, never straight to bytes.** `core/src/content.ts` is the
  one representation plus both encoders (`encodeSaved` picks the DATS type and reports
  `flattened`); `core/src/viewport.ts` is the 24-column window with `alive()` applied **at
  the window**, because masking a wide bitmap draws a hole that travels with the glyph.
  `dats.encodeImage` is type 2, and it is the live column format minus its
  `[04][index]` header (*derived* from two vendor encoders and two firmware paths,
  asserted against `Grid.toFrames` in `dats.test.ts`). `session.save()` still
  hardcodes type 1
- **The two saved ceilings are unrelated numbers**: 740 columns at type 1 (1480 bytes)
  and **383** at type 2, which is a column count, not a share of those bytes. The device
  buffers an image column as a 32-bit word and wraps at 384. Both *verified* on hardware.
  Use `content.maxColumns(type)`. *Corrected: this said 493, from dividing 1480 by type
  2's three wire bytes; `content.ts` did the same until 2026-08-09*
- **Only DATS type 1 persists** (*verified*). Type 2 stops in the RAM buffer `SMVEW 02`
  uses, so it survives a disconnect and not a power cycle, and the next `DATS` of either
  type wipes it. Since `savedType()` picks the type from whether the content has grey in
  it, **one grey pixel decides whether a save lasts**; force type 1 and show `flattened`
  when it has to. Type 2 costs no flash wear, though `session.save()` still charges it
- **A type 2 image displays on `DATCPOK` by itself, and `MODE` is a one-way door away
  from it.** No `MODE` is needed or wanted: `MODE 01`/`02` switch to the type 1 flash
  store and **nothing switches back**, so sending one after a type 2 upload destroys it
  (*verified*). Greyscale survives, checked by eye against a bright-half/dim-half block
- **Live pixels go through `core/src/sender.ts`, never a loop of writes.**
  `LiveSender` holds a desired grid and a believed-sent grid and writes the single
  next differing column, re-deciding after every write, so touches arriving mid-batch
  replace each other instead of queueing. `clear()` is one `CLRL`; `refresh()` after
  anything that moved the panel behind our back. It never enters or leaves DIY. Do not
  interleave `Glasses.show()` with it, they keep separate ideas of what was last sent.
  Tested against `mock-transport.ts`; **never run on hardware**

## Gotchas

- ONE 16-byte block per ATT write. Panel decodes first only, drops rest silently
- Write-without-response has no flow control. Pace writes or columns go stale
- Pacing-bound not hardware-bound, but the floor is ~6.5ms: one frame takes 6.42ms
  on the module's UART. Streamed full frames sweep visibly (24 x pacing to fill,
  58ms even at 2ms) because each column write pushes a whole frame; use DATS for
  clean motion, or the rhythm channel below
- **The rhythm channel sets all 24 columns in ONE write**, so it has no sweep at
  all: `[len][?][style][12 bytes]` on `960b`, two 4-bit bar heights per byte,
  heights 0-9, 4 styles. Bars only, but it is the sole atomic full-panel path
- `LEDOFF`/`LEDON` are **not implemented** and `LIGHT` floors at level 1. `CLRL`
  (undocumented, app never sends it) is the atomic clear. Note this contradicts the
  older note that `LEDOFF` darkens the panel; the opcode scan says it never matches
- `SMVEW 02` does **not** write flash (*derived*): it copies to RAM, so it survives a
  disconnect but not a power cycle. Only `DATS` **type 1** persists, and it lands in the
  same RAM buffer on the way. Power-cycle to check
- `SMVEW 00` restores the saved image, looks like stray pixels. Default `end('keep')`
- `MODE` while in DIY switches to saved content, discards the live buffer
- BLE = one connection per device, but one phone can hold several devices
- Env setup (macOS BT permission, noble `trustedDependencies`): README

## Geometry

9 rows x 24 cols **total, spanning both lenses** (~12 each; the "nose notch" is the
bridge). *derived* from the firmware sending one 24-col frame; one hardware test
settles it (light col 0, see if it lands on one lens). row 0 bottom, col 0 left.
Dead: top-row mid-6, nose notch. `display.alive()`.

Packing differs per channel. Live and DIY-image columns are 3 bytes at 2 bits per
pixel (row r -> bit 2r), big-endian on the wire. Col index >= 24 is dropped, not
wrapped. DATS text columns are 2 bytes at 1 bit per pixel, addressing the panel's 9
rows: bits 0-6 -> rows 1-7, bit 7 -> row 8, bit 15 -> row 0, bits 8-14 nothing, so
uploaded graphics reach all 9 rows. *Corrected: the old "14 rows in a 7+7 split" reading
was wrong, and `dats.ts` encoded it until 2026-08-09; it drew one row high and dropped
rows 7-8.* Still *derived* (two firmware paths agree, no hardware): one test settles it,
upload a column with only row 8 set and see if the top row lights.

`dats.encodeBitmap` takes **panel** rows, so 5-row text needs placing first:
`font.panelBitmap()` puts it at rows 2-6, the band alive across all 24 columns.

## Unverified

**How much of a type 2 image wider than 24 columns is ever visible**: `set_mode(26)`
copies only 96 bytes to the live buffer, so a 383-column upload is accepted and stored in
full and probably shows only its first 24. Whether 24 cols span both lenses or the module
mirrors.
Whether the display module accepts anything beyond brightness `0xa0-0xa5` and frame
`0x4a`. `LOOP` (firmware) vs `LOOA` (our notes). **How low live pacing goes**: 18ms per
column is copied from `Glasses`, never measured, and only `960a` bulk pacing was ever
bisected. **`CLRL` sent alone**, mid-session: it is the same instructions `SMVEW 01`
runs (*verified* at byte level) but no client of ours has ever sent it by itself.

Settled since: the odd bit is **brightness** - 4-level greyscale, confirmed on
hardware and used by `getAnim19`. `LEDFIRST`/`LEDSECOND`, `COLR`/`LEVL`/`POWR`,
`STYPE`, `EVERT`, `SCHD`, `CALL`, `MODE 07/08/09` are **absent from the firmware**,
not untested: it handles exactly 11 opcodes (opcode scan hand-checked). `MODE` 2nd
byte is boolean, 2 displays not 8 (*derived*). **`DATS` type 2 wider than the vendor's
72 bytes**: accepted to 383 columns, `ERROR` from 384, never written to flash, and
displayed on `DATCPOK` without a `MODE`. All four run on hardware 2026-08-09;
`bun run packages/cli/src/type2.ts` reproduces them.

Everything from the firmware teardown is tiered by trust in
`research/firmware-internals.md`'s Provenance section. Read it before patching.

## Don't

- **Send OTA ctrl `03` (commit) to anything.** On 2026-08-08 a *stock over stock*
  commit bricked `GLASSES-12C3EF`: staging fine, device's own CRC matched, it reset
  itself and never came back. The image cannot have been at fault, so the handoff into
  LDROM is. Read "Incident" in `research/firmware-flashing.md` first. `bun run flash
  stage` is still safe and was run on that unit with no harm; only `commit` is barred.
  Full postmortem and the SWD repair: `research/brick-2026-08-08.md`. The whole
  persistent change is `CONFIG0 = 0xFFFFFF3F`, clearing `CBS` to boot LDROM; the repair
  is one erase of the config page at `0x00300000`. Lift this bar only once LDROM has
  been dumped
- Send any image that has not passed `ota.check()` (`bun run ota-check <image>`).
  It is the gate, and it already encodes every limit below
- Relink firmware, exceed **76,800 bytes**, or send OTA `type 2`. Flashing a *patched
  stock* app image over BLE is safe: the OTA stages at `0x29400` and never erases the
  running app, so an aborted transfer costs nothing and we can re-flash stock
  ourselves. What is not safe is shipping an image that fails to bring up BLE (the
  OTA service lives in the app), and images over ~84 KB, which erase the bootloader.
  Read `research/firmware-flashing.md` before writing any flash.
  *Corrected: this used to say 66 KB, which is the stock length, and an appended
  extension necessarily exceeds it. 76,800 is the application region and the real bound*
- **Overwrite a block of firmware without first scanning for branches into it.** The
  `LIGHT` arm at `abs 0x184a6` jumps into the middle of the `LOOP` block, and the docs
  said that block had one entry point. Both `research/firmware-internals.md` and
  `notes/firmware-design.md` were wrong until the hook was actually built
- Commit vendor binaries: `apk/`, `decompiled/`, `native/`, `firmware/`
