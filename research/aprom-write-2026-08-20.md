# The first APROM write on this family, and the repair of GLASSES-12C3EF

**Confidence markers are `research/README.md`'s three**: *verified*, *derived*,
*unverified*.

## Verdict

**`GLASSES-12C3EF` is repaired.** Dead since 2026-08-08, when an OTA commit installed the
vendor APK's application over it. On 2026-08-20 the healthy `GLASSES-12E69E`'s application
region was written onto it over SWD, 150 pages of it, and the unit now boots, responds to
its button, advertises and accepts a BLE connection. *verified*, end to end.

    *** GLASSES-12C3EF  rssi -54  advert 5452003a0c ***

    bun cli probe ->  name      GLASSES-12C3EF
                      firmware  stock: no answer to HELLO

"No answer to `HELLO`" is the **correct** result and not a partial one: unit 1 now runs a
stock application with no `JGX1` extension, and silence to the `J` opcode is the
documented way a stock unit answers. What matters is that it advertised, accepted a GATT
connection, and answered as stock.

**This was also the first erase or program ever aimed at the application region on this
part, by anyone.** Six things became *verified* that were not:

| Claim | Was | Now |
| --- | --- | --- |
| `APUEN` unlocks APROM the way `CFGUEN` unlocked the config page | never driven | *verified* |
| `ISPCMD 0x22` / `0x21` against APROM | only ever against the config page | *verified* |
| 512-byte APROM erase granularity | *derived* from `section_cfg.h` and OpenOCD | *verified* by probe |
| the part tolerates a long write session | *unverified*, nothing near this size | *verified*, ~136,000 transactions |
| a flashed unit boots | *unverified* | *verified*, for a donor image |
| the 2026-08-08 root cause | *derived* from static analysis | *verified* by fixing it |

## The numbers

*verified* from the run logs.

| | |
| --- | --- |
| destination | `0x16800`-`0x29400`, the whole application window |
| pages | 150 written, 0 blank, 0 skipped on the first pass |
| words programmed | 19,200 |
| page erases | 151 on the first pass, one being the granularity probe |
| register transactions | about 136,000 |
| wall time | 10 minutes for 121 pages, so ~5 s/page and ~12.5 min for 150 at 100 kHz |
| `ISPCON` bit 6, the fail flag | never set, in either session |
| read-back mismatches | none |
| canary changes | none |

**It is all wire time.** The flash itself is under two seconds of that; the rest is
OpenOCD round trips. The transaction count rose from the ~97,000 an earlier plan quoted,
because `verify_last` now re-reads a page after every erase.

## It took two sessions, and the interruption was not the device

**The first run was killed at page 121 of 150 by a 10-minute timeout in the harness
driving OpenOCD.** SIGTERM, exit 143. No stop condition fired: no `FAILED`, no `ISPFF`, no
read-back mismatch, no port drop, and the elapsed time was inside the plan's own 5 to 12
minute estimate. **Give this a timeout well past 15 minutes, or run it detached.**

The state a re-dump found afterwards is exactly the resumable shape the tool is designed
around, and is worth recording because it is what a real interruption looks like:

| | |
| --- | --- |
| pages already matching the donor | 140 of 150 |
| of which written in that session | 121 |
| of which already matching beforehand | 20, the tail at `0x26c00`-`0x293ff` |
| matching neither donor nor old image | 1, `0x25800`, the page interrupted mid-write |
| still the old image | 9 |
| BLE stack bytes changed | 0 |

`--resume` then planned 10 writes and 140 read-back verifications, about 27,551
transactions, and completed in a little over two minutes with all 150 pages read back
again. **Do not resume if the granularity probe or `verify_last` has fired**; there,
resuming walks the same damage across the window a second time. Everywhere else it is the
right move, and neither had fired here.

## The granularity probe, which is the part worth copying

512-byte page granularity was the last load-bearing *derived* assumption, and the tool
tests it rather than trusting it. **One page is erased before any other, and then the
whole of its predecessor is read back.** It passed in both sessions, at `0x18200` and
`0x25e00`.

The probe page is chosen so that a block of up to 32,768 bytes could not leave the window,
and so that every block size from 1 KB up contains the page being read back. Both are
necessary for a pass to mean anything.

**The dangerous direction is backwards, not forwards**, and an earlier draft of
`notes/swd-flashing.md` had it the wrong way round by suggesting the page *after* the
erased one. `0x16800` is 2 KB aligned but **not** 4 KB aligned, so:

| Block | First-page block starts | BLE stack lost | Erasing page 1 wipes page 0 |
| --- | --- | --- | --- |
| 512 B | `0x16800` | 0 | no |
| 1 KB | `0x16800` | 0 | **yes** |
| 2 KB | `0x16800` | 0 | **yes** |
| 4 KB | `0x16000` | 2,048 | **yes** |
| 8 KB | `0x16000` | 2,048 | **yes** |
| 16 KB | `0x14000` | 10,240 | **yes** |
| 32 KB | `0x10000` | 26,624 | **yes** |

A 1 KB or 2 KB block destroys previously written pages while touching **nothing** outside
the window, so a below-window canary sweep alone cannot see it. Reading the predecessor
catches every case. The full argument is in
`research/variant-mismatch-2026-08-19.md`, "For track 54".

## Getting it to actually run afterwards, which took three wrong turns

**This is the part most likely to waste someone's evening, and none of it was in the
procedure.** *verified* 2026-08-20, by walking into all three.

1. **The write script halts the core and never resumes it.** After the write the CPU is
   still halted wherever it was, and the new firmware has never executed. Reading the
   register state at this point is misleading: `ICSR` showed `VECTACTIVE 3`, HardFault,
   which looks like the new firmware faulting and is actually the *old* halt state
   persisting. The tells are that OpenOCD prints no "halted due to debug-request"
   transition, `get_reg` returns all zeros, and `DHCSR` already has `C_HALT` set.
2. **"Power-cycle from the unit's own button" is a no-op here**, and the procedure said to
   do it. The button is **polled by firmware** (`CLAUDE.md`), so a halted or hardfaulted
   unit cannot act on a press. The core must be reset over SWD instead, which writes no
   flash:

       openocd -f research/tools/pan1020.cfg -c "init; reset run; shutdown"

   `ICSR` at `0xE000ED04` is how you confirm it: `VECTACTIVE` 3 is HardFault, 0 is Thread
   mode. On unit 1 it went `0x0041c003` to `0x00400000`, and `DHCSR` `0x00030003` to
   `0x01000001` with `S_HALT` clear. **That transition is the moment the repair worked.**
3. **A repaired unit then sits switched OFF and looks exactly like a brick.** Dark panel,
   no advertising, **and SWD stops answering** with "Error connecting DP: cannot read
   IDR", because the MCU is asleep. `research/brick-2026-08-08.md` describes the brick as
   "powered, charging, no radio, no LEDs, no button", which is the same picture. **A long
   press switches it on**, and then it advertises immediately.

**The red charge LED tells you nothing either way.** `research/firmware-flashing.md`
records that it is driven by the charger IC and not the MCU. The discriminator between a
repaired-but-off unit and a brick is **the button**: the bricked unit never responded to
it, a repaired one does.

**"Cannot read IDR" was not the running application claiming the ICE pins.** That theory
is in `research/hardware-access.md` and was already recorded as disproven on `12E69E`,
which attached on three wires while rendering. This evening did not resurrect it: the
cause was a sleeping MCU.

## What the write did not touch

*verified*, by comparing the post-write and post-power-cycle dumps against the pre-write
ones.

| Region | Bytes changed by the write |
| --- | --- |
| BLE stack `0x0`-`0x16800` | 0 |
| application window | all 76,800, to the donor's, as intended |
| everything above `0x29400` | 0 |

**One byte above the window differs from the 2026-08-19 dumps, and it is not ours.**
`0x3fe00` went `0xbf` to `0xff`. That address is the **config page's main-array
address**, an alias of the aperture at `0x00300000`, and the change is this morning's
config repair by another session: the pre-write dumps were taken at 20:23, before that
repair, so they still hold `0xbf`. Comparing the after-dump against the mid-write dump
gives 0 bytes differing above the window, which is the clean statement. Two consequences:

- **`0x00300000` and `0x3fe00` are *verified* aliases**, which the tool's own section 4
  comment asserts and which this confirms from the bytes.
- **A run using a pre-repair dump as `--to` will see that byte as a spurious diff.** It is
  not a canary address, so it does not abort anything, but it will look alarming.

## Artefacts

All in `firmware/`, which is gitignored, with copies in
`~/personal/joggles-dumps-backup/`. **Do not delete any of them.**

| File | What |
| --- | --- |
| `dump-12E69E-2026-08-19-{a,b,c}.bin` | the donor, 3x byte-identical, sha256 `69c85fa6…` |
| `dump-unit1-2026-08-19-{a,b,c}.bin` | unit 1 as it was bricked, sha256 `f6028078…` |
| `dump-unit1-2026-08-20-partial.bin` | after the interrupted first pass, 121/150 |
| `dump-unit1-2026-08-20-after.bin` | after the resume, before the power cycle |
| `dump-unit1-2026-08-20-postcycle.bin` | after the power cycle. Verifies against the donor |
| `sprom-unit1-2026-08-20.bin` | the SPROM at `0x00200000`, 512 bytes |
| `swdflash-donor-dump-12E69E-2026-08-19-a.tcl` | the generated script, first pass |
| `swdflash-resume.tcl` | the `--resume` script that finished it |

**The SPROM reads all zeros.** *verified* that the read succeeded; **not** established
that the SPROM is empty, because the aperture may not read without `SPUEN`, which stays
clear all session by design. Nobody has read the **donor's** SPROM, so if RF trim lives
there we cannot currently tell whether all-zero is normal. Open, and it needs the probe
back on `12E69E`.

## Open

- **`joggles-v1.bin` is still barred and still unrun.** What is *verified* here is that a
  **donor** image boots. `firmware/joggles-v1.bin` is built on the APK application and
  `CLAUDE.md` bars it from every unit; nothing in this run touches that.
- **`--blank-tail` remains unproven on a real unit** and the repair did not use it.
- **Re-locking `SYS_WRPROT` by writing `0x00`** is still *derived*. The simulator reports
  the session leaving it locked; nothing read the register back on hardware.
- **Whether unit 1 renders correctly** is unwitnessed. It advertises and connects; nobody
  has driven the panel and looked at it.
