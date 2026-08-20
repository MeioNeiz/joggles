# The fleet runs TR1906R04-12, and unit 1's orphan tail is unit 1's own firmware

**Confidence markers are `research/README.md`'s three**: *verified*, *derived*,
*unverified*. Every claim below is marked.

## Verdict

Three findings, all *verified* from bytes on 2026-08-19, all first possible that evening
because a dump of a healthy pair had never existed before.

1. **No pair here runs `TR1906R04-10`.** The healthy `GLASSES-12E69E` declares
   `TR1906R04-12`. `ota.DEVICE_VERSION` was hardcoded to `TR1906R04-10`, a string lifted
   from the vendor APK, and `ota.check` defaults its variant expectation to it. So the
   gate that exists to stop the wrong image reaching a unit was comparing candidates
   against the one image known to brick them.
2. **The two units share a BLE stack byte for byte**, all 92,160 bytes of
   `0x0`-`0x16800`. Same hardware, same SDK build, same set of callback slots dispatched
   through.
3. **The orphan tail at `0x26c00` is unit 1's own original application.** 7,047 bytes,
   byte-identical to the donor at the same addresses. It is not "an earlier, longer
   factory image" of unknown provenance: it is the upper part of the very build the
   donor is still running, left behind because the APK image that overwrote unit 1 was
   shorter.

**The consequence is the framing of the repair.** Writing the donor's application onto
unit 1 is not putting a sibling's firmware on a broken unit. It is **restoring unit 1's
own firmware**, and 7,047 bytes of that firmware are still physically present on unit 1
and match the donor exactly. Unit 1 was running this image on 7 August 2026.

## What refused the repair

`swdflash donor` refused, and the refusal is the finding rather than an obstacle to it:

    bun research/tools/swdflash.ts donor \
      firmware/dump-12E69E-2026-08-19-{a,b}.bin \
      --to firmware/dump-unit1-2026-08-19-a.bin

    REFUSED: the donor cannot be the source for another unit.
      the donor fails ota.check: wrong-variant: image reports "TR1906R04-12" but the
      target unit is "TR1906R04-10". These are different hardware variants

The message reads as a measurement of the target and is not one. *verified*: `ota.check`
computes `opts.expectVersion ?? DEVICE_VERSION`, no caller on the SWD path passed
`expectVersion`, and `DEVICE_VERSION` is a constant. Nothing read the unit.

**Why it had never been seen.** Track 52 built donor mode and exercised it against
fabricated donor windows whose fixture carries `TR1906R04-10`. The first real donor dump
landed after that track closed. *verified* from the fixture at
`swdflash.test.ts:synthDonorWindow`, which sets that string at offset `0x7000`.

| Where | String | Offset |
| --- | --- | --- |
| donor `GLASSES-12E69E`, application | `TR1906R04-12` | `abs 0x1e3bc` |
| unit 1 `GLASSES-12C3EF`, application | `TR1906R04-10` | `abs 0x1e008` |
| unit 1, OTA staging bank | `TR1906R04-10` | `abs 0x30c08` |
| both vendor OTA containers | none in plaintext | encoded, read via `referenceImage` |

Unit 1's two copies sit at the same offset within their respective images, `0x7808` from
each image base, which is what identifies the staging-bank copy as the same 8 August
staged image rather than a second build. *verified* by arithmetic on the two addresses.

**Unit 1 reads `-10` because that is what was written onto it, not because it is what it
ran.** The `-12` it did run is evidenced by the orphan tail below.

## The two identity proofs

One comparison, donor `dump-12E69E-2026-08-19-a.bin` against target
`dump-unit1-2026-08-19-a.bin`, by region. *verified*, and reproducible with the script at
the end of this file.

| Region | Span | Bytes | Differ |
| --- | --- | --- | --- |
| BLE stack | `0x00000`-`0x16800` | 92,160 | **0** |
| application window | `0x16800`-`0x29400` | 76,800 | 61,116 in 3,072 runs |
| orphan tail, content | `0x26c00`-`0x28786` | 7,047 | **0** |
| tail, programmed zeros | `0x28787`-`0x293ff` | 3,193 | **0** |
| above the window | `0x29400`-`0x40000` | 92,160 | 54,716 in 6,385 runs |

**The BLE stack is the region this tooling never writes**, which is what makes it usable
as a hardware fingerprint: `swdflash`'s window starts at `0x16800` and its generated
script re-checks every address that reaches `ISPADR`. Neither unit's stack has been
touched by anything we have run, and the 8 August OTA wrote only from `0x16800` up. So
identical stacks is a statement about two pieces of silicon and their factory
programming, not about anything either session did. *verified*.

**Why that matters more than the variant string.** The 2026-08-08 fault is a mismatch
between which callback slots the stack dispatches through and which the application
registers (`research/hardfault-0xd38-2026-08-19.md`). An identical stack means the
donor's application is built against exactly the stack the target is running. That is
the question the variant string was a proxy for, and it can be answered directly.

**The difference above the window is expected and is not a third unit-specific finding.**
`0x29400` up holds the OTA staging bank, the saved DATS content, and the info pages, all
of which are per-unit by design: unit 1's staging bank still holds the 8 August staged
image and its saved content is whatever was last uploaded to it. *verified* that this is
outside anything `swdflash` writes.

## What the orphan tail is, and the correction it forces

`notes/swd-flashing.md`, "The tail nobody erased", reads the blob at `0x26c00` as
*derived*: "an earlier, longer factory image was programmed first, and whoever flashed
the current one erased only the pages it needed". **The reading was right and it can
now be made specific.** *verified*: those 7,047 bytes are byte-identical to the donor
at the same addresses, and the identical run extends to the end of the window,
`0x26c00`-`0x293ff`, 10,240 bytes including the programmed zeros above the content.

So the earlier, longer image is **the build the donor is still running**, and the tail is
unit 1's own application, surviving because the APK image is 7,532 bytes shorter and the
bootloader copies only `ceil(codeSize/512)` pages.

Two documents describe it less precisely and should be read with this in front of them:

- `notes/swd-flashing.md`, "The tail nobody erased", calls the provenance unknown and
  says "Nothing has proved the running application never reads `0x26c00`". The provenance
  is now known. The caution about `--blank-tail` is unaffected and still correct.
- `research/hardfault-0xd38-2026-08-19.md` treats the tail as corroboration that the
  installed image is shorter than what the unit held. That still holds and is now
  stronger: the tail is not merely longer, it is a known build.

**Not established by this:** whether the running application reads `0x26c00`. Nothing
here bears on that, and the default of leaving the tail alone remains right.

## The unit-specific-data question, answered positively

`UNIT_SPECIFIC` in `research/tools/swdflash.ts` is an empty list, and its docblock is an
account of searching for per-unit data in the window and finding none. A search that
finds nothing is weak evidence. **Comparing two units is the test that settles it**, and
the plan's own note warns what to look for:

> Scattered single words in otherwise identical code are the signature to stop on.

The run list opens `0x16800` 2 B, `0x16808` 2 B, `0x16816` 1 B, `0x1681c` 2 B, which is
superficially that signature. Measured rather than assumed, it is not. *verified*:

| Measure | Value |
| --- | --- |
| window bytes differing | 61,116 of 76,800, 79.6% |
| runs | 3,072 |
| runs of 4 bytes or fewer | 1,540 |
| runs longer than 32 bytes | 521 |
| **short runs isolated by >=256 B of identical code either side** | **0** |
| largest identical stretches | `0x26c00`+10,240, `0x16822`+498, `0x16a15`+115 |

At 79.6% differing there is no "otherwise identical code" for a scattered word to sit in.
Not one of the 1,540 short runs has identical code on both sides of it. This is two
compiler outputs for two builds, not one build carrying per-unit patches.

**And the strongest part is the largest identical stretch.** `0x26c00` + 10,240 bytes is
the orphan tail: the only region where unit 1's *own* original application still exists
shows **zero** variation against the donor. For the one span where the comparison is
possible, per-unit data in the application window is *verified* absent rather than merely
not found. No `--keep` spans are needed.

**What this still cannot do**, *unverified*: it compares two units, not twenty. A per-unit
field that happens to hold the same value on both would be invisible to it. Nothing
suggests one exists; the advert-name suffix, the one plausible candidate, is *verified*
absent from flash in the `UNIT_SPECIFIC` docblock.

## The vendor's own OTA gate, read against this

*derived*, and it is a reading of a gate rather than a claim about anyone's intent.
`research/firmware-flashing.md` records that the vendor app refuses an OTA when the
version major is `>= 10`, and reads that as "the vendor app is not a recovery route for
us". With the fleet at `-12` and the APK's bundled image at `-10`, the gate refuses every
unit here, and it refuses precisely the units its own bundled image would brick. The
alternative reading already recorded in that file, that the vendor deliberately does not
OTA these units, fits the same evidence. Either way **the gate behaved as a safeguard and
the 2026-08-08 commit went around it**, since our own client has no such gate.

## What changed in code

| File | Change |
| --- | --- |
| `packages/core/src/ota.ts` | `DEVICE_VERSION` docblock corrected to say it is the APK's label, not the fleet's; new `FLEET_VERSION = 'TR1906R04-12'` carrying this evidence; `wrong-variant` now names where its expectation came from instead of asserting "the target unit is X" |
| `research/tools/swdflash.ts` | `variantOf`, `DonorSource.variant`, `DonorInput.target`, the BLE-stack-identity refusal, `expectVersion` threaded into both `ota.check` calls, CLI wiring, and the build named in the emitted script header |
| `research/tools/swdflash.test.ts` | +8 tests, including the exact bug as a regression and the stack-mismatch refusal |

**The gate is not looser, it is different.** In donor mode the expected variant is the
donor's own build, and that is reached only after the two units are proved to share a BLE
stack byte for byte. A differing stack now refuses outright, which nothing checked before.

**Outstanding, deliberately not done on a bench night.** `ota.check` still defaults
`expect` to `DEVICE_VERSION`, so a caller with no `expectVersion` and no dump still
measures an image against the APK. Flipping that default makes `build-firmware` refuse
the APK-derived `joggles-v1.bin` outright, which is correct per `CLAUDE.md` but is not a
change to make with a probe clipped on.

## Reproducing it

Offline, no hardware, a second to run.

    python3 - <<'PY'
    d=open('firmware/dump-12E69E-2026-08-19-a.bin','rb').read()
    u=open('firmware/dump-unit1-2026-08-19-a.bin','rb').read()
    def diff(lo,hi): return sum(1 for i in range(lo,hi) if d[i]!=u[i])
    print('stack   ', diff(0x00000,0x16800), 'of', 0x16800)
    print('window  ', diff(0x16800,0x29400), 'of', 0x29400-0x16800)
    print('tail    ', diff(0x26c00,0x28787), 'of', 0x28787-0x26c00)
    print('variants', d.find(b'TR1906R04-12'), u.find(b'TR1906R04-10'))
    PY

Expect `0`, `61116`, `0`, and offsets `123836` / `122888`.

## For track 54: the erase-granularity gap, and why one check is not enough

Not implemented here. `research/tools/swdflash.ts` and its script and tests belong to
track 54, so this section is the argument handed over rather than an edit. The aborted
run of 2026-08-19 was stopped before this landed, so **the emitted script as it stands
has none of it**.

**The assumption.** `PAGE` is `ota.FLASH_PAGE_SIZE`, 512 bytes, and it is *derived*:
Panchip's `section_cfg.h` and OpenOCD's `numicro` driver for ARMv6-M parts. No erase has
ever been issued to APROM on this family, so the real block size is unmeasured.

*Corrected 2026-08-20, tracks 55 and 56. Both halves of that sourcing were weaker than
they read, and the conclusion is now stronger than either. OpenOCD's rule is a core-based
heuristic with no per-part table and it is wrong for four Cortex-M0 families
(`research/numicro-fmc-upstream.md` section 2). But 512 is no longer an assumption at
all: the vendor's own bootloader and OTA writer have each already run an interleaved
erase-and-program at 512 stride on this silicon, and a block of 4 KB or more is disproven
directly by `0x16000`-`0x167ff` surviving an erase at `0x16800`. Three witnesses in
`research/fmc-erase-program.md` section 1, ***verified***. The argument below still holds
and is worth implementing, but as a canary rather than as cover for an unknown.* The
generated script erases and programs one 512-byte page at a time, which is only correct
if the hardware block equals the page.

**Why the bottom of the window is the direction that costs something.** `0x16800` is
92,160, which is 2 KB aligned but **not** 4 KB aligned. An FMC page erase aligns the
address down to the block, so a block larger than 2 KB reaches below `0x16800` into live
BLE stack, which is the one region `swdflash` cannot write and therefore cannot repair.
At the top of the window the same arithmetic spills into the OTA staging bank at
`0x29400`, which holds only the 8 August staged APK image and is on disk anyway, so a
large block there is harmless. *derived*, by arithmetic:

| Block | First-page block starts | BLE stack lost | Erasing page 1 wipes page 0 |
| --- | --- | --- | --- |
| 512 B | `0x16800` | 0 | no |
| 1 KB | `0x16800` | 0 | **yes** |
| 2 KB | `0x16800` | 0 | **yes** |
| 4 KB | `0x16000` | 2,048 | **yes** |
| 8 KB | `0x16000` | 2,048 | **yes** |
| 16 KB | `0x14000` | 10,240 | **yes** |
| 32 KB | `0x10000` | 26,624 | **yes** |

**Two checks are needed, and they answer different questions.** The check asked for
during the aborted run, reading `0x16000` straight after the first erase, is necessary
and is not sufficient:

1. **Before anything is programmed, read below the window.** `0x167fc`, `0x16000`,
   `0x14000` and `0x10000`, compared against the target's own dump. Four reads. This
   catches irreversible stack damage at the first erase, before 149 more erases compound
   it. `0x16000` alone distinguishes 4 KB and 8 KB; `0x14000` and `0x10000` are needed for
   16 KB and 32 KB, which lose 10 KB and 26 KB of stack respectively.
2. **After the second page's erase, re-verify the first page's data.** The stack check
   above is **blind to 1 KB and 2 KB blocks**, because `0x16800` is 2 KB aligned so
   neither touches anything below the window. They still corrupt the flash: erasing page
   1 at `0x16a00` takes page 0 at `0x16800` with it, and `check_words` for page 0 has
   already run and passed. The end state is only the last page of each block holding
   data, and nothing in the script notices until the post-flash dump. One `check_words`
   of page 0 after page 1's erase detects **every** block larger than 512 bytes.

Together those are five reads and they convert a 150-page assumption into a
second-page abort. Neither is in the script today.

**A related gap in `check_erased`.** It reads only the page just erased, so a block that
reaches backwards over already-written pages inside the window is invisible to it. That
is the same hole as item 2 and the same fix closes it.

**One documentation defect, harmless but misleading.** `expect_word`'s failure text ends
"Nothing has been written." That is true in sections 1 and 2, where it guards the
preconditions and the canaries before the FMC is unlocked. Section 6 reuses the same proc
for the after-the-fact canary sweep, where the message is false and would be read at
exactly the wrong moment.

**Not a defect, worth not re-deriving.** No page ordering makes a larger block safe.
Ascending order means each erase reaches back over pages already written; descending
means it reaches forward over pages about to be written and then erases them again. The
only correct shape for a block larger than a page is one erase per block followed by
programming every page in it, which is a different tool. Detecting the condition and
stopping is the right response, not reordering.

## Corrections this file makes to itself

*Corrected before publication, 2026-08-19: the tail was reported as 6,535 bytes in the
session messages that first carried these findings, twice. It is **7,047** bytes,
`0x26c00`-`0x28786` inclusive, which is also the figure `notes/swd-flashing.md` already
had. The 10,240-byte figure is the identical run including the programmed zeros above the
content, `0x26c00`-`0x293ff`, and the two should not be confused.*
