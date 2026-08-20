# Patching over Bluetooth, twice, without a probe

**The bar, in Jacob's words:** that we can patch over BT alone with no probe involved,
that we can patch **again** afterwards without bricking it, "and all that". The second
half is the one that decides the design. One-shot delivery with no way back is exactly
what cost `GLASSES-12C3EF` on 2026-08-08.

Judgement, so it is here rather than in `research/`. **It is built** as of 2026-08-20:
`research/tools/updater.ts` is the firmware, `packages/core/src/jgx.ts` the wire format,
and `research/tools/updater.test.ts` drives the whole loop against an ARMv6-M interpreter
and a model of this FMC (`research/tools/thumbsim.ts`). **Nothing in it has run on
silicon.** Confidence markers are `research/README.md`'s three.

**Architecture in one line:** a **resident** half written once over SWD that can never be
rewritten over the air, and **two slots** in the staging bank that carry every feature and
are replaced over the air, alternately, with the older one intact the whole time.

## What "over BT" cannot mean

**Not OTA ctrl `03`.** The bar on the vendor's commit path is unchanged and the repair of
unit 1 does not lift it: `research/ldrom-2026-08-19.md` establishes that the bootloader has
no recovery entry point at all, no radio, no GPIO read so no button, transmit-only UART.
A commit that hands control to it is exactly as unsurvivable as it was in August. What
changed is only that SWD can now undo one, and undoing one costs a probe, a donor dump and
150 page erases.

So "patch over BT" has to mean **our own path**, driven by our own code, through the FMC
registers the application already drives. That is not exotic: the vendor's application
erases and programs 130 pages of the staging bank over a live BLE connection every time it
takes an OTA (`research/fmc-erase-program.md`, witness 2, *verified* from bytes). We do the
same thing and stop before the part that kills units.

## The one property everything else serves

**A failed update must leave a unit that still answers the next update.**

That rules out the obvious design, which is to have the extension rewrite itself. Two
reasons, and the first is fatal:

- **It would erase the page it is executing from.** The vendor never does this; every one
  of its ISP call sites runs from a different page from the one being written, and
  `research/fmc-erase-program.md` calls that "the classic FMC gotcha". Working round it
  means copying a flash writer into SRAM, which costs code and re-opens the SRAM budget
  question, and the SRAM addresses in `notes/firmware-design.md` are the APK build's and
  do not hold on the image a real unit runs (the stack top alone moved from `0x20003910`
  to `0x20003470`).
- **There is no way back from a power loss halfway.** The hook is a `bl` into the
  extension. With the extension erased, that `bl` lands on `0xffffffff`, which faults on
  **every command frame the dispatcher does not match**. The unit would still boot and
  advertise and then die the moment the app spoke to it. From a wearer's point of view
  that is a brick, and it would need the probe.

The A/B design has neither problem, because the half that runs the update is never the
half being updated.

## The layout

*verified* free space, from `firmware/dump-12E69E-2026-08-19-a.bin`:

| Region | Span | Size | Who writes it |
| --- | --- | --- | --- |
| resident block | `0x28800`-`0x28ccb` | **1,228 B, spanning 3 pages** | **SWD only** |
| spare, in-window | `0x28bd4`-`0x293ff` | 2,092 B | SWD only, unallocated |
| slot A | `0x29400`-`0x2b3ff` | 16 pages, 8,192 B | **over BT** |
| slot B | `0x2b400`-`0x2d3ff` | 16 pages, 8,192 B | **over BT** |
| rest of the staging bank | `0x2d400`-`0x3bfff` | 60 KB | nothing yet |

Two things about that table are decisions rather than facts.

**The resident block is page-aligned at `0x28800`, not at the first free word.**
`ext.placeExtension` used to put it at `0x28788`, four-byte aligned, which straddles the
page holding live application data at `0x28600`-`0x28786`. Two reasons it moved, and the
second is what forced it: a block whose whole point is "SWD writes this and nothing else
ever does" reads better as whole pages, and `0x28784` holds the byte pair `a5 03`, which
decodes as `adr r5, #12` and names `0x28794`, sixteen bytes inside where the block used to
start. It is data in the image's tail, not code, but nothing offline can tell the
difference, so starting at the next page puts the block outside every `adr`'s ~1 KB reach
rather than arguing about it. Costs 120 of the 3,192 free bytes.

**The slots are in the OTA staging bank, which is outside the application region.** Three
consequences, all wanted:

- `swdflash` refuses every address outside `0x16800`-`0x29400` (`WINDOW` and its `guard`),
  so the SWD tool structurally cannot write a slot and the over-BT path structurally
  cannot write the resident block. The two delivery routes have disjoint targets.
- The staging bank is scratch by design. On the donor it holds 150 used pages of some
  previous staged image, which we erase.
- **A vendor OTA would clobber both slots.** That is acceptable: the unit falls back to
  resident-only behaviour, which still answers `HELLO` and still takes an update. It is
  not acceptable to *commit* such an OTA, and that is barred already.

## The slot format

    +0x00  magic "JGXS"      u32, PROGRAMMED LAST. This word is the commit.
    +0x04  gen               u32, higher wins. Zero is reserved, so it means "invalid"
    +0x08  len               u32, body length in bytes
    +0x0c  crc               u32, CRC-32 of the body
    +0x10  body              a JGX1 block: its own magic, version, capabilities,
                             entry, size and sub-command table

**The body is a `JGX1` block, the same shape as the resident one**, so a slot describes
itself and the resident dispatcher reads its table the same way it reads its own. There is
no `entry` or `version` field in the header above because the body already carries them,
and a second copy is a second thing that can disagree.

**Why the magic is last and why one word is enough.** Flash programming can only clear
bits, so a word that is partially programmed holds a strict superset of the target's
`1` bits. It therefore cannot equal the magic unless the program completed. A power loss
anywhere before that word lands leaves a slot that fails validation, and the other slot is
still whole. That argument is *derived* from how NOR flash programs, not measured on this
part.

**Which slot is live is computed, never remembered.** Valid magic and the higher `gen`
wins; neither valid means resident-only; equal `gen` on both, which should not happen,
takes the lower address and is reported by `UPD_STATUS` rather than hidden.

## The wire protocol, and why it holds no state

Sub-commands in the `0x01`-`0x0f` family, which `notes/firmware-design.md` already reserves
for session and control. `0x00` stays `HELLO`; `0x10` and up belong to the slot.

| Sub | Name | Payload | What it does |
| --- | --- | --- | --- |
| `0x01` | `UPD_BEGIN` | `len16`, `crc32` | picks the inactive slot, erases the pages `len` needs, programs `gen`/`len`/`crc`. Leaves the magic erased |
| `0x02` | `UPD_DATA` | `seq16`, 8 bytes | programs at `slot + 0x10 + seq * 8` |
| `0x03` | `UPD_END` | none | CRC-32 over `len` bytes of the body, compare, and **only then** program the magic |
| `0x04` | `UPD_ABORT` | none | erase the inactive slot's first page, so its header can never validate |
| `0x05` | `UPD_STATUS` | none | which slot is live and its generation |

**Eight body bytes a frame, because a command frame is one AES block.** `protocol.frame`
caps the body at 15 bytes, so opcode plus sub-command plus a `u16` sequence leaves 11, and
8 is the largest multiple of four that fits: two whole words, so every slot write stays
word-aligned and no frame straddles a word. That is 1,024 frames for a full 8 KB slot,
about 30 seconds write-with-response. Faster would mean carrying slot data on the `960a`
DATS stream, which is another edit to the vendor's code, and the hook is the one edit and
it is spent.

**No RAM is used between frames, and that is the point.** The write address is derived
from `seq`, the length and CRC live in the slot header in flash, and which slot is being
written is recomputed each time from the two generations. So there is no session to lose,
no timeout to get wrong, and no interaction with the 1,536-byte `DATS` buffer whose address
on the donor build nobody has re-derived. An interrupted update is not a state, it is just
a slot whose magic never landed.

**`UPD_BEGIN` erases the whole slot in one call.** Sixteen page erases back to back will
stall instruction fetch for a few milliseconds each. The vendor's own OTA erases 130 pages
the same way over a live connection, so the connection survives it; that is the strongest
evidence available and it is *derived*, not measured by us.

**Every `UPD_DATA` goes out write-with-response.** The link layer then gives ordering and
delivery, and the `seq` is belt and braces: a frame past the declared length is refused at
once rather than discovered by a CRC failure after the whole 8 KB has been sent. A frame
sent twice is harmless, because the address comes from the sequence number and programming
a word to the value it already holds clears no new bits.

**CRC-32 is ours, not the FMC's.** The part has a hardware CRC (`ISPCMD 0x2d`, driven by
the application at `abs 0x17958` on the APK build) and it would be free, but nobody knows
its polynomial, so the phone could not compute a matching value without a measurement on
silicon. A bitwise CRC-32 is about 30 bytes of Thumb and roughly 15 ms over 8 KB at 26 MHz,
and it agrees with `ota.crc32` by construction. Take the 15 ms.

## The guard, which is the only thing between the updater and the whole chip

`research/swdflash-review-2026-08-20.md` establishes the asymmetry and it applies here
unchanged: **`APUEN` enables the whole of APROM, and there is no hardware bit that
distinguishes the application region from the BLE stack below it.** The config page and the
LDROM are refused by hardware at their apertures; everything else is refused by software or
not at all.

So the resident updater carries the same shape of guard `swdflash` does, in firmware:

- one call site for `ISPADR`, and the guard is on it. Nothing else may write that register
- every address bounded to `[SLOT_A, SLOT_B_END)`. **The resident block is outside that
  bound**, so the updater cannot rewrite itself even if the sub-command asked it to
- page erases asserted 512-byte aligned, word programs asserted word aligned. A misaligned
  erase address is not an error on this FMC, it silently erases the containing page
  (`research/fmc-erase-program.md`, finding 6)
- read back every word programmed. **On this FMC generation software read-back is the only
  detection mechanism that exists**: there is no verify flag, no program-fail flag and no
  blank check, and `ISPFF` reports only pre-flight refusals (`research/numicro-fmc-upstream.md`)

## What every failure leaves behind

| Failure | State afterwards | Recovery |
| --- | --- | --- |
| power loss mid-`UPD_DATA` | inactive slot part written, magic erased | none needed. Live slot unchanged; resend |
| power loss during the magic word | word holds extra `1` bits, so not the magic | as above |
| bad CRC at `UPD_END` | magic never programmed | `UPD_BEGIN` again. Live slot unchanged |
| slot code that crashes on entry | HardFault on a `J` frame that reaches the slot | **the weak point.** See below |
| both slots erased or invalid | resident-only: `HELLO` and `UPD_*` still answer | send a slot |
| a vendor OTA stages over the slots | as above | send a slot |
| a bug in the **resident** half | whatever the bug does | **probe only** |

**The slot that crashes on entry is the one real hole**, and it is worth being plain about
it: nothing in the resident half can prove a slot's code is correct, only that its bytes
arrived intact. A slot whose handler faults takes the unit down on every `J` frame that
reaches it, which is recoverable over BT only if the fault does not stop the radio.
Mitigations, in order of how much they are worth:

1. **The resident half owns `HELLO` and every `UPD_*`**, and dispatches them **before**
   consulting the slot table. So a broken slot cannot make the unit unreachable by the
   commands that replace it. This is the load-bearing one.
2. ~~A slot is entered only for sub-commands `0x10` and above.~~ **False as written,
   corrected 2026-08-20 when the dispatch was actually built.** `jgx.SUB.TICK` is `0x06`,
   inside the range this line reserves, and it is answered by a slot. What is load-bearing
   is point 1, the ordering: the resident table is asked first and the slot only after, so
   `buildSlot` refuses any id the resident half answers and names the rule when it does.
   The number is not the guarantee, the order is. **The live hazard this leaves**: a future
   *resident* sub-command at `0x06` would silently shadow a slot's `TICK`, so allocate new
   resident ids from `0x07` upward and check `catalogue.ts` before taking one.
3. A boot counter would let the resident half demote a slot that faulted twice, but it
   needs a byte of flash written on every boot, which is flash wear on the critical path.
   **Not doing this in v2**; recorded so nobody re-derives it.

**And the honest limit: the resident half is replaceable only with a probe.** That is the
whole reason the probe stays clipped to unit 1 (Jacob, 2026-08-20, `.claude/locks/swd`),
and it is the argument for the resident half being as small and as boring as it can be:
trampoline, `HELLO`, the five update sub-commands, the FMC primitives, the guard and a
CRC. About 620 bytes by estimate. Every feature anyone actually wants goes in a slot.

## What is built, and what each test actually proves

`bun test research/tools/updater.test.ts`. Every one of these runs the assembled bytes,
so they are claims about behaviour rather than about layout.

| Proved | How |
| --- | --- |
| a slot arrives, validates and goes live | full upload, then the header and body read back byte for byte |
| **the magic is the last word programmed** | the FMC model records every program in order, and the magic is last |
| **patch again, and the first slot is untouched** | second upload lands in B at generation 2, A still holds generation 1 and its body |
| **and again**, alternating back to A | three round the loop, generations 1, 2, 3, and `UPD_STATUS` agrees |
| a wrong CRC is refused and the live slot keeps running | B written, magic never programmed, A byte-identical, status still A |
| an interrupted transfer leaves a slot that cannot validate | stop after three frames, never commit; status still names the old slot |
| and the next attempt just starts again | fourth upload lands in the same slot and commits |
| `UPD_ABORT` makes a half-written slot unusable on purpose | first page erased, so the header can never validate |
| a sequence past the declared length is refused | `BAD_SEQ`, before the guard is consulted |
| length zero or larger than a slot is refused **before any erase** | `BAD_LENGTH`, and the erase count is zero |
| `UPD_END` with nothing uploaded does not walk off the end of flash | the erased header reads `0xffffffff`, which the upper bound catches |
| **with no slot at all it still answers** | `UPD_STATUS` says `NO_SLOT` and `HELLO` still replies |
| **nothing outside the slots is ever written** | every erase and program address across two full updates swept |
| the FMC is locked again after every command, failures included | `ISPCON` and `SYS_WRPROT` both zero afterwards |
| the firmware's CRC is `ota.crc32` | six body sizes uploaded, each commits only if the two agree |
| an odd-sized body commits | the last frame is padded and the CRC covers only the declared length |
| a frame sent twice is harmless | the address comes from the sequence number, so it is idempotent |
| **the vendor application and the BLE stack are untouched** | both compared byte for byte after two updates |

### Two bugs the tests found in the first draft, worth keeping

**The reply buffer was in flash.** `reply` stored the result code into a constant in the
extension's own literal pool, which is not writable and, worse, is inside the resident
block. Replies are built on the stack now. There is no writable RAM address this code can
name: the SRAM map in `notes/firmware-design.md` is the APK build's, and the donor's
differs (the stack top alone moved from `0x20003910` to `0x20003470`).

**Two error paths left the stack unbalanced.** `upd_begin` pushed the body length around
its erase loop and jumped to the failure label without popping it, so
`pop {r4,r5,r6,r7,pc}` would have returned to a saved register. The erase loop is its own
subroutine now, which unwinds its own frame on both exits.

## What this unblocks

Every firmware feature in `notes/what-to-build.md`, "Firmware patches, ranked", becomes a
**slot** rather than a probe session. That is the whole point: today each of those costs a
case opening, a 12-minute SWD write and a bricking risk, which is why the project has
spent its life on static analysis. As a slot each costs a few seconds over Bluetooth and
is undone by sending the previous slot again.

The ones that were waiting only on delivery: seeding `rand()`, the tile palette,
sub-column scroll interpolation, and battery over BLE. The sync primitives and the
animation bytecode are `0x10` and `0x20` family sub-commands and land the same way.

**Two of the list turned out NOT to be slot work, and both were found by building it.**

- **The animation tick cannot be a slot.** The rate is an immediate handed to the vendor's
  `TIMER_Open` and every compensation is an immediate in the vendor's code, while a slot's
  guard bounds every write to its own slot. So the tick is a **build-time image edit**
  (`bun run build-firmware --feature tick`), and the slot half only reads back the rate and
  the hold byte so `jgx.powerOffIntact()` can be checked against a real unit instead of
  trusted. 44 halfwords on the donor: 1 rate, 33 `cmp` immediates, 10 `SPEED` divisors.
- **Notify on button press cannot be a slot either, and it is the bigger loss**, because it
  is what unlocks tap tempo, message handoff and the playlist advance. Nothing in the slot
  framework can express code that runs anywhere but inside a command frame: no ISR
  installation, no per-tick hook. A press arrives in the TIMER0 ISR, so it needs a second
  edit to the vendor's code, and **the hook is spent**. That makes it SWD-only with its own
  image. The same finding kills `jgx.ButtonEvent.ticks` as a slot feature: there is no
  free-running tick counter on stock, because every per-tick counter is reset by the event
  it measures.

**What a slot cannot do** is anything needing an edit to the vendor's own code, because
the hook is the one edit and it is spent. Bigger ATT writes, radio parameters and deleting
the OTA service are all still SWD-only (`notes/what-to-build.md`, "Tier 2"), and each
wants its own image and its own probe session.

## Sequencing, and the one thing that must not be got wrong

**The updater has to be in the FIRST image we flash.** An image that works but cannot be
replaced over the air puts us back where we were on 8 August, only with our own code on the
device. So the order is:

1. rebase the image on a real unit's dump and pass `ota.check(image, { reference })` with
   `referenceUnregistered === 0`. **Done, 2026-08-20**, and it is what
   `research/donor-dispatcher-2026-08-20.md` had to happen first
2. build the resident half: guard, FMC primitives, CRC, the five sub-commands. **Done**,
   1,228 bytes at `abs 0x28800` over 3 pages, leaving 1,844 bytes of in-window spare,
   and every path exercised offline
3. flash **one** unit over SWD, with the probe still on it. **Jacob's call, not taken**
4. prove the loop on silicon, in this order, because the third is the one that proves the
   bar and the first two only prove the feature:
   1. send a slot, watch `UPD_STATUS` report generation 1
   2. send a second, watch it report generation 2 in the other slot
   3. send a **deliberately corrupt** slot and watch it refused with the good one still
      running, then an **interrupted** one, then one built for the wrong slot address
5. only then consider a unit with no probe on it

## Open, in the order it matters

- **Nothing here has run.** Every claim is *derived* from the vendor's own code and from
  two dumps.
- ~~**The FMC primitive addresses on the donor build have not been resolved.**~~
  **Resolved 2026-08-20, track 59**: `research/fmc-primitives-donor-2026-08-20.md`. The
  base is `0x5000c000` with `SYS_REGLCTL` at `0x50000100`, identical on both builds, found
  by the poll idiom rather than by matching an address, and our updater's constants check
  clean against both images. **The trap it uncovered is worth more than the answer**: the
  two builds' FMC helper block is *not* a constant offset apart, `+0xf4` for the first six
  helpers and `+0x110` for the word programmer and the config writer, because the donor
  carries a 28-byte `ISPCMD 0x04` helper the APK build lacks. Porting an address by adding
  a delta gets six right and lands inside the wrong function for the last two.

- **Three findings from the adversarial review, 2026-08-20**, which are the reason nothing
  has been flashed yet. `research/patch-over-bt-review-2026-08-20.md` is the full list.
  - **`UPD_DATA` can reach the other slot, including the live one.** The address guard
    bounds writes to *both* slots rather than the target, and the length check leans on a
    header word that a failed or aborted `UPD_BEGIN` never wrote. Demonstrated: after an
    abort, one frame at sequence 1022 programs the other slot's magic and generation and
    is answered `OK`. Reachable on unit 1 from its first command, because its staging bank
    still holds the APK brick image.
  - **There is no slot dispatch at all yet**, so "the resident half answers before any
    slot" is currently *vacuous* rather than proven, and step 4.3 of the sequencing below
    would prove nothing. It becomes actively false once slot code runs in the TIMER0 ISR,
    which is what the button and tick features need.
  - **`UPD_STATUS` reports the live slot, not the target.** See the position-dependence
    bullet further down: the phone builds for the slot `UPD_STATUS` names, so with these
    semantics it builds for the wrong one, which is the failure that bullet calls the one
    the design cannot catch.

- **What the review attacked and could not break**, recorded because it is worth as much
  as the findings: the four-byte hook holds, re-derived from bytes across all 256 KB with
  indirect references as well as branches; the outer guard held 4,800 fuzzed frames with
  no write outside the slots; the stack is balanced on all 13 paths at the real `pop`; and
  the 2 second long press cannot be broken by this loop, because the button is in the
  TIMER0 ISR and the watchdog resets at 2.097 s.
- **Whether a 16-page erase burst survives a live BLE connection** is *derived* from the
  vendor doing the same thing, not measured.
- **The magic-word atomicity argument** is *derived* from how NOR flash programs. It has
  not been tested by pulling power mid-write, and it probably never will be.
- **Slot code is position-dependent** and is assembled for a fixed slot base, so a slot
  built for A cannot be programmed into B. `UPD_STATUS` tells the phone which slot it is
  about to write, and the phone builds for that address. Recorded because "just send the
  same bytes" is the natural assumption and it is wrong, and because nothing in the
  firmware can detect it: a slot built for the wrong base has a valid CRC and valid magic
  and simply branches somewhere absurd. **It is the one failure the design does not catch**
  and it is the fifth thing to test on silicon.
- **`UPD_BEGIN` erases whole pages, so a short body still costs its page.** A 100-byte
  slot erases one page and a 513-byte slot erases two. Flash wear on the staging bank is
  not counted by `core/src/budget.ts`, which tracks the saved-content store only.
