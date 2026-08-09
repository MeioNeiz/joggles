# Saved content, wide buffers, and the opcode inventory

**Status:** recovered by reading the decompiled vendor app end to end. Everything
here is what the app **actually emits**, kept distinct from what its library merely
defines.
**Scope:** the persist-to-device path, device-side wide-buffer scrolling, the
complete opcode inventory, and every hard limit.
**Related:** `notes/protocol.md` (key, frame format, geometry),
`research/firmware-image-format.md` (firmware and OTA).

## Key facts

| Fact | Value | Confidence |
| --- | --- | --- |
| Real save mechanism | `DATS`/`DATCP` handshake, not `SMVEW 02` | verified from app source |
| `SMVEW 02` in the app | dead code, zero callers, though the device honours it | verified |
| Saved content slots | one buffer per type, no slot index in the protocol | verified |
| Content types | `1` = text, `2` = DIY image | verified |
| Which type persists | **type 1 only**; type 2 stops in RAM, shown by mode 26 | verified |
| Usable ceiling | type 1 **740 columns** (1480 B), the firmware's own bound being 743; type 2 accepts 383 and **shows 24** | 740, 383 and 24 verified; 743 derived |
| Displaying type 2 | automatic on `DATCPOK`; any later `MODE` discards it, permanently | verified |
| Upload length field | 16-bit, so up to 65535 bytes announced | verified |
| Device-side wide scroll | real: the app uploads ~200 columns and scrolls them unattended | verified |
| Flash ceiling for saved content | `0x600` bytes (1.5 KB) at `abs 0x3c000` | derived from firmware literals |
| Main service UUID | `0xfff0`, **not** `0xfee9` | verified |
| `MODE` second byte | direction flag in the app, 0 or 1 only | verified |
| `IMAG` range | 0 to 10 | verified |
| `ANIM` range | 20 to 29 | verified |

## Correction: the main service is 0xfff0

The app's `BleManager.UUID_SERVICE_TEXT` is `0000fff0-0000-1000-8000-00805f9b34fb`,
and that is what `onServicesDiscovered` matches on. `0000fee9` survives only as a
stale default constant in the base library's `AppConfig.java`.

The firmware declares both: `0xfff0` at body `0xc2ec` and `0xfee9` at body `0xc2f8`,
twelve bytes apart in the same table. Our own `packages/core/src/protocol.ts`
already uses `0xfff0` and connects successfully, so `0xfff0` is the one to build
discovery around. The GATT table in `notes/protocol.md` lists `0xfee9` and is the
stale entry.

## The DATS/DATCP upload handshake

This is the real "save to device" mechanism.

| Step | Direction | Frame and channel |
| --- | --- | --- |
| 1 | app to device | `DATS <type> <len_hi> <len_lo>`, frame `07 44 41 54 53 tt hh ll`, on `...9600` |
| 2 | device to app | notify `DATSOK` on `...9601` |
| 3 | app to device | stream `len` bytes on `...960a` as count-prefixed 16-byte blocks: `[count][up to 15 data bytes]` |
| 4 | app to device | `DATCP`, frame `05 44 41 54 43 50`, on `...9600` |
| 5 | device to app | notify `DATCPOK` on success, or `ERROR` on failure |

`type` is `1` for the text buffer and `2` for a DIY image; those are the only values
the app uses. Inter-block pacing is 50 ms for text and 60 ms for images.

All three reply strings are present verbatim in the firmware image at body `0x1dbc`
(`DATSOK`, `DATCPOK`, `ERROR00`), which independently confirms the handshake is
firmware-side rather than an app-only abstraction.

`DATCPOK` is the device confirming it has stored and verified the buffer. There is
no slot argument: one saved buffer per type.

Type 1 content lands in a `0x600`-byte buffer at `abs 0x3c000`, with an 8-byte metadata
record at `abs 0x3c800`, erased at 512-byte granularity, having been staged in an
identically sized RAM buffer at `0x200030ac`. 1536 bytes is 768 columns at 2 bytes per
column. *Corrected: the same 1536 bytes is **384** type 2 columns, not the 512 this
paragraph used to claim, because the staging buffer holds an image column as a 32-bit
word rather than the 3 bytes it arrives as. Type 2 also never leaves that RAM buffer.*

### Measured upload limits and timing

*verified* 2026-08-09 on `GLASSES-125B37`, stock, type 1 (text). Reproduce with
`bun run packages/cli/src/uploadbench.ts [cols]`. Read this before sizing content or
tuning pacing: two of the numbers above and in `notes/what-to-build.md` were wrong.

**The device accepts less than the buffer holds.** 740 columns (1480 bytes, 99 blocks)
returns `DATCPOK`; 745 columns (1490 bytes, 100 blocks) returns `ERROR`. Bisected from
both directions. So the usable ceiling is **740 columns of text, not 768** (~3.6% below
the buffer). *Corrected: the 768 figure above is the buffer's capacity, not what the
firmware will take, and was quoted as a usable limit throughout the notes.*

**Resolved since, from the firmware: bytes, and block count never enters into it.** The
true type 1 bound is **1486 bytes / 743 columns**, which this bisection brackets exactly.
`DATCP` at `abs 0x182e0` passes only when a running counter equals what `DATS` predicted;
type 1 starts that counter at 48 and adds 2 per column, and it resets to 0 at 1536, so
1490 bytes can never match. Mechanism and addresses: "`DATCP` is an exact-match gate" in
`research/firmware-internals.md`. *Corrected: the paragraph here used to call the choice
between ~1485 bytes and 100 blocks unresolved.*

**Type 2 does not share this budget.** Its ceiling is **383 columns / 1149 bytes**,
because the device buffers an image column as a 32-bit word and wraps the column counter
at 384. Dividing 1480 by three bytes per column gives 493, which the device answers with
`ERROR` after taking the whole upload. *verified* 2026-08-09 on `GLASSES-125B37`: 24 and
383 columns both answer `DATCPOK`, 384 answers `ERROR`. Reproduce with
`bun run packages/cli/src/type2.ts ceiling --yes`.

**Length is validated.** The rejection is a clean `ERROR`, not silent acceptance.
*Corrected: `notes/what-to-build.md` says "`DATS` validates nothing today" and that an
over-long announcement "silently wraps and still replies `DATCPOK`". At least the
oversize case is checked. The specific claim about lengths past 1536 is untested, so it
is narrowed rather than overturned.*

**Inter-block pacing floors at 6 ms**, against the vendor app's 50 ms. At 700 columns
(1400 bytes, 94 blocks):

| Inter-block sleep | Transfer | Connect to disconnect | Reply |
| --- | --- | --- | --- |
| 50 ms (vendor's) | 4984 ms | 5941 ms | `DATCPOK` |
| 25 ms | 2610 ms | 3529 ms | `DATCPOK` |
| 12 ms | 1382 ms | 2388 ms | `DATCPOK` |
| 6 ms | 1081 ms | 1998 ms | `DATCPOK` |
| 3 ms | 1084 ms | 1969 ms | `DATCPOK` |
| 0 ms | 5067 ms | 6020 ms | **no reply** |

**Below 6 ms the time moves rather than disappearing.** From 6 ms to 3 ms the paced
writes halve (564 ms to 282 ms) while the wait for `DATCPOK` grows (517 ms to 802 ms):
the device absorbs the backlog during `DATCP`. Totals are conserved, so nothing is won,
and at 0 ms it stops replying altogether. 50 ms to 6 ms is 4.6x on the transfer and 3x
on the full cycle.

**Connection setup is ~880 ms and fixed**, consistent across every run and independent
of pacing. Once the sleep is tuned it is 44% of the cycle, so further gains are in
connection setup, not the stream.

**`DATCPOK` does not prove the content arrived intact**, which bounds all of the above.
The device confirms it stored *something*. Verifying a fast pass means reading the panel
by eye, which is why `uploadbench.ts` uploads stripes every third column: dropped or
shifted blocks show as uneven spacing, where a fill would hide them. **The 6 ms figure
is verified as "acknowledged", not yet as "correct".**

### The live channel has no measured pacing floor at all

*unverified*, and easy to misread the table above as covering it. Everything measured
here is inter-block pacing on `...960a` inside one `DATS` upload. Nobody has bisected
`...960b`, where a drawing canvas writes one column at a time, and the two are not the
same path: a bulk block lands in a staging buffer, while a live column write pushes a
whole 74-byte frame at the display module.

What the code uses is **18 ms, copied rather than measured**: `Glasses` picked it and
`packages/core/src/sender.ts` inherits it. The only floor with evidence behind it is
~6.5 ms, one 74-byte frame at 115200 baud, *derived* in `firmware-internals.md` and
recorded there as needing one hardware test. The gap is worth closing because a
whole-panel change is 24 writes: 430 ms at 18 ms, 168 ms at 7 ms.

The experiment, one connection's work: `LiveSender` with `pacing` set to N, drawing a
pattern where a dropped column is visible instead of hidden - alternate columns lit, the
same trick `uploadbench.ts` uses for the bulk stream - bisecting N downward until a
column goes stale. Read the **end state**, not the animation: 24 writes sweep visibly at
any N, which is the hardware and not a dropped write.

## Channel routing

| Characteristic | Role |
| --- | --- |
| `...9600` | commands, including `DATS` and `DATCP` |
| `...9601` | notify, device replies |
| `...960a` | `DATS` bulk stream, count-prefixed blocks |
| `...960b` | live/real-time: per-column DIY writes and rhythm frames |

So the `[04][column][3 bytes]` format documented in `notes/protocol.md` is the
**live** format on `...960b`. The `DATS` stream on `...960a` is a different
encoding.

DIY mode is not required for `DATS` uploads: the text path never enters DIY. DIY
(`SMVEW 01`/`03`) is for the live channel only.

## Three distinct pixel encodings

Worth keeping straight, because they are easy to confuse:

- **live column** on `...960b`: `[04][column index][3 bytes]`, two bits per pixel
- **`DATS` type 1 (text)**: flat concatenation of **2-byte little-endian columns**, one
  bit per pixel, addressing the panel's **9 rows**: bits 0-6 are rows 1-7, bit 7 is row
  8, bit 15 is row 0, and bits 8-14 reach nothing. *Corrected: this entry read "14
  usable rows in a 7 plus 7 split", which put every uploaded graphic one row high and
  dropped rows 7 and 8. See "DATS bit mapping, corrected" in
  `research/firmware-internals.md`; `packages/core/src/dats.ts` encoded the wrong
  reading until 2026-08-09*
- **`DATS` type 2 (DIY image)**: 3 bytes per column, two bits per pixel. **Byte for byte
  the live column format with its `[04][index]` header removed**, which the vendor
  states twice: `DiyAgreement.getDiyBytes0924` and `LedView.getRealTime` pack the same
  canvas with the same ladders. The vendor allocates a fixed `byte[72]` and so only ever
  sends 24 columns; the firmware will take 383 and display the first 24 of them

## Wide buffers are real

The scrolling-text path is the proof:

- Glyphs are emitted as runs of 2-byte columns and concatenated into one flat buffer
  with no truncation to 24 columns.
- The whole buffer goes up in a single `DATS 01 <len>` handshake, where the length
  field *is* the width parameter.
- Only afterwards does the app send one `MODE` command, once.

The app's 40-half-width-character input cap works out at roughly **200 columns, or 8
times the panel width**, in around 400 bytes. That is comfortably inside both the
16-bit length field and the 1.5 KB flash buffer, so the 40-character cap is a UI
limit rather than a protocol or firmware one.

The 24-column ceiling on DIY images comes from the drawing canvas being initialised
at 24 by 9, not from the protocol. The live column frame carries a full byte of
column index.

### The experiment that was worth running, and its result

**Run on 2026-08-09.** The question was whether `DATS` type 2 accepts a length greater
than the vendor's fixed 72 bytes. It does, up to 383 columns.

| Sent | Reply |
| --- | --- |
| type 2, 24 columns (72 B) | `DATCPOK` |
| type 2, 383 columns (1149 B) | `DATCPOK` |
| type 2, 384 columns (1152 B) | `ERROR` |

Two things came out of it that the question did not ask. **The image displays on
`DATCPOK` with no `MODE` sent at all**, greyscale intact. And **`MODE` is a one-way door
away from it**: `MODE 01 00` and `MODE 02 00` both switch the panel to the type 1 flash
store and nothing switches back, so driving a type 2 image with `MODE` destroys it. The
original phrasing of this experiment, "then drive it with `MODE`", would have thrown away
the result it was trying to measure.

**Nothing type 2 sends reaches flash**: the image was on the panel before a power cycle
and the type 1 text was back after it. Mechanism and addresses: "`DATCP` is an exact-match
gate" in `research/firmware-internals.md`.

**And the width turned out not to buy anything.** Only the first 24 columns of a type 2
image are ever displayed: 383 columns with a lit head and a black tail left the panel lit
and unchanging for two minutes. `set_mode(26)` copies 96 bytes and nothing scrolls the
rest. So the answer to "can a saved drawing be wider than the panel" is yes for type 1 and
**no for type 2**, and the 383 figure bounds what is accepted rather than what is useful.

*Confidence, because the three rows in the table above and this paragraph are not equally
solid.* The table is device replies on the wire. This paragraph is a person reporting that
a panel did not change, which is a null observation and the weakest thing in this
document's `DATS` material. It agrees with the disassembly and is believed, but see "Only
the first 24 columns of a type 2 image are ever visible" in
`research/firmware-internals.md` for how it could still be wrong and what would settle it.

## Corrections to the command table

### MODE arguments

The live scroll commands come from `getContentCommand(i, i2)`, frame
`06 4d 4f 44 45 <i> <i2>`, called only from the text screen with:

- `MODE 01 00` static
- `MODE 02 <dir>` horizontal scroll
- `MODE 03 <dir>` vertical scroll

where `<dir>` is 0 or 1. The `getRollToLeftCommand`/`getRollToRightCommand` variants
that produced the "`MODE 03 n` = scroll left at speed n" reading are **dead code**,
and speed has its own opcode (`SPEED n`) regardless.

**Open tension.** The app source says the second byte is a direction flag, which
conflicts with the hypothesis that it is a content-slot index. But cycling
`MODE 01 <n>` for n = 0..7 was observed to produce different displays on hardware.
Both can hold if the firmware interprets the byte more liberally than the app uses
it. The app only ever sends 0 or 1, so anything richer is firmware behaviour the app
does not exercise.

### IMAG and ANIM ranges

- **`IMAG 0` to `IMAG 10`**, eleven built-in images.
- **`ANIM 20` to `ANIM 29`**, ten built-in animations. The app adds a hardcoded
  offset of 20, suggesting indices 0 to 19 are reserved in a unified index space.
- Both banks are **read-only built-ins**. No code path writes to a bank index. The
  Java `ImageData`/`AnimData` arrays are app-side preview thumbnails rendered
  locally, never uploaded, and there are no bank blobs in the APK assets. The real
  bank content is firmware-resident.

### Opcodes absent from notes/protocol.md

From the app's `Command.java`, defined but unused, so presumably firmware-supported:
**`COLR`** (colour, length 8), **`LEVL`** (level, length 6), **`POWR`** (power,
length 5).

### Dead code in this build

Defined in the library with zero callers: `SMVEW 02`, `STYPE` and its reply parser,
`LEDFIRST`/`LEDSECOND`, the `MODE 03`/`04` count form, `MODE 07`, `MODE 08`/`09`,
`MODE 02 hi lo` flashing, `EVERT`, `LIGHTON`/`LIGHTOFF`, `LEDON`/`LEDOFF`, `STOPR`,
`CALL`, `SCHD` and `STSC`.

Actually emitted by the app: `SMVEW 01`/`03`/`00`, `MODE <i> <i2>`, `ANIM 20-29`,
`LOOA`, `IMAG 0-10`, `SPEED n`, `LIGHT n`, `SOUT`, plus the `DATS`/`DATCP` handshake
and the two bulk streams.

**Dead in the app does not mean absent from the firmware.** Hardware testing already
showed `SMVEW 02` works, so this is a menu of things to try, not a list to discount.

## What the app reads back

Only three notify replies are ever parsed, and all three belong to the `DATS`
handshake: `DATSOK`, `DATCPOK`, `ERROR`. Nothing else on `...9601` is interpreted.

Consequence for the `STYPE` question: the app **never asks the device for its
geometry**. Its `parseType` only knows 5x36, 12x48, 14x56 and 16x64, none of which
match our 9x24 panel. There is no alternative geometry query hiding in the app, so
empirical mapping remains the only route.

## Hard limits, with sources

- **Text input:** 40 half-width units, an app-side UI cap. CJK counts as 2.
- **`DATS` length field:** 16-bit, so 65535 bytes maximum announced.
- **Flash buffer for saved content:** `0x600` bytes at `abs 0x3c000`.
- **DIY image:** fixed 72 bytes, 24 columns by 3 bytes, from a 24 by 9 canvas.
- **Glyph rasterisation:** the app rasterises text itself at 12 by 12 using bundled
  TTFs (`assets/fonts/typeface1456.ttf`, 18.6 MB) plus a hardcoded glyph table. It
  does **not** rely on a device font. The firmware does carry a small 5-row glyph
  strip and a "Cool" bitmap for its own built-in content, so both exist and serve
  different purposes.
- **Bulk chunking:** 15 data bytes per 16-byte block, consistent with the
  one-block-per-write rule.
- **Rhythm mode:** 16-byte frames `[15][subchannel][12 bytes]` streamed on
  `...960b`, not persistent. Twenty mode constants exist, `MODE_RED_GRADUAL` to
  `MODE_WHITE_FLASH`.
- No max-frames or max-animation-length constant exists, because animations are
  firmware built-ins rather than uploads.

## What this means for the rendering complaint

Better rendering does not need a firmware flash. The device is not a dumb frame
buffer: it accepts a wide buffer through a verified handshake, stores it in 1.5 KB of
flash, and animates it unattended.

The vendor app's limits (40 characters, 24-column images, one buffer per type,
phone-side rasterisation at 12 pixels) are app limits sitting on top of a protocol
that is demonstrably more capable.

Highest-value next steps, none of which risk the hardware:

1. Implement `DATS`/`DATCP` for type 1 and drive it with our own rasteriser, which
   already produces better output than a 12-pixel TTF render for a 6-row band.
2. Test `DATS` type 2 with a buffer wider than 72 bytes.
3. Sweep the `MODE` second byte, and the `COLR`/`LEVL`/`POWR` opcodes the app never
   touches.
