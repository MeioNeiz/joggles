# Saved content, wide buffers, and the opcode inventory

**Status:** recovered by reading the decompiled vendor app end to end. Everything
here is what the app **actually emits**, kept distinct from what its library merely
defines.
**Scope:** the persist-to-device path, device-side wide-buffer scrolling, the
complete opcode inventory, and every hard limit.
**Related:** `notes/protocol.md` (the key, the geometry, the command table and how each
was established), the `packages/core/src` docblocks (the wire formats themselves),
`research/firmware-image-format.md` (firmware and OTA).

## Key facts

| Fact | Value | Confidence |
| --- | --- | --- |
| Real save mechanism | `DATS`/`DATCP` handshake, not `SMVEW 02` | verified from app source |
| `SMVEW 02` in the app | dead code, zero callers, though the device honours it | verified |
| Saved content slots | one buffer per type, no slot index in the protocol | verified |
| Content types | `1` = text, `2` = DIY image | verified |
| Which type persists | **type 1 only**; type 2 stops in RAM, shown by mode 26 | verified |
| Usable ceiling, type 1 | **740 columns** (1480 B), the firmware's own bound being 743 | 740 verified on the wire; 743 derived |
| Usable ceiling, type 2 | accepts **383 columns**, shows only the first **24** | 383 verified on the wire; **the 24 is derived**, a null observation by eye: see "Confidence" below and `content.MAX_IMAGE_COLUMNS` |
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
discovery around.

## The DATS/DATCP upload handshake

The real "save to device" mechanism. The five steps, the frames and both payload
encodings are in `packages/core/src/dats.ts`'s docblock; here is what that docblock
cannot say.

**Vendor pacing between blocks is 50 ms for text and 60 ms for images**, and the app
announces only `type` `1` (text) or `2` (DIY image). What that pacing is worth is
measured in "Measured upload limits and timing".

All three reply strings are present verbatim in the firmware image at body `0x1dbc`
(`DATSOK`, `DATCPOK`, `ERROR00`), which independently confirms the handshake is
firmware-side rather than an app-only abstraction.

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

### The live channel's pacing floor: 6 ms holds (verify item 7, answered 2026-08-12)

***verified*, and it is three times lower than what the code uses.** `bun run
packages/cli/src/verify.ts pacing 6` lit alternate columns on `GLASSES-125B37` with 6 ms
between writes. Jacob, by eye: **12 lines, every gap the same**. Twelve of twelve is the
full set, so **nothing was dropped at 6 ms**, and the end state was read rather than the
sweep, which is what the method below asks for.

**Say it as a bound, not a constant.** What is proven is that the floor is *at least as
low as* 6 ms on this link, in this room, on one connection. BLE negotiates its interval
per connection and a crowded radio environment can be slower, so code should take most
of the win and keep headroom rather than sitting on the measured edge. It was not
bisected further: 6 ms was chosen as the first probe because it is the frame time the
firmware implies, and it passed, so nothing below it has been tried.

**What it is worth.** A whole-panel live change is 24 writes: **430 ms at 18 ms, 144 ms
at 6 ms**. On the bulk path the same headroom is what separates a ~6 s full-width upload
from a ~2 s one, which is the wait behind Jacob's *"it seems to keep having to send the
animation to the device"* (`notes/what-to-build.md`, 2026-08-12 second batch).

The paragraphs below are the state before that run, kept because the method is the part
worth reusing and because the 18 ms number is still in the code.

*unverified* as written, and easy to misread the table above as covering it. Everything measured
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
  sends 24 columns; the firmware will take 383 (*verified* on the wire) and display the
  first 24 of them (*derived*: a null observation by eye, see "Confidence" below)

## Both scroll directions gap, and there is no seamless one (verify item 3, 2026-08-11)

**Neither direction loops seamlessly.** A wide type 1 loop was scrolled both ways on
`GLASSES-125B37`, same content and same save, changing only the direction byte of
`MODE 02 <dir>`. Jacob, by eye, driving the app's own Effects screen.

| Claim | Confidence |
| --- | --- |
| Both directions show dead space between repeats | ***verified***, both looks by eye |
| Neither direction is seamless | ***verified*** by the same looks |
| **The dead space sits at a different point in the pass per direction: one direction shows it at the *beginning* of the animation** | ***verified***, Jacob's own account of what he saw |
| The other direction therefore shows it later in the pass, which is why it read as seamless at first | *derived*, one step from the line above |
| Left-scrolling is the one that shows it later, and `MODE 02 00` is left-scrolling | *derived* twice over: on his "scrolling left i didnt see the cut off as quickly", and on the app's own Dir 0 label |
| Whether the two dead spaces differ in *size* | **not established.** Neither was measured |
| Whether it is ~24 columns or ~48 | **open**, the same question `research/loop-gap-2026-08-10.md` asks. The mechanism below predicts 24 |

**The mechanism this fits, and it is the store's own layout.** `DATCP` records
`ncols = N + 48` with the content starting at store column 24 (`abs 0x1833e`), so the record
is `[24 blank][content N][24 blank]`. A pass that begins at the content and runs **forward**
meets the trailing blank at the **end** of the pass; a pass that runs **backward** from the
content meets the leading blank **immediately**, at the **beginning**. That is exactly the
asymmetry observed, it needs no new firmware behaviour to explain, and it predicts **one**
panel width of dead space in both directions rather than two. *derived*, but it is now
*derived* with an observation behind it instead of against it: direction selects **which**
bracket a pass walks, not **how many**.

***Corrected twice on 2026-08-11, and the second correction is the substantive one.***

1. First written as "left-scrolling saves loop seamlessly, right scrolling have a big gap",
   *verified*, with a conclusion drawn: that direction was a variable the single-number
   bracket model in `core/src/dats.ts` failed to account for, and that the app should
   default to "the seamless direction".
2. Jacob: *"Neither direction was seamless, its just scrolling left i didnt see the cut off
   as quickly."* Rewritten to say both gap, and that the difference was perceptual.
3. Jacob again, and this is the part the second pass **dropped**: *"both scrolling
   directions have a dead space just one direction shows it at the beginning of the
   animation so i saw it earlier."* The difference is **where in the pass the dead space
   falls**, which is a fact about the device, and the second pass had recorded it as a fact
   about the viewer's attention. Flattening an observation into "the user did not notice"
   threw away the only mechanism on offer.

**What this settles and what it does not:**

- **The bracket model stands and is better supported than before.** It yields one number,
  the observations show one number, and the direction asymmetry falls out of the layout.
- **There is no seamless direction**, so a UI must not offer one.
- **But there is a direction worth defaulting to**, which the second pass wrongly concluded
  there was not: the one that puts the dead space at the **end** of a pass. It is the same
  amount of blank either way, and it reads as a loop finishing rather than as an app that
  failed to start. On the labels we have, that is left-scrolling, `MODE 02 00` (*derived*).
- **The 2026-08-10 contrary observation still stands unexplained**: a solid 32-column block
  that looped with no dark pass at all in the session that saved it. Direction does not
  explain that away, so track 16's two looks remain the experiment that settles whether the
  blanks are unconditional or follow a restore from flash.

**What is still worth one look**, needing no flash since the content is already saved: at
the slowest `SPEED`, is the dead space about **one** panel width or about **two**? One
confirms the mechanism above; two means both brackets are crossed and the mechanism is
wrong. `loop-gap-2026-08-10.md` predicts times for the same measurement.

**What the app can do.** Not remove it: the blank columns are the firmware's own, so the
only route to a truly seamless loop is the JGX sub-command that patches the wrap bound,
blocked on SWD delivery. What it can do is **default to the direction that hides the dead
space at the end of the pass, and stop implying seamlessness is available** - which is what
the `effects.ts` docblock already says in its own words: what a wide loop cannot promise is
that the panel shows no join.

**On verify item 3.** The remaining half was "one look at a scrolling save, plus direction
1", and both looks have now happened on our own uploaded content. Direction 1 scrolls and
does not misbehave, so the item is answered as far as it asked. What it did not ask, and
what these looks could not settle, is the size of the gap either way.

## The sitting, 2026-08-12: six looks at the panel, no flash spent

**The first time anyone has watched this panel since 2026-08-09**, and it graduated four
claims this repo was already building on. Jacob at the glasses, `packages/cli/src/verify.ts`
driving from the Mac, one subcommand per look, each printing what to look for before it
sent anything. **No `DATCP`, so zero page erases**: every command here is `SPEED`, `MODE`,
`SMVEW`, `CLRL` or a live column write, all of which stay in RAM.

| # | Look | Answer | Was |
| --- | --- | --- | --- |
| 0 | power-up, nothing connected | our saved word, animated by the device itself | never observed |
| 1 | `MODE 02 00` | travels **left**, blank between passes | one accidental sighting |
| 2 | `MODE 02 01` | travels **right**, blank between passes | **never sent, ever** |
| 3 | column 0 lit in DIY | **one** column, the leftmost | *derived* |
| 4 | `CLRL` alone on a lit panel | panel goes dark and stays dark | *derived* from a hand decode |
| 5 | live pacing 6 ms | 12 of 12 columns, no drops | 18 ms, copied never measured |
| 6 | `ANIM 0` | assembles from the bottom left | two readings, both unprovable |

### The device animates our saved content by itself, and `MODE 03` is how

**On power-up, with nothing connected, `GLASSES-125B37` restored the word saved in its
flash store and played it bouncing up and down while travelling left.** Jacob, by eye,
*verified*. Before the power cycle the same word had been sitting **static**.

His reading, and it fits without needing anything new: **`MODE 03` is the vertical bounce
and its second byte is a direction**, so it bounces *and* travels. *derived*, from one
observation plus the command table.

**This corrects a claim `notes/app-plan.md` makes twice**: that the saved route's motion is
"horizontal translation only". It is not. The saved store also gets a two-axis bounce for
the same zero flash, zero radio and zero connection, and **the app offers only `MODE 02`**.
`MODE 03` is a free motion nobody has exposed.

It also explains the unexplained state in `.claude/locks/track-16`: the panel found showing
a saved word **static** with nobody having commanded it. The device chooses a mode on its
own, so an uncommanded display state is normal rather than evidence of a stray write.

### Direction is settled, and both directions gap

Dir 0 travels **left**, dir 1 travels **right**, both *verified* by eye on 2026-08-12, and
**dir 1 had never been sent to a device in the life of this project**. That upgrades two
rows in the table above from *derived* to *verified*: `MODE 02 00` is left-scrolling, and
the left-scrolling default the app ships is the direction it meant to choose.

Both showed the panel go **fully dark between passes**, which is the third independent
sighting of the blank bracket and the first on content the device restored from flash with
no save anywhere in the session.

**The size still cannot be read off this, and that is the honest limit.** `review-16`
re-decoded the wire log the same night: the payload in flash is a 24-column save whose
**own bitmap carries a 10-column blank run**, so what was watched is the content's blanks
plus the device's bracket. What it proves is that a **24-wide window went fully dark at
all**, and ten blank columns cannot do that alone, so the bracket exists and does not
depend on having just saved. Whether it is 24 or 48 is still open, and the clean subject
for that measurement was already on the wire and unread: the 240-column loop of 2026-08-11
23:46, whose longest blank run is zero.

### One 24-wide surface, not two mirrored halves (verify item 2, answered)

Lighting **column 0 only** in the live buffer lit **one** column, at the leftmost edge.
*verified*. Two mirrored 12-wide surfaces would have lit a column on **each** lens, so the
panel is a single 24-column surface spanning both eyes and `packages/app/src/draw/` is
right as built. This was a UI decision, not a detail: it is the difference between one
canvas and two.

**One ambiguity survives, and it is exactly 180 degrees.** Jacob reported "left most
column" without saying whether he was wearing the glasses or facing them, and holding them
up swaps left and right. So *which end* column 0 sits at is *derived*, while *how many
surfaces there are* is *verified*. One word at the next sitting closes it.

Incidental, from look 4: with bars at columns 2, 11 and 20, he read the middle bar as
slightly left of centre. That is arithmetically right (11 of 0-23, centre 11.5), so
**column addressing runs linearly across the nose bridge with no hidden offset at the
join** (*derived*, one look).

### `CLRL` clears the panel (verify item 6, answered)

**Three separated vertical bars, then `CLRL` alone with nothing following it, and the panel
went dark and stayed dark.** *verified*, 2026-08-12.

This matters more than its size suggests: `CLRL` is undocumented, the vendor app never
sends it, and `core/src/sender.ts` marks all 24 columns known-blank the instant it goes
out. Had it been a no-op, the sender's model of the panel would have been silently wrong
after every clear. `clear({ atomic: false })` can stop being kept as a hedge.

**Not established: whether it clears all at once or wipes across.** Jacob was asked and
reported only that it went dark, so the word "atomic" in that path is still *derived*.

### `ANIM n` is mode n + 5 after all (track 20's contradiction, resolved)

`ANIM 0` played an animation that **appears from the bottom left**, continuous, with the
restart too hard to see. The firmware decode says `anim-0` is mode 5, 31 frames, and its
first frames assemble upward and rightward **from a three-pixel block at the bottom left**
(`bun run research/tools/bankdump.ts show anim-0 --all`). That signature matches, so:

- **`ANIM n` selects mode n + 5** is *verified* by behaviour, and `app/src/builtins.ts`
  `commandFor()` is right, so the 30 built-in tiles in the app show what they claim.
- **The vendor app's `ANIM 20-29` is a different convention of its own**, not evidence
  against the firmware reading. `protocol.animation`'s docblock can stop calling it
  disputed.
- The 3.7 s cycle is **not** confirmed: the restart was not visible to the observer.

### What the sitting did not answer

**Verify items 1 and 5 are untouched**, because both need the one save this sitting
deliberately did not spend: whether DATS bit 7 lights row 8 (the row mapping under every
rendered pixel, still *derived* from two firmware paths), and whether `MODE 02` scrolls
content narrower than the panel. `verify.ts rows --yes` does both in one save, five page
erases, and its content is a single row-8 line whose breaks at the dead pixels make the
reading self-checking.

Also unread: whether the scrolled word rendered **the right way up and unmirrored**, asked
twice during the sitting and not answered. It is free evidence for the row mapping the next
time anyone looks, since `BASS` is asymmetric top to bottom in every letter.

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

Reproduce with `bun run packages/cli/src/type2.ts ceiling --yes`. The mechanism is a
column counter that wraps at 384 because the device buffers an image column as a 32-bit
word: `content.IMAGE_ACCEPT_CEILING` has the addresses, and the correction of an earlier
493 read off type 1's byte budget.

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
- **Rhythm mode:** frames `[0d][style][12 payload bytes]`, 13 body bytes padded to a
  16-byte block, streamed on `...960b` and not persistent. *derived*, off the
  disassembly, and nothing has been sent to hardware. Twenty mode constants exist,
  `MODE_RED_GRADUAL` to `MODE_WHITE_FLASH`. *Corrected: this read
  `[15][subchannel][12 bytes]`, which is wrong and does not even add up to 16 bytes.
  There is no subchannel and no fourth field; byte 1 is the style. The error came from
  counting the handler's own offsets as wire offsets, and the handler is passed a
  struct whose frame data starts one byte in, so its `[frame+2]` is wire index 1.
  Byte-level walk: `research/rhythm-channel.md`. Encoder:
  `packages/core/src/rhythm.ts`.*
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
