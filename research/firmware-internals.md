# Firmware internals: the application region

**Status:** the application region is disassembled. This document is about what the
firmware *is*, as opposed to how to flash it (`firmware-flashing.md`) or how the
container is built (`firmware-image-format.md`).
**Scope:** the display module, the on-board button, the command dispatcher and its
real opcode set, the animation engine, and what a patch would and would not buy.
**Reproduce:** see "Reproducing" at the end.

Offsets are `abs`, i.e. flash addresses. `abs = body + 0x16800`.

## Provenance: read this before trusting an address

This document was produced in **one session** of automated disassembly, so it is exactly
the kind of file `notes/WRITING.md` warns about. Two tiers of trust, and they are marked
throughout:

- **Hand-checked against the bytes**, by reading literals and disassembly directly: the
  UART display module, the rhythm channel handler and its bar tables, the opcode letter
  set, the peripheral-absence scan, `rand()`/`srand()`, the notify sender and its callers,
  the 72-byte frame format, the free-space figure, and every measured number in the
  greyscale and compression tables.
- **From automated disassembly only, not independently confirmed**, and therefore marked
  *derived* even where the underlying analysis sounded certain: the `SMVEW 02` behaviour,
  the saved-content constants, and the SRAM budget.

**Graduated to hand-checked in a later session**, by re-reading the bytes: the whole
button section including the P5.2 pin, its RAM struct and its cycle constants; the `MODE`
dispatch tables and every mode's handler; the animation bank inventory and both frame
formats; and the `DATS` bit mapping (confirmed independently, from the animation path
rather than the receive path). Those sections say so where they stand.

**Method warning for anyone extending this file.** Animation bank data occupies
`abs 0x22df8`-`0x268f6`, 22.9% of the image, and produces plentiful coincidental 32-bit
words: 129 of them land in the `0x30000`-`0x40000` flash range alone. A "referenced N
times" claim from an unfiltered whole-image scan is worthless, and one such claim (a
"vendor data sector at `0x3f000`") survived several sessions before being caught. Scans
for *presence* must exclude the bank range; `BL` targets and `LDR` pool resolution are
safe because their encodings are distinctive; claims of *absence* are safe too.

**Before writing a patch against any address in the second group, re-derive it.** Several
of those claims contradict long-standing entries in `notes/protocol.md`, and a wrong
address in a flash patch is expensive in a way a wrong sentence is not.

## Headline: the MCU does not drive the LEDs

**The panel is a separate display module on UART1.** The PAN1020 assembles a whole
frame in RAM and DMAs it out at 115200 baud. There is no matrix scan loop, no PWM
block, and no GPIO output writes anywhere in the image. *verified*: `abs 0x18114` is
the only egress path, and its literal pool holds `0x50002000` (DMA) at `abs 0x18154`
and `0x40101000` (UART1) at `abs 0x18158`. `UART_Open` is called with
`0xe1 << 9 = 115200` and `SYS->P2_MFP |= 0x30`, putting TX/RX on P2.4/P2.5.

This reframes several questions that looked like firmware problems:

| Question | Answer |
| --- | --- |
| Can a patch improve greyscale separation? | **No.** The module owns the level-to-light curve |
| Can a patch add more than 4 greyscale levels? | **No.** Same reason |
| Is double buffering worth adding? | **No.** Every update is already one atomic packet |
| What is the real frame ceiling? | ~6.4 ms, i.e. 74 bytes at 115200 baud. ~155 Hz |

Consequence worth keeping: the levels-are-hard-to-distinguish finding in
`notes/protocol.md` is a property of the display module, not of our encoding or of
the firmware, and no amount of flashing will change it.

### The module protocol

`[total_len][payload][8-bit sum]`, *verified* from the `.data` initialiser of the
brightness buffer at RAM `0x2000266b` (flash `abs 0x26983`), which reads `03 a5 a8`:
length 3, payload `0xa5`, checksum `0x03 + 0xa5 = 0xa8`.

| Packet | Bytes | Meaning |
| --- | --- | --- |
| brightness | `03` `a0+n` `sum` | `n` is 1 to 5, clamped by the dispatcher |
| frame | `4a` `24 x 3 bytes` `sum` | all 24 columns, one packet, atomic |

**Only these two are known.** The module is an undocumented third party in the system
and it may well accept more. Probing it is cheap and needs no flashing: UART1 TX is
on P2.4 at 115200, so a £3 USB-serial adapter can watch the real traffic, and a
second one can talk to the module directly. That is the highest-value physical
experiment available and it carries none of the risk of an SWD session. *unverified*
whether anything beyond `0xa0`-`0xa5` and `0x4a` is accepted.

## The panel is one canvas across both lenses

*derived*. *It contradicted `CLAUDE.md`'s "24 cols/lens", which was corrected on
2026-08-09 and now reads "24 columns spanning both lenses". Kept as the record of where
the wrong figure came from.*

The firmware emits exactly one 24-column frame to one port, and the alive map in
`notes/protocol.md` shows a nose notch in the **middle** of the 24-column grid. A
notch mid-lens makes no physical sense; a notch at the nose bridge does. So the 24
columns span **both** lenses, roughly 12 each, and the two gaps in the alive map are
the bridge frame and the nose.

Practical upshot: text scrolling across both eyes already works and needs no patch.

**Decisive test, one command:** light column 0 only and look. One lens means 24
columns total (this reading). Both lenses means the module mirrors, in which case the
extra columns do not exist on the wire and no patch can create them.

## There is a button, and the firmware already uses it

**The two halves of this section carry different confidence, and the split is the point.**
The **pin is *verified***, hand-checked against the bytes as P5.2 in a later session; the
whole section was previously *derived* with a warning to re-derive before patching, and
that warning is discharged. The **behaviour is *unverified***: nobody has pressed the
button and watched. It is a ten-second test (press it, watch the mode change; hold it,
watch it power off), but until someone does it, only the disassembly says what a press
does. No patch is blocked on that test. **`CLAUDE.md` is stricter than this file** and
still reads "*derived*, pin unconfirmed", which the P5.2 check supersedes.

**Gotcha for anyone re-checking the pin.** `0x500042a8` never appears as a literal, so
searching for it finds nothing and looks like a refutation. The debouncer loads
`0x50004280` from the pool at `abs 0x1810c` and reads `[r1, #0x28]`, and
`0x50004280 + 0x28 = 0x500042a8`, which is `PIN_DATA` base `0x50004200 + 0x20*5 + 4*2`,
i.e. **P5.2**. *verified.* It is the only `PIN_DATA` read in the image: excluding bank
data, the whole GPIO block `0x50004000`-`0x500043ff` is referenced six times, once for
pin data and five times for port control (port 2 for the display UART, port 1 for the
debug UART, port 5 three times for the button and the ADC).

Note also that the "only bit 2 is ever tested" observation is about **bit 2 of the
debounced state word** at `0x2000308c`, set by `movs r1, #4` at `abs 0x180a8`, not about
the pin number. The two happen to coincide at 2, which makes the claim look better
corroborated than it is. Both are nonetheless correct.

This is the most interesting thing in the image, because it is the only route to
interaction that does not involve a phone.

| Property | Value |
| --- | --- |
| Pin | P5.2, configured input at `abs 0x1fd1c`, internal pull-up **off** |
| Polarity | active high, so an external pull-down |
| Read site | `GPIO_PIN_DATA(5,2)` = `0x500042a8`, read at `abs 0x180a6` |
| Debouncer | `abs 0x1808c`, requires 3 stable 20 ms ticks (60 ms) |
| Press latch | byte at RAM `0x2000306e`, set on the press edge |
| Edge masks | release `0x20003080`, press `0x20003084`, state `0x2000308c` |
| Interrupt | **none.** `INTEN`/`INTTYPE`/`INTSRC` are never written. Polled only |

The single GPIO data read in the whole image is this button, and only bit 2 is ever
tested, so there is exactly one key.

Behaviour, from `abs 0x2162c` (called from the TIMER0 ISR):

- **Short press:** `mode_index++`, wrapping at 21, then `set_mode(index + 4)`. So the
  button cycles 21 of the built-in display modes with nothing connected.
- **Long press, >= 100 ticks = 2.0 s:** toggles the on/off flag at `0x2000306d`.
  "Off" is ARM deep sleep via `abs 0x171b4` (`SLEEPDEEP`, `CLK->PWRCTL |= 0xC0`, `WFI`).

### The handler's RAM struct and cycle constants

*verified* from bytes. `r4` is loaded from the literal at `abs 0x216f8` = `0x2000306c`.

| Address | Field |
| --- | --- |
| `0x2000306c` | `mode_index`, the button's position in the cycle |
| `0x2000306d` | on/off flag |
| `0x2000306e` | press latch |
| `0x20003070` | tick counter, compared against 100 for the long press |
| `0x20003074` | long-press count |

**Every cycle constant exists twice, and a patch must change both.** The short-press
path is duplicated on the power-on path, which resets `mode_index` to 0 and shows mode 4.

| Constant | Short-press site | Power-on site | Encoding |
| --- | --- | --- | --- |
| `adds r0, #4`, the mode base | `abs 0x216de` | `abs 0x216a0` | `00 1d` |
| `cmp r0, #0x15`, the wrap at 21 | `abs 0x216ee` | `abs 0x216b0` | `15 28` |

Note `abs 0x216f0` is the `blo` that follows the compare, not the compare. Patching
there replaces a backward branch with an instruction and breaks the handler, while
still producing a valid CRC and passing every check `ota.check` can make. This is the
exact class of error the `expect`-the-old-bytes discipline exists to catch.

**Gotcha for anyone patching this:** the long press is the only power switch. Break it
and the glasses cannot be turned off. Also relevant if strangers are pressing the
button: two seconds of hold powers the unit down.

## Other hardware, and what is definitively absent

*verified* by an exhaustive scan of the image for peripheral base addresses.

| Peripheral | Present? | Notes |
| --- | --- | --- |
| Button | yes | P5.2, above |
| ADC | yes, one channel | **battery gauge only.** Ch0 on P5.3, `abs 0x20860` |
| TIMER0 | yes, running | periodic 50 Hz, ISR `abs 0x17ef8`. The animation tick |
| TIMER1 / TIMER2 | free | registers never touched. TMR2's clock is already on |
| UART0 | yes, 115200 | P1.2/P1.3. Debug console, with a printf hard-fault dumper |
| Microphone | **no** | ADC has one channel, no interrupt, no DMA, no audio-rate loop |
| Accelerometer | **no** | neither I2C nor SPI base occurs once in 66 KB |
| Any other sensor | **no** | no touch block, no comparator (`0x400d0000` absent) |
| Charger-state pin | **no** | inferable only from voltage saturating above 4150 mV |

Battery percentage is computed at `abs 0x206c0` against a millivolt ladder (4150,
4050, ... 3100) and filtered into RAM at `0x20003734`. It is never sent over BLE.

**On-device sound reactivity is impossible.** There is no microphone. The vendor's
rhythm mode is entirely phone-driven, which is not a design choice they could have
made differently.

## The command dispatcher: 11 opcodes, and a lot of absences

*verified.* The dispatcher is a flat chain of **byte compares** at
`abs 0x18264` - `0x185a8`: `ldrb [frame+n]` then `cmp #<ascii>`. It is not a jump
table and not 32-bit immediate compares, which corrects the guess recorded in
`firmware-image-format.md` ("the dispatcher compares them as immediates"). Opcode
ASCII does not appear as *data* in the image, which is what led to that guess; it
appears as immediates inside `cmp` instructions instead.

**The length gate, read out of the image rather than reasoned about.** It runs first,
before any opcode compare, and it bounds the payload at **both ends, 4 to 20 inclusive**.
At `abs 0x18268`, with `r4` just copied from `r0` at `0x18266`:

    18268  adds r0, #0xe0
    1826a  ldrb r0, [r0, #0x1b]      ; 0xe0 + 0x1b = [r4 + 0xfb], the length byte
    1826c  cmp  r0, #0x14
    1826e  bhi  0x182c2              ; too long: straight to the shared epilogue
    1827c  cmp  r0, #4
    1827e  blo  0x182c2              ; too short: same exit
    18280  ldrb r2, [r4, #0x2]       ; only now is the opcode read

The bytes are *verified*, decoded by hand from the stock image at this address. The
**behaviour is *derived***: both rejects branch to the shared epilogue at `abs 0x182c2`, so
an out-of-range frame should be dropped in silence with no reply and no notify, but nothing
has been sent to a device to watch it refuse one.

**Consequence for our own opcode: `jgx.hello()` is 4 bytes and sits exactly on the lower
bound.** The frame is `04 4a 00 01 00`, i.e. `J`, sub-command `HELLO`, then the app version
as a halfword, padded to 16 for the AES block. One byte shorter and the gate rejects it
before the `J` compare at `abs 0x182a6` is ever reached, which would read on the wire as a
silent unit rather than as a bad frame. Any future sub-command carrying less than 3 bytes
after the opcode must be padded, not trimmed.

Between the two compares sits a count-up loop at `abs 0x18270`-`0x1827a` (`movs r1, #0`,
then `adds`/`uxth`/`cmp`/`bhi`) which leaves `r1` equal to the length and is immediately
discarded, because `abs 0x18284` reloads `r1` from the literal pool. It computes nothing.
Recorded only so that the next person disassembling the gate does not go hunting for its
purpose.

**`[r4+2]` and "wire index 1" are the same byte.** `r4` is a struct pointer whose frame
data starts one byte in, so every wire index `n` is `[r4 + n + 1]`. Two independent
confirmations: `ANIM` reads its argument at `[r4+6]` (`abs 0x18508`) and the wire frame is
`[len][A][N][I][M][arg]`, argument at wire index 5; `DATS` reads type and length at
`[r4+6]`, `[r4+7]`, `[r4+8]` against `07 44 41 54 53 tt hh ll`. *verified*, and it also
settles the apparent conflict with `vendor-app-protocol.md`, which counts from the wire.
**Neither document was wrong; they count from different places.** `packages/core`'s
`frame()` builds `[len][opcode...]` and is confirmed on hardware by the `DATS` upload, so
the wire index is not in doubt.

**Everything the firmware handles:** `DATS`, `DATCP`, `SPEED`, `SMVEW`, `SOUT`,
`LIGHT`, `LOOP`, `ANIM`, `MODE`, `CLRL`, `IMAG`. That is all eleven.

**Everything in the app's tables that the firmware silently ignores:** `STYPE`,
`LEDON`, `LEDOFF`, `LIGHTON`, `LIGHTOFF`, `EVERT`, `STOPR`, `STSC`, `SCHD`, `CALL`,
`LEDFIRST`, `LEDSECOND`, `COLR`, `LEVL`, `POWR`, and `MODE 07`/`08`/`09` (the MODE
argument parser accepts only 1, 2 and 3). None of these reach a handler.

This retires most of the open questions in `CLAUDE.md`'s Unverified list at once. They
were not unverified capabilities; they are absent. In particular **there is no lens
select**, so `LEDFIRST`/`LEDSECOND` were never going to do anything, and `STYPE` going
unanswered on our unit is now explained rather than merely observed.

Two discrepancies against existing notes, flagged rather than resolved:

- **`LOOP`, not `LOOA`.** The firmware matches L-O-O-P at `abs 0x182ac`-`0x182b8`.
  `notes/protocol.md` records the app opcode as `LOOA`. *unverified* which is the
  transcription error. One on-wire check settles it.
- **`LEDOFF` does not exist**, yet `CLAUDE.md` recommends it for a genuinely dark
  panel. `LIGHT` cannot reach 0 either; its argument floors at level 1. Whatever
  produced a dark panel on hardware, it was not `LEDOFF`. Use `CLRL` (below).

### The dispatcher's branch islands, and what that costs a new opcode

*verified*, and it qualifies the "repoint the dead compare" plan in
`notes/firmware-design.md`.

The compare chain cannot reach its handlers directly, because Thumb conditional branches
carry only +/-256 bytes. So each `beq` targets a **2-byte branch island** in a block of
seven at `abs 0x1836e`-`0x1837b`, and the island does the real jump:

| Island | Letter | Jumps to |
| --- | --- | --- |
| `0x1836e` | `S` | `0x183aa` |
| `0x18370` | `L` | `0x184a0` |
| `0x18372` | `A` | `0x184f4` |
| `0x18374` | `M` | `0x1850e` |
| `0x18376` | `C` | `0x18564` |
| `0x18378` | `I` | `0x1858a` |
| `0x1837a` | `S` again, **dead** | `0x183b4` |

**The dead compare is confirmed dead.** `abs 0x1828a` tests `#0x53` first and always
wins, so the second test at `abs 0x182a2` can never fire. Repointing it is a **one-byte**
edit: change the immediate at `abs 0x182a2` to a new opcode letter.

**But the island cannot reach free flash.** A 2-byte Thumb branch spans about +/-2 KB,
and free flash starts at `abs 0x26a24`, **59,262 bytes** away
(`0x26a24 - 0x182a6`). So a new opcode needs an intermediate hop, which the design note
does not account for. *The exact figure is quoted rather than rounded on purpose: "roughly
60 KB" stood here, another document rounded it differently, and a third value was one
paraphrase away.*

The clean way out is to **repurpose the `LOOP` handler**, `abs 0x182a6`-`0x182c1`, which
is **28** contiguous bytes running up to the shared epilogue and is ample for
`ldr r0, [pc, #n]; bx r0` plus a 4-byte literal. `LOOP` only calls `set_mode(24)`
(`movs r0, #0x18` at `abs 0x182bc`), and mode 24 stays reachable as `ANIM 19`, so nothing
is lost.

The length is *verified* against the v1 diff run, `abs 0x182a6` to `0x182c1` inclusive.
*Corrected: this paragraph said 26 bytes ending at `abs 0x182c0`, "ending in `pop`". Both
the length and the end address were wrong, and this same file gave 28 in two other places.
The `f8 bd` `pop` epilogue sits at `0x182c2`, one halfword past the block, and is branched
to rather than contained. Worth more than the two bytes suggest: this is the block whose
entry points two of our own documents got wrong, and `CLAUDE.md` carries a standing warning
about scanning for branches into it before overwriting it.*

Incidentally this settles the firmware half of `LOOP` versus `LOOA`: the firmware matches
L-O-O-P, testing `0x4c`, `0x4f`, `0x4f`, `0x50` at `abs 0x182a6`-`0x182b8`. *verified.*
Which side the transcription error is on still needs the app, not the firmware.

### The dispatcher's register contract

*verified*, and it is what a trampoline has to honour.

| Site | What |
| --- | --- |
| `abs 0x18264` | prologue, `push {r3, r4, r5, r6, r7, lr}` |
| `abs 0x182c2` | **shared epilogue**, `pop {r3, r4, r5, r6, r7, pc}`. Every no-match path and every handler ends here |

Live registers once the compare chain is running:

| Reg | Holds |
| --- | --- |
| `r0` | frame length (4 to 20) |
| `r1` | `0x2000309e` |
| `r2` | the opcode byte from `[r4+2]` |
| `r4` | **frame pointer**, what a handler actually needs |
| `r5` | `0x200030a0` |

**So a trampoline may clobber `r0`-`r3` and `lr` freely**, because `r3`-`r7` are restored
by the epilogue's `pop` and the saved `lr` returns through `pc`. It must leave the stack
balanced and return by branching to `abs 0x182c2`. The stock `LOOP` handler does exactly
this: clobbers `r0`, calls `bl`, falls into the epilogue.

**The simplest hook needs no island and no dead-compare repoint.** `abs 0x182a6` is the
fall-through target for every unmatched opcode, and it runs to `0x182c1`, **28 bytes**
ending at the epilogue. That whole block can be replaced in one contiguous
length-preserving edit. The cost is `LOOP`, which only calls `set_mode(24)` and stays
reachable as `ANIM 19`.

#### Correction: the block has two entry points, and its first compare was already dead

*verified*, by scanning every `B`, `B<cond>` and `BL` in the image for a target inside
`abs 0x182a6`-`0x182c1`. This section previously described the block as the chain's final
compare reached only by fall-through. Both halves of that were wrong, and a hook built on
it would have run the trampoline on frames that are not ours.

- **`abs 0x184a6` branches to `abs 0x182aa`.** The `LIGHT` arm reads `[r4+3]`, and when it
  is not `I` it jumps back into the middle of this block to try `LOOP` instead. So the
  block is entered **four bytes in** as well as at the top, and that is the only way
  `LOOP` was ever reached.
- **The `cmp r2, #0x4c` at `abs 0x182a6` can never be true.** An `L` opcode already
  matched at `abs 0x1828e` and branched to the island at `0x18370`. So this compare is
  dead in exactly the way the `cmp r2, #'S'` at `0x182a2` is, and the block's only live
  role was "fall through to the epilogue".

That makes the address a free compare slot, which is convenient, but it dictates the
layout: **`abs 0x182aa` must hold a branch to the epilogue**, so that an `L` frame which
is not `LIGHT` is treated as unmatched. What we build is

    0x182a6  cmp  r2, #'J'             ; only reached by fall-through
    0x182a8  beq  0x182ac
    0x182aa  b    0x182c2              ; unmatched, and where the LIGHT arm lands
    0x182ac  mov  r0, r4               ; frame struct pointer as the argument
    0x182ae  ldr  r1, [pc, #4]
    0x182b0  blx  r1
    0x182b2  b    0x182c2
    0x182b4  .word <extension entry>
    0x182b8  nop x5                    ; unreachable padding to 28 bytes

Assembled and checked against the stock bytes by `research/tools/ext.test.ts`. The
back-branch at `0x184a6` is a build-time assertion in `build-firmware.ts`, so if it ever
differs the build fails rather than the device.

Note the argument goes in `r0`, not `r1` as an earlier sketch had it. Nothing forces
either, since the handler is ours, but `r0` is the ordinary first argument.

### Two opcodes the vendor app never sends

- **`CLRL`** (`04 43 4c 52 4c`): clears the live buffer and pushes a blank frame.
  An atomic clear in one write, and the closest thing to a real "off".
- **`SMVEW 03`** (arm at `abs 0x18484`): stops the animation engine *without* clearing
  the live buffer, where **`SMVEW 01`** (arm at `abs 0x1847e`) stops and clears.

#### `CLRL` and `SMVEW 01` are the same instructions

*verified*, by walking the dispatcher and both arms in the decoded image. It matters
because it is the strongest thing that can be said about `CLRL` without hardware: the
clear our client has never sent is the clear it performs at the start of every session.

    dispatcher 0x1829a  cmp r2,#'C' -> island 0x18376 -> b 0x18564   the CLRL handler
    0x18564   'L','R','L' checked at [r4+3],[r4+4],[r4+5]
    0x18576   movs r1,#0x60; ldr r0,=0x200036ac; bl 0x16ac6          zero 96 bytes
    0x1857e   movs r2,#1; ldr r1,=0x200036ac; movs r0,#0; bl 0x221c8 push the frame

`SMVEW 01` at `abs 0x1847e` calls `0x21114` and then **branches into `0x18576`**, the
middle of that handler. `SMVEW 03` at `abs 0x18484` makes the same call and returns
instead. So the shared routine `0x21114` (two `strb` of zero to `0x20003724`, then `bx
lr`) is the engine stop, and everything the docs call "the clear" is the `CLRL` body.

Three consequences:

- **`CLRL` is exercised every session already**, as the second half of `SMVEW 01`,
  which `Glasses.begin()` sends and after which drawing demonstrably works on hardware.
  What is still untested is `CLRL` *alone*, mid-session, with the engine already stopped.
- **The argument mapping is settled**: the compare chain at `abs 0x18444`-`0x1845a`
  reads the argument from `[r4+7]` and branches `01 -> 0x1847e`, `03 -> 0x18484`,
  `02 -> 0x1845c`, `00` falls through. *The entry above states this correctly but its
  parenthetical lists the two addresses in the opposite order to the two opcodes, which
  is easy to read backwards; it was read backwards once while writing
  `packages/core/src/sender.ts`.*
- **`abs 0x18576` is a second block with two entry points**, alongside the `LIGHT`-into-
  `LOOP` case this document already records. Anything relocating the `CLRL` handler must
  keep `0x18576` reachable or `SMVEW 01` stops clearing.

`0x200036ac` is the live column buffer this document already names twice, in the rhythm
handler and in the memory map. Two details the clear adds to it: it is the base of a
structure with **50 LDR sites** across the display driver, not an isolated buffer, and
the clear zeroes **96 bytes where a 24-column frame is 72**. What the other 24 bytes are
is *unverified*.

## The rhythm channel is a full-panel atomic write

*verified*, and it is the most useful thing in the firmware that our client does not
use. Handler at `abs 0x21b04`, reached from the `...960b` path.

A single 16-byte frame sets **all 24 columns at once**. On the wire it has **three
fields**, 13 body bytes padded to 16:

    [0d][style][12 payload bytes]

- Wire index 0 is the length byte, 13. Nothing reads it for its value; the gates are
  ranges, 4 to 20 at the dispatcher and 6 to 20 on the `...960b` path.
- Wire index 1 is the style, one of 4, read by the handler as `[r0+2]` at `abs 0x21b06`.
- Wire indices 2 to 13 carry **two 4-bit bar heights per byte**, low nibble first, so 12
  bytes give 24 columns. The handler reads them at `[r0+3..14]`; loop bound is
  `cmp r3, #0xc` at `abs 0x21b6a`.
- Each height indexes a table of ready-made column words, written straight into the live
  column buffer at `0x200036ac`. **An out-of-range height blanks its column** rather than
  saturating: see below.

*Corrected: this recorded the frame as `[len][?][style][12 payload bytes]`, four fields
with an unknown byte at wire index 1, and the Unverified list carried "the framing at
offsets 0 and 1" as an open question. **There is no unknown byte and no subchannel.** The
error was reading the handler's own offsets as wire offsets: the GATT write callback at
`abs 0x201c0` copies `OUT[k+1] = IN[k]`, so `[r0+n]` is wire index `n - 1`, exactly the
`[r4 + n + 1]` shift this file already establishes for the command dispatcher and then
failed to apply here. Folded in from `research/rhythm-channel.md`, which derives it byte by
byte; the encoder is `packages/core/src/rhythm.ts`, and `protocol.frame('', style,
...payload)` builds it with the same builder as every other command.*

The two tables, *verified* by reading the bytes:

| Table | Words | Shape |
| --- | --- | --- |
| `abs 0x22da8` | `0, 3, f, 3f, ff, 3ff, fff, 3fff, ffff, 3ffff` | solid bar, `4^n - 1`, n rows at level 3 |
| `abs 0x22dd0` | `0, 3, f, 3f, bf, 2bf, abf, 1abf, 5abf, 15abf` | tapered: rows 0-2 level 3, 3-5 level 2, 6-8 level 1 |

Style 0 uses the solid table, styles 1 to 3 the tapered one.

**A height of 10 or more blanks its column, and it does not saturate at 9.** Every arm
does `cmp #0xa; blo; movs #0`, so the out-of-range case substitutes **0** and that column
goes dark. *Corrected: this said each height "is clamped to `< 10`", which reads as
saturation and is not what the code does. The behaviour matters more than the wording,
because overshoot on the loudest beat is the natural bug in any audio meter and the panel's
answer to it is to go dark exactly then, i.e. the failure looks like a dead channel at the
one moment anybody is watching. `rhythm.encode` clamps on the host so the firmware's rule
never fires. Folded in from `research/rhythm-channel.md`; the encoder is
`packages/core/src/rhythm.ts`.*

**Why this matters more than anything else here.** Every other path updates one column
per BLE write, which is why full-frame streaming visibly sweeps. This path updates the
whole panel in one write, so the sweep does not exist. Anything expressible as 24
vertical bars of height 0-9 can be animated at the link rate with no artefact and no
firmware change at all. `0x3ffff` is 18 bits, which is independent confirmation of the
9-row geometry.

Note the table at `abs 0x22da8` was previously recorded in `firmware-image-format.md`
as a **palette**. That was wrong: it is a bar-height table, and the `4^n - 1` pattern
is simply "n rows lit at level 3" rather than a PWM ramp. Corrected here.

The separate 2-entry LUT at `abs 0x22da4` (`00 03 00 00`) *is* a level table: it is the
1-bit-to-2-bit expander for uploaded text, mapping off to level 0 and on to level 3.
Patching byte `abs 0x22da5` to `01` or `02` dims all DATS text by one byte.

## The animation engine

`abs 0x21dd0` is `set_mode(m)` with a 33-entry table at `0x21dea`; `abs 0x22030` is the
per-tick driver with its own table at `0x2204a`. State lives at `0x20003724`. The
`MODE 01 nn` inversion behaviour is still *derived* and cheap to confirm on hardware.

### Both dispatch tables are byte offsets, and their reach is 510 bytes

*verified*, and it is the main structural constraint on patching the mode system.

Neither table holds pointers. Each is 33 **bytes**, and the dispatch is:

    cmp  r4, #0x21          ; 33 modes, 0..32
    bhs  <default>
    movs r0, r4
    add  r0, pc
    ldrb r0, [r0, #4]       ; table[mode]
    adds r0, r0, r0         ; x2
    add  pc, r0             ; target = tableBase + 2 + 2 * table[mode]

| Table | Base | Reachable range |
| --- | --- | --- |
| `set_mode` `0x21dea` | `0x21dec` | `0x21dec` - `0x21fea` |
| per-tick `0x2204a` | `0x2204c` | `0x2204c` - `0x2224a` |

**So a mode entry cannot point at the free flash at `abs 0x26a24`.** One byte of offset
buys 510 bytes of range and no more. Repointing a mode at our own code means overwriting
a handler stub inside that window with a trampoline (`ldr r0, [pc, #n]; bx r0` plus a
4-byte literal) and jumping out from there. Any design that assumes the mode table can
address free flash directly is wrong.

**The `MODE` second byte is boolean**, not a count and not a slot index. It is tested
only for zero versus non-zero:

| Command | Behaviour |
| --- | --- |
| `MODE 01 00` | static |
| `MODE 01 nn` | static, **inverted** (`XOR 0xffff` at `abs 0x21ff6`) |
| `MODE 02 00` / `nn` | scroll left / scroll right |
| `MODE 03 00` / `nn` | scroll with vertical bounce, and its mirror |

So `MODE 01 n` for n = 0..7 yields exactly **two** displays. The "n=0..7 differ on
hardware" tension recorded in `notes/protocol.md` and `vendor-app-protocol.md` is
resolved: whatever produced eight distinct results was not the second byte.

Scroll rate is 50 Hz divided by `[0x2000266e]`, which `SPEED` sets to 13 down to 4 via
a bucketing ladder at `abs 0x183da`. **`SPEED` takes a 0-100 style argument**, not a
small index: the ladder compares against 50, 60, 70, 80, 90 (`abs 0x18400`-`0x18428`).
Default 7, giving 3.8 to 12.5 columns per second.

Modes 4 to 32 are all reachable as `ANIM (mode - 5)`, and the app only ever sends a
subset. Modes 27, 28 and 32 are unreachable from the vendor app entirely.

### The built-in banks decode offline, in two formats

*verified* by rendering every bank to legible content. **This corrects an earlier entry
here** which said the banks at `abs 0x22f06`, `0x2324b` and `0x235fc` "produce sparse
noise" and probably pointed at headers. They are fine; they are simply a **second frame
format** that a 72-byte stride cannot decode.

The consumer is `abs 0x20be4`, called as `(frameCount, bank1bpp, bank2bpp, formatFlag)`.
`r3` selects the format and which register carries the bank:

| `r3` | Stride | Layout |
| --- | --- | --- |
| 0 | **27 B/frame** | 24 data bytes, one per column, then 3 mask bytes |
| 1 | **72 B/frame** | 24 columns x 3 bytes little-endian, 2 bits per pixel |

The 27-byte format builds each column as `(data[c] << 8) | (maskbit(c) ? 0x80 : 0)`, so
**data bits 0-6 are rows 1-7, data bit 7 is row 8, and the 24-bit mask supplies row 0.**
It is 1 bit per pixel: level 0 or level 3, nothing between.

**This independently confirms the `DATS` bit mapping** recorded below, which that section
flags as the claim most worth checking. The halfword this path builds is the same shape
as a byte-swapped `DATS` column, arrived at from the animation path rather than the
receive path, and it renders as readable glyphs. Two unrelated code paths agree.

Built-in banks advance every 6 ticks (`cmp r5, #5; bhi` at `abs 0x20bf2`), so they run at
**8.3 fps**, not at the 50 Hz tick. A one-byte lever, independent of the tick patch.

### Bank inventory

*verified.* Resolved by walking the per-tick table to each mode's setup function and
reading its bank pointer, frame count and format flag. The region is **exactly
contiguous**: banks sum to 14,040 bytes and span `0x22f06`-`0x265dd`, which is a strong
check that the map is complete.

| Mode | `ANIM` | Bank | Frames | B/frame | Bytes |
| --- | --- | --- | --- | --- | --- |
| 5 | 0 | `0x22f06` | 31 | 27 | 837 |
| 6 | 1 | `0x2441e` | 19 | 72 | 1368 |
| 7 | 2 | `0x2324b` | 35 | 27 | 945 |
| 8 | 3 | `0x235fc` | 35 | 27 | 945 |
| 9 | 4 | `0x239ad` | 5 | 27 | 135 |
| 10 | 5 | `0x24976` | 24 | 72 | 1728 |
| 11 | 6 | `0x23a34` | 1 | 27 | 27 |
| 12 | 7 | `0x23a4f` | 30 | 27 | 810 |
| 13 | 8 | `0x25036` | 9 | 72 | 648 |
| 14 | 9 | `0x23d79` | 19 | 27 | 513 |
| 15 | 10 | `0x252be` | 26 | 72 | 1872 |
| 16 | 11 | `0x23f7a` | 2 | 27 | 54 |
| 17 | 12 | `0x23fb0` | 5 | 27 | 135 |
| 18 | 13 | `0x25a0e` | 10 | 72 | 720 |
| 19 | 14 | `0x24037` | 4 | 27 | 108 |
| 20 | 15 | `0x240a3` | 4 | 27 | 108 |
| 21 | 16 | `0x2410f` | 2 | 27 | 54 |
| 22 | 17 | `0x24145` | 27 | 27 | 729 |
| 23 | 18 | `0x25cde` | 32 | 72 | 2304 |
| 25 | - | `0x265de` | 11 | 72 | 792 |
| 27 | - | `0x22df8` | 2 | 27 | 54 |
| 28 | - | `0x22e2e` | 2 | 72 | 144 |
| 32 | - | `0x22ebe` | 1 | 72 | 72 |

The button cycles modes 4 to 24. Mode 11 renders as "I (heart) U"; mode 6 opens on the
centred 2x2 block previously reported as a bloom and resolves into lettering by frame 9;
mode 23 is a greyscale box animation that does use the intermediate levels.

**Total built-in content: 15,102 bytes**, from `abs 0x22df8` to the end of mode 25's
bank. All of it is pure data, read by the animation engine and never executed, so
replacing it in place is the lowest-risk edit class available: it cannot affect BLE
bring-up, and a length-preserving swap shifts no addresses. Combined with the free flash
above the image (10,628 bytes once `joggles-v1`'s extension is in place), that is
**25,730 bytes** available without relinking.

### `IMAG n` is mode 25 showing frame n of that one bank

*verified* by hand decode of both halves, 2026-08-11. It fills in the `-` the table above
leaves against mode 25: that row is not an unreachable oddment and not an `ANIM` index, it
is the **image bank**, and the eleven built-in images the app is recorded as sending are
its eleven frames.

| Site | Bytes | What |
| --- | --- | --- |
| `abs 0x1859c` | `11 49` | `ldr r1, [pc, #0x44]`, pool `0x185e4`, RAM `0x2000374e` |
| `abs 0x1859e` | `a0 79` | `ldrb r0, [r4, #6]`, the argument |
| `abs 0x185a0` | `08 70` | `strb r0, [r1]`, the index into that RAM byte |
| `abs 0x185a2` | `19 20` | `movs r0, #0x19`, then the `bl set_mode` at `0x185a4` |
| `abs 0x21832` | `0b 29` | `cmp r1, #0xb`, mode 25's tick refusing an index above 10 |
| `abs 0x2183a` | `48 21` | `movs r1, #0x48`, the 72-byte stride |
| `abs 0x2183c` | `48 43` | `muls r0, r1` |
| `abs 0x2183e` | `07 49` | `ldr r1, [pc, #0x1c]`, pool `0x2185c`, bank `0x265de` |

So the arithmetic is `0x265de + 72 * index`, and the count is **read out of the image**
rather than assumed: `IMAG 11` fails that compare and shows nothing rather than reading
past the bank. Eleven is also what `vendor-app-protocol.md` records as verified from the
app source, which never saw these bytes, so two independent sources agree.

**`ANIM n` selects mode n + 5.** `abs 0x18506`-`0x1850c` is `ldrb r0, [r4, #6]`,
`adds r0, r0, #5`, `uxtb r0, r0`, then a branch into that same `bl set_mode`. The bytes are
*verified*; the wrap the `uxtb` allows, which would make `ANIM 251` to `ANIM 255` the only
route to modes 0 to 4 that is not the button, is *derived* and untried.

**That leaves one contradiction, and it is the thing to settle before any app ships a tap.**
The vendor app sends `ANIM 20` to `ANIM 29` for its ten animations
(`Agreement.getAnimCommand(i + 20)` in `AnimFragment`, over ten list entries), and under
`n + 5` those are modes 25 to 34: the image mode, the type 2 display mode, six oddments,
and two values `set_mode` rejects outright at its `cmp #0x21`. So either the vendor's
animation menu has never addressed the 19 banks above, or the `+ 5` is wrong. No amount of
further disassembly can say which, because both halves of the disagreement are already
disassembly, and `packages/core/src/protocol.ts`'s `animation()` currently documents the
vendor's offset as though it were the firmware's rule.

`research/tools/bankdump.ts` renders every bank offline, which reduces that to one sitting:
send `ANIM 0` and compare the panel against `bun research/tools/bankdump.ts show anim-0`.
The same run re-resolved this section's map independently and prints its disagreements: the
19 animation banks and the image bank all agree with the rows above, and they are exactly
contiguous from `0x22f06` to `0x268f6`, 14,832 bytes.

### The firmware's own animations use greyscale, so 1-bit compression is lossy

*verified* by decoding 24 frames of the `abs 0x2441e` bloom and counting levels:

| Level | Share |
| --- | --- |
| 0 (off) | 79.4% |
| 1 | 4.0% |
| 2 | 1.8% |
| 3 (full) | 14.9% |

**5.8% of pixels sit at the intermediate levels**, which the bloom uses to soften the
edge of the expanding ring. That matters for any storage scheme: `notes/protocol.md`
records that the vendor's frame data "only ever uses `0b00` or `0b11`", which holds for
the app-side `AnimData` previews but **not** for the firmware's own banks. A 1-bit
format would visibly degrade them.

### Compression is a weak lever, measured

*verified* on the same 24 frames. Raw is 72 bytes per frame, and 10.2 of 24 columns
change per frame, so the content is far less delta-friendly than an LED animation
intuitively seems.

| Scheme | Size | Ratio |
| --- | --- | --- |
| raw, 3-byte columns | 1728 B | 1.0x |
| tight 18-bit columns (54 B/frame) | 1296 B | 1.3x |
| delta columns, 2bpp | 1008 B | 1.7x |
| delta columns, 1bpp | 729 B | 2.4x |
| 1-bit packed (27 B/frame) | 648 B | 2.7x, **lossy** |
| parametric (1 byte of radius per frame) | 24 B | **72x** |

Capacity if content is repointed at the 76.8 KB staging bank:

| Per frame | Frames | At 100 fps | At 25 fps |
| --- | --- | --- | --- |
| raw 72 B | 1066 | 10.7 s | 43 s |
| delta ~32 B | 2436 | 24.4 s | 97 s |
| 1-bit 27 B | 2844 | 28.4 s | 114 s |

**Conclusion: do not build a compressor.** Repointing storage at the staging bank is a
50x lever on its own, generating content procedurally is 72x on this example and
effectively unbounded, and every lossless frame-compression scheme measured lands
between 1.3x and 2.4x for real decoder complexity. Compression's best argument is
**upload time**, not storage: 76.8 KB over `DATS` at 15 payload bytes per block and
20 ms pacing is about 102 seconds, which 2.4x would cut to roughly 42.

Design rule that follows from the frame-count table: **generate the fast content and
store the slow content.** Stored frames at 100 fps exhaust even the staging bank in
under half a minute, whereas 25 fps gets 1 to 2 minutes and looks fine for most effects.

## Corrections to existing notes

Recorded rather than deleted, per `notes/WRITING.md`.

**Every row below that cites the root `CLAUDE.md` was applied there on 2026-08-09.**
`CLAUDE.md` now reads correctly on all of them, and the rows are kept as the record of
what was wrong and for how long, not as a live defect list. Rows citing other files are
live unless they say otherwise.

| Claim, and where | Correction |
| --- | --- |
| "palette at `abs 0x22da8`" (`firmware-image-format.md`) | bar-height table for rhythm mode, not a palette |
| "banks at `0x22f06`/`0x2324b`/`0x235fc` produce noise, probably headers" (this file) | wrong. They are a second, 27-byte 1bpp frame format. All 19 banks decode |
| "animation frames are 72-byte frames" (this file) | true for 7 banks; the other 16 are 27 bytes at 1bpp |
| "the dispatcher compares opcodes as immediates" (same) | it compares them byte by byte |
| `MODE` 2nd byte may be a slot index (`protocol.md`) | boolean, gives 2 displays not 8 |
| `LEDFIRST`/`LEDSECOND`, `COLR`, `LEVL`, `POWR`, `STYPE` unverified (`CLAUDE.md`) | absent from the firmware, not merely untested |
| `LEDON`/`LEDOFF` tabled as "panel on/off", and `LEDOFF` advised for a genuinely dark panel (`notes/protocol.md`) | neither reaches a handler. Use `CLRL`. *Re-aimed: this row cited `CLAUDE.md`, which was corrected on 2026-08-09. The live wrong copy is `notes/protocol.md`* |
| "9 rows x 24 cols/lens" (`CLAUDE.md`) | *derived*: 24 columns total across both lenses |
| "`LOOA`" (`protocol.md`) | firmware matches `LOOP`. Which is wrong is *unverified* |
| DATS rows 7-8 may not reach the panel (`CLAUDE.md`) | they do, via bits 7 and 15. See below |
| "the same budget is **493 columns**" for DATS type 2 (`CLAUDE.md`, `content.ts`, `app-plan.md`) | 383. A type 2 column costs 4 buffer bytes, not 3, and 1480 was measured at type 1's stride |
| "Only `DATS`/`DATCP` persist" (`CLAUDE.md`, this file) | only type 1. Type 2 stops in RAM and is shown by mode 26 |
| "`DATS` validates nothing today" (this file) | it validates length exactly, at `DATCP`. Content is what goes unchecked |

### DATS bit mapping, corrected

**Now corroborated from a second, independent code path**, so the confidence here is
higher than the rest of this file's *derived* material. The 27-byte animation format
(see "The built-in banks decode offline") builds exactly this halfword layout, and its
frames render as legible glyphs. The receive path and the animation path agree without
having been read together. A hardware test would still be the final word: upload a
single column with only bit 7 set and see whether row 8 lights.

The claim is that the DATS text format is **not** 14 rows in a 7+7
split as far as our panel is concerned. The receive path byte-swaps each column at
`abs 0x1864e` and the frame builder at `abs 0x221c8` maps the high field's bit `r+7`
to row `r`, giving:

| Upload bit | Panel row |
| --- | --- |
| 0 to 6 | rows 1 to 7 |
| 7 | **row 8** |
| 15 | **row 0** |
| 8 to 14 | nothing |

So the two bits the vendor font leaves unused are exactly the two rows their text
never reaches, and uploaded graphics can use all 9 rows. Reported as cross-checked
against the factory `.data` default, where `0x3e00` for 'C' lands on rows 2 to 6, but that
cross-check was not repeated by hand.

### `SMVEW 02` does not write flash

*derived*, from automated disassembly only, and confirmable in ten seconds by
power-cycling a unit that has just saved something. `abs 0x1845c` copies the 24 live
column words to RAM at `0x200030ac` and
selects mode 26. `SMVEW 00` runs the same code and only differs by falling back to
mode 1 when the live buffer is blank. So the "drawing JOM, saving, and disconnecting
leaves JOM on screen" result in `notes/protocol.md` is a RAM copy surviving a
disconnect, which it does. It will **not** survive a power cycle. Only `DATS`/`DATCP`
writes flash. *Narrowed: only `DATS` **type 1** writes flash. Type 2 lands in this same
RAM buffer and selects this same mode 26. See the next section.*

## `DATCP` is an exact-match gate, and type 2 never reaches flash

**Now *verified* on hardware**, 2026-08-09 on `GLASSES-125B37`, stock. The section was
written from disassembly and every prediction in it was then run:

| Run | Predicted | Observed | Read from |
| --- | --- | --- | --- |
| type 2, 24 columns (72 B), the vendor's own width | `DATCPOK` | `DATCPOK` | wire |
| type 2, 383 columns (1149 B) | `DATCPOK` | `DATCPOK` | wire |
| type 2, 384 columns (1152 B) | `ERROR` | `ERROR` | wire |
| panel after a type 2 `DATCPOK`, nothing else sent | shows the image | shows the image | eye |
| panel after a `MODE` on top of that | type 1 content | type 1 content | eye |
| the same image after a power cycle | gone, type 1 back | gone, type 1 back | eye |
| 383 columns, lit head and black tail, 2 minutes | only the head shows | never went dark | **eye, null** |

Reproduce with `bun run packages/cli/src/type2.ts <ceiling|watch|show|wide> --yes`.
Adjacent widths with opposite outcomes, landing exactly on the 384-word wrap, is the part
worth keeping: it pins the mechanism and not merely the number.

**The last column is not decoration.** Three of these are device replies and carry no
interpretation. Four were read off a pair of glasses by a person, and the last one is a
*null* observation, where "nothing changed" and "nobody watched closely enough" produce
the same report. The positive eye results are much stronger than that: the observer
described a bright half and a dim half unprompted, which is the image that was sent and
not something the unit had shown before. Weight them accordingly, and see "Only the first
24 columns" below for what would harden the weak one.

It also explains a hardware measurement that had no explanation before, and it changes
what "save" means.

`DATCP` at `abs 0x182e0` compares a running counter against a value `DATS` computed up
front, and answers `DATCPOK` only when they are equal, `ERROR` otherwise. That is the
only check: content is never verified, so a dropped block still answers `DATCPOK`. The
two types set the counter up differently, and that difference is the whole of why their
ceilings are unrelated numbers.

| | counter starts | per column | wraps at | `DATS` expects | ceiling |
| --- | --- | --- | --- | --- | --- |
| type 1 | 48, `abs 0x18314` | +2 bytes | 1536, `abs 0x18686` | `len + 48` | **1486 bytes, 743 columns** |
| type 2 | 0 | +1 **word**, 4 bytes | 384, `abs 0x18634` | `len / 3` | **383 columns, 1149 bytes** |

**A type 2 column costs four bytes of the 1536-byte buffer, not the three it costs on
the wire.** It is stored as a 32-bit word at `0x200030ac + 4*n` (`abs 0x18628`), so the
buffer holds 384 of them and storing the 384th resets the counter. `DATCP` then compares
0 against the 384 it expected and answers `ERROR` once the whole upload has been sent.
Dividing type 1's byte budget by three to size a type 2 payload gives 493 and is wrong;
`packages/core/src/content.ts` did exactly that until 2026-08-09.

**This settles the 740/745 bisection.** `vendor-app-protocol.md` measured 1480 bytes
accepted and 1490 rejected without being able to say why, or whether the bound was
~1485 bytes or 100 blocks. It is neither: at 1490 the counter passes 1536, resets to 0,
and can never equal the 1538 that `DATS` predicted. Block count never enters into it.
The true bound is 1486 bytes, and the measurement brackets it exactly.

### Only type 1 writes flash

The erase-and-write at `abs 0x218cc` (five page erases from `0x3c000`, 1536 bytes
written, then an 8-byte record of pointer, `ncols` and type at `0x3c800`) has **exactly
one call site**, `abs 0x1835e`, on the type 1 arm of `DATCP`. Checked with
`fwtool callers 0x218cc 0x218cd`, so the bank-data scanning trap does not apply.

Type 2 takes the other arm at `abs 0x182f0`: it stores `ncols`, builds a frame from the
RAM buffer and calls `set_mode(26)`. Same buffer at `0x200030ac`, same mode 26 as
`SMVEW 02`.

So **a type 2 upload is a display command, not a save.** It survives a disconnect and
not a power cycle (*verified*: the image was on the panel before the cycle and the type 1
text was back after it), and the next `DATS` of either type destroys it, because both
arms fall through to the `bzero` of all 1536 bytes at `abs 0x18326`. The vendor app
agrees: its DIY screen sends type 2 to *show* a drawing and writes the drawing itself to
a local database, never to the device.

**The type 1 flash content survived eight type 2 uploads**, which is the same finding
from the other side: had any of them reached `abs 0x218cc`, the 1536-byte store and its
type byte at `0x3c800` would have been replaced.

### Type 2 displays itself, and `MODE` is a one-way door away from it

*verified* in the same session, and it is the practical shape of the above.

The image appears **on `DATCPOK`, with nothing else sent**: the `DATCP` arm builds the
frame and calls `set_mode(26)` itself. Greyscale survives the round trip, confirmed by
uploading a block that is level 3 across the left half and level 1 across the right and
seeing two distinct brightnesses on the panel. That also checks `dats.encodeImage`'s byte
order end to end against real hardware rather than against our own decoder.

**`MODE 01 00` and `MODE 02 00` both switch the panel to the type 1 flash store, and
nothing switches back.** So a type 2 image is displayable exactly once, at upload, and
any `MODE` after it discards it. Anything driving both types has to send them in that
order or not at all.

### Only the first 24 columns of a type 2 image are visible: disassembly firm, eye null

**The two halves of this are not the same strength, which is why the heading says so
rather than the body.** The disassembly is *verified*. The panel half is a single **null**
observation by eye, so the claim as a whole is **the weakest result in this section and the
one most worth re-running before anything expensive rests on it** - and
`content.MAX_IMAGE_COLUMNS` is sized on it. *Corrected: the heading read "are ever
visible" under a bare verified marker, and only the body admitted the weakness, so a reader
skimming headings took the whole claim as checked against hardware.*

The disassembly and the panel agree, which is why it is believed; the panel half is one
person reporting that nothing changed for two minutes, and a null observation by eye
cannot distinguish "it never scrolled" from "the
scroll was slower than the watch, or paused between passes the way type 1 does, or the
observer looked away". A first pass of the same test with a *dim* rather than black tail
came back "not certain, but it feels like it is bright all the time", which is what
prompted the black-tail re-run.

**What would harden it**, in rough order of cost: put a distinct marker every 24 columns
so any window other than the head is identifiable rather than merely dark; watch for five
minutes rather than two; or drop the eye out of it entirely by patching `set_mode(26)`'s
96-byte copy and seeing whether the rest becomes reachable. Until then, treat "24 is the
visible width" as firm enough to size content by and not firm enough to build a feature
on refuting.

It is the finding that decides what type 2 is for.

`set_mode(26)` copies **96 bytes, 24 columns**, from the staging buffer to the live column
buffer (`abs 0x21f26`), and the frame the `DATCP` arm builds is 24 wide as well
(`abs 0x221de`). So a wide type 2 upload is accepted in full and displayed only at its
head. Tested by uploading 383 columns whose first 24 were lit and whose remaining 359 were
black: the panel stayed lit and unchanging for two minutes. Nothing scrolls it, and the
one command that might have, `MODE`, discards the image instead.

**So the two type 2 numbers are 383 and 24, and they are for different things.** 383 is
where `DATCP` starts answering `ERROR`. 24 is the widest image that does anything. Sizing
content by the first is how you build a payload that is accepted, acknowledged, and 94%
invisible; `packages/core/src/content.ts` keeps both, as `IMAGE_ACCEPT_CEILING` and
`MAX_IMAGE_COLUMNS`, and bounds content by the second.

What this leaves type 2 as: **a whole 24-column greyscale frame delivered in one
handshake**, with no left-to-right sweep, at the cost of a full `DATS` round trip. That is
a genuinely different thing from the live channel, which needs 24 paced writes and visibly
wipes, and from the rhythm channel, which is atomic but draws only bars.

**Consequence for the client.** `content.savedType()` picks the type from whether the
content has grey in it, so one grey pixel decides whether a save persists. Anything that
must survive a power cycle has to force type 1 and accept the flattening. The upside is
that type 2 costs no flash wear at all and need not be charged to the ledger in
`packages/core/src/budget.ts`.

### Type 1 gets 24 blank columns at each end, free

`DATS` zeroes the buffer and starts type 1's counter at 48, and `DATCP` reports
`ncols = N + 48` (`abs 0x1833e`: halve the counter, add 24). So the firmware itself
places 24 blank columns before the content and 24 after, which is exactly the gap a
marquee wants. A client appending its own trailing gap for type 1 is spending 48 of its
1480 bytes on a third one. Type 2 gets no lead-in.

### Every block's payload must divide by 3 for type 2

The type 2 receive loop steps its block offset by 3 (`abs 0x18640`) and reloads the
block length each pass, so it reads whole columns only while every block carries a
multiple of 3 payload bytes. The 15-byte blocks the protocol uses satisfy that, and so
does the remainder of any 3-bytes-per-column payload. The handler accepts blocks up to
20 bytes (`abs 0x185f0`), so raising the chunk size to speed an upload would leave type
1 correct and mis-frame type 2 from the second block onwards.

## The button cannot talk to the host, and that is a patchable gap

*verified*, and it decides the design of anything interactive.

The **only** outbound notification path in this firmware is `abs 0x2145c`. It has
exactly **three callers**, all inside the `DATS`/`DATCP` arm of the dispatcher
(`abs 0x1832e` for `DATSOK`, `0x1839a` and `0x183a4` for `DATCPOK`/`ERROR`), and it
never appears anywhere as a function pointer, so there is no indirect call either. All
three pass `r0 = 7`, so stock's longest reply is 7 bytes against the 15-byte payload
ceiling, which is the headroom a `J` sub-command reply has to play with (*verified*).

So the firmware can say exactly three things to a host, and none of them is about the
button. **The button state is never transmitted.** Any design where the phone reacts to
a press, tap tempo included, needs a patch first.

The patch is small: `0x2145c` already takes a pointer and a length, so a new call from
the button handler at `abs 0x2162c`, guarded on the existing press latch at RAM
`0x2000306e`, is a handful of bytes. That single change turns the button into a general
purpose input for our own app.

## The crypto and notify paths, traced end to end

*verified.* These were the two gates `notes/firmware-design.md` flagged as its v1
blockers, so they are recorded here in full.

### One key, one schedule, both directions

| Step | Address | What |
| --- | --- | --- |
| key constant | `abs 0x22b94` | 16 bytes: `34 52 2a 5b 7a 6e 49 2c 08 09 0a 9d 8d 2a 23 f8` |
| single reference | `abs 0x208c2` | `ldr r0, =0x22b94` inside a 4-instruction wrapper at `0x208c0` |
| wrapper's only caller | `abs 0x1c81e` | called once at init |
| key setup | `abs 0x1f5fc` | **one caller only.** Copies the 16 bytes to RAM and expands the schedule |
| RAM key schedule | `0x20002f90` | read from 9 LDR sites across both cipher families |
| AES core | `abs 0x1cc1c` | 4 callers, spanning both families |

**So overwriting the 16 bytes at `abs 0x22b94` changes RX and TX symmetrically.** The
argument is from uniqueness rather than from tracing each direction: there is exactly one
key constant, one setup call and one expanded schedule, so both directions must use it.

**Hazard, and it is not caught by any check we have.** The **AES S-box begins immediately
at `abs 0x22ba4`**, `63 7c 77 7b f2 6b 6f c5 ...`, byte-identical to the standard forward
S-box (*verified* against the published table). A key patch that writes 17 bytes instead
of 16 corrupts the cipher in both directions. That address is outside every
`PROTECTED_REGIONS` entry, so `ota.check` would pass it. Write exactly 16 bytes.

### The notify sender takes no DATS state, but it does constrain the frame

`abs 0x2145c(r0 = length, r1 = pointer)`:

1. writes `r0` as a length byte at RAM `0x20003041`, then copies `r0` bytes after it
2. `bl abs 0x1ca8c`, encrypting `0x20003041` into `0x20003055`
3. `bl abs 0x192cc(0x0b, 0x20003055, 0x10)`, sending **exactly 16 bytes**

Three consequences for any back-channel built on it:

- **It is safe to call from anywhere.** It reads no DATS global; its only inputs are the
  two arguments and two fixed scratch buffers. The three existing callers are all in the
  `DATS`/`DATCP` arm, but nothing in the function depends on that.
- **The target is hardcoded**, characteristic index `0x0b`, so every notification goes to
  the same place. There is no handle to choose.
- **The payload ceiling is 15 bytes.** The frame is `[len][payload]` padded to one AES
  block, and the send length is the immediate `0x10`. Anything longer needs a second call
  or a patched length.
- **Notifications are encrypted**, so a client must decrypt them. This is already true of
  the stock `DATSOK`/`DATCPOK` replies.

## Randomness: `rand()` is present but unseeded

*verified.* A textbook glibc LCG lives in the image:

| Symbol | Address | Detail |
| --- | --- | --- |
| `rand()` | `abs 0x16a70` | `seed = seed * 0x41c64e6d + 0x3039`, returns `seed >> 1` |
| `srand()` | `abs 0x16a82` | stores its argument to the seed global |
| seed global | RAM `0x20002708` | last word of `.data` |

**Two gotchas, both important if randomness is going to drive animation.**

`srand()` has **zero callers**, and the seed's `.data` initialiser at flash
`abs 0x26a20` is **`0x00000000`**. So without intervention the sequence is identical on
every power-on. Two units would play the same "random" animation in the same order,
which is the opposite of what a random effect is for.

`rand()` does have two callers, `abs 0x193da` and `abs 0x22432`, but **both are
BLE-related, not animation**: the `0x22432` site fills 16 bytes inside a setup path that
calls out through the stack's exported tables. So the seed does advance during boot, but
deterministically. No existing animation uses randomness.

Entropy actually available on this hardware, best first:

- **The free-running timer count at the first button press.** Human timing is genuinely
  unpredictable, and this costs nothing since the button is already debounced.
- **Low bits of the ADC battery reading**, sampled at `abs 0x17f10`. Noisy by nature.
- **The BLE MAC.** Constant per boot, so useless as entropy, but unique per unit, which
  makes two pairs diverge from each other even when each is deterministic.

## On-device simulation: compute is free, SRAM is not

*derived* from the budget, and it is worth stating because the intuition runs backwards.
**The three figures below were re-checked and hold**; see "SRAM budget, confirmed" at the
end of this section.

The panel is 24 x 9 = **216 pixels**. A frame takes 6.42 ms to clock out to the display
module, so at 100 fps there is roughly 10 ms of slack per frame, about **260,000 cycles**
at 26 MHz, or ~1,200 cycles per pixel. Game of Life, fire, plasma, particles and simple
physics all fit with room to spare. **CPU is not the constraint.**

SRAM is, **on figures that are themselves only *derived*** and worth confirming before
budgeting against them. App RAM runs to about `0x20003804` against an initial SP of
`0x20003910`,
leaving only ~268 bytes of stack headroom, so simulation state cannot live on the stack.
The place to get working memory is the **1536-byte `DATS` content buffer at
`0x200030ac`**, which is free whenever saved content is not in use and is ample for
double-buffered cell state at 216 bytes a side.

Two further notes. `TIMER1` and `TIMER2` are entirely unreferenced, so a faster
simulation tick than the 50 Hz animation tick is available for free. And with only 4
brightness levels, whose curve the display module owns, "more complex" has to mean
richer *motion* rather than more detail: fades and particle trails read well because
they use the 4 levels as fade steps.

### SRAM budget, confirmed

*verified*, by scanning every literal word in the image that looks like an SRAM address
and excluding bank data. 90 distinct addresses.

| Figure | Value | How |
| --- | --- | --- |
| Initial SP | `0x20003910` | image head, body `0x08` |
| Highest app data reference below SP | `0x20003803` | so app RAM ends about `0x20003804` |
| Stack headroom before it collides with app data | **~268 bytes** | confirms the previously *derived* figure |
| `DATS` content buffer | `0x200030ac`, **1,536 bytes** | confirmed by adjacency: `0x200030ac + 1536 = 0x200036ac`, exactly where the live column buffer begins |

So the conclusion stands unchanged: **extension state must come from the `DATS` buffer,
never the stack.**

One loose end. A single reference to `0x20003ffc` sits *above* the initial SP, implying
16 KB of SRAM with roughly 1,776 bytes above the stack top. Whether that is reserved for
the BLE stack or simply unused is *unverified*, and nothing should be built there.

## What patching would buy, ranked

Free flash for appended code: **10,716 bytes on stock**, `abs 0x26a24` (image end, last
non-zero byte at `0x269e9`) up to the staging bank at `0x29400`. `joggles-v1` spends 88 of
them on its `JGX1` extension at the bottom of that gap, so a crew unit has **10,628 bytes**
left. *verified.* Everything below is costed against the gap, not against either total.

**The byte costs below are estimates, not measurements.** They are useful for ordering the
work and nothing else; do not plan a flash layout around them. **Three rows are no longer
prospective**: they are in `firmware/joggles-v1.bin`, marked **done in v1**, and their
costs there are real.

| Patch | Cost | Value |
| --- | --- | --- |
| Animation tick 50 Hz to 100 Hz | **1 byte** at `abs 0x18052` (`0x32` to `0x64`) | doubles smoothness of every device-side animation and the `SPEED` range |
| AES key swap | 16 bytes at `abs 0x22b94` | **done in v1**, the crew key from `firmware/crew-key.json`. Locks out the vendor app, which is the defensive point: nobody with the stock app can drive a unit a crew member is wearing. Single reference site, clean in-place edit |
| Rename `GLASSES-` | **exactly** 8 bytes at `abs 0x2691c` | **done in v1**. Crew units are told from stock at scan time. Shorter is not free, see below |
| Widen the brightness clamp | ~6 bytes at `abs 0x184ba` | probes whether the module accepts beyond `0xa5`. *unverified* payoff |
| Dim uploaded text | 1 byte at `abs 0x22da5` | level 3 to level 1 or 2 |
| A new opcode | 28 bytes at `abs 0x182a6` plus a handler | **done in v1** as opcode `J`. Overwrites the whole `LOOP` block and reaches free flash through a literal. The dead-compare route this row used to propose cannot work, see below |
| Button drives our content | ~50-100 bytes | the only route to phone-free interaction. Hook the existing latch at `0x2000306e` |
| Notify on button press | ~10-20 bytes | makes the button an input to our app. `0x2145c` already does the sending |
| Seed `rand()` | ~10 bytes | without it, "random" is byte-identical on every boot |
| Battery level over BLE | ~30 bytes | the value already sits at `0x20003734` |
| Multi-column live writes | ~25 bytes, blocked | see below |
| Content in the staging bank | 60-100 bytes | 1.5 KB to 76.8 KB of saved content |

### Correction: a new opcode cannot be bought with the dead compare

**This corrects the "new opcode" row above**, which read "~6 bytes plus a handler: a dead
redundant `cmp r2, #'S'` at `abs 0x182a2` can never fire and can be repointed at a
trampoline in free flash". The compare really is dead and really is a free slot, but
**repointing it cannot reach a trampoline in free flash**, and this file's own analysis
says so: the compare feeds a 2-byte branch island, an island's branch spans about +/-2 KB,
and free flash starts 59,262 bytes away. A one-byte immediate change has nowhere to land.
See "The dispatcher's branch islands".

What `joggles-v1` actually ships is the hop the idea was missing: **the 28-byte `LOOP`
block at `abs 0x182a6`-`0x182c1` is overwritten wholesale** with `cmp r2, #'J'`, a
`ldr`/`blx` through a literal, and a branch to the shared epilogue. One contiguous
length-preserving edit, no island, no dead-compare repoint. The idea is kept here rather
than deleted because the free slot at `0x182a2` remains genuinely free for a *second*
opcode, on the same condition: it needs a hop, not a direct branch.

*verified* by disassembly 2026-08-09. **This corrects the rename row above**, which read
"8 bytes of zero padding follow, so a same-or-shorter name is free" until this session.
Those 8 zeros are not padding: they are the buffer the MAC suffix is written into at boot.

The name is assembled in RAM and the advertiser never reads flash:

| Step | Where | What |
| --- | --- | --- |
| Boot | scatterload entry at `abs 0x26908` | copies 268 bytes from `abs 0x26918` to RAM `0x20002600`, so the flash string at `abs 0x2691c` becomes the RAM buffer at `0x20002604` |
| Boot | `abs 0x21540` | hex-formats the MAC at RAM `0x20001527` through the digit table `0123456789ABCDEF` at `abs 0x22954`, then `copy6(0x2000260c, ...)` at `abs 0x188f6`, and `0x2000260c` is name + 8 |
| Advertise | `abs 0x193c8` | `memcpy(record + 6, 0x20002604, 14)`, then `strb #0xe` into the length field at `[record+5]` |

So the advertised name is one fixed-length field: 8 bytes of prefix from flash, then 6
hex characters of the low three MAC bytes. `GLASSES-12C3EF` is 8 + 6, not a string and a
suffix appended to it. The suffix lands at a **fixed offset of 8**, and the length 14 is
an immediate in two places, `abs 0x193ca` and `abs 0x193d4`.

**A prefix shorter than 8 breaks the fleet rather than shortening the name.** Padding
`CREW-` with NUL gives `CREW-\0\0\0` + `12C3EF`: the advert still carries 14 bytes, every
scanner stops at the first NUL, and every unit flashed with that image shows as `CREW-`
with nothing to tell one from another. That is the opposite of what the rename is for.
`build-firmware.ts` used to accept it and pad; it now refuses anything but 8 printable
bytes. A shorter name is still possible, but only by also patching the two length
immediates, and then the MAC suffix has to move too.

Consequence for a **runtime** rename, which is the interesting one: the live name is RAM
at `0x20002604`, so changing it costs a 14-byte write and a re-advertise, not a flash
erase. Persisting it across a power cycle is the hard half, since the boot path always
rebuilds the buffer from `abs 0x2691c` plus the MAC.

### The 1-byte tick patch has a catch

`abs 0x2162c` and `abs 0x22030` measure timeouts in ticks, including the 100-tick long
press. Doubling the tick rate halves every one of them, so the 2 s power-off becomes
1 s. Compensate those constants in the same patch or the button behaviour changes.

### Multi-column live writes: the blocker, and a way round it

The live handler decrypts exactly one 16-byte block and stores one column
(`abs 0x20694`), with no length read anywhere. *verified.* An 11x throughput win is
~25 bytes of loop, but it needs the ATT write length, and the display callback's event
struct does not carry one. The OTA handler's struct does (`len` at `[evt+4]`,
`abs 0x1ea5e`), which proves the stack has the value, but the display callback receives
a different, compacted struct and the GATT core lives below `abs 0x16800`, outside our
patchable region.

**The way round it is to not need the length.** Speculatively decrypt the next block
and check the plaintext for a magic marker, e.g. a reserved `[len]` value plus a
signature byte. A short write leaves stale RX buffer contents there, which decrypt to
noise and fail the check; the false-positive rate is the width of the marker. Reading
16 bytes past a write stays inside SRAM, so it does not fault. *unverified*, but it
sidesteps the ABI problem entirely.

Note that AES here is software and slow (a byte-oriented implementation with a non-inlined
GF multiply, `abs 0x1cc1c` calling `0x1ef60`), so it is negligible against today's 20 ms
pacing but becomes material once one callback has to decrypt eleven blocks. Any
multi-block patch should be designed alongside an unencrypted bulk path. *derived*, and
the cycle estimate behind it was rough enough not to be worth quoting.

### Flow control cannot be patched

*derived*, from automated disassembly only: there is no application-side queue, ring
buffer or busy flag, and handlers
write straight to their targets. Write-without-response drops happen in the controller
RX path below `abs 0x16800`. A patch can only trim the live callback's busy-wait (up
to 2000 `isb` spins, ~0.5 to 1 ms, at `abs 0x186f0`/`0x18708`/`0x1872c`). Pacing stays
mandatory.

Separately, `abs 0x18114` never waits for the previous DMA to complete, and a frame
takes 6.42 ms on the wire. That is a better explanation of "pace your writes or columns
go stale" than controller overrun, and it sets a floor: **pacing below ~6.5 ms buys
nothing.** *derived*, and one hardware test would confirm it.

### Content in the staging bank

The read side is nearly free: the display reads through RAM pointers
`[0x20002670] = 0x3c000` and `[0x20002674] = 0x3c800`, set at `abs 0x215da`/`0x215e2`.
`ncols` is a u16 and the scroll offset a u32, so the read path already scales to 65535
columns. `0x29400` even encodes in the same 2-instruction shape (`movs #0xa5; lsls #10`)
as the existing `0x3c000` (`movs #0x0f; lsls #14`), so the base is a same-length patch.

The write side is the work: the SRAM staging buffer is only 1536 bytes, so `DATS` must
flush to flash as it fills. The hooks are the wrap points that today just reset the
counter, `abs 0x18686` (type 1) and `abs 0x18634` (type 2), plus turning the five
hardcoded page erases at `abs 0x218cc` into a loop.

Two caveats. Any OTA destroys content held in the staging bank. And a wider buffer has
to move the `DATCP` gate too, not only the wrap points: `DATCP` passes on an exact
counter match, so today a payload that wraps is rejected outright rather than truncated.
*Corrected: this section used to say `DATS` validates nothing and that an over-long
announcement "silently wraps while `DATCP` still replies `DATCPOK`". The length is
checked, exactly; it is the **content** that goes unchecked, so dropped blocks still
answer `DATCPOK`.*

## Unverified

- Whether 24 columns span both lenses or the module mirrors them. One hardware test.
- **That a type 2 image shows only its first 24 columns.** Hardware agreed with the
  disassembly, but that half is a single null observation by eye, so it is the one
  `DATS` result worth re-running: a distinct marker every 24 columns makes any window
  other than the head identifiable rather than merely dark, and five minutes beats two.
  `content.MAX_IMAGE_COLUMNS` is sized on it. *Graduated 2026-08-09 and now firm: the
  383-column accept ceiling, the RAM-only behaviour, and that type 2 displays itself on
  `DATCPOK`. The section above records every run and which were read from the wire.*
- Whether the display module accepts any command beyond `0xa0`-`0xa5` and `0x4a`.
- `LOOP` versus `LOOA`.
- Whether the speculative-decrypt trick works for multi-column writes.
- ~~The exact rhythm frame framing at offsets 0 and 1.~~ **Settled, and the question was
  malformed.** There is no byte at wire index 1 other than the style: the frame is
  `[0d][style][12 payload bytes]`, and both this file's old `[len][?][style][12]` and
  `vendor-app-protocol.md`'s `[15][subchannel][12 bytes]` came from reading handler
  offsets as wire offsets. See "The rhythm channel is a full-panel atomic write" above and
  `research/rhythm-channel.md`. Still *derived*: nothing has been sent to hardware.
- How the unit wakes from its powered-off deep sleep. No GPIO or power-down wake interrupt
  is enabled in the application, so it presumably comes from the BLE stack's own sleep
  timer, below `abs 0x16800` and out of reach.
- How much SRAM is genuinely free. The figures in this document are *derived* from a
  scatterload table and the initial SP, and they underpin the claim that SRAM rather than
  CPU is the constraint on on-device simulation, so they deserve a check before anyone
  budgets against them.
- **Whether the timer feeding the 50 Hz tick is crystal-derived or from the internal RC
  oscillator.** `abs 0x171a4` returns the `SystemCoreClock` global, so the answer is one
  level further into the clock init than this pass went. It decides how long two units
  stay in sync, and the cheap answer is to start two animating together and time the
  divergence rather than to keep reading.

## Reproducing

**The decode-and-objdump recipe lives in `research/firmware-flashing.md`,
"Reproducing the disassembly".** Follow it there rather than here. *Corrected: this section
carried a third copy of those three commands and described `mkelf.ts` as a scratchpad
one-off. It is a repo tool, `research/tools/mkelf.ts`, which `firmware-flashing.md` had
already corrected; a stale duplicate sends the next reader looking in the scratchpad for a
file that is checked in.*

Peripheral bases were confirmed against Panchip's own `PN102Series.h` rather than
guessed. From the SDK mirrors listed in `firmware-flashing.md`:

| Block | Base |
| --- | --- |
| SYS / CLK | `0x50000000` / `0x50000200` |
| DMA | `0x50002000` |
| GPIO P0..P5 | `0x50004000 + 0x40 * port`; pin data `0x50004200 + 0x20 * port + 4 * pin` |
| FMC | `0x5000c000` |
| TIMER0/1/2 | `0x40010000` / `0x40010020` / `0x40010040` |
| UART0 / UART1 | `0x40100000` / `0x40101000` |
| I2C0/1, SPI0-3 | `0x40102000`+, `0x40104000`+. **Never referenced** |
| ADC | `0x400e0000` |

Landmarks in the application region:

| Address | What |
| --- | --- |
| `0x1808c` | button debouncer |
| `0x18114` | the only display egress path: DMA to UART1 |
| `0x18264` - `0x185a8` | command dispatcher |
| `0x185e8` / `0x186b4` | `DATS` bulk handler / live column handler |
| `0x20694` | live column store, single column |
| `0x201c0` | the GATT write callback for every display characteristic |
| `0x20860` / `0x206c0` | ADC init / battery millivolt ladder |
| `0x21b04` | rhythm handler, the 24-column atomic path |
| `0x21dd0` / `0x22030` | `set_mode` / per-tick animation driver |
| `0x22b94` | AES key, single reference from `0x208c2` |
| `0x22da4` / `0x22da8` / `0x22dd0` | text level LUT / solid bars / tapered bars |
| `0x21540` / `0x193c8` | MAC-to-hex for the name suffix / advert name copy, fixed 14 bytes |
| `0x2691c` | `GLASSES-` name prefix, exactly 8 bytes, MAC suffix written at +8 in RAM |
| `0x269e9` | last non-zero byte of the image |
