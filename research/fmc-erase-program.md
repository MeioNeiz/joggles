# The FMC: what erase and program actually do on this silicon

**Status: offline analysis, 2026-08-20, track 55. No hardware was touched.** Everything
here comes from the LDROM disassembly, the application disassembly, the four 256 KB dumps
already on disk, and the vendor's own SDK headers.
**Scope:** erase granularity, the vendor's erase-and-program sequence register by
register, what an interrupted write can and cannot break, whether halting the CPU is
enough, how long the write will take, and six things this project has assumed that are
wrong.
**Verdict: the erase granularity is 512 bytes, and this is not an inference from a
Nuvoton datasheet.** It has already been measured on this exact silicon, at this exact
address range, three separate times, by the vendor's own code. The write can proceed on
that count. Five other things should change first, and one of them is a wrong opcode
number repeated in nine files.

Offsets are `abs` flash addresses unless marked `ld` (LDROM linked at `0x00100000`).

## Verdict

| Question | Answer | Confidence |
| --- | --- | --- |
| Erase granularity in `0x16800`-`0x293ff` | **512 bytes** | ***verified*** on this silicon, three independent witnesses. See below |
| Can the first erase at `0x16800` reach the BLE stack below it? | **No.** A block of 4 KB or more is disproven directly | ***verified***: the bootloader erased `0x16800` upward on unit 1 and `0x16000`-`0x167ff` is still byte-identical to the healthy unit |
| Does the vendor's own code do anything ours does not? | **Yes, four things**, one of which matters | *verified* from bytes |
| Can an interrupted erase or program permanently damage the part? | **No, not the flash.** Every torn erase or program is repaired by re-erasing the page. No vendor document promises this, and none warns against it either | *derived*, strongly |
| Is halting the CPU enough? | **Almost certainly yes, and the reason is a watchdog bit** | *derived* from the vendor CMSIS header, the reset value, and the value the firmware writes |
| Is there a watchdog that could reset mid-write? | **Yes, the application arms a ~2 s reset watchdog.** Its ICE-freeze bit is clear, which is documented to hold the counter while the CPU is held by ICE | *verified* that it is armed; *derived* that it freezes |
| How long will 150 pages take? | **About 4 to 10 minutes at 100 kHz.** Minutes, not hours. The flash contributes under 4 seconds of it | *derived* by arithmetic, calibrated against the 22.9 s dump |
| Should the write happen as currently designed? | **Not yet.** Five changes, listed at the end, and two of them are free | |

## 1. The erase granularity is 512 bytes, and it was measured before we asked

The strongest evidence is not the datasheet, which says nothing, nor the SDK, which says
512 in three places. It is that **the vendor's shipped code has already performed exactly
the operation we are about to perform, on this exact part, at this exact address, and the
result is sitting in our dumps**.

### Witness 1: the bootloader's copy loop, 130 pages at `0x16800`

*verified* from `ld 0x100afa`-`0x100b22` in `firmware/ldrom-unit1-2026-08-19.bin`. The
loop body, in order, once per page:

| Site | Instruction | Effect |
| --- | --- | --- |
| `0x100afc` | `lsls r6, r5, #9` | byte offset = page index x **512** |
| `0x100b06` | `bl 0x100a0c` | read 512 B from `0x29400 + offset` into a stack buffer |
| `0x100b0e` | `bl 0x1009dc` | **erase the destination page** at `0x16800 + offset` |
| `0x100b1a` | `bl 0x100a44` | program 512 B into that page |
| `0x100b20` | `cmp r7, r5; bhi` | next page |

The erase of page *k* happens **after** page *k-1* has been programmed. So if the erase
block were larger than 512 bytes, every erase would wipe the page written on the previous
iteration, and the destination would end up with alternating blank pages (1 KB blocks),
three blank in four (2 KB), and so on. `0x16800` is `45 x 2048`, so it is aligned to 512,
1 KB and 2 KB alike and every such block would be exactly aligned to the loop's stride.

What the dump actually holds, *verified*:

    unit1 0x16800 vs 0x29400 agree for 66560 bytes = 130 pages

130 pages, `ceil(66084 / 512) x 512` to the byte, with **no blank page anywhere in the
run**. The device's own hardware CRC32 over `[0x16800, 66084)` equals `0x04acebff`, the
value in the record at `0x3d800`, which is the only route by which that record could have
been promoted. Recomputed offline: `crc32(0x16800, 66084) = 0x04acebff`. So the copy is
correct and the interleaved erase did not disturb its own output.

### Witness 2: the application's OTA staging writer, 130 pages at `0x29400`

*verified* from `abs 0x1eaa0`-`0x1eb7a` and the dump. Same shape, different region:

| Site | Effect |
| --- | --- |
| `0x1eabe` | unlock `SYS_REGLCTL` with `0x59`/`0x16`/`0x88`, retrying until it reads back non-zero |
| `0x1eaca` | `ISPCON \|= ISPEN` |
| `0x1ead6` | `ISPCON \|= APUEN` |
| `0x1eada` | `bl 0x17928`, **page erase** at `staging_base + offset` |
| `0x1eade` | `ISPCON &= ~ISPEN`, then `SYS_REGLCTL = 0` |
| `0x1eaf6` | write 512 B into that page |
| `0x1eafe` | `offset += 0x200` and around again |

Result on unit 1, *verified* offline: `crc32(0x29400, 66084) = 0x04acebff`, correct, and
the erased tail after the image ends stops at `0x39800`, the next 512 boundary. Again no
blank page inside the run.

### Witness 3: the BLE stack below the window survived

This is the one that answers the question the brief actually asks. A 4 KB erase block
containing `0x16800` has base `0x16000`, because `0x16800` is not 4 KB aligned. The
bootloader erased `0x16800` on unit 1. Therefore, if the block were 4 KB or larger,
`0x16000`-`0x167ff` would now read `0xFFFFFFFF`.

*verified* offline, from the dumps already on disk:

| Check | Result |
| --- | --- |
| `0x16000`-`0x167ff` on unit 1 | 1,916 of 2,048 bytes are **not** `0xFF`. Real content |
| `0x0`-`0x167ff`, unit 1 against healthy `GLASSES-12E69E` | **0 differing bytes** |

So the region a 4 KB block would have destroyed is intact, and byte-identical to a unit
that never ran the bootloader. **Any erase block of 4 KB or more is disproven outright**,
independently of the interleave argument, and 4 KB is the smallest block that could reach
below the window at all. The catastrophic case in the brief cannot happen.

### Witness 4, weaker: the survival boundaries

Unit 1's orphan tail resumes at `0x26c00`, immediately above the last page the bootloader
erased (`0x26a00`-`0x26bff`), and the staging bank's un-erased tail resumes at `0x39800`,
immediately above `0x39600`-`0x397ff`. Both rule out blocks of 2 KB or more. They do not
rule out 1 KB, because a 1 KB block based at `0x26800` stops at `0x26bff`. Recorded for
completeness; witnesses 1 and 2 are the ones that close 1 KB.

### What the paper sources say, for the record

| Source | Says |
| --- | --- |
| PAN1020 **datasheet** | **nothing.** No register map, no flash characteristics table, no page size, no CONFIG0. It is a marketing and pinout document |
| PAN1020 **User Manual v1.8** | *Corrected 2026-08-20, see below.* It exists, it has a real FMC chapter, and this document originally implied no such thing did |
| Vendor SDK `fmc.h` | `FMC_FLASH_PAGE_SIZE 0x200`, and `FMC_Erase()`'s docblock: "The page size is 512 bytes... Must be a 512-byte aligned address" |
| Vendor SDK `section_cfg.h` | `FLASH_PAGE_SIZE (0x0200)` |
| Vendor SDK `flash_config.h` | `PAGE_SIZE (0x200)` |
| Vendor CMSIS header `PN102Series.h` | three hardware-side corroborations: CRC32 needs "512 bytes alignment", `ISPSTS.VECMAP` remaps in 512-byte units with a 9-bit offset, and "ISPADR[8:0] must be kept all 0 for Vector Page Re-map Command" |
| Other Panchip parts | **do not corroborate and must not be cited.** PAN1070/PAN1080 use a completely different SPI-NOR-flavoured controller with 256-byte pages and 4 KB sectors. Different architecture, not this FMC |

Nothing in any source suggests a non-uniform array.

**Correction: there *is* a Panchip register manual, and this document first said there was
not.** *Added 2026-08-20 after track 56 found it.* The **PAN1020 User Manual v1.8, June
2022, 373 pages**, carries an FMC chapter at section 4.3, pp.73-94. It is on Panchip's own
forum rather than anywhere indexed, which is why every previous search concluded the
datasheet was all there was. The sentence above about the datasheet is still accurate about
the **datasheet**; the impression it gave, that no Panchip register documentation exists at
all, was wrong, and that impression is what a future reader would have acted on.
`research/numicro-fmc-upstream.md` is the account of what the manual says. Three things
from it bear on this file: it confirms `0x23` verbatim as "FLASH whole chip Erase (ROM
mode)", it documents `CONFIG0` as `[31:8]`
Reserved while its own prose cites fields up there (so the upper bits are **undocumented
for this part, not absent**, and every `CONFIG0` bit position in this file is *derived*),
and it adds `ALOCK`, which is in finding 2.

**One leg of the old argument turns out to be weak, and it is worth knowing why.**
`notes/swd-flashing.md` item 2 justifies 512 partly by "OpenOCD's `numicro` driver uses
512 for ARMv6-M parts". That is a **heuristic, not a table**: upstream `numicro.c`'s
`numicro_get_arm_arch()` picks `512` for any ARMv6-M core and `2048` for anything else,
with no per-part override, and it is **wrong for at least four Cortex-M0 families**
(NUC126, NUC1262, NUC029xGE and M031 built with `PAGE_SIZE_2048`), which is why Nuvoton's
own OpenOCD fork replaces it with a part-ID table. Page size tracks the flash macro
generation, not the core. So the paper argument was thinner than it read, and the reason
to believe 512 here is the three witnesses above, not the driver.

## 2. The measurement should still happen, but it is no longer mainly a granularity test

The coordinator's proposal, an erase high in the window with the neighbours read either
side, is **sound, and the cost of being wrong really is zero**. Assessment and refinement:

- **Pick `0x28a00`, not `0x28800`.** `0x28800` is aligned to 512, 1 KB and 2 KB, so an
  oversized block based there spills only upward and you learn less per erase. `0x28a00`
  is 512-aligned and **not** 1 KB aligned, so the base of whatever block gets erased is
  visible directly, and one read of `0x28000`-`0x293ff` afterwards names the block size
  and its alignment in a single shot.
- **What each outcome looks like.** Only `0x28a00` blank: 512 bytes, the prediction.
  `0x28800` and `0x28a00` blank: 1 KB. `0x28800`-`0x28fff`: 2 KB. `0x28000`-`0x28fff`:
  4 KB. Wider still spills past `0x29400` into the staging bank.
- **What it can cost.** `0x28800`-`0x293ff` on unit 1 is programmed zeros. Below that,
  `0x26c00`-`0x28786` is the orphan tail, which we hold in three byte-identical dumps and
  which is also byte-identical to the donor. Above, `0x29400` is the staging bank, which
  we hold in the dumps and in the APK container. Nothing at risk is unrecoverable unless
  the block were 64 KB, which is not physically plausible for a part whose config page is
  512 bytes.
- **Its real value now is three other firsts.** The granularity answer is already in hand.
  What this erase would establish that nothing else can:
  1. **`APUEN` unlocks the application region.** Item 1 of `notes/swd-flashing.md` "What
     is still unproven". No erase or program has ever been aimed at APROM on this family;
     the config repair used `CFGUEN`.
  2. **A timing datum.** Time one erase, then one full 128-word page write, and multiply
     by 150. That turns the estimate in section 6 into a measurement.
  3. **The watchdog question in section 5**, settled in the same session for free.

**The prediction, recorded before the measurement, so it counts:** only `0x28a00` reads
`0xffffffff`; `0x28800` and `0x28c00` are unchanged; `ISPCON` bit 6 stays clear; and the
first read of `ISPTRG` after the trigger already shows bit 0 clear, because a single SWD
register read takes longer than the erase.

### The exact commands

Write them to a file rather than typing them as `-c` arguments, because the poll loop does
not survive shell quoting, and because `research/hardware-access.md`'s rule is that write
procedures live in their own file. This is deliberately not added to the repo: whoever
runs it should read every line first.

    cat > /tmp/granularity.tcl <<'TCL'
    init
    halt
    proc rd {a} { return [expr {[lindex [read_memory $a 32 1] 0] & 0xffffffff}] }
    echo "--- DHCSR before (bit 25 S_RESET_ST, bit 17 S_HALT)"
    echo [format 0x%08x [rd 0xE000EDF0]]
    echo "--- ISPCON as found, never read before on this part"
    echo [format 0x%08x [rd 0x5000c000]]
    echo "--- neighbourhood before"
    mdw 0x00028000 4 ; mdw 0x00028400 4 ; mdw 0x00028800 4
    mdw 0x00028a00 4 ; mdw 0x00028c00 4 ; mdw 0x00029200 4 ; mdw 0x00029400 4
    mww 0x50000100 0x59 ; mww 0x50000100 0x16 ; mww 0x50000100 0x88
    if {([rd 0x50000100] & 1) != 1} { echo "WRPROT still locked" ; shutdown error }
    mww 0x5000c000 0x00000049
    set con [rd 0x5000c000]
    echo [format "ISPCON now 0x%08x" $con]
    if {($con & 0x34) != 0} { echo "CFGUEN/LDUEN/SPUEN set, STOP" ; shutdown error }
    mww 0x5000c00c 0x00000022
    mww 0x5000c004 0x00028a00
    mww 0x5000c010 0x00000001
    for {set i 0} {$i < 2000} {incr i} { if {([rd 0x5000c010] & 1) == 0} break ; sleep 1 }
    echo [format "polls %d, ISPTRG 0x%08x, ISPCON 0x%08x" $i [rd 0x5000c010] [rd 0x5000c000]]
    echo "--- neighbourhood after"
    mdw 0x00028000 4 ; mdw 0x00028400 4 ; mdw 0x00028800 4
    mdw 0x00028a00 8 ; mdw 0x00028c00 4 ; mdw 0x00029200 4 ; mdw 0x00029400 4
    echo "--- DHCSR after"
    echo [format 0x%08x [rd 0xE000EDF0]]
    mww 0x5000c000 0x00000000
    mww 0x50000100 0x00000000
    shutdown
    TCL
    time openocd -f research/tools/pan1020.cfg -f /tmp/granularity.tcl > /tmp/gran.log 2>&1

**Redirect, never pipe.** `mdw` output vanishes behind a pipe to `grep` or `tail`; that
gotcha is already recorded in `research/hardware-access.md` and it cost twenty minutes
once.

**`ISPCON = 0x49` and nothing else.** `CFGUEN`, `LDUEN` and `SPUEN` stay clear, so the
config page, the LDROM aperture and the SPROM are refused by the hardware for the whole
session. Note the assertion mask above is `0x34`, not the `0x30` the generated script
uses: see finding 4 in section 7.

## 3. The vendor's own erase-and-program sequence, register by register

All *verified* from bytes. The bootloader and the application contain the **same compiled
primitives**, and they match the SDK's `fmc.c` line for line, so three sources agree.

| Primitive | LDROM | Application | Sequence |
| --- | --- | --- | --- |
| enable ISP | `ld 0x1003f0` | `abs 0x179ac` | `ISPCON \|= 1` |
| disable ISP | `ld 0x100360` | `abs 0x17918` | `ISPCON &= ~1` |
| read word | `ld 0x100400` | `abs 0x179bc` | `ISPCMD=0x00`, `ISPADR`, `ISPTRG=1`, poll, return `ISPDAT`. **No fail check** |
| program word | `ld 0x100464` | `abs 0x17a5c` | `ISPCMD=0x21`, `ISPADR`, `ISPDAT`, `ISPTRG=1`, poll. **No fail check** |
| page erase | `ld 0x100370` | `abs 0x17928` | `ISPCMD=0x22`, `ISPADR`, `ISPTRG=1`, poll, then check `ISPCON` bit 6; if set, write it back to clear and return -1 |
| CRC32 | `ld 0x1003a0` | `abs 0x17958` | `ISPCMD=0x2d` with `ISPADR`=start and `ISPDAT`=length, poll, check bit 6, then `ISPCMD=0x0d` to read the result out of `ISPDAT` |

The poll is always the same three instructions: `ldr ISPTRG; lsls #31; bne` back. It is
**unbounded**, has no delay and no timeout, in the vendor code and in the SDK alike.

Two constraints on those writes that no document in this repo records, both from the
reference-manual text the vendor header transcribes:

- **`ISPADDR[1:0]` must be `00` for a 32-bit ISP operation**, and a page erase address
  must be 512-byte aligned. See finding 6 for what happens when it is not.
- **The three unlock writes must be adjacent.** "Any different data value, different
  sequence or any other write to other address during these three data writing will abort
  the whole sequence." Nothing may be interleaved between the `0x59`, `0x16` and `0x88`
  writes, which is a real constraint on a hand-driven TCL loop.

Around every operation, the wrapper is:

| Step | LDROM erase wrapper `ld 0x1009dc` | Application `abs 0x1eaac`, `abs 0x214a8` |
| --- | --- | --- |
| 1 | `SYS_REGLCTL = 0x59, 0x16, 0x88`, **read back and retry the three writes until it is non-zero** | identical |
| 2 | `ISPCON \|= ISPEN` | identical |
| 3 | `ISPCON \|= APUEN` | identical |
| 4 | the operation | identical |
| 5 | `ISPCON &= ~ISPEN` | identical |
| 6 | **`SYS_REGLCTL = 0`, re-locking** | identical |

The bootloader's `main` at `ld 0x100bd8` additionally sets `LDUEN` **and** `APUEN` before
the copy, so it can write both regions. We deliberately set only `APUEN`.

### What the vendor does that we do not

| Vendor | Us | Does it matter? |
| --- | --- | --- |
| unlocks `SYS_REGLCTL` and re-locks it around **every single operation**, so `ISPCON` and `ISPTRG` are hardware-read-only in between | unlocks once and holds it open for the whole session, 4 to 10 minutes | **Yes, mildly.** `ISPTRG` is one of only three FMC registers `REGLCTL` protects; with it locked, no ISP operation can be triggered at all. Re-locking per **page** would cost about 600 extra transactions, 0.5% of the run |
| clears `ISPEN` after every operation | leaves `ISPEN \| APUEN` set throughout | same argument, same fix |
| **read-modify-writes `ISPCON`**, never writing the whole register | writes `ISPCON = 0x49` wholesale | **Yes.** See finding 3 |
| **never reads flash through the AHB**, always through `ISPCMD 0x00` | reads back with `read_memory` | Probably not: no prefetch buffer is documented on this FMC, only `FATCTL` wait states. And any staleness would cause a spurious **failure**, not a spurious pass |
| retries the unlock in a loop until `REGLCTL` reads non-zero | checks once, then aborts | No. Aborting is the safer behaviour, and nothing has been written at that point |
| runs its ISP code from a **different flash region** from the one being erased | CPU is halted, no instruction fetch at all | In our favour. This is the classic FMC gotcha and SWD sidesteps it entirely |

**And there is nothing else to check.** *Added 2026-08-20 from track 56.* On this FMC
generation there is **no verify flag, no program-fail flag, no blank check, no busy bit
distinct from `ISPGO` and no FMC interrupt**: the bit later parts use for it is Reserved
here. `ISPFF` reports only pre-flight refusals, which are constant across a whole page, so
it cannot tell you that an accepted program silently failed to take. **Software read-back
is the only detection mechanism that exists on this part.** That is the argument for never
trading `check_words` away for speed, and it is why "no `ISPFF`, therefore done" is not a
success criterion. The vendor is inconsistent about this in its own SDK: `FMC_Erase`
checks `ISPFF` and returns `-1`, while `FMC_Write` is `void` and checks nothing at all.

Two more differences, both of which make our tool the stricter one and are worth keeping:
the vendor's erase helper returns -1 on `ISPFF` and **both callers ignore the return
value**; the application's config writer at `abs 0x17aa2` clears `ISPFF` after a failed
erase and then **carries on programming anyway**. We stop.

## 4. What can be broken permanently, and what cannot

The vendor's CMSIS header lists every condition that sets `ISPFF`, and two of them are
new information for this project:

> (1) APROM writes to itself if APUEN is 0. (2) LDROM writes to itself if LDUEN is 0.
> (3) CONFIG is erased or programmed if CFGUEN is 0. (4) SPROM is erased or programmed if
> SPUEN is 0. (5) SPROM is programmed at SPROM secured mode. (6) Destination address is
> illegal, such as over an available range. (7) Invalid ISP commands.

and, only in the `ISPSTS` copy at `0x5000c040`:

> (6) **Page Erase command at LOCK mode with ICE connection.**
> (7) **Erase or Program command at brown-out detected.**

| Failure | Recoverable? | Why |
| --- | --- | --- |
| Brown-out mid-erase | **Yes.** Re-erase the page | Erase drives bits towards 1. A torn erase leaves a page that reads partly programmed; erasing it again completes it. *derived*, and it is standard NOR behaviour |
| Brown-out mid-program | **Yes.** Erase the page and rewrite it | Program drives bits towards 0. A torn program leaves marginal cells, which the read-back catches |
| Reset mid-erase or mid-program | **Yes**, same as above. The FMC has no persistent state across reset | |
| Losing the debug connection with the FMC unlocked | **Yes.** Nothing continues on its own | The engine completes the operation in flight and stops. `REGLCTL` and `ISPCON` are cleared by any reset, including a power cycle |
| Endurance | Not a concern | 150 pages, a handful of cycles each, against a NOR endurance spec that is at worst 10,000 |
| `CONFIG0` LOCK bit | **The one permanent path**, and it is closed. `CFGUEN` is clear all session, and erase cannot set a bit to 0 anyway | |
| Whole-flash erase | Closed, but **the opcode this project guards against is the wrong number**. See finding 1 |
| **Losing the SWD port** | **Possibly not**, and this is the real residual risk. See below |
| A **misaligned** erase address | Not an error and not reported. See finding 6 |

**The residual risk nobody has written down: a garbage application that re-muxes the ICE
pins.** `P4.6` and `P4.7` mux to UART1, I2C0 and SPI. `research/hardware-access.md` has
*verified* that a healthy, rendering unit does not claim them, so `RST` is currently
called "a fallback, not a prerequisite". That reasoning holds for a unit running known
firmware. It does not hold for a unit running a half-written or wrong application, which
is the state a failed write leaves behind, and which could write `P4_MFP` within
microseconds of boot. **For a write session the `RST` lead stops being a fallback.** One
extra wire from pad 1 to the probe's ground, held low during attach, is the difference
between an unfinished flash and a unit with no way back in.

**Nothing in any Nuvoton or Panchip document claims permanent damage from an interrupted
erase or program, and nothing promises that re-erasing recovers it either.** No TRM read
for this work contains any statement about partial erase, recovery, or resetting while
`ISPGO` is set; there is not even a "do not reset during ISP" warning. The row above is
therefore *derived* from how NOR flash works and from the wider industry position, which
is consistent: a truncated cycle leaves cells at indeterminate thresholds, the data is
untrustworthy until the page is erased again to completion, and physical damage comes from
over-erase or a failed charge pump rather than from a torn cycle. Treat "re-erase recovers
it" as the well-founded default and "the datasheet says so" as false.

**A refused command never starts, so it cannot leave a partial write.** The manuals are
explicit: "ISP operation **is not started** and the ISP fail flag will be set instead."
Every `ISPFF` condition is therefore a **pre-flight refusal**, not an abort part way
through. That bounds the corruption window usefully: it opens only after a trigger that
was accepted, and it is about 20 us wide for a word program and about 20 ms for a page
erase. "Something might go wrong during the write" is a much smaller and much
better-characterised risk than it sounds.

**`ISPFF` does not block the next operation**, so a failure is silent unless somebody
looks. M051's manual says so outright, and the NUC121 generation Panchip forked from drops
the sentence without contradicting it, saying only that the user must check and clear the
flag after each operation. Our script checks after every trigger, which is stricter than
OpenOCD's own driver (once per buffer) and than the vendor's (never, on program).

**Brown-out protection is off.** `CONFIG0` bit 23 = 1 means `BODEN` defaults to 0, and
both units read `CONFIG0 = 0xFFFFFFBF`, so the brown-out detector is disabled. The
"Erase or Program command at brown-out detected" fail flag therefore never fires. The
mitigation stays what it was: a charged battery, never power from the probe. Enabling the
BOD before a write would convert a sagging rail from silent corruption into an `ISPFF`
stop, which is attractive, but it means writing `SYS->BODCTL` at `0x50000018` and an
analogue control register the SDK touches for the threshold, and neither has been read.
Recorded as an idea, not a recommendation.

## 5. Is halting the CPU enough? The watchdog is the answer, and it is armed

### There is a watchdog, and the application turns it on

*verified* from bytes, in **both** builds. The helper at `abs 0x18864` (APK build) and
`abs 0x18acc` (the donor, the firmware a healthy unit actually runs) is:

    r2 = (arg1 << 1) | arg0 | (arg3 << 4) | 0x80
    *(0x40004000) = r2 ;  *(0x40004004) = arg2

`0x40004000` is `WDT_BASE` in the vendor header, confirmed by the `REGLCTL` protection
list, which names "WTCR (0x4000_4000) : Watchdog Timer Control". Both builds call it
twice with `arg0 = 0x500`, `arg1 = 1`, `arg3 = 0`, so:

    WDT_CTL = 0x582  =  WDTEN | RSTEN | TOUTSEL=5      WDT_ALTCTL = 0

`TOUTSEL = 5` is `2^14` WDT clocks. The SDK's own `WDT_Start()` uses the same interval and
comments it as **2.097 s**. `RSTEN` is set, so it resets the chip rather than interrupting.
The call sites are `abs 0x1c8c0` and `abs 0x1c910`, inside the init function that runs
`cpsie i` at `abs 0x1c85e`, so **the watchdog is armed during application init**, before
the main loop. The main loop feeds it at `abs 0x1f8a4`: clear `RSTF`, clear the flags,
then set bit 0 `RSTCNT`.

This also offers a tidy explanation for something `research/brick-2026-08-08.md` records
as unexplained: unit 1 "self-recovered from the hardfault with no intervention". The fault
handler ends in `b .` and never resets. **A 2 s watchdog does.** *derived*, and it fits.

### Why halting is nonetheless safe

`WDT_CTL[31]` is `ICEDEBUG`, and the vendor header transcribes the reference manual:

> 0 = ICE debug mode acknowledgement affects WDT counting. **WDT up counter will be held
> while CPU is held by ICE.** 1 = ICE debug mode acknowledgement Disabled. WDT up counter
> will keep going no matter CPU is held by ICE or not.

The firmware writes `0x582`. **Bit 31 is clear**, which is also the reset default, so the
counter is held while the debugger holds the core. That is consistent with what has
already happened on the bench: three 22.9-second dumps and a config repair, all with the
core halted, none interrupted by a reset.

Two independent legs support this. `WDT_CTL`'s reset value on the Nuvoton originals is
`0x0000_0700`, which is `TOUTSEL = 111` with `WDTEN` clear and **bit 31 clear**, so the
freeze behaviour is the power-on default and the firmware's `0x582` keeps it. And
`CONFIG0`'s `CWDTEN`, bits 31 and 4:3 together, reads `111` on both units, so the watchdog
is not force-enabled by fuse and is genuinely off in the window between a reset and our
halt. Only the application turns it on.

Marked *derived* rather than *verified* because it rests on a header comment for the
PN102 and on the absence of an observed reset, not on a deliberate test. The deliberate
test is one read, and it is in section 2's script: **`DHCSR` at `0xE000EDF0` bit 25 is
`S_RESET_ST`, sticky and cleared on read.** Read it, wait 60 seconds halted, read it
again. Set means something reset the part while it was halted.

Two further points on `CONFIG0` that the project has not had before: bits 31 and 4:3 are
`CWDTEN`, and "if CWDTEN is not 111, WDTEN is forced to 1 and user cannot change it to 0".
Both units read `0xFFFFFFBF`, so `CWDTEN = 111` and the watchdog is **not** force-enabled
by fuse. Had it been, it would still freeze on halt, but it would be running during the
brief window between a reset and our halt.

### Everything else that could touch flash while halted

| Master | Can it? |
| --- | --- |
| Interrupts | **No.** A halted Cortex-M0 takes no exceptions. They pend and stay pended |
| DMA | **No such peripheral is referenced.** A scan of every `ldr rN,[pc]` literal in the peripheral ranges, across the BLE stack region, the APK application and the donor application, finds no PDMA base. Peripherals present are UART0/1, the timer at `0x40010000`, the watchdog, the radio blocks at `0x40070xxx` and `0x50001xxx`, GPIO, SYS, CLK and the FMC |
| The BLE radio | Runs on RAM buffers, and the stack that drives it is not executing. It cannot issue ISP commands: only a write to `ISPTRG` starts one, and that needs the CPU or us |
| The FMC itself | Completes the operation in flight and stops. `ISPTRG` bit 0 is cleared by hardware |

**The AHB stall that aborted the first draft of the config-repair script now has a
documented mechanism.** The NUC121 generation, which Panchip forked from, words it as:
"When the ISPGO bit is set, FMC start to process ISP command, **CPU will be halt to wait
ISP done if CPU trying to access flash memory** ... The peripheral still keeps working as
usual when ISP processing." The stall is on the **flash** AHB slave, not the bus as a
whole. So reading the FMC registers while `ISPGO` is set is safe, because they are on the
APB side and every driver in existence spins on `ISPTRG` for the whole duration; reading a
**flash address** while `ISPGO` is set holds `HREADY` low and stalls the AHB-AP, which is
exactly the observed failure. **Never read a flash address without polling `ISPTRG` to
zero first.** *derived*, and it matches the bench observation precisely.

### The change that removes the question entirely

**Halt the core at the reset vector instead of wherever it happens to be.** ARMv6-M
implements `DEMCR` bit 0 `VC_CORERESET`. Set it, issue `SYSRESETREQ`, and the core stops
at the reset handler with no application code executed: no watchdog armed, no radio
brought up, no peripheral configured, no pins re-muxed.

    mww 0xE000EDFC 0x00000001      ;# DEMCR, VC_CORERESET
    mww 0xE000ED0C 0x05FA0004      ;# AIRCR, SYSRESETREQ
    ;# then confirm DHCSR bit 17 S_HALT is set and pc is the APROM reset handler

`SYSRESETREQ` is already *verified* to work on this part (`research/brick-2026-08-08.md`),
and it is already *verified* not to re-latch the boot select, so it changes nothing about
which image runs. It must be issued **before** section 3 of the script, because a system
reset re-locks `REGLCTL` and clears `ISPCON`.

## 6. Timing, honestly

**Nobody should be told "somewhere between two minutes and half an hour".** The arithmetic
is tractable and it is calibrated by a measurement we already have.

The flash is not the cost, and the family figures now bound that claim rather than
asserting it. Nuvoton publishes page erase and word program times in its "Flash DC
Electrical Characteristics" tables, and **the spread across the family is 10x**, so no
single number can be carried across to Panchip:

| Part | Page erase, typ | Word program, typ | Endurance |
| --- | --- | --- | --- |
| NUC100/120 | **2 ms** | 20 us | not stated |
| M051 | **20 ms** | 40 us | 20,000 |
| NUC123 | 20 ms | 35 to 40 us | 20,000 |
| M0518 | 20 ms | 40 us | 20,000 |

No maximum is specified anywhere and every table is footnoted "guaranteed by design, not
tested in production". Taking the pessimistic end, 150 erases at 20 ms plus 19,200
programs at 40 us is **under four seconds of flash time in total**. Everything else is the
SWD link. It also confirms the `wait_trg` bound: a 2 s ceiling is 100x the worst published
page erase, where OpenOCD's own driver allows 100 ms, which is only 5x.

Counted from the generated script, `firmware/swdflash-donor-dump-12E69E-2026-08-19-a.tcl`:
150 pages, 128 words each, **19,200 words**.

| Item | Per unit | Count | OpenOCD commands |
| --- | --- | --- | --- |
| `program_word` | 4 `mww` + 2 reads | 19,200 | 115,200 |
| `erase_page` | 3 `mww` + 2 reads | 150 | 750 |
| `check_erased` + `check_words` | one 128-word block read each | 300 | 300 block reads |
| preconditions and canaries | | 30 | 30 |

So **about 116,000 individual command round trips**, not the 84,000 or 97,200 quoted in
`notes/swd-flashing.md`; those counts omit the per-word `ISPCON` read. In SWD transfers,
at roughly three transfers per discrete command and one per word of a block read, that is
about **387,000 transfers**.

Calibration: the 256 KB dump took **22.9 s at 200 kHz**, which is 65,536 word reads, so
0.35 ms per transfer including all host overhead, of which about 0.23 ms is the 46 clocks
an SWD transfer costs on the wire. That model reproduces the observation to within 10%.

| Adapter speed | Wire time | Plus per-command host overhead | Expect |
| --- | --- | --- | --- |
| 100 kHz (the tool's default) | ~3.0 min | 0.5 to 2 ms x 116,000 | **4 to 10 min** |
| 200 kHz (what the dumps ran at) | ~1.5 min | same | **2.5 to 6 min** |

**It is minutes, not hours, and it cannot be under about three minutes at 100 kHz.** The
dominant term is the SWD clock, so raising the adapter speed to the 200 kHz the dumps
already ran at reliably roughly halves it. Read-back errors are caught by `check_words`,
and SWD parity plus the DP's sticky error flags catch a corrupted transfer, so speed
trades against retries rather than against silent corruption.

The estimate is *derived*. The way to make it *verified* costs one page: time the erase
and the 128-word write of section 2's experiment, and multiply by 150.

## 7. Eight things this project has assumed that are wrong

### 1. The chip-erase opcode is `0x23`, not `0x26`

*verified* from the vendor's own `fmc.h`:

    #define FMC_ISPCMD_CPERASE  0x23   /*!< ISP Command: Whole Flash earse ;Note: Rom use only!! */

and the reference-manual transcription in `PN102Series.h` lists the complete valid set as
`0x00` read, `0x04` read unique ID, `0x0B` read company ID, `0x0C` read product ID, `0x0D`
read CRC32, `0x21` program, `0x22` page erase, `0x2D` run CRC32, `0x2E` vector remap, and
then says "**The other commands are invalid**". `0x26` is not a command at all; issuing it
would set `ISPFF` and do nothing.

**Where the wrong number came from**, since a mistake is worth more with its provenance.
`0x26` is OpenOCD's own undocumented guess: `numicro.c` defines
`ISPCMD_CHIPERASE 0x26` with the comment "Undocumented isp Chip-Erase command". It appears
in no Nuvoton and no Panchip table. On this silicon it is most likely simply an invalid
command that sets `ISPFF` and does nothing.

`0x26` was named as whole-chip erase in nine places across the repo. **Track 54 has since
fixed the three files it owns** (`swdflash.ts`, `swdflash-sim.tcl` and the tripwire in
`swdflash.test.ts`, which now asserts `CMD_CHIP_ERASE === 0x23`), so the simulator's abort
check watches the real opcode. **Six sites remain stale**, none of them owned by this
track or track 54:

| File | Sites |
| --- | --- |
| `research/hardware-access.md` | 2, including the "what can permanently kill it" table |
| `notes/swd-flashing.md` | 2, including the refusals table |
| `research/brick-2026-08-08.md` | 1 |
| `research/tools/fmc-repair-config.sh` | 1, a header comment |
| `research/tools/fmc-ladder1.sh` | 1, a header comment |

The actual protection was never affected: `ISPCMD_VALUES` is a closed set of two opcodes
and a test asserts nothing else is ever written. But every remaining sentence about `0x26`
should say `0x23`.

### 2. `0xFFFFFFBF` **is** what a healthy unit holds, and it can be read off a file

This has been an open question in three documents and listed as a prerequisite for
`--ldrom-verified`. **It is already answered by a dump on disk**, because the config page
is physically the last 512-byte page of the main array and the `0x00300000` aperture is a
view of it. The vendor SDK's `config.h` states the physical addresses outright:

    #define CMPL_CONFIG0_ADDR    0x0003FE00
    #define CMPL_CONFIG1_ADDR    0x0003FE04
    #define CMPL_CONFIG2_ADDR    0x0003FE08
    #define CMPL_CONFIG3_ADDR    0x0003FE0C
    #define CMPL_SEC_MODE_ADDR   0x0003FDFC

Read at those offsets, *verified* offline:

| Word | Unit 1, pre-repair dump | Healthy `GLASSES-12E69E` |
| --- | --- | --- |
| `CONFIG0` `0x3fe00` | `0xffffffbf` | **`0xffffffbf`** |
| `CONFIG1` `0x3fe04` | `0x00000000` | `0x00000000` |
| `CONFIG2` `0x3fe08` | `0x00000000` | `0x00000000` |
| `CONFIG3` `0x3fe0c` | `0x0003dbff` | `0x0003dbff` |
| `SEC_MODE` `0x3fdfc` | `0xf1ffffff` | `0xf1ffffff` |

Three consequences.

- **`0xFFFFFFBF` is the normal value.** A never-OTA'd working unit holds it, so it is the
  factory value and not merely the bootloader's handoff. The config repair on 2026-08-19
  changed a correct value to a different one.
- **Unit 1 is now the only unit at `CBS = 11`**, "APROM without IAP mode", where every
  working unit is at `CBS = 10`, "APROM with IAP mode". Before concluding anything from a
  donor repair that does not work, put `CONFIG0` back to `0xFFFFFFBF`. That is one config
  page erase and four programs with `CFGUEN`, and it must be a **separate session**:
  `CFGUEN` and `APUEN` must never be set together.

  *Both halves of that need qualifying, 2026-08-20, and the full argument is now
  `research/config0-cbs-2026-08-20.md`.* The premise is spent: the donor repair **did**
  work, so this is no longer a variable to eliminate before reading a failure. The live
  reason to care is different and larger, namely that IAP is in-application programming and
  the resident updater is the only thing this project has ever built that needs it. And
  "the operation already proven on this unit" does **not** cover it: the proven operation
  left `CONFIG0` erased and never programmed it, so the reversal is the first `CONFIG0`
  program here, which is exactly the case the `LOCK` row above is closed by two legs
  against. Both legs are gone when the operation is a program needing `CFGUEN`.
- **The whole config page is identical between the bricked and the healthy unit.** That
  independently kills any remaining "a config difference explains the brick" theory.
- **Do not read lock state off `CONFIG0` alone.** *Added 2026-08-20.* The PAN1020 User
  Manual gives `LOCK` a second latch, `ALOCK` in `CONFIG2[7:0]`, which must read `0x5A`,
  and says an erase reprograms it to `0x5A` by itself. **Both our units read
  `CONFIG2 = 0x00000000`**, which is not `0x5A`, on a part whose `CONFIG0` `LOCK` bit is
  set. Nobody has worked out what that combination means. It has cost nothing so far,
  because both units are *verified* readable, but it is an unexplained device reading and
  this project has been bitten by passing over one of those before.

The pre-repair reading also confirms `0x3fe00` is the live physical location rather than a
stale copy, because it agreed with the aperture read taken the same evening. A cheap
offline check once unit 1 is re-dumped: `0x3fe00` should now read `0xffffffff`.

### 3. Writing `ISPCON = 0x49` wholesale writes a boot-select bit

`ISPCTL` bit 1 is `BS`, and it is writable:

> Boot Select. Set/clear this bit to select next booting from LDROM/APROM, respectively.
> This bit also functions as chip booting status flag... initiated with the inversed value
> of CBS[1] (CONFIG0[7]) after any reset.

`CONFIG0` bit 7 is 1 on both units, so `BS` comes up as 0 and writing `0x49` leaves it at
0. **No harm on these units today**, but the project's own standing rule is "never write a
register whose semantics you have not read", and the vendor never writes `ISPCON`
wholesale: it always read-modify-writes. The safe form keeps whatever else the boot ROM
left in there while still guaranteeing the safety property:

    read ISPCON, clear CFGUEN | LDUEN | SPUEN, set ISPEN | APUEN | ISPFF, write back,
    then assert the three update bits came back clear

### 4. The `ISPCON` assertion misses `SPUEN`, and there is a region nobody has read

There are **four** update-enable bits, not three: `[2] SPUEN` gates the SPROM. The
generated script asserts `(con & 0x30) != 0` for `CFGUEN | LDUEN`. It should be `0x34`.
Writing `0x49` does clear `SPUEN`, so the property holds today by construction; the
assertion just does not check it.

More interesting is what `SPUEN` protects. The vendor header puts SPROM at `0x00200000`,
512 bytes, and `config.h` calls the same range the **ID block**:

    #define ID_BLOCK_START_ADDRESS  0x00200000
    #define ID_BLOCK_END_ADDRESS    0x002001FF

`ISPSTS[31]` is `SCODE`, "Security Code Active Flag... only cleared by SPROM page erase".
`research/hardware-access.md` lists "erasing factory trim, unique ID or RF calibration" as
unrecoverable and says "it may live outside `0x0`-`0x3ffff`". **It does, and this is
where.** Every dump so far is `0x0`-`0x3ffff`, so the SPROM has never been read.

**Read it before any write session.** `mdw 0x00200000 128` is read-only, costs seconds,
and it is the one region of this part that is both potentially unique per unit and
currently unarchived.

### 5. "The hardware refuses the config page and the LDROM" holds only for the apertures

The five-layer safety argument in `swdflash.ts` says layer 2, `CFGUEN` and `LDUEN` clear,
means "the **hardware** refuses" the config page and the LDROM. That is true of accesses
through the `0x00300000` and `0x00100000` apertures. It is **not** established for the
same content at its main-array addresses: the config page really is at `0x3fe00` and the
bootloader really is at `0x3dc00`, both inside the range `APUEN` enables. The `fmc.h`
`LDROM_SIZE` of `0x800` is in any case stale for this part, since the reserved bootloader
region is 9,216 bytes.

The tool is still safe, because layer 1, the `guard` proc, checks every address that
reaches `ISPADR` and the window stops at `0x29400`. But the safety **argument** is weaker
than written: for those two addresses it is one layer, not two. Worth saying plainly, and
worth remembering if anyone ever proposes widening the window or adding a "blank the whole
APROM" mode.

### 6. A misaligned erase address is not an error, it silently erases the containing page

Alignment appears in the manuals as a **requirement**, never as an `ISPFF` condition, and
where later Nuvoton parts document the behaviour they say the low address bits are
*ignored*. So an erase aimed at `0x16900` does not fail: it erases `0x16800`-`0x169ff` and
reports success. For a hand-driven register loop that is the sharpest edge in the whole
register set, and it is the one failure mode that produces a plausible-looking log and a
wrong flash array.

The tool's addresses are aligned by construction, and `guard` checks bounds. It does not
check alignment. One assertion in `erase_page` (`addr % 512 == 0`) and one in
`program_word` (`addr % 4 == 0`) costs nothing and closes it. See the handover.

### 7. A locked part is not the dead end this project thinks it is

`research/hardware-access.md` says of a `LOCK`ed unit that "a locked unit is effectively a
dead end for extraction", because the array reads back as `0xFFFFFFFF` over the debug
port. That is true of an **AHB** read. It is not true of an ISP read. M051's manual states
it plainly: "**ISP can read data anywhere regardless of LOCK bit value.**"

So on a locked unit, `ISPCMD 0x00` through the FMC still returns real content, and that is
a path this project has already validated on silicon (`fmc-ladder1.sh`). What a locked
part **does** refuse is the erase, via the `ISPSTS` condition "Page Erase command at LOCK
mode with ICE connection". Read first, conclude second.

Not urgent, since both units are *verified* unlocked, but it changes what a locked third
unit would mean, and it is the kind of pessimistic claim that stops someone trying.

### 8. Smaller corrections

- **`notes/swd-flashing.md` item 2, "That a 512-byte page is the erase granularity",
  should move from unproven to *verified*** with the three witnesses in section 1.
- **Item 7, re-locking `SYS_WRPROT` by writing `0x00`, is not merely *derived* from
  Nuvoton.** The vendor's own code on this part does exactly `SYS->REGLCTL = 0` after every
  flash operation, at `ld 0x1009fc`, `abs 0x1eae2`, `abs 0x214d8` and `abs 0x21530`, and
  the unlock helper reads the register back and retries until it is non-zero, which is what
  makes the read-back meaningful.
- **The part ID has a home, and the `0x50000000` reading is by design.** Nuvoton's `SYS_T`
  begins with `PDID` at offset `0x00`; Panchip's begins with `RESERVED0[1]` and puts
  `RSTSTS` at `0x04`. The register was deleted, so `0x00000000` is not a fault and no
  amount of probing that address will help. The FMC kept the ID commands instead, and the
  addresses matter: **company ID is `ISPCMD 0x0B` with `ISPADDR 0x00`, product ID is
  `ISPCMD 0x0C` with `ISPADDR 0x04`** (not 0), unique ID is `0x04` with `ISPADDR` = index,
  and UCID is `0x04` with `ISPADDR = 0x10 + 4n`. All read-only, all needing `ISPEN` and no
  update-enable bit, all through the path `fmc-ladder1.sh` already validated.
- **`ISPSTS` exists at `0x5000c040`** and nothing in this repo reads it. It carries
  `ISPBUSY[0]`, a read-only `CBS[2:1]` (so the boot select can be read without decoding
  `CONFIG0`), an `ISPFF` mirror, `VECMAP[20:9]` and `SCODE[31]`. `CBS` from `ISPSTS` is a
  one-word read-only way to confirm the boot select on a unit before touching it.
- **`0x40004000` is the watchdog**, `0x40010000` is a timer, and there is no DMA
  controller. Worth adding to the peripheral map in `research/firmware-internals.md`.

## 8. What should change before the write, handed to track 54

**Outcome, later on 2026-08-20: all five landed**, and one of them corrected the reasoning
that produced it. Kept in full rather than trimmed to a note, because the corrections are
the valuable part. `research/swdflash-review-2026-08-20.md` is track 54's account.

Not edited here. Five items, in the order they matter.

1. **Detect an oversized erase after the FIRST erase, not after the 150th.** The canaries
   outside the window are read in section 2 and again in section 6, so a 4 KB block
   destroying `0x16000`-`0x167ff` would be reported only at the end, after 150 pages. And
   an oversized block of 1 KB or 2 KB is not covered by any canary at all, because
   `0x16800` is 2 KB aligned so those blocks never reach below the window; they eat the
   **previous page inside** the window as the write walks upward, and nothing notices until
   the post-flash dump. The fix is one read: after the first `erase_page`, read the page
   **above** it, `addr + PAGE`, and require it to still match what the target's dump says
   it holds, and re-read the sub-window canaries. That catches every oversized block in
   both directions after exactly one erase, and it costs 128 words plus ten reads once.

   **Done, and the proposal above was half wrong.** *Corrected 2026-08-20 by track 54:
   reading the page **above** is the **weaker** half. An oversized block reaching forwards
   destroys pages not yet written, which the run then writes correctly anyway; the harmful
   direction is **backwards**, over a page already programmed. The page **below** and a
   `verify_last` after every erase are what actually matter, and both are now in the
   script, along with a dedicated probe erase and a first-erase canary sweep.*
2. **Notice if the target resets mid-run.** The script does `init; halt` and never looks
   again. If the part resets, OpenOCD resumes the application, which then runs while we
   poke the FMC, and which writes flash itself on a DATS save. **Read `DHCSR`
   (`0xE000EDF0`) once per page** and abort unless bit 17 `S_HALT` is set and bit 25
   `S_RESET_ST` is clear. 150 extra reads against 116,000, and it is the only thing that
   would catch a watchdog reset or a brown-out reboot at the moment it happens.
   Better still, **halt at the reset vector**: set `DEMCR` bit 0 and issue `SYSRESETREQ`
   before section 3, so the application never runs and never arms anything.

   **The `DHCSR` half is done**, before the unlock, before every erase and at the end,
   with a simulator `--reset-at n` proving it fires. **The reset-vector halt was declined,
   with a reason worth keeping:** it changes what the operator's session does before the
   script is sourced and it touches the boot-select latch, so it belongs in a procedure a
   human agreed to rather than inside a generator. It therefore stays a recommendation for
   the person holding the probe, in section 5, and not a tool change.
3. ~~**Fix the opcode.**~~ **Done by track 54 on 2026-08-20**, in all three files it owns;
   the tripwire now asserts `0x23`. Six sites elsewhere are still stale and are listed in
   finding 1, but none of them is code.
4. **Read-modify-write `ISPCON`, and assert with mask `0x34`.** Findings 3 and 4. While
   there, print `ISPCON` as found before overwriting it: nobody has ever seen its value on
   this part, and it costs one read.
5. **Assert alignment, not just bounds.** `guard` checks the address is inside the window
   and nothing else. A misaligned erase address is not an `ISPFF` condition: the low bits
   are ignored and the containing page is erased, with success reported (finding 6). One
   `addr % 512 == 0` in `erase_page` and one `addr % 4 == 0` in `program_word` close the
   only failure mode that produces a clean log and a wrong array. **Done**, and track 54
   reached the same place independently.

Two optional hardenings, both cheap, neither required, **and neither taken up as of this
writing**: re-lock `SYS_WRPROT` and clear `ISPEN` **per page** rather than per session,
matching the vendor's granularity at about 0.5% of the runtime; and raise the adapter
speed to the 200 kHz the dumps already ran at, which roughly halves the wall time.

One thing to leave alone: the per-word `ISPFF` check could be reduced to one per page,
since `ISPFF` is sticky and write-1-to-clear, saving a sixth of the run. It is not worth
it. The read-back is what actually proves the page, and knowing which **word** failed is
worth more than ninety seconds.

## Unverified

- **That the erase granularity is 512 in `0x26c00`-`0x293ff`.** Witnesses 1 and 2 cover
  `0x16800`-`0x26bff` and `0x29400`-`0x397ff`. The 20 pages between them are *derived* by
  uniformity, which every source supports and none contradicts. The experiment in section
  2 lands squarely in that gap, which is a further reason to run it.
- **That `WDT_CTL[31] ICEDEBUG = 0` really holds the counter while the CPU is halted on
  this part.** The wording is the vendor header's transcription of a reference manual that
  is not public. The supporting observation, four long halted sessions with no reset, is
  circumstantial. One `DHCSR` read settles it.
- **This part's own flash timing.** No page erase time, word program time, endurance or
  retention figure has been found in any Panchip source. **The PAN1020 User Manual v1.8's
  FMC chapter is the first place left to look** and nobody has reported a flash
  characteristics table in it either way; the SDK's own
  `FLASH_TIME_TO_ERASE_PAGE_US` and `FLASH_TIME_TO_WRITE_ONE_WORD_US` are commented out and
  never defined. The Nuvoton family figures in section 6 bound it to 2-20 ms per page and
  20-40 us per word, which is enough to call the 2 s poll ceiling sane, but the spread is
  10x and the real number for this silicon is one measurement away.
- **What OpenOCD's undocumented write of `1` to `0x5000C01C` does.** Its `numicro` driver
  does it in `numicro_init_isp()`, commented only "Write one to undocumented flash control
  register". It is inside the FMC's reserved space between `FATCTL` and `ISPSTS`. Neither
  the bootloader nor the application writes it, so we do not need it; recorded so nobody
  copies it in from the driver on the assumption that it is required.
- **Whether the brown-out `ISPFF` condition aborts an operation in flight or only refuses
  to start one.** Every other condition is a documented pre-flight refusal, and a brown-out
  is the one that can arrive *after* the trigger. Track 56 could not close it. It is the
  difference between "a sagging rail stops the write" and "a sagging rail corrupts the page
  in flight", which is exactly the risk the charged-battery rule exists for.
- **What `CONFIG2 = 0` means when `ALOCK` is supposed to be `0x5A`.** Finding 2.
- **Whether a misaligned erase really erases the containing page on this part** rather
  than failing. Documented that way on later Nuvoton parts, silent on this generation.
  The tool should assert rather than find out.
- **Whether the AHB read-back is coherent immediately after a program.** No prefetch buffer
  or cache is documented on this FMC, only `FATCTL` wait states, and the vendor reads
  through `ISPCMD 0x00` rather than the AHB. If spurious `check_erased` or `check_words`
  failures appear, this is the first suspect, and the fix is to read the same address twice
  or to read through the FMC.
- **What `CONFIG0` bit 1 is on this part.** A LOCK mode exists, because `ISPSTS` lists
  "Page Erase command at LOCK mode with ICE connection" as a fail cause, but no Panchip
  source names the bit or its polarity. Nuvoton's `LOCK` at bit 1 with 0 meaning locked
  remains the working assumption and remains unchecked.
- **What is in the SPROM at `0x00200000`.** Never read. See finding 4.
- **What `SEC_MODE` at `0x3fdfc` is.** Both units read `0xf1ffffff`, so three bits are
  deliberately programmed to 0. It sits in the page below the config page, outside the
  window, and nothing in the firmware reads it.
- **Whether `APUEN` alone would permit an erase at `0x3dc00` or `0x3fe00`.** Finding 5.
  Untested, and it should stay untested: the `guard` proc is what keeps it academic.

## Reproducing this

Offline, no device. The dumps are gitignored; copies are outside the repo.

    bun research/tools/mkelf.ts firmware/ldrom-unit1-2026-08-19.bin /tmp/ldrom.elf 0x00100000
    OD=$(xcrun --find llvm-objdump)
    $OD -d --triple=thumbv6m-none-eabi --start-address=0x100360 --stop-address=0x1004e0 \
       /tmp/ldrom.elf                                  # the FMC primitives
    $OD -d --triple=thumbv6m-none-eabi --start-address=0x100a88 --stop-address=0x100b30 \
       /tmp/ldrom.elf                                  # the copy loop

    bun research/ota-codec.ts decode firmware/TR1906R04-10_OTA.bin /tmp/fw10.bin
    bun research/tools/mkelf.ts /tmp/fw10.bin /tmp/fw10.elf 0x16800
    $OD -d --triple=thumbv6m-none-eabi --start-address=0x17918 --stop-address=0x17b20 \
       /tmp/fw10.elf                                   # the same primitives, in the app
    $OD -d --triple=thumbv6m-none-eabi --start-address=0x1eaa0 --stop-address=0x1eb80 \
       /tmp/fw10.elf                                   # the OTA staging erase loop
    $OD -d --triple=thumbv6m-none-eabi --start-address=0x1c860 --stop-address=0x1c8ca \
       /tmp/fw10.elf                                   # the watchdog being armed

`fwtool.ts` cannot be pointed at the LDROM: its `BASE` is pinned to `0x16800`. Both of its
scanning traps were honoured throughout by resolving `ldr rN,[pc,#imm]` to their literal
pools rather than matching raw words, and by treating `movs`/`lsls` construction
separately. That second pass is what catches `0x00300000` being built as `0x5000c000 << 6`
in both config writers, and it is why the peripheral inventory in section 5 was built from
resolved LDR literals rather than a word scan.

The dump arithmetic in sections 1 and 7 is a few lines of Bun over
`firmware/dump-unit1-2026-08-19-a.bin` and `firmware/dump-12E69E-2026-08-19-a.bin`:
compare `0x16800` against `0x29400` byte by byte, CRC32 both spans, diff `0x0`-`0x16800`
between the two units, and read four words at `0x3fe00`.

## Sources

- Vendor SDK mirror, the single most useful source and better than the datasheet:
  [hao0527/BLE_APP](https://github.com/hao0527/BLE_APP). `src/platform/driver/inc/fmc.h`
  for the page size and the ISPCMD table, `src/platform/driver/src/fmc.c` for the
  sequences, `src/platform/driver/inc/config.h` for the physical CONFIG addresses,
  `src/platform/driver/src/wdt.c` for the watchdog wrappers, and above all
  `src/platform/arch/inc/PN102Series.h`, a CMSIS device header whose comments are a
  transcription of the unpublished PN102 reference manual. **It contains invalid UTF-8:
  use `LC_ALL=C grep -a`, or plain `grep` silently returns nothing on macOS.**
- [PAN1020 datasheet](https://www.panchip.com/static/upload/file/20191011/1570778962386423.pdf),
  which contains no register map, no flash characteristics and no CONFIG0 section. It is
  useful for the pin table and for the BOD and LVR thresholds in tables 4-9 and 4-10, and
  for nothing here. **The datasheet is not the only Panchip document**: the PAN1020 User
  Manual v1.8, June 2022, 373 pp, has an FMC chapter at section 4.3, and this file
  originally implied it did not exist. See the correction in section 1.
- Do **not** transfer anything from PAN1070, PAN107x or PAN1080. Their `pan_fmc.h` is a
  different controller entirely: 256-byte pages, 4 KB sectors, SPI-NOR opcodes.
- [OpenOCD `numicro` driver](https://github.com/openocd-org/openocd/blob/master/src/flash/nor/numicro.c),
  read for what it actually does rather than as an authority: its page size is an
  ARMv6-M heuristic with no per-part table, its poll ceiling is 100 ms, it never checks
  `ISPFF` in `numicro_fmc_cmd()`, it treats a failed unlock as success, and `0x26` is its
  own undocumented guess at a chip-erase opcode.
  [Nuvoton's fork](https://github.com/OpenNuvoton/OpenOCD-Nuvoton) replaces the heuristic
  with a part-ID table, which is the evidence that the heuristic is wrong.
- **`research/numicro-fmc-upstream.md`** (track 56, written alongside this one) is the
  fuller treatment of the NuMicro ancestry, family by family. Where the two documents
  cover the same ground they were sourced independently and they agree; this one is the
  silicon and the vendor's own code, that one is the paper.
- Nuvoton technical reference manuals for the register semantics Panchip inherited
  verbatim: **M051** (`ISPFF` non-blocking, the unlock-sequence abort rule, the CPU stall,
  "when a word will be changed, all 128 words need to be copied"), **NUC121/125** (the
  nine-condition `ISPFF` list Panchip copied word for word, and the `CWDTEN` fuse),
  **NUC100** and **M0518** for the flash characteristics tables in section 6.
- `research/ldrom-2026-08-19.md` for the bootloader's structure, which this document
  extends at the register level rather than repeating.
