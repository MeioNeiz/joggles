# The rhythm channel, byte for byte

What the `...960b` full-panel path actually accepts, and the two conditions under
which it is ignored. Written for track 9, whose encoder is
`packages/core/src/rhythm.ts`.

A separate file rather than an edit to `research/firmware-internals.md` because that
file belonged to another track and was under review while this was written. It corrects
three entries there and one in `research/vendor-app-protocol.md`. *All four were folded
into those files on 2026-08-11, so this is no longer the only account: this file remains
the byte-level walk, and they carry the conclusions.*

Offsets are `abs`, as everywhere. Reproduce with the recipe at the end of
`firmware-internals.md`, then read `abs 0x186b4`, `0x201c0` and `0x21b04`.

## Provenance

*derived*, all of it: hand-decoded from the disassembly in one session, nothing sent
to hardware. It is the same tier as the entries it corrects and it should be read
with the same suspicion. `packages/cli/src/rhythm.ts send --yes` is the settling
test and **it has not been run**: on 2026-08-09 the unit did not answer two 20-second
scans, so the session did not happen.

What would show up first if this is wrong: the panel stays dark, or it draws the
wrong style. A single wrong column instead means the frame reached the
single-column store, which is the DIY failure described below.

## The frame has three fields, not four

    [0d][style][12 payload bytes]        13 body bytes, padded to 16, on 960b

`protocol.frame('', style, ...payload)` builds it, the same builder as every command.
There is no unknown byte and no subchannel.

**Two documents say otherwise and both are wrong the same way.**
`firmware-internals.md` records `[len][?][style][12 payload bytes]`, and its Unverified
list carries "the exact rhythm frame framing at offsets 0 and 1" as an open question.
`vendor-app-protocol.md` records `[15][subchannel][12 bytes]`, which does not add up
to a 16-byte block. Both come from reading the handler's own offsets as wire offsets.

They are not wire offsets. `firmware-internals.md` establishes this for the command
dispatcher and then does not apply it here: **the handlers are passed a struct whose
frame data starts one byte in, so `[r0 + n]` is wire index `n - 1`.** The GATT write
callback at `abs 0x201c0` is where the shift happens. It decrypts into one buffer and
copies into another, `OUT[k+1] = IN[k]`, one byte higher, for `len + 1` bytes; the
length byte itself lands at `OUT[0xfb]` where the dispatcher's length gate reads it.

Applied to the rhythm handler at `abs 0x21b04`:

| Handler reads | Wire index | Field |
| --- | --- | --- |
| `[r0+2]`, `ldrb r3, [r0, #0x2]` at `0x21b06` | 1 | style |
| `[r0+3..14]` | 2 to 13 | 12 payload bytes |
| never read by this handler | 0 | length, gated earlier at `[r0+0xfb]` |

Two independent checks that the shift is real, both in code already trusted:

- The single-column store at `abs 0x20694` reads its column index at `[r0+2]` and its
  three pixel bytes at `[r0+3..5]`. Our own `protocol.column` puts the index at wire
  index 1 and the pixels at 2 to 4, and that is confirmed on hardware by every DIY
  frame this repo has ever drawn.
- `firmware-internals.md`'s own `ANIM` and `DATS` derivations, which arrive at the
  same `[r4 + n + 1]` from the dispatcher side.

So the length byte is 13. Nothing reads it for its value: the gate is a range,
4 to 20 at the dispatcher and 6 to 20 on this path, so 13 is what the frame builder
produces rather than a constant the firmware demands.

## Two conditions, and the failure modes are different

`abs 0x186b4` is the whole of the `...960b` routing, and it decides in this order:

1. **Wire length `<= 5`** goes to the single-column store, always. Every live column
   write is length 4, so `LiveSender` is untouched by everything below.
2. **`SMVEW` mode 1 or 3**, the two DIY modes, sends the frame to the single-column
   store too, whatever its length. The global is `0x2000309c`, written by the
   `SMVEW` arm at `abs 0x1843e`.
3. **The panel power flag at `0x2000306d` must be 1**, or the handler returns having
   done nothing.

Only then is `abs 0x21b04` called.

**Condition 2 corrupts rather than ignores.** A rhythm frame sent from inside DIY is
handed to a store that reads `[r0+2]` as a column index and `[r0+3..5]` as pixels, so
the style byte becomes a column number and three payload bytes become that column's
pixels. Style 0 to 3 all pass its `cmp #0x17` bounds check. The result is one wrong
column, quietly, not a no-op. **So leave DIY first, and never interleave rhythm
frames with `LiveSender`,** which owns the live buffer for its whole lifetime.

**Condition 3 is the button.** `0x2000306d` is byte 1 of the struct at `0x2000306c`,
which is why a scan for it as a literal finds only reads: the one site that sets it
to 1 computes the address as base+1. Zeroed at init (`abs 0x215ce`), set to 1 at
`abs 0x21688` in the button handler, cleared again at `abs 0x21866`. The other three
readers are consistent with a power state - the battery sampler only runs when it is
1 - so it is most likely "the display is switched on", and rhythm frames sent to a
unit nobody has switched on go nowhere. *derived*, and the cheapest confirmation is
the hardware run, which fails in exactly this way if the reading is wrong.

## Which mode to be in, which is not obvious

The animation engine keeps ticking while rhythm frames arrive, and whether it fights
them depends entirely on which buffer the current mode's per-tick handler repaints
from. There are two buffers and the distinction decides the whole feature:

| Buffer | What it is | Written by |
| --- | --- | --- |
| `0x200036ac` | live column buffer | live column writes, `CLRL`, **the rhythm handler** |
| `0x200030ac` | saved RAM buffer | `DATS` type 2, `SMVEW 02` |

**Mode 1 is the mode to be in.** Its tick at `abs 0x2206c` counts to 11 and then
pushes `0x200036ac`, the live buffer, so it re-pushes whatever the rhythm handler
last wrote. It refreshes our own bars rather than erasing them. Mode 0's tick is a
bare `pop` and is equally safe, but nothing that leaves `SMVEW` out of DIY selects it.

**Mode 26 is the one to avoid.** It repaints from `0x200030ac` every 6 ticks, 8.3 Hz,
and would erase the bars.

Which of the two you land in depends on something easy to miss. `SMVEW 00` and
`SMVEW 02` both run the copy loop at `abs 0x1845c`, which copies the live buffer into
the saved buffer and then branches on whether **any column was lit**:

- live buffer empty: `set_mode(1)`, and the `SMVEW` global stays as sent.
- live buffer lit: the `SMVEW` global is overwritten with **2** and `set_mode(26)`.

So the preparation is two commands and the order matters. `SMVEW 01` stops the
animation engine and clears the live buffer (both already *verified* at byte level in
`firmware-internals.md`); `SMVEW 00` then leaves DIY with that buffer empty and lands
in mode 1. Leaving DIY with pixels still lit puts the unit in mode 26 instead.

`SOUT` is not a rhythm command. Its arm at `abs 0x183c4` is `set_mode(1)` and nothing
else, so it is a synonym for `MODE 01 00` and does not touch either gating global.
`protocol.exitRhythm`'s name is a description of what the vendor app used it for.

## The bar tables, and what each style does

Confirmed by reading the words, and they agree with `firmware-internals.md`.

| Table | `abs` | Words |
| --- | --- | --- |
| solid | `0x22da8` | `0, 3, f, 3f, ff, 3ff, fff, 3fff, ffff, 3ffff` |
| tapered | `0x22dd0` | `0, 3, f, 3f, bf, 2bf, abf, 1abf, 5abf, 15abf` |

A word is a live column: two bits per pixel, so `0x3ffff` is nine rows at level 3 and
`0x15abf` is rows 0-2 at level 3, 3-5 at level 2, 6-8 at level 1.

**The four styles differ in bar width, not in animation.** Each fills all 24 columns
and each reads only as many payload bytes as its bars need; the rest are sent and
ignored. This is new here: `firmware-internals.md` records only which table each
style uses.

| Style | Bars | Columns each | Gap | Table | Payload bytes read | Loop bound |
| --- | --- | --- | --- | --- | --- | --- |
| 0 | 24 | 1 | 0 | solid | 12 | `cmp r3, #0xc` at `0x21b6a` |
| 1 | 24 | 1 | 0 | tapered | 12 | `cmp r3, #0xc` |
| 2 | 12 | 2 | 0 | tapered | 6 | `cmp r3, #6` at `0x21c30` |
| 3 | 8 | 2 | 1 | tapered | 4 | `cmp r3, #4` at `0x21cb8` |

*Corrected: the style 0 bound first read `0x21b68`, off by 2; the `cmp` is at
`0x21b6a` (bytes `0c 2b` re-peeked during review-9, `e4 b2` uxtb sits at `0x21b68`),
which is where `firmware-internals.md` already had it.*

Two heights per byte, **low nibble first**, so bar `2n` comes from `byte & 0xf` and
bar `2n+1` from `byte >> 4`.

**An out-of-range height blanks its column rather than topping out.** Every arm does
`cmp #0xa; blo; movs #0` - a height of 10 or more is replaced with **0**, not clamped
to 9. `firmware-internals.md` says "clamped to `< 10`", which reads as saturation and
is not what the code does. It matters because the natural bug in an audio meter is a
bar that overshoots on the loudest beat, and the panel's response to that is to go
dark exactly then. `rhythm.encode` clamps on the host so the firmware's own rule
never fires.

## What is worth knowing beyond this file

The handler writes straight into the live column buffer and then pushes one frame, so
the cost of a full-panel update is **one BLE write** against 24. That is the reason
to care about a channel that can only draw bars. `notes/what-to-build.md` has the
festival ideas that want it.
