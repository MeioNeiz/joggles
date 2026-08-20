# Hardware state, as of 2026-08-20 (early hours)

A snapshot for a session picking up the hardware cold, at handover from joggles-2c to
joggles-b6 after the donor dump. **This changes as work proceeds; treat it as a point in
time, not a standing truth.**

**Why this file exists:** today produced one provenance mix-up (a RAM capture filed under the
wrong unit because nobody read the advert name inside it). A fresh session is exactly who
falls into the next one. Trust the advert suffix and the filenames below, and if anything
looks off, verify a dump's contents (`strings <file> | grep -o 'GLASSES-[0-9A-F]*'`) rather
than its filename.

## The three pairs, by advert suffix

| Advert | Role | State | On the probe? |
| --- | --- | --- | --- |
| **GLASSES-12C3EF** | **unit 1, REPAIRED** | **working as of 2026-08-20.** The donor's application was written over SWD, 150 pages, verified byte-identical. Advertises, connects, answers as stock. Seen advertising at -57 dBm from the app on 2026-08-20 afternoon. `research/aprom-write-2026-08-20.md` | **Probe REMOVED and the case reassembled**, Jacob, 2026-08-20 afternoon, reversing his own morning decision to leave it on. **Track C now costs a case-opening and a re-clip**, and that is the price of the first write of our own firmware, because a bug in the resident half is probe-only. Nothing of ours was ever flashed. |
| **GLASSES-12E69E** | **the healthy DONOR** | working, untouched. Read-only dumped 2026-08-19; nothing was ever written to it. | No. The probe moved to unit 1 for the repair. |
| **GLASSES-125B37** | older healthy pair | working, not involved in the repair. Was on BLE earlier; Jacob powered it OFF. | No. |

## Why unit 1 WAS dead, in one line

*Corrected 2026-08-20: this section was headed "Why unit 1 is dead". It is repaired.*


Its flash holds an application built from the phone APK, which never registers four callback
slots (`+0x5c`..`+0x68`) the BLE stack dispatches through; the first cold boot branches through
an un-filled pointer and hardfaults. The correct firmware (on 12E69E) DOES register them.
Confirmed four independent ways: `research/hardfault-0xd38-2026-08-19.md`,
`research/image-silicon-match.md`, and `notes/dump-healthy-unit.md` "Outcome".

## The repair, as done (2026-08-20)

**Done.** `research/aprom-write-2026-08-20.md` is the run, the numbers and the three
wrong turns getting it to boot afterwards. The short version of the last one, because it
is the trap: the write script leaves the core HALTED, the button is polled by firmware so
a button power-cycle is a no-op, the core needs `reset run` over SWD, and the unit then
sits switched OFF looking exactly like a brick until a LONG PRESS wakes it.

### The original plan, for reference

Write 12E69E's application region `0x16800`-`0x293ff` onto unit 1 over SWD. The donor image is
the DUMP FILE, not a live read, so the probe goes on unit 1 (the target), not the donor.
Procedure and write tooling: `notes/swd-flashing.md`, `research/tools/swdflash.ts`.

**Do NOT flash `firmware/joggles-v1.bin`.** It is built on the APK image and carries the same
defect; it would brick ANY unit. This prohibition was widened to "any unit" in `CLAUDE.md`
today.

## Files: dumps, backups, what is verified

All in `firmware/` (gitignored) with copies in `~/personal/joggles-dumps-backup/`.

| File | Unit | sha256 | Notes |
| --- | --- | --- | --- |
| `dump-12E69E-2026-08-19-{a,b,c}.bin` | 12E69E donor | `69c85fa6…` | 3x byte-identical. The correct firmware. `-a` backed up. |
| `dump-unit1-2026-08-19-{a,b,c}.bin` | 12C3EF unit 1 | `f6028078…` | 3x byte-identical. The bricked state. `-a` backed up. |
| `ldrom-unit1-2026-08-19.bin` | 12C3EF unit 1 | `412c1931…` | 9216 B bootloader (alias of `0x3dc00`). |
| `sram-12E69E-2026-08-19.bin` | 12E69E | - | a good-boot SRAM capture. **Was misnamed `sram-unit1`**; corrected today. Contains `GLASSES-12E69E` x2. |

## Config, and what was written today

The ONLY flash write to any unit today: unit 1's config page, by joggles-1d via
`research/tools/fmc-repair-config.sh`.

| | Unit 1 (12C3EF) now | Healthy (measured on 12E69E) |
| --- | --- | --- |
| CONFIG0 | `0xFFFFFFFF` (erased) | **`0xFFFFFFBF`** (the normal shipped value) |
| CONFIG1/2/3 | `0` / `0` / `0x0003dbff` | `0` / `0` / `0x0003dbff` |

Unit 1's CONFIG0 is a value no healthy unit holds, and **it is not merely cosmetic.**
`0xFFFFFFBF` is `CBS = 10`, "APROM with IAP mode"; `0xFFFFFFFF` is `CBS = 11`, "APROM
without IAP mode". IAP is in-application programming, i.e. the running application writing
flash, which is exactly and only what the resident updater does, and unit 1 is the Track C
target. Whether `CBS` actually gates application-driven ISP is *derived* to be "no" and is
**not settled**: `research/config0-cbs-2026-08-20.md` has the argument, its limit, and the
two offline steps that settle it without writing anything.

*Corrected 2026-08-20: this paragraph called the difference harmless because both values
boot APROM. Both do boot APROM, and the unit works, but "boots" was the wrong test. The
mode name says the difference is about in-application programming and nobody checked it
against the one feature that needs it.*

**`fmc-repair-config.sh` now does this direction**, rewritten 2026-08-20: precondition
`0xFFFFFFFF`, programs `0xFFFFFFBF`, `CFGUEN` only, and it exits 0 saying "nothing to do"
on a unit already correct. It **refuses without `--cbs-checked`** as well as `--yes`,
because if `CBS` does not gate ISP the write buys nothing and is not free. It is not free
because it is the first `CONFIG0` **program** in this project: `research/fmc-erase-program.md`
calls the `CONFIG0` LOCK bit "the one permanent path" and closed on two legs, `CFGUEN` clear
all session and "an erase cannot drive a bit to 0", and **both legs are gone** when the
operation is a program that needs `CFGUEN`. Two guards on the literal refuse anything but
`0xFFFFFFBF`, and both were checked by trying to defeat them, including with `0xFFFFFF3F`,
the `CBS = 00` boot-LDROM value the application wrote before the brick.

12E69E: read-only today, nothing written. 125B37: BLE only, now off.

## Standing safety, unchanged

- The probe attaches on three wires (`EK`/`ED`/`G`); NO RST lead needed (disproven today on a
  running donor).
- The one board-killer: probe GND on pad 5 `VD`. Pad order `RST EK ED G VD`; ground on the
  black wire, never pad 4 / near VD.
- Power the glasses from their own battery, never the probe.
- Read scripts and write scripts stay in separate files (`research/hardware-access.md`).
