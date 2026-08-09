# Firmware design: the extension framework

**Status: v1 is built and unflashed.** `bun run build-firmware` produces an image that
passes `ota.check`; nothing has been near a device. Everything from v2 on is still
design. Judgement, so it lives in `notes/` not `research/`. Every byte address cited
comes from `research/firmware-internals.md` or `research/firmware-flashing.md` and
carries that file's confidence marker, repeated here. No new hardware fact is established
by this document.

**What v1 turned out to be:** 88 bytes appended at `abs 0x26a24`, 28 bytes replacing the
`LOOP` dispatcher arm, 16 bytes of AES key and 8 bytes of advert name. That is 52 bytes
written over the vendor's code, of which **48 actually differ** from stock: 27 of the 28
hook bytes, all 16 key bytes, and 5 of the 8 name bytes. 48 is the number a diff against
stock reports, and the one `dumpcheck` prints; 52 is the number of bytes the build
writes. *Clarified 2026-08-09: this said "28, 16 and 8 ... 48 in total", three figures
that do not sum to the fourth.* The build is `research/tools/build-firmware.ts`, the
extension is `research/tools/ext.ts`, the wire format is `packages/core/src/jgx.ts` and
the client probe is `bun cli probe`.
**Scope:** how we add our own features to the stock image without relinking, the wire
formats that make it extensible, and the staged roadmap from a no-firmware client to
on-device content.
**The one rule it obeys:** never relink (`research/firmware-flashing.md`). Everything here
is an extension appended in free flash plus the fewest possible hook patches.
**For a reviewer:** the load-bearing assumptions are gathered in the last two sections,
"Open gates" and "For the reviewer". Start there if you are checking soundness rather than
reading front to back.

## "Properly" does not mean "from scratch"

Building a fresh image means owning BLE bring-up, the OTA service and the vector table,
and getting any of it wrong leaves no way back over the air, because the recovery path
*is* the stock app's own BLE and OTA. So the proper ground-up design is:

> A clean extension appended in the 10,716 free bytes at `abs 0x26a24` to `0x29400`,
> hooked into the stock image at as few points as possible. The stock firmware stays the
> untouchable substrate that guarantees recovery; our code is a module above it.

Everything below is the architecture of that extension.

## Budget: what we have to work with

| Resource | Size | Source | Confidence |
| --- | --- | --- | --- |
| Free flash for appended code | 10,716 B, `abs 0x26a24` to `0x29400` | last non-zero byte `0x269e9`, staging bank at `0x29400` | *verified* |
| Image ceiling before anything else is touched | 66,084 B (stock size) | leaves 10,716 B headroom | *verified* |
| Free SRAM while not uploading | 1,536 B `DATS` buffer at `0x200030ac` | reusable as extension working memory | *derived* |
| Stack headroom | ~268 B (app RAM to `0x20003804`, SP `0x20003910`) | so extension state cannot live on the stack | *derived* |
| Spare CPU per 100 fps frame | ~260,000 cycles, ~1,200 per pixel | 6.42 ms frame time at 26 MHz | *derived* |

The constraint is SRAM, not flash or CPU. Any extension feature that needs working memory
takes it from the 1,536 B `DATS` buffer, which is free whenever saved content is not in
use, and must not assume the stack.

## The load-bearing decision: one opcode, a sub-command namespace

Patch the vendor dispatcher **once, ever**, to add a single custom opcode that trampolines
into our region. Its first payload byte is a sub-command id. Every feature we ever add is
then a new sub-command in free flash, costing zero further edits to the stock image. This
is the single decision that makes the firmware extensible rather than accreted.

    [len][OP][subcmd][args...]          on the command characteristic (9600)
              \_ the whole future feature set lives in this byte

*Corrected 2026-08-09: this diagram and the HELLO one below drew a spare byte between
`[len]` and `[OP]`. There is none. The opcode is wire index 1, exactly as
`notes/protocol.md` has it, so the sub-command is wire index 2 and the trampoline reads
it at `[r4+3]` (`ARG(2)`, since the struct starts one byte before the frame). Anyone
adding a sub-command off the old diagram would have read the byte after theirs.
`research/tools/ext.ts` and `packages/core/src/jgx.ts` were always right; only this
document was wrong.*

Reserve the sub-command space now so later work slots in without renumbering:

| Range | Family | First member |
| --- | --- | --- |
| `0x00` | HELLO / capabilities | HELLO |
| `0x01`-`0x0f` | session / control | reserved |
| `0x10`-`0x1f` | sync | set-phase, set-tempo, sync-mark |
| `0x20`-`0x2f` | content | upload, select, generate |
| `0x30`-`0x3f` | input / sensors | button-config, battery-request |
| `0x40`-`0xff` | reserved | future |

### The hook itself

The dispatcher is a flat chain of byte compares at `abs 0x18264` to `0x185a8`:
`ldrb [frame+n]` then `cmp #<ascii>`. The opcode is at `[frame+2]` (`ldrb r2, [r4, #0x2]`
at `abs 0x18280`). Length is gated first and must be 4 to 20, but it is read from a
separate struct field at `[struct+0xfb]` (`abs 0x1826a`), **not** from `[frame+0]`.
*verified.* Two ways in, cheapest first:

1. **Repoint the dead compare.** `research/firmware-internals.md` records a redundant
   `cmp r2,#'S'` at `abs 0x182a2` that can never fire because an earlier `S` opcode always
   matches first. Its branch target can be repointed at our trampoline. *derived*; the
   opcode would then be an `S`-prefixed frame distinguished by a later byte, which is
   slightly awkward but costs no added instructions.
2. **Add one clean compare** for a fresh opcode letter, inserted in the chain. Costs a few
   bytes and keeps the opcode a distinct letter.

Either way the hook must branch from the dispatch region near `abs 0x182xx` to the
extension at `abs 0x26a24`, which is **34,690 bytes (~34 KB) away**, not the ~18 KB this
document previously said. That is far beyond a short `B` (+/-2 KB), so it needs a `BL` or a
literal-pool PC load, and the sequence must not clobber a register the dispatcher relies
on after the call.

**Simplest hook: overwrite the `LOOP` block, and skip the dead compare entirely.**
`abs 0x182a6` is the fall-through target for every unmatched opcode and runs 28 bytes to
the shared epilogue at `0x182c2`. One contiguous length-preserving edit replaces it.

**Correction, found while building it: the block has a second entry point.** This section
previously said `abs 0x182a6` was reached only by fall-through, and sketched a hook with
`bne 0x182c2` at the top. That hook would have been wrong. `abs 0x184a6`, in the `LIGHT`
arm, branches to **`abs 0x182aa`**, four bytes in, whenever an `L` opcode is not `LIGHT`;
that back-branch is how `LOOP` was reached at all, and it is why the `cmp r2, #0x4c` at
`0x182a6` was already dead code. With the naive layout, every `L???` frame would have
fallen into `mov r0, r4` and run the trampoline on a frame that is not ours. What ships
instead puts the epilogue branch exactly where the back-branch lands:

    0x182a6  cmp  r2, #'J'             ; 2   only ever reached by fall-through
    0x182a8  beq  0x182ac              ; 2
    0x182aa  b    0x182c2              ; 2   unmatched; also where LIGHT lands
    0x182ac  mov  r0, r4               ; 2   frame struct pointer as the argument
    0x182ae  ldr  r1, [pc, #4]         ; 2
    0x182b0  blx  r1                   ; 2
    0x182b2  b    0x182c2              ; 2
    0x182b4  .word <extension entry>   ; 4
    0x182b8  nop x5                    ; 10  unreachable padding

An unmatched opcode and a non-`LIGHT` `L` frame both reach the epilogue, exactly as stock
did once `LOOP` stopped existing; only `J` reaches us. The cost is `LOOP`, which only
called `set_mode(24)` and stays reachable as `ANIM 19`. The back-branch is a build-time
assertion, so if it ever moves the build fails rather than the device.

**The lesson worth keeping:** "this block is only entered at the top" is an assumption, and
on a flat compare chain with shared tails it is often false. Scan for branch targets
inside any block before overwriting it. One `B` in 66 KB was the difference between a
correct hook and a subtly wrong one.

**ABI, *verified*:** the dispatcher's prologue is `push {r3,r4,r5,r6,r7,lr}` and every
path returns through `pop {r3,r4,r5,r6,r7,pc}` at `0x182c2`, so the trampoline may
clobber `r0`-`r3` and `lr` freely and must simply leave the stack balanced.

The earlier plan of repointing the dead `cmp r2,#'S'` at `abs 0x182a2` still works but is
strictly worse: its `beq` targets a **2-byte branch island** at `abs 0x1837a` that cannot
reach free flash, so it needs a second hop. Recorded so nobody re-derives it. See
`research/firmware-internals.md`, "The dispatcher's branch islands" and "register
contract".

**Frame-offset caveat, now resolved.** This document previously flagged a one-byte
disagreement between `firmware-internals.md` (`[frame+2]`) and `vendor-app-protocol.md`'s
`DATS` frame `07 44 41 54 53 tt hh ll` (`[frame+1]`). The dispatcher settles it:
`ldrb r2, [r4, #0x2]` at `abs 0x18280`, with `LOOP`'s trailing letters read from
`[r4+3]`, `[r4+4]` and `[r4+5]`. **The opcode starts at `[frame+2]`.** *verified.*

## The extension region layout

A small self-describing block at `abs 0x26a24`, so the HELLO handler can report exactly
what is compiled in rather than a hardcoded constant that can drift:

    +0x00  magic "JGX1"            marks a valid extension, guards against a half-flash
    +0x04  ext_version u16         our firmware version, returned by HELLO
    +0x06  cap_bitmap u16          which sub-command families are present
    +0x08  subcmd_table            offset per implemented sub-command, 0 = absent
    ...    handler code
    ...    read-only data (capability text, defaults)

The group key and the advert name are patched **in place** at their stock addresses (see
"Identity"), not stored in this region. v1's code footprint here is small: trampoline
entry, sub-command dispatch, the HELLO handler, and one notify-framing helper.

## HELLO and capability negotiation

Foundational in v1 even though v1 has few features, because "control both strangers and
crew" means the app meets a mixed fleet: stock units, crew units at fw v1, crew units at
fw v2. The app must **probe**, never assume.

Request, app to device on `9600`:

    [len][OP][0x00][app_ver_lo][app_ver_hi]

Reply, device to app on the notify characteristic `9601`:

    [marker][0x00][ext_ver_lo][ext_ver_hi][cap_lo][cap_hi][unit_id 0..5]

- A **stock** unit does not recognise `OP`, silently ignores it (the dispatcher falls
  through to no-match), and never replies. The app times out and classifies the unit as
  stock. This is how stock-versus-ours is detected without guessing. *derived* from the
  dispatcher ignoring unknown opcodes.
- `cap_bitmap` tells the app which families this unit supports, so a v1 app talks safely
  to a v2 unit and vice versa.
- ~~`unit_id`~~ **Drop it.** It was to be the 6-byte BLE MAC, but the MAC lives in the BLE
  stack below `abs 0x16800` and cannot be located offline. It is also **redundant**: a
  central already learns the peripheral's address from the scan and the connection, so the
  device never needs to report it. Dropping it reclaims 6 of the 15 available payload bytes
  and removes a v1 blocker outright. *verified* reasoning.

## The back-channel: structured notify

Stock can say exactly three things, `DATSOK`, `DATCPOK`, `ERROR`, all ASCII, all sent from
the `DATS`/`DATCP` arm through the sender at `abs 0x2145c`, which already takes a pointer
and a length. *verified.* We reuse that sender for one extensible outbound frame:

    [marker][type][payload...]        on notify characteristic 9601

`marker` is a reserved byte chosen so our frames never collide with the vendor ASCII
replies (a `DATSOK` frame starts with `0x44`); a high byte such as `0xF0` is safe.
Message types, additive:

| type | Meaning | Payload |
| --- | --- | --- |
| `0x00` | HELLO reply | version, capability bitmap, unit id (above) |
| `0x01` | button event | edge (press / long / release) + free-running timer count |
| `0x02` | battery | millivolts or level, the value already sits at `0x20003734` |
| `0x03` | sync status | phase / tempo, for multi-pair diagnostics |

The button event carries the **timer count at the press edge**, not just "a press
happened", so the host computes tap-tempo intervals from device timestamps and never eats
BLE round-trip jitter. That single field is what makes tap tempo accurate rather than
approximate.

**Design the framing in v1, populate the types later.** v1 ships only the HELLO reply
(type `0x00`); button and battery are v2. The framing must exist in v1 so later types cost
nothing structural.

**Gate discharged, with three constraints.** `abs 0x2145c` was traced end to end
(`research/firmware-internals.md`, "The crypto and notify paths"). It reads **no** DATS
global; its only inputs are the pointer, the length, and two fixed scratch buffers, so it
is safe to call from our handler. But it constrains the frame:

| Constraint | Consequence for the back-channel |
| --- | --- |
| Hardcoded characteristic index `0x0b` | every notification goes to the same place; no handle to choose |
| Always sends exactly 16 bytes | one AES block, regardless of payload |
| Frame is `[len][payload]` inside that block | **payload ceiling is 15 bytes** |
| Output is AES-encrypted | the client must decrypt notifications, as it already does for `DATSOK` |

The HELLO reply as designed, minus `unit_id`, is 6 bytes, comfortably inside 15.

## Identity, the crew key, and the rename

Two in-place, length-preserving patches, both at *verified* addresses.

| What | Address | Patch | Confidence |
| --- | --- | --- | --- |
| AES key | 16 B at `abs 0x22b94`, single ref from `0x208c2` | overwrite with the crew group key | *verified* location |
| Advert name | `GLASSES-` prefix at `abs 0x2691c`, 8 B field | rename to a crew prefix of **exactly** 8 bytes | *verified* |

*Corrected 2026-08-09: this row said "same length or shorter", and the 8 bytes after the
prefix were called zero padding. They are not padding, they are where the boot code writes
6 hex characters of the MAC, and the advert length is a hardcoded 14. A shorter prefix
padded with NUL makes every unit on that image advertise the same truncated name with no
MAC to tell them apart. Disassembly in `research/firmware-internals.md`, "The advert name
is 14 fixed bytes". `build-firmware.ts` now refuses anything but 8 printable bytes;
`JOGGLES-` is 8, so `firmware/joggles-v1.bin` as built is unaffected.*

Swapping the key does two jobs at once: it locks out the vendor app (which only holds the
vendor key) **and** it is the crew credential, because only a holder of the group key can
drive a crew unit. Renaming the advert lets the app tell crew from stock at scan time.

**Recovery is unaffected by the rename.** The vendor app cannot OTA us regardless (its OTA
gate is version-major < 10, ours reports 10, *verified* in `firmware-flashing.md`), and
our own client can scan for any name, so renaming does not remove a recovery route as long
as our client knows the new prefix.

**Gate discharged, and a hazard found.** There is exactly one key constant, one setup call
(`abs 0x1f5fc`, single caller) and one expanded schedule in RAM at `0x20002f90`, read by
both cipher families. So one overwrite changes both directions symmetrically, by
uniqueness rather than by tracing each path. *verified.*

**The hazard: the AES S-box begins immediately at `abs 0x22ba4`,** byte-identical to the
standard forward S-box. Writing 17 bytes instead of 16 corrupts the cipher in both
directions, and that address is outside every protected region, so `ota.check` would pass
it. **Write exactly 16 bytes.** This belongs in the safety invariants below.

## The dual-key consequence of wanting both

Opportunistic stranger control and a hardened crew force the **app** to speak two keys:
the vendor key to drive strangers on stock, the group key to drive crew.
`packages/core/aes.ts` already isolates the cipher, so the key becomes a per-connection
parameter rather than a rewrite. Strangers stay on the vendor key forever because we
cannot reflash them. The scale ceiling on all of this (one connection per pair, no
broadcast, the BLE stack unpatchable) is in `notes/what-to-build.md`, "Controlling other
people's glasses", and is not repeated here.

## Roadmap: start simple, each layer additive

| Stage | Firmware? | Content | Depends on |
| --- | --- | --- | --- |
| v0 | none | Multi-connection app client. Drive your own pairs and opportunistic stranger stock pairs. Proves the whole interaction model at zero flash risk | nothing |
| v1 | **built, unflashed** | Extension framework + HELLO/capabilities + group key & rename. 88 B of extension, 48 B of the vendor's code changed. `bun run build-firmware` | done: all three gates discharged |
| v2 | yes | Button back-channel: button events over notify. Unlocks tap tempo, message handoff down a row, stranger opt-in | re-derive the *derived* button addresses on hardware |
| v3+ | yes | Sync primitives, seeded-rand decision, on-device content, staging-bank capacity, animation bytecode | crystal-vs-RC test, SRAM budget confirmation |

Nothing after v1 re-patches the dispatcher or the notify sender; it is all new
sub-commands and new message types. That is the payoff of the one-opcode decision.

**The v1 cut, as built:** framework + HELLO + group-key/rename. Smallest thing that is
genuinely ours, enables crew control, and depends on no *derived* button address. Putting
the button back-channel in v1 instead would have pulled the button-address re-derivation
onto the critical path.

**Peel it back for the first flash.** `--stock-key --stock-name` builds the extension
alone: 27 bytes of the vendor's code changed, the vendor app still works, and the existing
client still talks to it on the vendor key. That is the smallest possible thing to put on
a device first, and it isolates "does the trampoline work" from "did the key swap work".
Add the key and the rename on the second flash.

## Reserved seams: sync (v3)

Design the seams now, build later. Two regimes, both expressible as sub-commands in the
`0x10` family:

- **Live-driven.** The host holds connections and streams frames (rhythm channel, 24
  columns per write, no sweep). Drift cannot exist by construction; skew is just
  connection-interval jitter, 15 to 50 ms, well inside a beat. Costs constant radio.
- **Autonomous + resync.** Each pair animates locally; the host sends `set-phase` /
  `set-tempo` every few seconds. Battery-friendly. Needs a **fractional tempo accumulator**
  (interval in 8.8 fixed point, add per tick, advance on crossover) so quantisation to the
  20 ms tick does not drift a full beat within 30 s.

The extension owns the accumulator rather than editing the stock animation engine, which
keeps the risky region untouched. Whether two pairs stay locked all night or separate in
seconds depends on crystal-versus-RC tick, an open hardware gate below.

## Reserved seams: on-device content (v3+)

The `0x20` family. The research's conclusion is **generate the fast content, store the
slow content**: a frame compressor is a weak lever (1.3x to 2.4x measured), whereas
repointing storage at the 76.8 KB staging bank is 50x and parametric generation is 72x on
the one example measured. The endgame is a tiny animation **bytecode** (fill-rect, shift,
fade, mirror, invert, wait-N, loop, plasma-with-params), interpreter in 500 to 1,500 free
bytes, a whole animation in tens of bytes. It composes with everything else: a sub-command
selects a program, the staging bank holds hundreds, a seeded `rand()` varies them per
boot. All *derived* from `research/firmware-internals.md`; nothing here is built.

## Safety invariants the design never breaks

- Patch in place, never relink. Edits to the vendor's code are length-preserving; new
  code is **appended**, never inserted, so no existing address can move.
- **Correction: the image cannot stay at 66,084 bytes and also carry an extension.** This
  list used to say both, which is impossible: 66,084 *is* the stock length, and free flash
  starts where the image ends. The real ceiling is the application region, 76,800 bytes
  (`abs 0x16800` to `0x29400`); past that, staging overruns the saved-content pages. So the
  rule is: appended code only in `abs 0x26a24` to `0x29400`, body at or below 76,800, and
  the OTA `codeSize` covers the appended bytes so the staged-image CRC does too. v1 lands
  at 66,172, leaving 10,628 bytes. `ota.check` warns `larger-than-stock` by design; that
  warning is expected on every extension build and is not a problem to be silenced.
- Never touch the `fd00` OTA service, advertising, connection handling, the GATT core, the
  OTA handler, the payload descrambler, the CRC path, or the 2 s long-press power-off.
  These are the recovery path and `ota.check`'s protected regions.
- Do not break the button's 2 s long-press power-off; it is the only power switch.
- The AES key patch writes **exactly 16 bytes** at `abs 0x22b94`. The S-box starts at
  `0x22ba4` and a one-byte overrun breaks the cipher in both directions, uncaught by
  `ota.check`.
- Every image passes `bun run ota-check <image> firmware/TR1906R04-10_OTA.bin` before a
  single BLE byte. The second argument diffs against stock and refuses any edit landing in
  a protected region.

## Failure modes and recovery

| Failure | Cost | Recovery |
| --- | --- | --- |
| Aborted or corrupt transfer | none, nothing committed | staging bank is scratch; reconnect, retry |
| Valid image that boots but breaks BLE | high, no OTA service to re-flash through | prevented by patching in place, never relinking; caught by `ota.check` boot-vector checks |
| Image erases bootloader (>83,968 B) | unrecoverable without SWD | prevented by the 76,800 B ceiling in `patch.ts`, which refuses to emit past it |
| Extension half-flashed | cannot happen | the bootloader only copies after a hardware CRC-32 over the whole staged image matches, so a partial transfer is never applied |
| Crew group key lost | inconvenient, not fatal | the `fd00` OTA path is XOR-descrambled, not AES-encrypted, so a unit can still be re-flashed to stock. *derived* from the OTA state machine, not traced independently |

**Correction: the `JGX1` magic does not guard a half-flash.** This table used to claim a
missing magic would make the trampoline no-op back to stock. It would not, for two
reasons: a half-flash cannot reach the running image at all (the CRC gate above), and a
guard would have to execute in the stock region, where there are 12 spare bytes and no
room for one. The magic is a **marker for our own tooling**, so a built image can be read
back and report its version, capabilities and sub-command table rather than us trusting a
constant. `readExtension()` and `bun run build-firmware` use it that way.

## Build and inject pipeline

    bun run build-firmware                          # firmware/joggles-v1.bin
    bun run build-firmware out.bin --stock-key --stock-name   # extension only

That is the whole pipeline; the steps below are what it does, kept here because knowing
them is what makes the output trustworthy.

1. Decode the container: XOR pad, then the header CRC-32 over the body
   (`packages/core/src/ota.ts`).
2. **Assert** the bytes the patch depends on but does not write, currently the `LIGHT`
   back-branch at `abs 0x184a6`.
3. **Append** the extension at `abs 0x26a24`. An append can only go past the end of the
   image, so nothing existing can move; `patch.ts` refuses one that lands inside.
4. **Edit** in place, each declaring the bytes it expects to overwrite. A mismatch aborts.
   This is the only layer that catches a wrong address: an off-by-one that lands on the
   wrong instruction still produces a valid CRC, a bootable image and a clean `ota.check`.
   It has already caught one (`abs 0x216f0` is the `blo`, not the `cmp` at `0x216ee`). The
   tool also refuses length changes and any edit running past the AES key into the S-box.
5. Re-encode, keeping `codeSize` a multiple of 4 and at or below 76,800.
6. `ota.check` against stock. The build refuses to write on any fatal finding, and exits
   non-zero so it can gate a script.
7. Read the image back and confirm the `JGX1` header and that the hook's literal points at
   the entry the header declares.

The Thumb is assembled by `research/tools/thumb.ts`, an encoder for the dozen instruction
forms this needs rather than a toolchain dependency. It is checked by **reassembling the
vendor's own code**: `thumb.test.ts` rebuilds the stock `LOOP` arm and the entire notify
sender from mnemonics and asserts the bytes match the image. An encoder that reproduces
code already running on the device is worth more than one that merely compiles.

Only flash after step 3 of the safe procedure in `research/firmware-flashing.md` has
proven staging on hardware.

## Open gates before any bytes

| Gate | Blocks | What settles it | Confidence today |
| --- | --- | --- | --- |
| ~~Opcode frame offset~~ | - | **settled, and it was never a disagreement.** `r4` is a struct pointer whose frame data starts one byte in, so wire index `n` is `[r4+n+1]`: the opcode is wire index 1 *and* `[r4+2]`. Both documents were right. Confirmed twice over: `ANIM` reads its argument at `[r4+6]` for wire index 5, and our own `frame()` is verified on hardware by the `DATS` upload. The length gate is a separate field at `[r4+0xfb]`, not `[frame+0]` | *verified* |
| ~~Notify sender safe outside DATS~~ | - | **discharged.** `0x2145c` reads no DATS global; inputs are ptr+len plus two fixed scratch buffers. **But it constrains the frame:** hardcoded characteristic index `0x0b`, always sends exactly 16 bytes, payload ceiling **15 bytes**, output AES-encrypted | *verified* |
| ~~Key buffer covers both RX and TX~~ | - | **discharged by uniqueness.** One key constant, one setup call (`0x1f5fc`, single caller), one RAM schedule at `0x20002f90` read by both cipher families. **Hazard: the AES S-box starts at `0x22ba4`, immediately after the key.** Write exactly 16 bytes; a 17th corrupts the cipher and `ota.check` will not catch it | *verified* |
| ~~BLE MAC readable address~~ | - | **dissolved, not solved.** The MAC comes from the BLE stack below `abs 0x16800` and cannot be located offline. But a central already learns the peripheral address from the scan and connection, so `unit_id` in the HELLO reply is redundant. Drop it and reclaim 6 of the 15 payload bytes | *verified* reasoning |
| ~~Dispatcher hook distance~~ | - | **settled.** Overwrite the 28-byte `LOOP` block at `abs 0x182a6`-`0x182c1`, the fall-through target for unmatched opcodes. One contiguous length-preserving edit, 18 bytes used of 28, no branch island. Costs `LOOP`, still reachable as `ANIM 19` | *verified* |
| ~~Second entry into the hooked block~~ | - | **found while building, now closed.** `abs 0x184a6` in the `LIGHT` arm branches to `abs 0x182aa`, four bytes into the block, for any `L` opcode that is not `LIGHT`. The layout puts the epilogue branch exactly there. Asserted at build time. See the hook section | *verified* |
| ~~Dispatcher hook ABI~~ | - | **discharged.** Prologue `push {r3,r4,r5,r6,r7,lr}` at `abs 0x18264`, shared epilogue `pop {r3,r4,r5,r6,r7,pc}` at `abs 0x182c2`. The trampoline may clobber `r0`-`r3` and `lr` freely and must return by branching to `0x182c2`. `r4` is the frame pointer | *verified* |
| ~~Button pin and addresses~~ | - | **discharged.** Whole button section hand-checked against bytes, P5.2 confirmed as `0x50004280 + 0x28`. v2 needs no hardware re-derivation first | *verified* |
| Mode table reach | anything adding a display mode | **new.** Both `MODE` dispatch tables are byte offsets with a 510-byte reach, so a mode entry cannot address free flash either. Same trampoline problem, different table | *verified* |
| Crystal vs RC tick | v3 sync cadence | start two pairs together, time divergence | *unverified* |
| ~~SRAM genuinely free~~ | - | **confirmed.** SP `0x20003910`, app RAM ends ~`0x20003804`, so ~268 B stack headroom. The 1,536 B `DATS` buffer is confirmed by adjacency: `0x200030ac + 1536 = 0x200036ac`, exactly the live column buffer. Conclusion unchanged: take working memory from the `DATS` buffer, never the stack | *verified* |

## For the reviewer

Items 2 to 5 of the original list were the v1 blockers, and all four are now discharged
against the disassembly; the record of what each turned out to be is in "Open gates".
What remains are assumptions that **no amount of static analysis can settle**, because
they are about a device nobody has flashed yet. None of them breaks the recovery
guarantee, which rests only on "never relink, stay under 76,800 B, do not touch the
protected regions".

1. **One dispatcher patch is enough forever.** True only if the sub-command indirection
   holds up, i.e. our handler can dispatch on `[subcmd]` and reach any future feature. Low
   risk, it is a jump table, but it is the whole architecture. Note the table is indexed
   from 0, so the first sub-command in the `0x10` sync family costs 32 bytes of zero slots
   ahead of it. Cheap, but it is a real consequence of the numbering.
2. **The trampoline runs in a context where calling the notify sender is safe.** Static
   analysis says yes: same call stack as `DATSOK`, no DATS state read, stack balanced. But
   the stock callers all run inside a `DATS` handshake and ours does not, so the first
   HELLO on hardware is the actual test. If it locks up, that is where to look.
3. **The advert name field is 8 bytes and nothing else reads it.** Same-length rename, one
   occurrence in the image. *Partly settled since:* the base+offset path has now been
   traced, and it is a scatterload into RAM `0x20002604` plus a MAC suffix at +8, read by
   the advertiser at `abs 0x193c8` with a hardcoded length of 14. So "8 bytes" is a hard
   requirement rather than a ceiling. What is still unproven is that nothing *else* reads
   the buffer; a unit that comes back advertising nothing is the symptom.
4. **The dispatcher's length gate accepts our frames.** It reads `[r4+0xfb]`, not the wire
   length byte, and what fills that field was not traced. Every frame from 4 to 20 bytes
   passes today, ours are 4 to 15, and `SOUT` at length 4 already works, so the risk is
   low. Recorded because it is the one input to the hook that was reasoned about rather
   than read.
5. **The 4-level greyscale, the panel and the button are untouched by all of this.** No
   edit goes near them. Stated so a bad flash is not misdiagnosed as a display problem.

The two things worth doing before any of this is trusted are on hardware, not in the
disassembly: flash `--stock-key --stock-name` first and check the unit still behaves, then
send one HELLO and see whether a notification comes back.

### Reviewed 2026-08-09, and what the review could not reach

A second agent decoded the built image by hand, without using `thumb.ts`, and every byte
matched this design. *verified*, against `firmware/joggles-v1.bin`:

| Checked | Result |
| --- | --- |
| the 14 halfwords of the hook at `abs 0x182a6` | as laid out in "The hook itself" |
| the `LIGHT` back-branch at `abs 0x184a6` | still `00 e7`, still lands on the `b 0x182c2` at `0x182aa` |
| the literal at `abs 0x182b4` | `0x26a3d`, equal to the entry the `JGX1` header declares |
| the trampoline and HELLO handler | dispatch reads `[r4+3]`; `bl` resolves to the notify sender at `0x2145c` |
| the diff against stock | 48 bytes in 4 runs, the key patch ending exactly where the S-box starts |

**What that does not establish is anything about a device.** The confidence above is
"these bytes are the bytes this document describes", not "this firmware runs". Everything
in the numbered list above stays open, item 4 (the length gate at `[r4+0xfb]`) especially,
because no amount of decoding reaches it. The first flash is still the first test.

The review also found the wire-frame diagram wrong, corrected in "The load-bearing
decision" above, and left one thing unfixed: **`research/README.md` indexes six of the
eight files in `research/tools/` and omits `dumpcheck.ts` and `swd-recon.sh`**, so the two
SWD tools are invisible to anyone arriving through the index. `research/*.md` belongs to
track 5 (`notes/parallel-tracks.md`), which was mid-flight, so it was recorded rather than
edited.
