# Adversarial review of the APROM write path, 2026-08-20

**Verdict: it should not have been run as it stood on 2026-08-19. It can be run now.**
The tool as reviewed would, on one *derived* assumption being wrong, have run to
completion, printed "Every word written was read back and matched", exited zero, and
left half the application region erased. That is worse than a brick: it is a brick the
tool certifies. Five layers of safety were in place and none of them covered it. The
layers are now six, the sixth is asserted against the generated artefact at every block
size the assumption could be wrong by, and the same scenario now stops after one page
erase with nothing outside the window touched.

**The assumption turned out to be right.** `research/fmc-erase-program.md`, landed the
same day by track 55, establishes 512 bytes as *verified* on this silicon from three
witnesses in the vendor's own shipped code, and disproves 4 KB and larger outright: the
bootloader erased `0x16800` upward on unit 1, and `0x16000`-`0x167ff` still holds real
content byte-identical to the healthy unit. So the irreversible half of what follows is
now a hazard that was, not a hazard that is. **The 1 KB and 2 KB cases are not excluded
by that argument** and they are the ones no canary can see, so the checks stay. They cost
one page erase and about 34,000 reads, all of it wire time, and this project's own
history is that *derived* facts have repeatedly been wrong.

What follows is what was found, what changed, and what is still not covered. **Nothing
here touched hardware**; every result is from `swdflash-sim.tcl` and the dumps taken on
2026-08-19.

## The dangerous one: the erase block, and a run that passes while lying

**As of 2026-08-19 the 512-byte page was *derived* and had never been measured on this
silicon.** `notes/swd-flashing.md`, "What is still unproven", item 2 said so: it came
from Panchip's `section_cfg.h` (`FLASH_PAGE_SIZE 0x200`) and from OpenOCD's `numicro`
driver, which uses 512 for ARMv6-M parts. The part ID at `0x50000000` reads `0x00000000`
(*verified* 2026-08-19), so there was not even a device ID to check that inheritance
against. `research/fmc-erase-program.md` has since made it *verified*; everything below
is what the tool would have done had it not been, which is the state it was about to be
run in.

`WINDOW.start` is `0x16800`. It is 2 KB aligned and not 4 KB aligned, and that single
piece of arithmetic splits the failure into two shapes that need two different checks.

| block | block base of `0x16800` | BLE stack lost on erase 1 | erasing page 1 wipes page 0 |
| --- | --- | --- | --- |
| 512 B | `0x16800` | 0 | no |
| 1 KB | `0x16800` | 0 | **yes** |
| 2 KB | `0x16800` | 0 | **yes** |
| 4 KB | `0x16000` | 2,048 | yes |
| 8 KB | `0x16000` | 2,048 | yes |
| 16 KB | `0x14000` | 10,240 | yes |
| 32 KB | `0x10000` | 26,624 | yes |

The old script's only defences were a per-page `check_words` immediately after that page
was programmed, and a canary sweep before and after the whole run. Neither sees a later
erase reaching backwards over a page already written. So, measured by running the
2026-08-19 script against the simulator with `--erase-block` set, on unit 1's own dump:

| block | what the old script did | outside the window |
| --- | --- | --- |
| 1 KB | **exit 0. "=== DONE. Every word written was read back and matched."** 150 erases, 19,200 words, every canary matched | nothing moved, correctly |
| 2 KB | failed, but only at the final canary sweep, after all 150 pages | 256 words of the staging bank gone |
| 4 KB | failed at the final sweep | **479 words of BLE stack gone**, 768 above |
| 16 KB | failed at the final sweep | **2,526 words of BLE stack gone**, 2,816 above |

The 1 KB row is the finding. `verify` against the resulting array reports **37,574 bytes
differing in 682 runs, with 39,297 of the window's 76,800 bytes left erased**, and the
operator has been told the flash landed. The 4 KB and 16 KB rows are the irreversible
ones: this tool can never write below `0x16800`, so the BLE stack it just erased is
gone, and the failure is only reported once all 150 erases have happened anyway.

**One more thing the old script got exactly backwards.** `expect_word`'s failure text
ended "Nothing has been written." That proc runs the after-the-fact canary sweep too, so
in the 4 KB case the operator reads "the last page of the BLE stack reads 0xffffffff ...
Nothing has been written" at the moment 19,200 words have been written and 1,916 bytes of
live stack are gone. It is the single most misleading sentence in the file, printed at
the single worst moment.

### What was added

**A granularity probe, section 5, before any page of the plan.** It erases exactly one
page and then reads the page below it back in full. The page is chosen by `chooseProbe`
so that:

- it is one of the plan's own pages, and so is the page below it, so the probe erases
  nothing the run was not going to erase anyway;
- `addr % 1024 === 512`, so for **every** block size from 1 KB to 32 KB the block base
  is at or below `addr - 512`, which means one page-sized read-back detects all of them,
  including the 1 KB and 2 KB cases no canary can see;
- the enclosing block, out to `containedTo`, lies wholly inside the window. On the real
  repair the probe lands at `0x18200` with `containedTo` 32,768, whose block is
  `0x18000`-`0x20000`. So a 32 KB erase block would destroy 32 KB **of the span this run
  rewrites end to end** and nothing else;
- the page below has at least one word that is not `0xffffffff`, or reading it back
  could not tell an over-erase from the truth.

This is not a reordering of the write plan and it does not try to make an oversized
erase safe. No ordering can: ascending reaches back over pages already written,
descending reaches forward and then erases them again. It moves the *first* erase of the
session to the one place where being wrong is free.

**A canary sweep inside the first erase of the session, whichever erase that is.**
`erase_page` fires it once, on `$::JGX_SWEPT`, so it happens between the erase and any
programming. Four canaries below the window were added for it, at `0x10000`, `0x14000`,
`0x16000` and `WINDOW.start - 4`, one per block base an oversized erase could have.

**`verify_last`: every erase re-reads the page finished before it.** Any block larger
than a page that reaches backwards contains the adjacent page, so this detects every
oversized block, at the second page, with no dependence on anything outside the window
moving. It is what covers 1 KB and 2 KB if the probe is ever absent.

**Section 7: the whole window read back once more at the end.** Per-page verification
says each page was right when it was written; this says the window is right *now*. It
also refuses if fewer pages were recorded than planned.

Measured on the real repair script, all six block sizes: **1 page erase, 0 words
programmed, 0 bytes changed outside the window, `SYS_WRPROT` left locked.** At 512 bytes
the run is unchanged and still lands byte for byte.

`swdflash.test.ts` asserts every one of those numbers against the generated artefact,
per block size, and holds three mutation tests: remove the probe and a 4 KB block reaches
the BLE stack; remove `verify_last` and 1 KB is caught only by section 7; remove all
three and the run passes with the flash wrong, which is the 2026-08-19 shape preserved
as the reason the layers exist.

## Is verification independent of the write path?

**Yes on addressing, no on time, and time was the hole.**

Reads go through `read_memory` on the AHB-mapped flash address, not through
`ISPCMD 0x00`. So the read path shares no register, no opcode and no update-enable bit
with the write path. If `ISPADR` decoded to somewhere other than where the script thinks,
the program would land elsewhere and the read-back at the intended address would show
unchanged data, and `check_words` would fail. That much is genuinely independent.

What was not independent was *when*. Every read-back happened immediately after the write
it checked and never again, so the script's claim was "each page was correct at the moment
it was finished", which is not the claim anyone wants. Section 7 now makes the stronger
one. Residual, and *unverified*: nothing rules out a prefetch buffer or a stale AHB read
serving a value the array does not hold. A Cortex-M0 at this size is unlikely to have a
cache, and `check_words` reads 128 words in one transaction after 128 programs, so a
single-word buffer could not survive it.

## Failure mid-write

**The device ends in a state that is detectable and resumable, and the FMC is no longer
left open.**

- The script stops at the first bad read and never carries on past one. That was already
  true.
- **It now tears the FMC down on the error paths too.** `fail` calls `lock_down`, which
  writes `ISPCON := 0` and `SYS_WRPROT := 0`, before `shutdown error`. Previously an
  abort left `ISPEN | APUEN` set with the write protection open, and whatever resumed the
  core next would have run on writable flash. A power cycle would have cleared it, but
  nothing in the procedure required one, and `--resume` explicitly does not.
- **`--resume` verifies what it skips, and always did.** A skipped page emits `keep_page`,
  which is `check_words` over the data plus `check_erased` over the tail. It trusts
  nothing; the dump only decides what to *rewrite*, never what to believe. A page that was
  erased but not programmed when a run died fails `pageMatches` and is rewritten.
- **A skipped page cannot be the probe's neighbour.** `chooseProbe` requires both pages to
  be pages the run will write, because an over-erase of a page nobody rewrites is damage
  the run would not repair.

Not addressed, and not addressable from here: a brown-out or a dropped SWD link during an
erase. `research/hardware-access.md` rates a brown-out mid-erase as the one failure that
may not be recoverable, and the mitigation stays procedural (own battery, `VD`
unconnected). The watchdog is *unverified*: nothing establishes that halting the core
stops it.

## Can anything reach outside the window?

Each layer was mutated in the tests and the answer is per region, not global.

| Region | What stops a write | If the guard is deleted |
| --- | --- | --- |
| config page `0x300000` | `CFGUEN` clear, so **hardware** | still refused, ISPFF set. Tested |
| LDROM `0x100000` / `0x3dc00` | `LDUEN` clear, so **hardware** | still refused |
| **BLE stack `0x0`-`0x16800`** | **`guard` only, in software** | **erased, no ISPFF, only a canary notices** |
| staging bank, saved content, info pages | `guard` only, in software | as above |
| whole chip | `ISPCMD 0x26` not expressible; closed set of two opcodes; test fails the build on a third | unchanged |

**The asymmetry is worth saying out loud, because the script's own banner groups the four
refusals together and one of them is not like the others.** `APUEN` enables the whole
APROM, and the BLE stack is APROM. There is no hardware bit that distinguishes the
application region from the stack below it. A new test, "the region below the window has
no hardware backstop", deletes `guard`, aims a page at `0x00000000`, and asserts the
simulated part erases it with `ISPFF` never set.

**And the hardware half of the argument has never been observed in the refusing
direction.** `CFGUEN` and `LDUEN` refusing a write is *derived* from Nuvoton. The config
repair set `CFGUEN` because it wanted the config page; `fmc-ladder1.sh` only read. The
simulator models the refusal from the same reading the tool relies on, so a passing
simulator run on that point is the model agreeing with itself. It is now the last item in
the simulator's own "does not model" list, and the CONFIG0 canary is what would notice on
real silicon, which is why it is now mandatory (below).

Two other escapes were closed:

- `erase_page` asserts its address is on a 512-byte page and `program_word` asserts word
  alignment. `guard` bounds addresses; it never checked alignment, and a misaligned
  `ISPADR` is a different fault.
- A mistyped `--config0` or `--ldrom` became `NaN`, and `NaN >>> 0` is `0`, so the canary
  silently expected `0x00000000` at an address that has never held it. Refused now.
  `--speed 0` reached OpenOCD as adaptive clocking on a part with no RTCK pin; refused.

## Canaries that could not see an erase

**Three of the eleven canary addresses read `0xffffffff` on the units in hand, and a
canary on an erased word can detect a stray program but not a stray erase.** An erase is
the failure that matters. `WINDOW.start - 4` is `0x167fc` and reads `0xffffffff` on both
12E69E and unit 1: the canary closest to the window was the one that could say least.

`sightedCanary` now moves each canary to the nearest word in its own page that is not
erased, backwards first, and says in the plan that it moved. On unit 1 the below-window
canary lands at `0x16778`, 136 bytes under the edge. Where the whole page is erased, as
`0x3da00` is on unit 1, the canary is kept and labelled `BLIND to an erase` rather than
quietly presented as evidence.

## `--config0` is now required, and that is a real change to the procedure

`swdflash script` and `swdflash donor` refuse without `--config0`. `plan` still runs
without one and says what it lost.

The reasoning: the headline claim of the whole session is that the config page is refused
by hardware, and that claim has never been tested in the refusing direction on this part.
The CONFIG0 canary is the only thing in a run that would notice if `ISPCON` bit 4 does not
mean what Nuvoton says it means. It costs one read-only `swd-recon.sh diag`. The procedure
in `notes/swd-flashing.md` already passes it at every step, so nothing documented breaks;
what breaks is the shorter command line people type from memory.

## How strong is the simulator, honestly

**It is the author's model of the part, and on the one question that mattered it was the
same wrong assumption as the tool.** `swdflash-sim.tcl` hardcoded `512` in its erase, in
a line commented "Page erase, 512 bytes." So a passing run proved the script agreed with
the assumption, not that the assumption was true, and the failure above was invisible by
construction.

`--erase-block` fixes that specific case and makes the assumption a variable the tests
sweep. The general lesson does not go away: **the simulator can only test what its author
thought to model.** Its header now carries the full list of what it does not model, which
is the honest measure of what a passing run is worth:

| Not modelled | Why it matters |
| --- | --- |
| timing; `sleep` is a no-op | `wait_trg`'s 2 s ceiling is never real time. `--busy` exercises the loop's shape only |
| the AHB stalling while the ISP engine is busy | this is the documented reason the poll exists at all |
| brown-out, reset, watchdog, a dropped SWD link | no run can be interrupted; every failure is one the script chose to raise |
| whether the part accepts these opcodes with `APUEN` at all | `APUEN` has never been set on this silicon |
| whether `CFGUEN`/`LDUEN` clear really refuse | modelled from the same reading the tool relies on |
| prefetch buffers, stale AHB reads, a read-locked part | `read_memory` always returns the array |
| the re-lock | *derived* from Nuvoton, never run |

Two capabilities were added so the tests can reach further: `--busy n` holds `ISPTRG` set
for n polls, which is the first thing ever to exercise `wait_trg`'s loop rather than
short-circuit it, and `--out` is now written on failure as well as success, so the state
after an abort can be looked at instead of guessed.

## What I could not fix

- **The page size is *verified* for `0x16800`-`0x26bff` and `0x29400`-`0x397ff` only.**
  Track 55's witnesses are the bootloader's copy loop and the OTA staging writer, and the
  20 pages between them, `0x26c00`-`0x293ff`, are *derived* by continuity. The probe and
  `verify_last` cover them, which is the one place those checks are still load-bearing
  rather than belt and braces.
- **`APUEN` has still never been set on this part.** If bit 3 is not `APUEN` on a Panchip
  die, the likely outcome is that the first erase is refused and `ISPFF` sets, which the
  script catches cleanly. The unlikely outcome is that bit 3 does something else, and
  nothing here would help.
- **Brown-out.** Procedural only, and now known to be silent: BOD is off by default
  (`CONFIG0` bit 23 is 1), so the FMC's documented brown-out fail flag never fires. The
  watchdog is a smaller worry than it looked: the application arms a ~2 s reset watchdog
  but `WDT_CTL[31]` `ICEDEBUG` is clear, so the counter should freeze while ICE holds the
  core (*derived*). `check_halted` is what notices if either reasoning is wrong.
- **A half-written application re-muxing the debug pins.** Nothing in the tool can help;
  it is why the RST lead is now required.
- **Nothing was written to hardware, so none of this is *verified* on silicon.** Every
  number in this document came from the simulator or from the two dumps.

## One experiment worth running before the repair, that nobody has built

**Test the refusal, not just the permission.** With `ISPCON = 0x49` (`APUEN` set,
`CFGUEN` clear), issue `ISPCMD 0x22` at `0x00300000` and check that `ISPFF` sets and the
four config words are unchanged. That is the first direct evidence that the second safety
layer exists at all, rather than being read off a Nuvoton datasheet for a part whose ID
register reads zero.

It is bounded and recoverable **on unit 1 specifically**: its config page currently holds
`CONFIG0 0xFFFFFFFF`, `CONFIG1 0`, `CONFIG2 0`, `CONFIG3 0x0003dbff`, and if the refusal
does not happen the page erases and `fmc-repair-config.sh` already knows how to put
`CONFIG1`-`CONFIG3` back. It is **not** a safe experiment on a healthy unit and it needs
a script of its own, in a separate file, written on the day, per
`research/hardware-access.md`. This is a proposal and it is Jacob's call, not the tool's.

## Track 55's four handoffs, and what each turned into

`research/fmc-erase-program.md` section 8 hands four items to this track. All four are in
files this track owns and all four are done.

**1. Detect an oversized erase after the first erase.** Done, and further: the probe, the
first-erase canary sweep, `verify_last` after every erase, and the final read-back. Track
55's proposal was to read the page **above** the first erase; that is now the probe's
second read-back, and it is the weaker half. An oversized block reaching forwards
destroys pages not yet written, which the run then writes correctly; the harmful
direction is backwards, over a page already programmed, and that is what the page below
and `verify_last` cover.

**2. Notice a mid-run reset.** `check_halted` reads `DHCSR` at `0xE000EDF0` before the
unlock, before every erase, and after the last page, and aborts unless `S_HALT` is set
and `S_RESET_ST` is clear. The simulator grew `--reset-at n` so a test can prove it
fires: with a reset after the first erase the run stops at the next page with 256 words
programmed rather than 19,200. Track 55's stronger suggestion, halting at the reset
vector with `DEMCR` and `SYSRESETREQ` so the application never runs at all, is **not**
done: it changes what the operator's session does before this script is sourced, it
interacts with the boot-select latch, and it belongs in a procedure the person holding
the probe agreed to rather than in a generator.

**3. Chip erase is `0x23`, not `0x26`.** Fixed in all three files this track owns:
`swdflash.ts` (four sites, now `CMD_CHIP_ERASE`), the simulator's abort check, and the
test tripwire. Both guards had been watching a number that is not a command on this part
while the real destroyer went unnamed. What actually protects the run is unchanged and
was never affected: `ISPCMD_VALUES` is a closed set of two, and a test asserts the
generated script writes nothing else to `ISPCMD`. Both the closed set and the correct
number are now asserted.

**4. Read-modify-write `ISPCON`, assert with mask `0x34`, print it as found.** All three.
The script now reads `ISPCON`, echoes it (nobody has ever seen its value on this part),
and writes `(was & BS) | ISPEN | APUEN | ISPFF`, so bit 1 boot select is preserved rather
than decided. The assertion covers `SPUEN` as well as `CFGUEN` and `LDUEN`, and a test
walks all 256 possible found values to prove the mask cannot produce an update-enable
bit. `isp_ok` no longer stores `ISPCON` to clear `ISPFF`: it achieved nothing, since the
run stopped anyway, and it was a second wholesale store to that register. `ISPFF` is now
left set, so a dump taken afterwards still shows the FMC refused something.

**And the claim that was wrong.** The safety argument said layer 2, `CFGUEN` and `LDUEN`
clear, means the hardware refuses the config page and the LDROM. That holds for the
apertures at `0x300000` and `0x100000`. It does **not** hold for the same content at its
main-array addresses, `0x3fe00` and `0x3dc00`, which are inside what `APUEN` enables.
Both the script's banner and the `guard` proc's own comment now say which regions have
two layers and which have one, and the "no hardware backstop" test covers it.

## Two things this could not change, that the procedure must

**The RST lead is required for a write session.** 2026-08-19 established that three wires
are enough, on a running donor, and that is true for a **read** session on a unit whose
application is intact. A half-written application can re-mux P4.6/P4.7 away from ICE
within microseconds of boot (`research/fmc-erase-program.md`), so after a partial write
the unit may steal the SWD pins on every power-up and connect-under-reset becomes the only
way back in. For a write session the lead is not a fallback.

**Read the SPROM first.** `ISPCON` bit 2 `SPUEN` gates the SPROM at `0x00200000`, 512
bytes, which the vendor's `config.h` calls the ID block. Every dump this project holds is
`0x0`-`0x3ffff`, so it has never been read, and it is the best candidate for the "factory
trim, unique ID or RF calibration" that `research/hardware-access.md` warns may live
outside that range. `mdw 0x00200000 128` is read-only and takes seconds. The plan output
now says this, in its own block, above the canary list.

## Owed to whoever owns `notes/swd-flashing.md`

**The section numbers in its "When it fails" table are now stale.** The generated script
has nine sections rather than seven: 5 is the granularity probe, the page loop moved from
5 to 6, the final read-back is a new 7, the closing canary sweep moved from 6 to 8, and
the teardown from 7 to 9. Sections 1, 3 and 4 are unchanged. Three rows want adding: the
probe failing, `verify_last` failing after an erase, and section 7 failing. All three mean
the same thing, and it is not the thing the current table says about a canary: **the erase
block is larger than 512 bytes.** The right response is to stop and re-dump, and
`--resume` is *not* safe until the real granularity is known, because a resume would
repeat the same oversized erase.

Two other edits that file needs and this review could not make: item 2 of "What is still
unproven" should say the probe now tests it rather than that "the first `check_erased`
after the first erase is what would show it" (it would not have; `check_erased` only reads
the page it aimed at), and `script`/`donor` now refuse without `--config0`.

## Where things stand

| Layer | 2026-08-19 | Now |
| --- | --- | --- |
| one window | plan bound plus `guard` in the script | plus page and word alignment assertions, and `guard`'s comment now says which regions it is the only layer for |
| one update-enable bit | `ISPCON := 0x49` stored whole, assertion mask `0x30` | read-modify-write preserving `BS`, printed as found, mask `0x34` including `SPUEN` |
| no chip erase | closed opcode set; every named guard watched `0x26` | closed set unchanged; the named guards say `0x23`, which is the real one |
| erase and program are one operation | one `program_word` call site | unchanged |
| two confirmations | `--yes` plus the CRC token | plus `--config0` required |
| **erase granularity** | **nothing** | **probe, first-erase canary sweep, `verify_last` after every erase, final read-back of the whole window** |
| **the core stayed ours** | **nothing after the initial `halt`** | **`DHCSR` read before the unlock, before every erase, and at the end** |
| teardown | success path only | every exit path, via `lock_down` |
| canaries | 8 words, one of them blind, none within 2 KB of the window | 13 words, each moved to one that can see an erase or labelled `BLIND`, one 136 bytes under the edge |

Cost of all of it on the real repair: one extra page erase and about 39,000 extra word
reads, 115,963 against the previous 77,000. The printed estimate went from about 97,000
transactions with no time attached to about 136,000 and "roughly 5 to 12 minutes at
100 kHz", which is the figure an operator actually needs.

## The verdict, plainly

**Run it.** The thing that made the 2026-08-19 version unsafe to run is gone twice over:
the assumption it rested on is now *verified*, and the script no longer rests on it. The
run has been exercised end to end against the simulator on the real donor and the real
target, lands byte for byte, touches nothing outside `0x16800`-`0x293ff`, and stops after
one page erase under every wrong-block-size and mid-run-reset scenario the model can
produce.

Four things before the probe goes on, none of them this tool's job:

1. **Archive the SPROM.** `mdw 0x00200000 128`, read-only, seconds. It has never been read
   and it is the one region of this part that is plausibly per-unit and unbacked-up.
2. **Wire RST.** For a write session it is required, not a fallback.
3. **Charged battery, `VD` unconnected.** BOD is off by default (`CONFIG0` bit 23), so the
   FMC's brown-out fail flag never fires and a brown-out mid-erase is silent.
4. **Read section 5 of the run's output before section 6 starts.** If the probe passes, the
   512-byte page is *verified* for this die by direct measurement rather than by reading
   somebody else's code, and the rest of the run is the thing the previous review already
   believed it was.

And read the plan, not the script. The plan prints the `device-match` line, the donor and
target diff, the canary list with the moved and blind ones marked, and now the wall clock.
That is where the theory is tested. Section 5 is only where it is confirmed.
