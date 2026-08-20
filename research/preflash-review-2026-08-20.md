> **STOPPED MID-WRITE, 2026-08-20. Read this before anything below it.**
>
> The session ran out of usage and this review was killed while it was doing its last
> step, which was **verifying its own file:line citations**. So:
>
> - **The findings and the verdict were reached by execution** against the rebuilt
>   image's own bytes, and they are the substance of the file.
> - **Every `file:line` reference in here is UNVERIFIED** and may be off or point at the
>   wrong symbol. Re-resolve by content before acting on one. That is exactly the trap
>   `research/tools/fwtool.ts`'s header warns about, arriving from our own side.
> - Nothing after the last complete section may exist at all. Do not read absence of a
>   section as absence of a finding.
> - No flash followed this review. Nothing of ours has ever been written to any unit.
>
> Its verdict, for the record, was **flash it with the probe on and left on**, and its
> most useful finding was not about the firmware but about the gate: `ota.check` returns
> PASS on twelve deliberately broken versions of this image, including one whose resident
> half is entirely erased and one whose hook branches into the BLE stack. **The gate is a
> statement about the vendor container and this silicon's callback slots, and says nothing
> whatever about our extension.** That gap is closed for this image by this review and is
> closed for the next one by nothing.

# Pre-flash review of the rebuilt `joggles-v2.bin`, review 34

**Status: offline, 2026-08-20. No hardware was touched, no `openocd`, no `adb`, no `bun
cli`, nothing written to any unit, no OTA control byte sent.** Confidence markers are
`research/README.md`'s three. Everything below comes from the bytes of
`firmware/joggles-v2.bin` itself, from `firmware/dump-12E69E-2026-08-19-a.bin` and
`firmware/dump-unit1-2026-08-20-postcycle.bin`, and from executing the image's own bytes
under `research/tools/thumbsim.ts`. **Nothing of ours has run on silicon and this review
does not change that.**

This is the follow-through check on `research/patch-over-bt-review-2026-08-20.md`
(review 33) against the image that was rebuilt after it, which is a different design:
review 33 reviewed a 980-byte resident half with no slot dispatch, and this file is a
1,228-byte resident half with slot dispatch in it.

## Verdict

**Flash it, with the probe on and left on. Nothing severe was found, and review 33's
four live defects are all confirmed fixed by execution rather than by reading the
changelog.** The single strongest reason to go: the cross-slot write that was reachable
on unit 1 from its very first command is now refused for every sequence number from 0 to
65,535, executed against this file's own bytes entering at the vendor's real dispatcher
entry, and 6,000 fuzzed frames across four starting states produced no flash write
outside the slot being written.

**The strongest reason to be careful is not in the firmware, it is in the gate.**
`ota.check` says PASS on twelve deliberately broken versions of this image, including one
whose resident half is entirely erased and one whose hook branches into the BLE stack. Its
clearance is a statement about the container and about this silicon's callback slots, and
it says nothing whatever about our extension. Nothing between `build-firmware` exiting and
the probe going on re-checks the hook or the block. For this flash that gap is closed by
this review; for the next image it is not closed by anything.

## Review 33's fixes, one by one

| Review 33 | Confirmed? | How |
| --- | --- | --- |
| 1. three `UPD_*` frames were two bytes and the vendor's 4..20 length gate dropped them | **fixed, confirmed** | every attack below enters at `dispatcher.entry` `abs 0x184c8`, 30 halfwords above the hook, and every frame got a reply. The regression test review 33 asked for exists: `research/tools/updater.test.ts:567` |
| 2. `UPD_DATA` bounded to both slots, so `seq 1022` cleared the live slot | **fixed, confirmed** | see "The cross-slot write" below. `BAD_SEQ` for every sequence number tried, zero bytes of the other slot changed |
| 3. no slot dispatch at all, so "resident before slot" was vacuous | **fixed, confirmed** | dispatch exists (`research/tools/ext.ts:1082`) and the ordering now holds against a hostile slot that claims all six resident ids. Executed |
| 4. `UPD_STATUS` named the live slot, not the write target | **fixed, confirmed** | the reply is seven bytes and carries `target`. On a virgin unit it reads `{code: NO_SLOT, liveIsB: false, target: 'a'}`, and A is what the next `UPD_BEGIN` writes |
| 5. `fmc_unlock` did not read `REGLCTL` back | **present in the bytes, effect unconfirmable** | `research/tools/updater.ts:206` reads it back and retries up to `UNLOCK_TRIES` 4. thumbsim still models no interrupts, so no test can produce the abort the retry exists for. The fix is *derived*, exactly as the gap was |
| 6. `fmc_lock` wrote `ISPCON` wholesale | **fixed, confirmed** | `updater.ts:245` is a read-modify-write preserving `BS` and writing one to clear `ISPFF`. `updater.test.ts:480` |
| 7. `UPD_BEGIN` stalls the chip for up to 16 page erases | **not fixed, and not fixable offline** | measured again on this file: a full-size `UPD_BEGIN` is **16,360 instructions** and **16 page erases** back to back. The 130 x 20 ms contradiction review 33 raised is still unresolved |
| 8. `UPD_END` could reply `OK` on a generation that reads as invalid | **fixed, confirmed** | `UPD.EXHAUSTED` 0x06, refused in `UPD_BEGIN` before any erase. `updater.test.ts:545` |

## The image is the source, which is the first thing worth knowing

*verified.* Rebuilding with the documented command line produces a file **byte-identical**
to `firmware/joggles-v2.bin`:

    bun run build-firmware <out> \
      --from-donor firmware/dump-12E69E-2026-08-19-a.bin \
      --from-donor firmware/dump-12E69E-2026-08-19-b.bin --into-fill

This matters more than it sounds. `research/tools/updater.test.ts` and
`research/tools/features/slot.test.ts` do not load the file: they call `buildExtension`
themselves. Reproducibility is what makes their passes statements about the artifact
rather than about a sibling of it. Every attack in this review used the file's own
plaintext instead, so the two agree from both directions.

## What the rebuild changed, and what it did not

*verified*, plaintext against plaintext.

| | stale 0315 | rebuilt |
| --- | --- | --- |
| resident half | 980 B, `0x28800`-`0x28bd3` | **1,228 B, `0x28800`-`0x28ccb`** |
| header read-back | JGX1 v1, entry `0x28821`, subs 0x0-0x5 | JGX1 v1, entry `0x28821`, subs 0x0-0x5 |
| plaintext bytes differing | 1,099, **all of them inside `0x2880c`-`0x28cc9`** | |
| container CRC | `0xb4462317` | `0xd327dfeb` |

So the whole rebuild is confined to the resident block. The hook, the crew key and the
advert rename are byte-identical between the two builds.

**The two files are indistinguishable to every gate in the pipeline.** *verified*:
`ota.check` returns the same verdict and the same two warnings for both, and
`swdflash plan` would too. The only field that separates them is the extension header's
size word, 1,228 against 980, and the only thing that reads it is
`ext.readExtension`, whose sole non-test caller is `build-firmware.ts:460`. That is why
`notes/swd-flashing.md` step 1's instruction to read the resident size off the build
output is load-bearing rather than advisory.

## Item 3: the resident block still lands in free space, and nothing points into it

All *verified* from bytes, scanning the whole 256 KB of the donor dump rather than the
application window, because that is the scan that has caught things here before.

| Question | Answer |
| --- | --- |
| block span | `0x28800`-`0x28ccb`, 1,228 B |
| pages | 3: `0x28800`, `0x28a00`, `0x28c00`, the last ending `0x28dff` |
| the fill it lands in | `0x28800`-`0x293ff` on the donor: 3,072 bytes, **0 non-zero and 0 erased**, so all programmed zeros |
| spare left | **1,844 B**, `0x28ccc`-`0x293ff` |
| distance to slot A | `0x28dff` to `0x29400`, so the third page clears the bank by 1,537 bytes |
| donor's last byte that is neither `0x00` nor `0xff` | `0x28786`, i.e. 122 bytes below the block |
| branches into the block from anywhere in 256 KB | **0** |
| branches into page 3 alone, `0x28c00`-`0x28dff` | **0** |
| branches into the 248 bytes only this build uses, `0x28bd4`-`0x28ccb` | **0** |
| `ldr`-literal, raw word, `adr` or `movs`/`lsls` naming the block, from outside it | **0**, over all 256 KB |
| the hook | `abs 0x18506`, four bytes, `10 f0 8b f9`, decodes `bl 0x28820` |
| branches into the four hook bytes, 256 KB | **0** |
| branches into `returnTo 0x1850a` | **0** |

**Nothing of the vendor's was displaced, and the edit accounting proves it rather than
asserting it.** Exactly 1,134 bytes of the 76,800 differ from the donor window, and every
one falls in a named region with none left over:

| Region | Span | Bytes |
| --- | --- | --- |
| the hook | `0x18506`-`0x18509` | 4 |
| crew AES key | `0x235dc`-`0x235eb` | 16 |
| advert name | `0x28688`-`0x2868c` | 5 |
| resident block | `0x28800`-`0x28ccb` | 1,109 |
| **unaccounted** | | **0** |

The hook is still the only edit to vendor **code**. The other two are vendor data, a key
and a string.

## Item 1: review 33's own attacks, re-run on the rebuilt file

Every run below loads `ota.plaintext(firmware/joggles-v2.bin)` into the FMC model at
`0x16800` and enters at `abs 0x184c8`, the vendor's dispatcher prologue, so the 4..20
length gate is crossed on every frame. *derived* behaviour, *verified* bytes.

### The cross-slot write

Two updates, so B is live at generation 2 and A is the spare, then `UPD_ABORT`, which is
what leaves A's length word erased:

    UPD_STATUS      {liveIsB: true, generation: 2, target: 'a'}
    UPD_ABORT       OK,  A.len reads 0xffffffff
    UPD_DATA seq 1022   BAD_SEQ, slot B bytes changed: 0
    UPD_DATA seq 1023   BAD_SEQ, slot B bytes changed: 0
    UPD_DATA seq 1500   BAD_SEQ, slot B bytes changed: 0
    UPD_DATA seq 2045   BAD_SEQ, slot B bytes changed: 0
    UPD_DATA seq 2046   BAD_SEQ, slot B bytes changed: 0
    UPD_DATA seq 4095   BAD_SEQ, slot B bytes changed: 0
    UPD_DATA seq 8191   BAD_SEQ, slot B bytes changed: 0
    UPD_DATA seq 65535  BAD_SEQ, slot B bytes changed: 0
    slot B magic 0x5358474a unchanged, generation 2 unchanged

Review 33's own numbers were `OK` at 1022 with two programs landing on slot B's magic.
That is closed.

### The hostile length word, which is unit 1's actual state

Slot A's header planted with unit 1's bytes, `magic 0x00026904` and **`len
0x20003910`**, and `UPD_DATA` as the very first command the unit ever sees:

    seq     0  BAD_SEQ  0 bytes changed
    seq     1  BAD_SEQ  0 bytes changed
    seq  1021  BAD_SEQ  0 bytes changed
    seq  1022  BAD_SEQ  0 bytes changed
    seq  1500  BAD_SEQ  0 bytes changed
    seq  2045  BAD_SEQ  0 bytes changed
    seq  2046  BAD_SEQ  0 bytes changed
    seq 32767  BAD_SEQ  0 bytes changed
    seq 65535  BAD_SEQ  0 bytes changed

Two bounds now stand where one did. `research/tools/updater.ts:637` refuses any declared
length above `MAX_BODY` before the sequence is even compared against it, and
`updater.ts:161` bounds the write to `[target, target + SLOT_SIZE)` rather than to both
slots. Either alone closes the abort case; both are needed to close the stale-bank case.

### Address arithmetic, checked for overflow

*derived* from the emitted instructions and confirmed by the sweep. `seq` is a `u16`, so
`seq << 3` tops out at 524,280 and cannot wrap. The declared length is then bounded to
`MAX_BODY` 0x1ff0, so the accepted `seq * 8` is at most 0x1fe8 and the last byte written
is `target + 0x1fff`, which is the slot's last byte exactly. `page_round` is
`SLOT_HDR_LEN + PAGE - 1` = 527 and `len + 527` cannot exceed 0x21ff, so the erase span
cannot wrap either, and a full-size `UPD_BEGIN` erases **16** pages and never a 17th.

### Nothing outside the target slot, across two full updates and 6,000 fuzzed frames

Two 2,048-byte updates: **10 erases, 1,032 programs, 0 refusals**, and every address
inside the slots with none in the resident block.

Then 1,500 random frames from each of four starting states, with random sub-commands,
random payloads and random body lengths inside the gate:

| Starting state | Writes in the resident block | Writes outside the slots | Writes in the non-target slot | Vendor bytes changed |
| --- | --- | --- | --- | --- |
| virgin, erased bank | 0 | 0 | 0 | 0 |
| unit 1's staged APK image | 0 | 0 | 0 | 0 |
| two updates done, B live | 0 | 0 | 0 | 0 |
| two updates then `UPD_ABORT` | 0 | 0 | 0 | 0 |

Review 33's fuzz asserted only "inside `[SLOT_A, SLOT_END)`". The third column is the new
one, and it is the property that was broken.

## Item 2: attacking the slot dispatch, which nobody had reviewed

`research/tools/ext.ts:1082`-`1127`. Every result *derived*, executed against the file's
bytes, with each slot committed through the real `UPD_BEGIN`/`UPD_DATA`/`UPD_END` loop so
its CRC is genuine.

### The load-bearing ordering holds, and it is no longer vacuous

A slot committed with `TABLE_COUNT` 9 and a table entry for **every** sub-command from
0x00 to 0x08, all pointing at a real handler:

| sub | slot handler entered | who answered |
| --- | --- | --- |
| 0x00 `HELLO` | **no** | resident, hello reply |
| 0x01 `UPD_BEGIN` | **no** | resident, `BAD_LENGTH` |
| 0x02 `UPD_DATA` | **no** | resident, `BAD_SEQ` |
| 0x03 `UPD_END` | **no** | resident, `BAD_CRC` |
| 0x04 `UPD_ABORT` | **no** | resident, `OK` |
| 0x05 `UPD_STATUS` | **no** | resident, `OK` |
| 0x06, 0x07, 0x08 | yes | the slot |

That is the first execution of `notes/patch-over-bt.md`'s mitigation 1 against a slot that
actively tries to shadow it. The reason it holds is structural: the trampoline reads
`TABLE_COUNT` and the table out of the resident block, and only falls through to
`try_slot` when the resident table is past its end or holds a zero.

### The five refusals, each attacked

| Attack | Result |
| --- | --- |
| slot header magic `0xffffffff`, `0xff58474a`, `0x5358ffff`, `0x5358474b`, `0xd358474a` | all five read as `NO_SLOT`. Only the exact word 0x5358474a validates, which is the magic-word-last argument holding under every partial program shape |
| body is not a `JGX1` block | refused, silent |
| body assembled for slot B, committed into slot A | refused, and **`HELLO` reports 0x11, the resident capabilities only**, so the slot does not advertise what it cannot deliver |
| declared length 0, 1, 0x15, 0x1ff1, `0xffffffff`, `0x20003910` | all refused. 0x1ff0 accepted, which is `MAX_BODY` and correct |
| `TABLE_COUNT` = 0xffff with a 0x40-byte body, subs 0x06 to 0xff | **0 entered, 0 exceptions.** The table read runs at most to body+0x212, inside the slot, and every offset it finds fails the `offset < len` bound |
| `TABLE_COUNT` = 0xffff with a declared body of `MAX_BODY` and 8,176 random bytes, subs 0x06 to 0xff | 36 distinct entries, **all inside the declared body**, `0x29474` to `0x2b384`. 37 of 250 raised an undefined instruction. **0 writes outside the slots. 0 vendor bytes changed. `HELLO` and `UPD_STATUS` still answered afterwards** |
| table offset pointing into the resident block | **arithmetically impossible.** The offset is a `u16` bounded below the declared length, and the target is `body + offset`, so it cannot leave the slot |
| equal generations on both slots | A wins, the lower address, and `UPD_STATUS` says so rather than hiding it |

### The sixth case, which it does not refuse

***derived*, executed. Low severity, and it is a claim to correct rather than a bug to
fix before flashing.**

`ext.ts:1119` bounds a table offset from **above** against the declared length and never
from **below**. An offset inside the body's own 20-byte header is accepted:

| table offset | where the `blx` landed |
| --- | --- |
| 0x00 | refused, because zero means "not compiled in" |
| 0x04 | body+0x05, i.e. the `version` and `capabilities` halfwords executed as code |
| 0x08 | body+0x09, the assembled-for word executed as code |
| 0x14 | body+0x15, the sub-command table itself executed as code |

Nothing our tooling builds can produce it, because `buildSlot` lays the header down first
and every handler label is therefore past it. The exposure is a hand-crafted slot, and
anybody who can commit a slot can already run arbitrary code, so this grants no capability
it did not have. What it costs is the accuracy of the docblock at `ext.ts:1090`, which
says "five refusals, all silent, and each is a way a slot can be wrong without being
corrupt": an offset below `HDR.TABLE + tableCount * 2` is a sixth such way, and one
`cmp` closes it.

### Where slot code can go once it is entered, which is anywhere

***verified* by PC trace, and it is the honest limit on mitigation 1.**

Tracing every instruction for 250 sub-commands into a random 8,176-byte slot body: the
`blx` entry is bounded to the declared body, but after that the CPU wandered 790
instructions into the **1,844 bytes of programmed-zero spare at `0x28ccc`-`0x293ff`**,
which decodes as `movs r0, r0` and walks forward into slot A's header. That is not a
defect, it is what "no MPU" means. It does mean the claim at
`notes/patch-over-bt.md:202`, that a broken slot cannot make the unit unreachable by the
commands that replace it, is exact for a slot that **faults** and is not true for a slot
that **runs**: slot code holds the same privileges the resident half does, can drive the
FMC directly, and the guard in `updater.ts` binds only the resident updater's own writes.

Two things keep that from mattering today, and both are worth writing down because they
are what makes the first flash safe rather than lucky. No slot exists to send, and the
first flash puts only the resident half on the unit.

## Item 4: `ota.check` PASS is a claim about the container, not about our patch

***verified* by construction. This is the most severe finding in the review.**

`packages/core/src/ota.ts:372` checks the container header and CRC, the section type, the
size against the flash map, the vector table at body 0x08 and 0x0c, the version string,
and then hands off to `compareDevice` for the callback-slot registration check that 8
August did not have. It never looks for a `JGX1` block and never decodes the hook.
`compareExtension` at `ota.ts:567` reads the word "extension" but takes the **reference
dump** as its argument, not the image: it warns that staging will erase the slots a
*unit* already carries.

Twelve mutations of `joggles-v2.bin`, re-encoded so the container CRC is right, and the
verdict for every one of them:

| Mutation | `ota.check(file, {reference: donor})` |
| --- | --- |
| one byte of the trampoline flipped | **PASS**, no fatals |
| the whole 1,228-byte resident block zeroed, hook left in | **PASS** |
| the whole resident block set to `0xff`, as if erased | **PASS** |
| `JGX1` magic destroyed | **PASS** |
| extension `SIZE` field set to 0 | **PASS** |
| `TABLE_COUNT` set to 0, so no resident handler at all | **PASS** |
| every table entry zeroed, so `HELLO` and all five `UPD_*` unreachable | **PASS** |
| hook `bl` into the BLE stack at `0x1000` | **PASS** |
| hook `bl` to `0x28900`, mid-instruction inside our own block | **PASS** |
| hook `bl` into the staging bank at `0x29400`, outside the image | **PASS** |
| hook `bl` into the middle of the vendor dispatcher | **PASS** |
| unmodified | PASS |

Its report never contains the strings `JGX1`, `28800` or `18506`. The third row is the
brick the design document itself describes: a `bl` into erased or wrong flash on every
command frame the vendor's chain does not match.

**`CLAUDE.md` says of `ota.check` that "it is the gate and it already encodes every limit
here". That is true of the vendor's image and of the silicon, and false of our extension.**
The only thing that ever verifies the block and the hook is `build-firmware.ts:460`, at
the moment of building, and its output is printed once to a terminal. `swdflash` inspects
the extension in the **dump** (`extensionIn`, `swdflash.ts:919`) and never in the image it
is about to write.

For this flash the gap is covered, because this review verified the file's own bytes from
four directions. For the next image nothing covers it. The fix is small: give `ota.check`
an optional expectation that the image carries a well-formed `JGX1` block whose entry the
hook actually branches to, or have `swdflash plan` print `readExtension` of the image
beside the plan.

## What `swdflash plan` does say, against the unit it would go on

*verified*, and it writes nothing:

    bun research/tools/swdflash.ts plan firmware/joggles-v2.bin \
      --from firmware/dump-unit1-2026-08-20-postcycle.bin \
      --config0 0xffffffbf --ldrom 0x20000610

    PASS: no fatal findings
    device-match: all 23 dispatched callback slots are registered, this image covers
                  everything the device holds, and it reads 77 of 92 exports
    150 pages, 19200 words, ~135,911 register transactions, 5 to 12 minutes at 100 kHz
    OTA staging bank 0x29400-0x3c000  canary 0x29400 = 0x00026904

That last line is the one to read twice. **The SWD write does not touch the staging bank**,
so after the flash unit 1 still holds the 2026-08-08 APK image there, its slot A header
still reads `magic 0x00026904` and `len 0x20003910`, and 74,906 of the bank's 76,800 bytes
are still not `0xff`. That is precisely the state the second attack above was run in, and
it is refused. *verified* from the dump: the pending-request page at `0x3da00` is entirely
blank, and the installed record at `0x3d800` is `0x00010224 0x04acebff 0x00000000 0x0000dbc3
0x00012c00 0x00029400`, which the unit already boots past with a different application in
place, so nothing re-installs from the bank unasked.

## Timing and stack, measured on this file

*derived*, from instruction counts under thumbsim at 26 MHz. thumbsim models no time, no
interrupts and no BLE stack, so these are CPU-occupancy figures and nothing more.

| Command | Instructions | ms at 26 MHz | Stack used | `sp` delta |
| --- | --- | --- | --- | --- |
| a frame that is not ours | 45 | 0.00 | 24 B | 0 |
| `HELLO`, no slot | 119 | 0.00 | 60 B | 0 |
| `HELLO`, slot live | 128 | 0.00 | 60 B | 0 |
| a slot sub-command | 129 | 0.00 | 64 B | 0 |
| an unknown sub-command | 117 | 0.00 | 64 B | 0 |
| `UPD_STATUS` | 180 | 0.01 | 72 B | 0 |
| `UPD_ABORT` | 1,148 | 0.04 | 100 B | 0 |
| `UPD_BEGIN` len 64 | 1,495 | 0.06 | 128 B | 0 |
| `UPD_BEGIN` len `MAX_BODY` | 16,360 | 0.63 | 128 B | 0 |
| `UPD_DATA`, worst single frame | 438 | 0.02 | 112 B | 0 |
| `UPD_END` over `MAX_BODY` | **547,943** | **21.07** | 104 B | 0 |

**Every path leaves `sp` where it found it**, including the two new ones,
`slot_dispatch` and `slot_caps`. The deepest is 128 bytes on top of whatever the vendor's
own stack holds under the dispatcher, and the SRAM map for this build is still unknown
(`notes/firmware-design.md`'s is the APK's, and the stack top alone moved from
`0x20003910` to `0x20003470`).

The 21 ms figure is unchanged from review 33 and is still the number to watch on the
bench: it is a bitwise CRC-32 over 8 KB inside one ATT callback.

## Findings, ranked

**1. `ota.check`'s clearance says nothing about the extension, the hook or the slots, and
nothing re-checks them after `build-firmware` exits.** Section "Item 4". *verified*.
Failure scenario: someone hand-edits an image, or hands `swdflash` a file built by an
older tool, or simply picks `joggles-v2-STALE-0315.bin` off the disk. Every gate in the
documented procedure passes and the first sign of trouble is a unit that advertises and
answers nothing, or a unit that faults on the first unmatched command frame.
`packages/core/src/ota.ts:372` and `:567`; the only verifier is
`research/tools/build-firmware.ts:460`.

**2. `notes/swd-flashing.md`'s numbered procedure now names two different images.**
*verified*. Step 1 was rewritten to build and check `joggles-v2.bin` (`:275`, `:283`), and
steps 2, 3, 4 and 7 still name `firmware/joggles-v1.bin` (`:291`, `:303`, `:318`, `:362`,
`:363`), the image that must not go on anything. The caveat at `:253` covers "this section
names v1", but step 1 no longer does, so the caveat no longer covers the section it heads.
Failure scenario: at the bench with a probe attached, the reader runs step 2 verbatim and
gets four fatals. **The tool refuses correctly**, confirmed here: `plan` on
`joggles-v1.bin` against a healthy dump reports `wrong-variant`,
`stock-base-mismatch`, `unregistered-callback` naming all four RAM slots, and
`device-holds-more`, then `REFUSED: do not send this image`. The hazard is not a bad flash,
it is that a REFUSED at step 2 gets read as normal and the next refusal gets read the same
way.

**3. Slot dispatch has a sixth case it does not refuse: a table offset inside the body's
own header.** `research/tools/ext.ts:1119`. *derived*, executed. Not reachable from
`buildSlot`, and grants no capability a slot sender does not already have. It makes the
docblock's "five refusals, and each is a way a slot can be wrong without being corrupt"
one short.

**4. `RESIDENT_SUBS` is a hand-maintained list and nothing ties it to what the extension
actually compiles in.** `research/tools/features/index.ts:60` against
`research/tools/ext.ts:989`. *verified* that no test compares them. Failure scenario: a
seventh resident sub-command is added at 0x07 and `RESIDENT_SUBS` is not updated;
`buildSlot` then happily builds a slot claiming 0x07 and the trampoline silently shadows
it, which is the live hazard `notes/patch-over-bt.md:207` names in prose and nothing
enforces. One assertion closes it: `readExtension(built).subcommands` equals
`[...RESIDENT_SUBS].sort()`.

**5. "A broken slot cannot make the unit unreachable" is exact for a slot that faults and
untrue for a slot that runs.** `notes/patch-over-bt.md:202`. *verified* by PC trace: slot
code executes with the same privileges as the resident half and the `updater.ts` guard
binds only the resident updater's own writes. Not a blocker, because no slot is being sent
and the first flash carries the resident half alone. It is the sentence to correct before
the first slot is written, not after.

**6. Documentation and reporting drift, all *verified*.**

| Where | Says | Should say |
| --- | --- | --- |
| `notes/patch-over-bt.md:63` | spare `0x28bd4`-`0x293ff`, 2,092 B | `0x28ccc`-`0x293ff`, 1,844 B, which the same file's `:304` already gets right |
| `notes/patch-over-bt.md:219` | the resident half is "about 620 bytes by estimate" | 1,228 bytes, measured |
| `research/tools/updater.ts:132` | `UPD.EXHAUSTED` "is not in jgx.ts yet" | it is, `packages/core/src/jgx.ts:445`, and `updater.test.ts:671` already asserts the two sets are equal |
| `research/tools/build-firmware.ts:304` | `opcode 'J', sub-commands: HELLO(0x0)` | six are compiled in. `:475` prints the truth from the read-back, twelve lines further down |

**7. `updater.test.ts:444`, "the guard refuses every address outside the slots, called
directly", does not call the guard.** It resolves an address, `void`s it, and then asserts
the FMC model refuses the config page. The property is genuinely covered by the three tests
at `:222`, `:253` and `:273`, so nothing is untested; the name overclaims, and a name that
overclaims is how the next reviewer decides not to look.

## What I attacked and could not break

Worth as much as the findings, because it is the list the next session should not rebuild.

- **The four-byte hook.** Re-derived from bytes over all 256 KB: `10 f0 8b f9`,
  `bl 0x28820`, zero branches into the four bytes, zero into `returnTo`, and the only edit
  to vendor code in the whole image.
- **The block's isolation.** Zero branches and zero references of any of the four kinds
  into `0x28800`-`0x28ccb` from anywhere in 256 KB, and the same for the third page alone
  and for the 248 bytes only this build uses.
- **The edit accounting.** 1,134 bytes changed, four regions, nothing unaccounted.
- **The resident-first ordering**, against a slot that claims all six resident ids.
- **The magic-word-last argument**, against five partial-program shapes.
- **The write bound**, over 6,000 fuzzed frames from four starting states including unit
  1's real staging bank, with the target-slot column that review 33's fuzz did not have.
- **Stack balance on every path**, including both new routines, measured at the real
  `sp` rather than at a stop address.
- **`buildSlot`'s own refusals**: a resident-owned id, a duplicate id, an over-size body
  with the byte count, and an unresolved fact.

## The first three commands after the write, and what each proves

The write script halts the core and never resumes it, so `DONE` means the bytes are in
flash and nothing more. In order:

1. **`reset run` over SWD, then read `ICSR` at `0xE000ED04`.** Proves the new firmware has
   actually executed. `VECTACTIVE` 0 is Thread and the image is alive; 3 is HardFault and
   the image is not, and the value would otherwise still be the *old* fault. Nothing later
   in the list means anything until this one passes.
2. **A long press on the on-board button, then dump and verify.**
   `./research/tools/swd-recon.sh dump firmware/after-flash.bin`, then
   `bun research/tools/swdflash.ts verify firmware/after-flash.bin firmware/joggles-v2.bin`
   (**v2, not the v1 the runbook still names**). Proves all 150 pages read back as the
   image and, from the `JGX1` header `verify` reports, that the resident half on the device
   is **1,228** bytes and not 980. The long press is needed because a repaired unit sits
   switched off, and a switched-off unit looks exactly like a bricked one: dark panel, no
   advert, and SWD answering "cannot read IDR".
3. **`bun cli probe`.** Proves the hook works. Expect `JOGGLES-<MAC6>` advertising and a
   `HELLO` reply of version 1 with capabilities `0x11`, which is `SESSION | UPDATE` and is
   the correct answer for a unit with no slot. Advertising with silence on `HELLO` means
   the image is on the device and the hook is not, which is a firmware bug and not a
   flashing one.

Then the fourth, which is the first one that tests today's work rather than the flash:
**`UPD_STATUS`**. On unit 1 it must answer `NO_SLOT` with `liveIsB: false` and
`target: 'a'`, because the bank's first word reads `0x00026904` and not `JGXS`. If it
answers anything else, stop: the slot arithmetic disagrees with the flash in front of it.

## Unverified

- **Everything about the silicon.** No unit was touched. The image bytes, the donor bytes,
  both staging banks and both info pages are *verified* from files; every behavioural claim
  is our code executed against thumbsim's model of this part.
- **Whether the `REGLCTL` retry does anything.** The read-back and the bounded retry are in
  the bytes. The abort they exist for needs an interrupt, and the model has none. One read
  of `ISPCON` after a deliberately locked trigger would settle whether `ISPFF` even reports
  it, which review 33 also asked for and which needs no writes.
- **Whether a 16-page erase burst or a 21 ms CRC survives a live BLE connection.** Still
  argued from the vendor doing the same thing, still unmeasured, and the 130 x 20 ms
  contradiction review 33 raised is still open.
- **Whether the vendor's flash driver can run concurrently with ours.** Unchanged from
  review 33.
- **Everything about a slot on real silicon.** No slot has ever been written to anything,
  and slot code is the half with no sandbox.

## Suite state on leaving

`bun test`: **1,779 pass, 0 fail**, unchanged. Nothing in the repository was modified by
this review except this file and `.claude/locks/review-34`. Every probe lives in the
session scratchpad.
