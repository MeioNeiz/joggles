# Adversarial review of the over-BT patch loop, before the first write

**Status: offline, 2026-08-20, review 33. No hardware was touched, no `openocd`, no
`bun cli`, nothing written to any unit.** Confidence markers are
`research/README.md`'s three. Everything here comes from the bytes of
`firmware/dump-12E69E-2026-08-19-a.bin` and `firmware/dump-unit1-2026-08-20-after.bin`,
plus executing the assembled firmware under `research/tools/thumbsim.ts`. **Nothing in
`notes/patch-over-bt.md` has run on silicon and this review does not change that.**

## Verdict

**Two defects would have shown up on the bench, and one of them would have made the
loop look dead.** The first was that three of the five `UPD_*` commands, including the
commit, never reached the dispatcher at all: they were two bytes long and the vendor's
length gate drops anything under four. It is **fixed**, by track 61's `subFrame`, while
this review was running; section 1 is the independent verification and the reason to
keep the check.

**The live defect is section 2.** `UPD_DATA`'s guard bounds the write address to *both*
slots rather than to the target slot, so one frame with a high sequence number
overwrites the other slot, and if that is the live one the unit loses it. **This is
reachable on unit 1 from its very first command**, because unit 1's staging bank still
holds the 2026-08-08 APK image and the bytes that fall where slot A's length field goes
read `0x20003910`.

**The central safety claim is untested rather than proven**: there is no slot dispatch
in the firmware at all, so "resident handlers are dispatched before any slot" is
currently vacuous. Whoever adds slot dispatch inherits the claim and there is no test
for it. Section 3 also names the thing that would turn it false, which is the first
feature anyone wants.

The four-byte hook holds. It was re-derived from bytes, independently of
`ext.findHookSite`, over the whole 256 KB rather than the application window, and with
indirect references as well as direct branches. Section "What I could not break" is the
list, and it is worth as much as the findings.

## 1. Three of the five `UPD_*` commands never reached the dispatcher

***verified* bytes, *derived* behaviour. Found here, fixed by track 61 mid-review, and
the fix is verified below.**

The vendor's dispatcher runs a **length gate before the opcode is read**, and it bounds
the payload at both ends, 4 to 20 inclusive. `research/firmware-internals.md` records it
on the APK build at `abs 0x18268`. It is on the donor build too, at the same shape,
which nothing had checked. Decoded by hand from
`firmware/dump-12E69E-2026-08-19-a.bin`, *verified*:

    0x184cc  30e0   adds r0, #0xe0
    0x184ce  7ec2   ldrb r2, [r0, #0x1b]      ; [r4 + 0xfb], the length byte
    0x184d0  2a14   cmp  r2, #20
    0x184d2  d82a   bhi  0x1852a              ; too long: the shared epilogue
    0x184e0  2a04   cmp  r2, #4
    0x184e2  d322   blo  0x1852a              ; too short: same exit
    0x184e4  78a1   ldrb r1, [r4, #2]         ; only now is the opcode read

`updEnd`, `updAbort` and `updStatus` were `frame(OPCODE, sub)`, a two-byte body. Driving
the assembled firmware from the dispatcher's own prologue at `abs 0x184c8`, with the
length byte at `struct + 0xfb` where the gate reads it:

| frame | body length | trampoline entered | reply |
| --- | --- | --- | --- |
| `hello` | 4 | yes | hello reply |
| `updBegin` | 8 | yes | `OK` |
| `updData` | 12 | yes | `OK` |
| `updEnd` | 2 | **no** | none |
| `updAbort` | 2 | **no** | none |
| `updStatus` | 2 | **no** | none |

**The concrete bench outcome this would have produced.** `UPD_BEGIN` answers, all 1,024
`UPD_DATA` frames answer, and then `UPD_END` returns nothing at all. No slot ever goes
live, `UPD_STATUS` is silent so the phone cannot tell a patched unit from a stock one,
and `UPD_ABORT` cannot clean up. Step 4.1 of `notes/patch-over-bt.md` "Sequencing",
"send a slot, watch `UPD_STATUS` report generation 1", fails with silence, which is
exactly the signature `packages/core/src/jgx.ts` documents as *stock*.

**Why the existing suite cannot see it.** `research/tools/updater.test.ts:87` sets
`m.r[15] = site.callAt` and enters at the hook, so every test bypasses the gate. The
gate is 30 halfwords above the hook and no test crosses it.

**Verified fixed.** `packages/core/src/jgx.ts:201` `subFrame` pads to `MIN_BODY` 4. Every
frame builder the module exports now reports a body of 4 to 15, and the whole loop runs
through the real dispatcher entry: three updates round the A/B pair, generations 1, 2, 3,
`UPD_STATUS` agreeing each time. **The lasting fix is the test**, not the padding: a
case that enters at `abs 0x184c8` rather than at `site.callAt` is what stops the next
sub-command being added two bytes long. There is currently no such case.

## 2. `UPD_DATA` can overwrite the other slot, including the live one

***derived***, executed under `thumbsim`, on the real staging-bank bytes of both units.
**This is the live defect.**

`research/tools/updater.ts:189` bounds every address that reaches `ISPADR` to
`[SLOT_A, SLOT_END)`, which is **both slots**. `notes/patch-over-bt.md:173` states that
bound accurately and presents it as the thing that protects the live slot. It does not:
it protects the resident block and the vendor's application, and says nothing about the
boundary at `0x2b400`.

The sequence bound at `research/tools/updater.ts:509` compares `seq * 8` against the
**length word read out of the target slot's own header**. When that word was written by
`UPD_BEGIN` it is at most `MAX_BODY`, and `seq` cannot reach the next slot. When it was
not, `seq` is bounded only by the guard, and `0x29410 + seq * 8` reaches `0x2d3fc`.

Two states leave a length word `UPD_BEGIN` did not write, and both are ordinary:

- **`UPD_ABORT`**, whose entire job is to erase the target slot's first page, so the
  length word reads `0xffffffff`. Also a power loss between the generation and length
  programs in `UPD_BEGIN`.
- **a freshly flashed unit**, where the word is whatever the staging bank held.

### The failure, start to finish

Executed against the donor image plus the resident updater, with slot content as the
real unit holds it:

1. two good updates, so slot B is live at generation 2 and slot A is the spare.
   `UPD_STATUS`: `{liveIsB: true, generation: 2}`.
2. `UPD_ABORT`. Target is A, its first page is erased, `A.len` reads `0xffffffff`.
   `UPD_STATUS` still `{liveIsB: true, generation: 2}`, correctly.
3. **one** `UPD_DATA` frame, `seq = 1022`, payload eight zero bytes. `1022 * 8 = 8176`,
   which is below `0xffffffff`, so the sequence check passes. The address is
   `0x29400 + 0x10 + 8176 = 0x2b400`, inside the guard, and it is **slot B's magic
   word**. Two programs land, at `0x2b400` and `0x2b404`.
4. reply: `OK`. `UPD_STATUS`: `NO_SLOT`. Slot B's magic is `0x00000000` and its
   generation is 0.

`seq` from 1022 to 2045 covers **all 8,192 bytes of slot B**, so the whole live slot can
be cleared, not just its header. Programming can only clear bits, so a magic cannot be
forged this way, only destroyed, and a generation can only be lowered, which is a
downgrade rather than a promotion.

### Reachable on unit 1 without any `UPD_ABORT`

Unit 1 is the intended first-flash target and the probe is on it. Its staging bank was
never touched by the repair and still holds the staged **APK** image, `TR1906R04-10`,
the one that bricked it. *verified* from `firmware/dump-unit1-2026-08-20-after.bin`:

| | donor `12E69E` | unit 1 `12C3EF` |
| --- | --- | --- |
| `0x29400` slot A magic | `0x00000000` | `0x00026904` |
| `0x29408` slot A **len** | `0x00000000` | **`0x20003910`** |
| bank `0x29400`-`0x3bfff` | 76,800 bytes of `0x00`, no erased page | 74,906 bytes not `0xff` |

So on the donor a stray `UPD_DATA` reads `len = 0` and is refused `BAD_SEQ` for every
sequence number, harmlessly. **On unit 1 it reads `0x20003910` and every sequence number
up to 2045 is accepted**, executed:

    seq    0  FMC_REFUSED  program@0x29410
    seq 1022  FMC_REFUSED  program@0x2b400   <-- slot B
    seq 1500  FMC_REFUSED  program@0x2c2f0   <-- slot B
    seq 2045  FMC_REFUSED  program@0x2d3f8   <-- slot B
    seq 2046  FMC_REFUSED  no flash touched  <-- the guard, holding

The reply is `FMC_REFUSED` rather than `OK` only because those words are not erased, so
the read-back disagrees. **The bits were still cleared.** The guard stops it dead at
`SLOT_END`, which is the half of the guard that works.

### What it costs and what it does not

The residue is both slots invalid, which is resident-only: `HELLO` answers, `UPD_*`
answer, a slot can be sent again. **It is not a brick.** What it breaks is the property
the design is built on, that the live slot is untouched from beginning to end, and it
breaks it with an `OK` reply on the donor path.

The fix is one bound, not a redesign: clamp to `[target, target + SLOT_SIZE)` rather
than `[SLOT_A, SLOT_END)`, or check `seq * 8` against `MAX_BODY` as well as against the
header word. Either closes both states. `research/tools/updater.ts:509` and `:189` are
the two lines.

## 3. There is no slot dispatch, so the load-bearing claim is untested

***verified*** from the built bytes.

`notes/patch-over-bt.md:203` lists "a slot is entered only for sub-commands `0x10` and
above" as an existing mitigation, and mitigation 1 above it, that resident handlers are
dispatched before any slot, is called "the load-bearing one".
`packages/core/src/jgx.ts` and `research/tools/updater.ts`'s own docblock say the same.

**No slot is ever entered.** `research/tools/ext.ts:857` computes
`tableCount = max(handler ids) + 1 = 6`, and the trampoline at `research/tools/ext.ts:898`
refuses any sub-command at or above `tableCount` in silence. The built header reads
`TABLE_COUNT = 6` with entries `0..5` and nothing else. Executed, every sub-command from
`0x06` to `0xff` produces no reply and no flash access, including `TICK 0x06`,
`SMOOTH 0x22`, `BUTTON 0x30` and `BATTERY 0x31`, which `packages/core/src/jgx.ts` now
carries as slot features.

So the ordering property is true today only because there is nothing to order against.
It is not false and it is not proven. Two consequences:

- **step 4.3 of the sequencing plan proves less than it says.** Sending a slot built for
  the wrong base is currently inert: the slot validates, goes live, and is never
  branched into. Nothing observable happens, which reads as a pass.
- **the first feature anyone wants makes the claim false.** `MSG.BUTTON` is unsolicited
  and the button handler runs from the TIMER0 ISR at `abs 0x2162c` (*verified*,
  `research/firmware-internals.md`). Slot code on that path faults 50 times a second
  from boot, before any BLE frame can be dispatched, so the resident `UPD_*` handlers
  never get their turn and the unit needs the probe. The same applies to `TICK`, which
  changes the timebase the ISR runs on. **The recovery argument holds only while slot
  code is entered from the command dispatcher and nowhere else**, and that is a rule to
  write down before the first slot is written, not after.

## 4. `UPD_STATUS` names the live slot, not the one the next write goes to

***derived***, executed.

`notes/patch-over-bt.md:305` says "`UPD_STATUS` tells the phone which slot it is about
to write, and the phone builds for that address". It does not. It reports `liveIsB` and
the generation, and the write target is `target_slot()`
(`research/tools/updater.ts:408`), which is the slot that is **not** live.

The inversion is right in every case but one, and the exception is the first update of
every unit. Executed on a virgin unit:

    UPD_STATUS -> { code: NO_SLOT, liveIsB: false, generation: 0 }
    the slot the next UPD_BEGIN actually writes: A

A phone that inverts `liveIsB` builds for B and the firmware programs it into A. Slot
code is position-dependent, so that is precisely "a slot built for the wrong base",
which the same document names as **the one failure the design cannot catch**. The
protocol invites it on the one command every unit runs first.

The status reply has nine spare payload bytes. Naming the target explicitly costs one,
and it removes the only case where a client has to special-case `NO_SLOT` correctly to
avoid an uncatchable failure.

## 5. `fmc_unlock` does not check that the unlock took

***derived***. The gap thumbsim cannot see, and the vendor's own code does not have it.

`research/tools/updater.ts:149` writes `0x59`, `0x16`, `0x88` to `SYS_REGLCTL` and moves
straight on. The reference-manual text this repo already transcribes says "any different
data value, different sequence or **any other write to another address** during these
three data writings will abort the whole sequence". The vendor's own OTA staging writer
at `abs 0x1eabe` **retries the three writes in a loop until `REGLCTL` reads back
non-zero** (*verified*, `research/fmc-erase-program.md`). Ours does not read it at all.

An interrupt is exactly the "other write" that aborts it, and the BLE stack and TIMER0
are interrupt-driven. **thumbsim models no interrupts**, so no test can reach this state.
Modelling the abortion directly, by dropping the middle key write:

    UPD_BEGIN with the unlock aborted -> FMC_REFUSED, 0 erases, 0 programs

which is the safe answer. But it is safe for a reason the model supplies rather than the
part: `thumbsim.ts`'s `trigger()` sets `ISPFF` when `wrprot` is clear, and **"REGLCTL
locked" is not in the vendor header's list of `ISPFF` conditions** (APUEN, LDUEN, CFGUEN,
SPUEN, illegal address, invalid command). On silicon the `ISPTRG` write is simply dropped
and `ISPGO` reads 0, so `fmc_op` returns **success with nothing done**. What saves it
then is the read-back in `program_word` and `erase_page`, and one of those two cannot
tell the difference: `erase_page`'s read-back passes when the page was **already erased**,
which is the state the documented recovery path "`UPD_BEGIN` again" produces. The residue
is still safe, an erase silently skipped on a page that needed no erasing, but the chain
of reasoning is longer than anyone would want to rely on.

Two lines close it: read `REGLCTL` back and branch to the failure label if it is zero.

## 6. `fmc_lock` writes `ISPCON` wholesale, which is the defect finding 3 already names

***derived***.

`research/tools/updater.ts:171` locks by storing 0 over the whole of `ISPCON`. Two
consequences, both small, and the first is one this repo has already written up against
its own SWD tool.

- **It clears `BS`, the boot-select bit**, which `fmc_unlock` fifteen lines above goes
  out of its way to preserve with a read-modify-write (`updater.ts:161`, and the comment
  says why). `research/fmc-erase-program.md` finding 3 establishes that `CONFIG0` bit 7
  is 1 on both units so `BS` comes up 0 and there is **no harm today**, and that the
  vendor never writes `ISPCON` wholesale. The firmware now reproduces the exact pattern
  that finding exists to condemn, and it contradicts its own unlock.
- **It cannot clear `ISPFF`, which is write-one-to-clear**, so any command that sets the
  fail flag leaves `ISPCON` at `0x40` after "locking". `ISPEN` is clear so nothing can be
  triggered and the next `fmc_unlock` clears it, so this is not a hazard. It does mean
  `updater.test.ts`'s "the FMC is locked again after every command, including the
  failures" is exact only for the four paths it drives, none of which sets `ISPFF`.
  Executed, a path that does set it ends with `ispcon = 0x40` and the assertion
  `toBe(0)` would fail.

The safe form is finding 3's: read, clear the update-enable bits, write back with
`ISPFF` set to clear it.

## 7. `UPD_BEGIN` stalls the whole chip for up to sixteen page erases in one command

***derived***. Bounded, and the bound comes from the vendor rather than from a datasheet.

Executed, a full-size `UPD_BEGIN` is **15,515 instructions**, 0.6 ms of CPU at 26 MHz,
**plus 16 page erases back to back**. `research/numicro-fmc-upstream.md` says plan for a
20 ms page erase, which is **320 ms** in one handler with the AHB stalled: no instruction
fetched from flash, so no TIMER0 ISR, no button debounce, no 6.42 ms panel frame, no BLE
connection event and no watchdog feed. `UPD_END` over a full body is 548,072
instructions, 21.1 ms, which matches the design's 15 ms estimate closely enough.

`notes/patch-over-bt.md` defends the burst with "the vendor's own OTA erases 130 pages
the same way". That defence is **stronger than it is stated**, and it also contradicts
the 20 ms figure. The vendor's staging writer at `abs 0x1eaa0`-`0x1eb7a` is one function
with the 130-page loop inside it (*verified*, `research/fmc-erase-program.md` witness 2),
it is called from the main loop, and the main loop is the only thing that feeds a
watchdog armed at `WDT_CTL = 0x582`, **2.097 s with reset enabled** (*verified* from
bytes, same file). A 130-page burst that demonstrably completes therefore bounds the real
page-erase time at **under about 16 ms**, so our 16 pages is under 256 ms and probably
far less. Both of those cannot be true as written: 130 x 20 ms is 2.6 s and would trip
the watchdog. Worth resolving before anyone sizes a poll timeout on 20 ms.

The mitigation, if the stall matters on the bench, is free: the erase span is
`round_up(len + 16, 512)`, so a 500-byte slot erases **one** page. Only a full 8 KB slot
erases sixteen.

## 8. `UPD_END` can reply `OK` on a slot that will never validate

***derived***, executed. Low, because the trigger is generation overflow, but the shape
matters.

`target_slot` does `adds r1, 1` at `research/tools/updater.ts:411` with no check.
Generation 0 is reserved as "invalid" (`slot_gen`, `updater.ts:403`). Planting slot A at
generation `0xffffffff` and running one more update: the new slot in B gets generation 0,
`UPD_END` programs the magic and replies **`OK`**, and `slot_gen` then reads B as invalid.
`UPD_STATUS` still names A. Every later update repeats it, so the unit is permanently
un-updatable while answering `OK` to every command.

2^32 updates is not a real counter, and the cross-slot write in section 2 can only lower
a generation, not raise one, so there is no shortcut to it. What is worth fixing is that
**`UPD_END` programs the magic without checking the slot it is about to commit will
validate**, so "OK" and "live" are not the same thing. Refusing generation 0 in
`UPD_BEGIN` is one compare.

## 9. Rows the failure table does not have

`notes/patch-over-bt.md` "What every failure leaves behind" is accurate for every row it
lists. Four failures are missing, and one existing row understates the residue.

| Missing failure | State afterwards | Recovery |
| --- | --- | --- |
| a stray or hostile `UPD_DATA` at `seq >= 1022` while slot A's length word is erased or stale | **the live slot cleared**, up to all 8,192 bytes of it; reply `OK` on erased flash | resident-only, send a slot. Section 2 |
| `UPD_DATA` as the first command on a freshly flashed unit | on unit 1, programs anywhere in `0x29410`-`0x2d3fc`; on the donor, refused `BAD_SEQ` | as above |
| `UPD_END` commits a generation the loop reads as invalid | reply `OK`, slot dead, older slot still live | none. Section 8 |
| an interrupt aborts the `REGLCTL` unlock | `FMC_REFUSED`, or on silicon a silently skipped erase of an already-erased page | resend. Section 5 |

**The row that understates it** is "a vendor OTA stages over the slots -> as above, send a
slot". That is the vendor writing over us. The reverse is not listed and it is worse:
**the bootloader's copy source is hardcoded to `0x29400`, which is slot A's address**, and
`research/ldrom-2026-08-19.md` establishes *verified* that it **does not validate the
staged image before copying**, only CRCs the destination afterwards and declines to
promote the record on a mismatch. So while our slots are populated, any request record at
`0x3da00` plus the config write means the bootloader installs **slot A and slot B over the
application region**. The standing bar on OTA ctrl `03` already covers this and the
outcome is the same brick it always was, but the reason is new: our persistent
over-BT-writable data now sits exactly where the bootloader copies from. Both units are
currently clean, *verified*: `0x3da00` is blank on unit 1 and zeros on the donor.

## 10. Two corrections to the record

**The donor's staging bank is not a staged image, it is zeros.** *verified* from
`firmware/dump-12E69E-2026-08-19-a.bin`: all 76,800 bytes of `0x29400`-`0x3bfff` read
`0x00`, and not one of the 32 slot pages is erased. `0x3d800` and `0x3da00` are zeros
too. This answers the open question in
`research/donor-dispatcher-2026-08-20.md`, "the staging bank's contents on the donor are
unidentified, 150 used pages that are not the reference image, and nobody has asked what
they are". They are programmed zeros, the same fill as the 3,072 bytes at
`0x28800`-`0x293ff` that `--into-fill` targets. `notes/patch-over-bt.md:86`, "on the
donor it holds 150 used pages of some previous staged image", is wrong.

**Unit 1's staging bank does hold an image, and it is the one that bricked it.**
*verified*: `0x29400` reads `0x00026904`, which is the APK build's head word 0 from
`research/donor-dispatcher-2026-08-20.md`'s own table, and 74,906 of 76,800 bytes are not
`0xff`. Unit 1 also carries an **installed** record at `0x3d800`, length 66,084, CRC
`0x04acebff`, destination `0xdbc3` = `0x16800`, with `0x3da00` blank. So the two units
differ in what our slots would be written over, the flash target is the one holding
`TR1906R04-10` there, and the first `UPD_BEGIN` on it erases part of that image.

## What I tried to break and could not

This is the half worth reading before the next session re-derives it.

**The four-byte hook holds.** Re-derived from the bytes of
`firmware/dump-12E69E-2026-08-19-a.bin` independently of `ext.findHookSite`, scanning the
**whole 256 KB** rather than the application window, and checking indirect references as
well as direct branches. All *verified*:

| Question | Answer |
| --- | --- |
| the four bytes at `0x18506` | `53 29 6b d0`, `cmp r1,#0x53` / `beq 0x185e2` |
| is the letter already answered | yes, at `0x184ee`, `cmp r1,#0x53` / **`beq`**, the same halfword `0x294c` |
| anything non-`cmp`/`b<cond>` between the two | none, so `r1` cannot be rewritten in the span |
| direct branches into the four bytes | **0**, over all 256 KB |
| direct branches into the dead `beq` halfword alone | **0** |
| direct branches into the chain interior | **0** |
| direct branches into `returnTo` `0x1850a` | **0** |
| the island `0x185e2`'s referrers | exactly 1, and it is `0x18508`, the dead `beq` |
| `ldr`-literal, raw-word, `adr` or `movs`/`lsls` naming any of those | **0**, including the Thumb-bit forms |
| the instruction the fall-through lands on | `0x294c`, `cmp r1,#0x4c`, a flag **setter**, so the N/C/V our compare leaves are overwritten unread |
| does the vendor test `J` anywhere | **no `cmp rN,#0x4a` exists in the application at all** |
| the `bl` written | `10 f0 8b f9`, decodes to `0x28820`, displacement `0x10316`, well inside +/-16 MB |

The scan was sanity-checked against a known answer in the same run: it finds all **ten**
branches into the shared tail at `0x18526`, the ones that would have been silently
destroyed by the 28-byte hook.

**The outer guard holds under fuzzing.** 4,800 `J` frames with random sub-commands,
random payloads and random body lengths inside the gate, across four starting states
including the real staging bank and a slot region filled with random bytes: **zero** FMC
writes outside `[SLOT_A, SLOT_END)`, **zero** inside the resident block
`0x28800`-`0x28bd4`, and the application region byte-identical in every trial. All six
reply codes were exercised. The resident block being outside the guard is arithmetic, and
the arithmetic is right.

**The stack is balanced on every path.** `updater.test.ts` stops the machine **at** the
epilogue and never checks `sp`, so nothing in the suite would notice a leak that returns
the dispatcher's `pop {r3,r4,r5,r6,r7,pc}` to a saved register. Driving each command to
the real `pop` with a sentinel planted in the `lr` slot: `sp` delta 0 and the sentinel
popped into `pc`, on all thirteen paths tried, including `BAD_LENGTH`, `BAD_SEQ`,
`BAD_CRC`, `FMC_REFUSED`, abort, status, an unknown sub-command and a frame that is not
ours. The two unbalanced error paths the design notes say were found in the first draft
are genuinely gone.

**The magic-word-last ordering holds**, and so does the every-length arithmetic. For
every declared length from 1 to `MAX_BODY`, the last byte a legal sequence number can
write is inside the span `UPD_BEGIN` erased and inside the slot. The tightest case is a
length that is a multiple of 8 with `len + 16` exactly on a page boundary, where the last
byte written is the last byte erased, and it fits.

**The 2 second long press cannot be broken by anything in this loop.** The button is
polled from the **TIMER0 ISR** at `abs 0x2162c`, not from the main loop (*verified*,
`research/firmware-internals.md`), so even an unbounded spin in `fmc_wait` leaves the
switch working. And if the AHB ever stalls indefinitely, because `ISPGO` fails to clear,
the watchdog at `WDT_CTL = 0x582` resets the part after 2.097 s, leaving a torn page that
re-erases. **The worst case is not a unit that cannot be switched off.** What is real is
that `UPD_BEGIN` starves that ISR for the length of its erase burst, section 7, so the
button, the panel and the radio are dead for that window and the debouncer's three
stable 20 ms samples are lost. That delays a press, it does not disable one.

**The resident half cannot be reached around**, for the reason section 3 gives: the
trampoline reads `TABLE_COUNT` and the handler table out of the resident block only, and
the hook is four bytes of the vendor's code that only SWD can write. There is no path
through a corrupted slot header, a half-programmed magic or an interrupted erase that
reaches slot code first, because there is no path that reaches slot code at all.

## Unverified

- **Everything about the silicon.** Nothing here ran on a unit. The gate bytes, the hook
  bytes and the two staging banks are *verified* from dumps; every behavioural claim is
  our code executed against `thumbsim`'s model of this part.
- **Whether the erase burst survives a live BLE connection.** Section 7 bounds the stall
  and argues from the vendor's own 130-page loop. Nobody has measured a connection
  through one.
- **Whether `ISPFF` is set when `REGLCTL` is locked.** The model says yes, the vendor's
  documented condition list says no, and section 5 turns on which is right. One read of
  `ISPCON` after a deliberately locked trigger settles it, and it needs no writes.
- **Whether the vendor's flash driver can run concurrently with ours.** Both drive the
  one set of FMC registers, we hold `REGLCTL` open across a whole command and the vendor
  re-locks around every single operation, so a vendor operation landing inside ours
  truncates our unlocked window. That direction is safe, because the read-backs notice.
  The reverse, ours corrupting theirs, has not been reasoned through and would need to
  know whether their driver is ever reached from an interrupt.
- **The 130 x 20 ms contradiction in section 7.** Either the page erase on this part is
  well under 16 ms or the vendor's staging loop feeds the watchdog somewhere the trace
  did not record.

## Suite state on leaving

`bun test`: **1504 pass, 1 fail**. The failure is
`research/tools/swdflash.test.ts:1386`, "an image rebased on that unit passes, where the
APK baseline refused it", which now receives three findings including
`protected-regions-off-base`. That code was added to `packages/core/src/ota.ts:569` by a
track running concurrently with this review, is track 57's recorded
`PROTECTED_REGIONS` finding being implemented, and belongs to neither this review nor
`notes/patch-over-bt.md`. Not touched here.
