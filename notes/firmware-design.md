# Firmware design: the extension framework

**Status: v1 is built and unflashed.** `bun run build-firmware` produces an image that
passes `ota.check`; nothing has been near a device. Everything from v2 on is still
design. Judgement, so it lives in `notes/` not `research/`. Every byte address cited
comes from `research/firmware-internals.md` or `research/firmware-flashing.md` and
carries that file's confidence marker, repeated here. No new hardware fact is established
by this document.

***Superseded 2026-08-20, and the numbers below are the APK build's.*** The hook is
**four bytes** now, not 28, and the extension is 980 bytes on a real unit's image rather
than 88 on the APK's. Both changed because the APK build is not the build any unit here
runs: `research/donor-dispatcher-2026-08-20.md` for the hook, `notes/patch-over-bt.md`
for what the extra 900 bytes are. Everything in "The hook itself" below describes the
28-byte `LOOP`-block design, which is **not what ships**; it is kept because the
reasoning that killed it is the reason the rule about scanning for branches exists. Read
the two documents above first.

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

## Whose glasses these are, and why modifying them is fair

**Lead with it plainly, because reflashing a commercial product's firmware is not a neutral
act and these docs should not pretend it is: this is a hobby project modifying glasses we
bought and own, for our own use and interoperability, and every choice below is made to keep
it fair to the vendor and safe for anyone wearing a pair.** The specifics, so the claim is
checkable rather than asserted:

- **Only our own units are ever flashed.** Flashing needs physical SWD access to a board in
  hand (`research/hardware-access.md`), one device at a time. A stranger's pair is never
  reflashed. The most we ever do to someone else's glasses is speak the stock BLE protocol
  they already expose, temporarily and with consent (`notes/what-to-build.md`, "Controlling
  other people's glasses").
- **We do not redistribute the vendor's software.** The stock image, the decompiled app and
  the native blobs are gitignored and never committed (`CLAUDE.md`, "Don't"). This repo
  holds our own analysis and our own extension code, not the vendor's binaries; the build
  patches a locally held stock image, it does not ship one.
- **The work is interoperability and personal enhancement**, the long-accepted reasons to
  reverse-engineer a device you own: understanding an undocumented protocol to build our own
  controller, and adding features to hardware we paid for. It is not circumvention for
  redistribution, nor for reaching anything that is not ours.
- **The extension is deliberately respectful of the product.** It patches in place, never
  relinks, and never touches the vendor's OTA service, BLE bring-up or the recovery path, so
  a unit can always be returned to stock (`ota.check`, and the region guards in this file).
  We change the least we can, not the most we can.
- **The honest caveats, stated rather than buried.** Modifying firmware can void a warranty,
  it carries a real bricking risk that has already cost one unit
  (`research/brick-2026-08-08.md`), and the vendor did not design for any of this. Those
  costs fall on us, the owners, and on nobody else, which is the line that keeps it fair.

None of this is legal advice; it is the stance the project holds itself to, and the rest of
the firmware docs are written to be consistent with it.

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
| Stock image size, **not a ceiling** | 66,084 B | where the image ends is where free flash begins. The binding ceiling is the 76,800 B application region, see "Safety invariants". `joggles-v1` is 66,172 B | *verified* |
| Free SRAM while not uploading | 1,536 B `DATS` buffer at `0x200030ac` | adjacency: `0x200030ac + 1536 = 0x200036ac`, exactly the live column buffer. Reusable as extension working memory | *verified* |
| Stack headroom | ~268 B (app RAM to `0x20003804`, SP `0x20003910`) | so extension state cannot live on the stack. `research/firmware-internals.md`, "SRAM budget, confirmed" | *verified* |
| Spare CPU per 100 fps frame | ~260,000 cycles, ~1,200 per pixel | 6.42 ms frame time at 26 MHz | *derived* |

The constraint is SRAM, not flash or CPU. Any extension feature that needs working memory
takes it from the 1,536 B `DATS` buffer, which is free whenever saved content is not in
use, and must not assume the stack.

*Corrected 2026-08-11: the second row read "image ceiling before anything else is touched
| 66,084 B", which contradicted this file's own safety invariant. 66,084 is the stock
length; any image carrying an extension is necessarily larger, and `joggles-v1` is 66,172,
both *verified* against the built binary. The only ceiling that binds is 76,800.*

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
at `abs 0x18280`). Length is gated first and must be 4 to 20 inclusive, bounded at both
ends, but it is read from a separate struct field at `[struct+0xfb]` (the sequence starts
at `abs 0x18268`), **not** from `[frame+0]`. Decode in `research/firmware-internals.md`.
*verified.* Two ways in, cheapest first:

1. **Repoint the dead compare.** `research/firmware-internals.md` records a redundant
   `cmp r2,#'S'` at `abs 0x182a2` that can never fire because an earlier `S` opcode always
   matches first. Its branch target can be repointed at our trampoline. *derived*; the
   opcode would then be an `S`-prefixed frame distinguished by a later byte, which is
   slightly awkward but costs no added instructions.
2. **Add one clean compare** for a fresh opcode letter, inserted in the chain. Costs a few
   bytes and keeps the opcode a distinct letter.

Either way the hook must branch from the dispatch region near `abs 0x182xx` to the
extension at `abs 0x26a24`, which is **59,262 bytes (~58 KB) away**. That is far beyond a
short `B` (+/-2 KB), so it needs a `BL` or a literal-pool PC load, and the sequence must
not clobber a register the dispatcher relies on after the call.

*Corrected 2026-08-11: this line has now carried two wrong figures, ~18 KB and then 34,690
bytes, and **both were wrong**. `0x26a24 - 0x182a6` = 59,262, *verified*, and
`research/firmware-internals.md`, "What patching would buy, ranked", had it right all
along. No conclusion moves, since all three are far outside a short branch's reach, but
this is the document reviewers start from and its arithmetic gets copied, not rechecked.*

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
instead puts the epilogue branch **exactly at `abs 0x182aa`**, where the back-branch
lands, compares for `J` at the top, and spends the tail on the literal and unreachable
nops: 18 of the 28 bytes used, no branch island needed. The 14 halfwords are listed once
in the repo, in `research/firmware-internals.md`, "Correction: the block has two entry
points, and its first compare was already dead"; `research/tools/ext.ts` builds them and
`ext.test.ts` asserts them against the image.

An unmatched opcode and a non-`LIGHT` `L` frame both reach the epilogue, exactly as stock
did once `LOOP` stopped existing; only `J` reaches us. The cost is `LOOP`, which only
called `set_mode(24)` and stays reachable as `ANIM 19`. The back-branch is a build-time
assertion, so if it ever moves the build fails rather than the device.

**The lesson worth keeping:** "this block is only entered at the top" is an assumption, and
on a flat compare chain with shared tails it is often false. Scan for branch targets
inside any block before overwriting it. One `B` in 66 KB was the difference between a
correct hook and a subtly wrong one.

**ABI, *verified*:** the dispatcher's prologue at `abs 0x18264` is
`push {r3,r4,r5,r6,r7,lr}` and every path returns through `pop {r3,r4,r5,r6,r7,pc}` at
`abs 0x182c2`. `r4` is the frame struct pointer and is what the trampoline is handed in
`r0`. So the trampoline may clobber `r0`-`r3` and `lr` freely, must leave the stack
balanced, and returns by branching to `0x182c2` rather than through `lr`.

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

    +0x00  magic "JGX1"      marks a valid extension to our own tooling
    +0x04  ext_version u16   our firmware version, returned by HELLO
    +0x06  cap_bitmap u16    which sub-command families are present
    +0x08  entry u32         trampoline entry, Thumb, so the low bit is set
    +0x0c  size u32          extension length, so a read-back knows what to check
    +0x10  table_count u16   how many sub-command slots follow
    +0x12  reserved u16
    +0x14  subcmd_table      u16 offset per sub-command, 0 = absent
    ...    handler code
    ...    read-only data (capability text, defaults)

*Corrected 2026-08-11: this diagram put `subcmd_table` at `+0x08` and listed no entry,
size or table count at all, so anyone laying out a v2 header from it would have collided
with three fields. `HDR` in `research/tools/ext.ts` is the authority and the built header
matches it. The magic was also called a half-flash guard, which "Failure modes" explains
it is not. v1's values are in the "Reviewed 2026-08-09" table.*

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

**These numbers are superseded. `packages/core/src/jgx.ts`'s `MSG` is the wire.** The
table below is the original design and the numbering it proposed did not survive: `0x01`
became `UPD_REPLY` when the updater was built, and that half is **resident**, so it cannot
be renumbered by any slot. *Corrected 2026-08-20, after track 61 built the real table and
track 62 found this note still contradicting it.*

| type | Meaning | As designed | **As built** |
| --- | --- | --- | --- |
| HELLO reply | version, capability bitmap | `0x00` | `0x00` |
| answer to any `UPD_*` | not foreseen here at all | - | **`0x01`, resident** |
| button event | edge + free-running timer count | `0x01` | **`0x02`** |
| answer to a setting | not foreseen here at all | - | **`0x03`** |
| battery | millivolts, the value already sits at `0x20003734` | `0x02` | **`0x04`** |
| tick rate | not foreseen here at all | - | **`0x05`** |
| sync status | phase / tempo, for multi-pair diagnostics | `0x03` | not built |

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

**Read the key swap the right way round: it is first a defence, and the crew credential
falls out of the same change.** Its primary job is that nobody holding the stock vendor app
can drive a unit someone is wearing in a field full of `GLASSES-` pairs; that the group key
then also gates crew control is the same 16 bytes doing a second job. The extension adds no
way to write another person's flash or to leave content they cannot clear: reaching a
non-crew pair is the temporary, no-flash live route in `notes/what-to-build.md`, "At a
festival: spraying a temporary image at nearby pairs", governed by the consent rule there.
"Stranger control" below names a capability the stock protocol already hands every
vendor-app user, not a covert feature this extension introduces.

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
| v2 | yes | Button back-channel: button events over notify. Unlocks tap tempo, message handoff down a row, stranger opt-in, and the playlist advance ("Reserved seams: playlist") | re-derive the *derived* button addresses on hardware |
| v3+ | yes | Sync primitives, seeded-rand decision, on-device content, staging-bank capacity, animation bytecode | crystal-vs-RC, which needs a second working pair and so sits behind the SWD repair, unless the clock init is read offline first. SRAM budget: **now confirmed**, no longer a dependency |

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
  `set-tempo` every few seconds. Battery-friendly. Needs a **fractional tempo
  accumulator**: the fixed-point arithmetic and why whole ticks drift a full beat within
  30 s are in `notes/what-to-build.md`, "Syncing several pairs", not repeated here.

The design commitment is that **the accumulator lives in our region**: the extension owns
it rather than editing the stock animation engine, which keeps the risky region untouched.
Whether two pairs stay locked all night or separate in seconds depends on the
crystal-versus-RC tick, which is still open and is **not** the quick measurement it was
long described as: it wants two working pairs and only one exists. See "Open gates".

## Reserved seams: on-device content (v3+)

The `0x20` family. The research's conclusion is **generate the fast content, store the slow
content**, and it rules a frame compressor out. The measured ratios, the staging-bank
capacity table and the parametric multiple are in `research/firmware-internals.md`,
"Compression is a weak lever, measured", and are not restated here.

What belongs here is the design consequence: **bytecode is the seam in the `0x20`
family.** A tiny animation bytecode (fill-rect, shift, fade, mirror, invert, wait-N, loop,
plasma-with-params) with an interpreter in 500 to 1,500 free bytes puts a whole animation
in tens of bytes, and it composes with everything else: a sub-command selects a program,
the staging bank holds hundreds, a seeded `rand()` varies them per boot. *derived*;
nothing here is built.

## Reserved seams: playlist (v2 button + v3 slots)

The phone-side playlist exists and is cycled by the host: 2 to 10 items, statics live and
every scroller packed into one type 1 reel, so a press writes no flash. It is
`core/src/playlist.ts` and the judgement is `notes/playlist.md`.

What belongs here is which two seams it lands on, because it is the first feature that
needs both. **Select is a sub-command in the `0x20` family and the advance is the v2 button
hook**: entries become page-aligned slots in the staging bank, the reel concept disappears
once the device can hold all ten scrollers, and the hook at the press latch advances an
index in RAM and repoints the display's content pointers, so a press still writes no flash.
The index resetting to item 1 at power-on is deliberate, slot upload rewrites only that
slot's pages, and any OTA wipes the bank so playlists re-upload after a flash. The 2 s
long-press power-off is never touched.

`playlist.Cycler`'s `Driver` is the seam on our side: four methods, and the firmware version
replaces what they send without moving `Entry`, `check` or `compile`. Detail and the button
addresses this waits on are `notes/playlist.md`, "The firmware version this is shaped for",
and `research/firmware-internals.md`, "Content in the staging bank". *derived*, and it
inherits v2's dependency: the button addresses are hand-decoded and unwitnessed.

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
| **Commit (OTA ctrl `03`) hands control to an unverified bootloader. This is the one that happened, 2026-08-08** | the unit. `GLASSES-12C3EF` staged cleanly, its own CRC matched, it reset itself and never came back, so the fault is the handoff into LDROM rather than the image | **none over the air, but SWD recovers it.** *Corrected 2026-08-20: this said the whole persistent change was `CONFIG0 = 0xFFFFFF3F` and the repair was one erase of the config page. Both were wrong.* `CONFIG0` was never the fault; the bootloader installed the **wrong application**, one whose registrar fills 22 of 26 callback slots. The repair is to write a working unit's application region over SWD, which was done on 2026-08-20 and brought the unit back: `research/aprom-write-2026-08-20.md`. Still do not send ctrl `03` to anything; `bun run flash stage` is safe and was run on that same unit with no harm |
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

**Steps 1 to 3 of the safe procedure in `research/firmware-flashing.md` are all anyone
should run today**, and nothing goes near a device until step 3 has proven staging on
hardware. **Step 4 is struck**: it was `bun run flash commit` on the stock container,
verbatim the command that bricked `GLASSES-12C3EF`. `packages/cli/src/flash.ts` now refuses
`commit` without `--ldrom-verified`, printing the brick and exiting 2 before it opens the
Bluetooth adapter, and `--yes` alone no longer gets past it. Only an LDROM dump over SWD
showing a bootloader that restores `CBS` honestly supports that flag, and nobody has dumped
it, so the bar is in code rather than in a reader's discipline. Do not pass it to silence
the tool.

## Open gates before any bytes

**Two are still open.** They are stated in full below. The other nine are discharged, and
what each turned out to be is recorded in the section that owns it rather than duplicated
here, because this table used to restate half the document two hundred lines further down
and the two live gates were lost in it.

| Gate | Blocks | What settles it | Confidence today |
| --- | --- | --- | --- |
| **Mode table reach** | anything adding a display mode | **open.** Both `MODE` dispatch tables are byte offsets with a 510-byte reach, so a mode entry cannot address free flash either. Same trampoline problem as the dispatcher, different table, and no `LOOP`-shaped block to spend on it | *verified* |
| **Crystal vs RC tick** | v3 sync cadence | **open, and the obvious test CAN now be run.** *Corrected 2026-08-20: this said the test needed two working pairs and we had one. Unit 1 was repaired on 2026-08-20, so there are three.* Starting two pairs together and timing the divergence is available again. Two discriminators do not need a second unit: **read the clock init** behind the `SystemCoreClock` global at `abs 0x171a4` (`research/firmware-internals.md`, "Unverified"), which settles it offline at *derived* confidence, or **time one pair against a host clock** over ten minutes, where RC error of 1 to 2% shows up as seconds and crystal error as milliseconds. Pair-to-pair skew is at most twice one unit's error, so one unit bounds it | *unverified* |
| ~~Opcode frame offset~~ | - | discharged, see "The hook itself", the frame-offset caveat | *verified* |
| ~~Notify sender safe outside DATS~~ | - | discharged, with three constraints on the frame: see "The back-channel: structured notify" | *verified* |
| ~~Key buffer covers both RX and TX~~ | - | discharged by uniqueness, plus the S-box hazard: see "Identity, the crew key, and the rename" | *verified* |
| ~~BLE MAC readable address~~ | - | dissolved rather than solved, see "HELLO and capability negotiation" | *verified* reasoning |
| ~~Dispatcher hook distance~~ | - | discharged, see "The hook itself" | *verified* |
| ~~Second entry into the hooked block~~ | - | discharged, see "The hook itself", the correction | *verified* |
| ~~Dispatcher hook ABI~~ | - | discharged, see "The hook itself", the ABI paragraph | *verified* |
| ~~Button pin and addresses~~ | - | discharged. Whole button section hand-checked against bytes, P5.2 confirmed as `0x50004280 + 0x28`: `research/firmware-internals.md`. v2 needs no hardware re-derivation first | *verified* |
| ~~SRAM genuinely free~~ | - | discharged, see "Budget: what we have to work with" | *verified* |

## For the reviewer

Items 2 to 5 of the original list were the v1 blockers, and all four are now discharged
against the disassembly; the record of what each turned out to be is in the section that
owns it, indexed from "Open gates".
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
4. ~~**The dispatcher's length gate accepts our frames**, the one input to the hook that
   was reasoned about rather than read.~~ **It was read, on 2026-08-09, and the answer is
   that we sit on the boundary.** The gate is at `abs 0x18268`, reads `[r4+0xfb]` rather
   than the wire length byte, and is bounded at **both** ends: **4 to 20 inclusive**. The
   byte-level decode belongs to `research/firmware-internals.md` and is not restated here.
   `jgx.hello()` is 4 bytes, **exactly on the lower bound**, which is the part a designer
   needs: the obvious future change, a sub-command frame shorter than 4 bytes, is dropped
   by the gate rather than answered, on hardware nobody can currently test. Still
   *derived* about behaviour, because it is a hand-decode of a static image and nothing
   has been sent to a device. *Corrected 2026-08-11: this item, and the sentence under the
   review table below, said the gate was reasoned about rather than read and that no
   amount of decoding reached it. Decoding reached it. Kept rather than deleted because "a
   field the dispatcher fills from somewhere we have not traced" is exactly the shape of
   claim that gets left undecoded for a session too long.*
5. **The 4-level greyscale, the panel and the button are untouched by all of this.** No
   edit goes near them. Stated so a bad flash is not misdiagnosed as a display problem.

The two things worth doing before any of this is trusted are on hardware, not in the
disassembly: flash `--stock-key --stock-name` first and check the unit still behaves, then
send one HELLO and see whether a notification comes back.

**Both are barred today, and that is not a matter of caution.** Either needs an OTA
commit, which is the exact operation that bricked `GLASSES-12C3EF` on 2026-08-08, so `bun
run flash commit` refuses to run without `--ldrom-verified` (see "Build and inject
pipeline"). This is the plan for after the SWD work, not for the next session.

### Reviewed 2026-08-09, and what the review could not reach

A second agent decoded the built image by hand, without using `thumb.ts`, and every byte
matched this design. The last four rows were folded in on 2026-08-11 from
`.claude/context/firmware-flash-readiness.md`, now retired, and re-read from the binary
that day. *verified*, against `firmware/joggles-v1.bin`:

| Checked | Result |
| --- | --- |
| the 14 halfwords of the hook at `abs 0x182a6` | as laid out in "The hook itself" |
| the `LIGHT` back-branch at `abs 0x184a6` | still `00 e7`, still lands on the `b 0x182c2` at `0x182aa` |
| the literal at `abs 0x182b4` | `0x26a3d`, equal to the entry the `JGX1` header declares |
| the trampoline and HELLO handler | dispatch reads `[r4+3]`; `bl` resolves to the notify sender at `0x2145c` |
| the diff against stock | 48 bytes in 4 runs, the key patch ending exactly where the S-box starts |
| the `JGX1` header at `abs 0x26a24` | entry `0x00026a3d` (Thumb, so the odd bit is the mode bit), size `0x58` = 88 bytes |
| the sub-command table | count 1, and `TABLE[0] = 0x40`, which puts `hello` at `abs 0x26a64` |
| the HELLO reply constant at `abs 0x26a74` | `f0 00 01 00 01 00`: marker `0xf0`, type `0x00`, ext version 1, capability bitmap 1. 6 bytes, inside the 15-byte notify ceiling |
| the image length | 66,172 B of body, against stock's 66,084, so 10,628 B of the gap left |

**What that does not establish is anything about a device.** The confidence above is
"these bytes are the bytes this document describes", not "this firmware runs". Everything
in the numbered list above stays open, and the first flash is still the first test.

*Corrected 2026-08-11: the paragraph above used to single out item 4, the length gate at
`[r4+0xfb]`, as the one thing "no amount of decoding reaches". It was decoded on
2026-08-09: the bound is 4 to 20 and `HELLO` sits on the lower one. What stays open about
it is only whether the device behaves as the bytes say.*

The review also found the wire-frame diagram wrong, corrected in "The load-bearing
decision" above, and left one thing unfixed: ~~`research/README.md` indexes six of the
eight files in `research/tools/` and omits `dumpcheck.ts` and `swd-recon.sh`~~, which made
the two SWD tools invisible to anyone arriving through the index. **Closed 2026-08-11: both
are indexed now.** Kept as the record of why the reviewer wrote it down rather than fixing
it: `research/*.md` belongs to track 5 (`notes/parallel-tracks.md`), which was mid-flight,
and one file edited from two tracks at once is how a document ends up wrong.
