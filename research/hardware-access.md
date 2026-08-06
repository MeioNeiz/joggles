# Physical access: SWD, pads, probes

**Status:** not needed for firmware work. `research/firmware-flashing.md` establishes
that app images can be flashed over BLE with the running application never at risk.
This document exists as insurance and for the two things OTA genuinely cannot do:
dump the BLE stack and the bootloader, and revive a unit whose application no longer
brings up BLE.
**Scope:** what is on the board, where the debug pads are, what to buy, how to dump,
how to restore.
**Cost:** about £12 for a probe. Everything else is a multimeter and patience.

## Verdict

| Question | Answer | Confidence |
| --- | --- | --- |
| Is there a usable debug port? | yes, standard ARM SW-DP over SWD | derived |
| Are the pads broken out, or must we probe the QFN? | broken out, five labelled pads | derived from FCC photos |
| Can we dump 256 KB without vendor tooling? | yes, reads need no flash algorithm | verified from the architecture |
| Can we write flash back without vendor tooling? | yes, but it needs work, see "Restoring" | derived |
| Can the debug port be locked against us? | possibly, and it is testable in one command | unverified |

## What is on the board

There is no published teardown of any product in this family. The only PCB imagery in
existence is in FCC filings by Shenzhen Shining Bright Technology, [fccid.io/2AOLN](https://fccid.io/2AOLN).

| FCC ID | Product | Relevance |
| --- | --- | --- |
| `2AOLNSL-004` | **Funky Glasses** | our generation. [Internal photos](https://fccid.io/2AOLNSL-004/Internal-Photos/Internal-Photos-4549066) |
| `2AOLNSL-012` | Shining Glasses, 2021 | sibling, and its debug header is the legible one |
| `2AOLN-16` | Shining Mask | different, two-chip architecture. Do not transfer its findings |

On the `SL-004` board. *derived* from the photographs; our own unit has not been opened.

| Item | Observation |
| --- | --- |
| SoC | `U2`, QFN32, roughly 5 x 5 mm. Matches the PAN1020 QFN32 package |
| Crystals | two, `Y2` beside the SoC. Reported as 16 MHz plus 32.768 kHz |
| Debug header | five gold-plated through-pads in a row, silkscreened |
| Board marking | `TR1905H012-07`, dated `20191015` |
| Design | single chip driving the matrix directly, PCB antenna |

Only lot and date codes are legible on the SoC (`1932BA...`), never a part number, even
upscaled. The Panchip identification rests on firmware and SDK evidence, not a marking.

### The debug header

**Read the silkscreen on your own board. The pad order differs between revisions.**

| Board | Order, left to right |
| --- | --- |
| `SL-012` (2021) | header marked `DBG1`: `GND`, `RST`, `CLK`, `DAT`, `3V`, with `BLE_ICE` nearby |
| `SL-004` (ours) | `RST`, `CLK`, `DAT`, `G`, `VD` |

The `SL-012` legends are the fully legible ones and settle what the five signals are.
`BLE_ICE` is Panchip's own nomenclature: the datasheet calls the SWD pins `ICE_CLK` and
`ICE_DAT`. So this is a documented, deliberate programming header, not a happy accident,
and nothing needs to be probed blind or tapped off the QFN.

The board number is worth noting for its own sake: the firmware is `TR1906R04` and the
board is `TR1905H012`, so `TR19xx` is the ODM's product-series scheme. It says nothing
about the silicon.

### Correction to the 26 MHz crystal

`README.md` and `firmware-image-format.md` record a 26 MHz crystal, inferred from the
constant `0x018cba80` (26,000,000) in the firmware's tail config block. That constant is
almost certainly the **internal** oscillator and PLL reference: Panchip's SDK sets
`__HIRC` and `__PLL` to 26 MHz while defining the external `__HXT` as 16 MHz, and the
FCC photographs show a 16 MHz part. Treat the external crystal as 16 MHz until someone
reads the marking on our own board. *unverified* either way.

## Pin mapping, if the pads turn out not to match

From the PAN1020 datasheet pin table. *derived*, since the die marking on our unit is
unread.

| Signal | Port | QFN32 | QFN48 | SSOP24 |
| --- | --- | --- | --- | --- |
| `NRESET_PAD` | - | 1 | 2 | 4 |
| `ICE_CLK` (SWCLK) | P4.6 | 3 | 4 | 6 |
| `VDD` | - | 4 | 5 | 7 |
| `ICE_DAT` (SWDIO) | P4.7 | 5 | 6 | 8 |

All four sit on one package corner, so counting from the pin-1 dimple and buzzing
through to the test pads is a five-minute job. Note that P4.6 and P4.7 also mux to
UART1, I2C0 and SPI, so if the application claims them shortly after boot the port
goes dead a few milliseconds in. Connecting with reset asserted avoids that entirely.

## What to buy

| Probe | Cost | Notes |
| --- | --- | --- |
| **Raspberry Pi Debug Probe** | ~£12 | RP2040 running `debugprobe`, buffered, 3.3 V, cables included. The default choice |
| Bare RP2040 board + `blueTag` | ~£4 | Doubles as an SWD pin scanner, then as a CMSIS-DAP adapter |
| Generic CMSIS-DAP / DAPLink clone | ~£5 | Fine, quality varies |
| J-Link EDU | ~£20 | Works via a generic Cortex-M0 device selection. Non-commercial licence |
| **ST-Link clone** | ~£3 | **Avoid.** ST firmware refuses non-ST targets, and OpenOCD's HLA path hides the raw DAP, which is exactly what you need visible here |

**Power the glasses from their own battery.** Wire only SWDIO, SWCLK, GND, and RST if
you can reach it. Probe 3.3 V rails supply a couple of hundred milliamps and the LED
drivers will brown the target out; a brown-out mid-erase is the one failure mode that
corrupts a page. If your probe has a VTREF pin, wire it to target VDD as a *reference*
only. Never power from both the probe and the battery at once.

Keep leads under about 15 cm and start at 100 to 200 kHz. A poor ground return
produces intermittent reads that look exactly like a bad solder joint.

## Dumping

Reading internal flash over SWD is a plain AHB-AP memory read, electrically the same
transaction the CPU issues on a fetch. No vendor flash algorithm is involved, because
flash algorithms exist only for erase and program. *verified* from the architecture.
So an entirely unsupported part dumps fine.

`pan1020.cfg`:

    adapter driver cmsis-dap
    transport select swd
    adapter speed 200

    set _CHIPNAME pan1020
    swd newdap $_CHIPNAME cpu -enable
    dap create $_CHIPNAME.dap -chain-position $_CHIPNAME.cpu
    target create $_CHIPNAME.cpu cortex_m -dap $_CHIPNAME.dap
    $_CHIPNAME.cpu configure -work-area-phys 0x20000000 \
        -work-area-size 0x2000 -work-area-backup 1
    reset_config none separate

Recon first, then the dump:

    openocd -f pan1020.cfg -c "init; dap info; halt; \
      mdw 0xE000ED00; mdw 0x50000000; mdw 0xE000EDF0; shutdown"

    openocd -f pan1020.cfg -c "init; halt; \
      dump_image dump.bin 0x00000000 0x40000; shutdown"

`dump_image` is the read primitive. `flash read_bank` is the one that needs a driver.
Record the DPIDR (expect `0x0bb11477`, the stock Cortex-M0 SW-DP), the CPUID, and the
part ID at `0x50000000`; that last value is what a flash driver would need later.

Dump three times from cold boot and compare. Then check `mdw 0x00100000` (LDROM) and
`mdw 0x00300000` (config) and note whether they fault.

**Validate the dump against what we already have.** Decode
`firmware/TR1906R04-10_OTA.bin` and confirm the plaintext appears verbatim at
`0x16800` in the dump. That simultaneously proves the dump is good and confirms the
flash map, which is far stronger than a vector-table sanity check.

### If the port is locked

The FMC is Nuvoton-derived, so `CONFIG0` very likely carries Nuvoton's LOCK bit. When
locked, SWD still connects and still reports DPIDR and the config words; only the
array reads back as `0xFFFFFFFF`. **So "SWD works" is not evidence the part is
unlocked.** Read a few words of flash and check they are not all-FF. Nuvoton's own
escape hatch is a whole-chip erase, which unlocks the part and destroys the firmware
you wanted, so a locked unit is effectively a dead end for extraction. *unverified*
for this part.

## Restoring

Three routes, easiest first.

**OpenOCD's `numicro` driver, adapted.** Its register map is already exactly right:
`ISPCON 0x5000c000`, `ISPADR/DAT/CMD/TRG` following, `SYS_WRPROT 0x50000100`, unlock
keys `0x59 0x16 0x88`, 512-byte pages for ARMv6-M. The only thing that fails is
`numicro_probe()`, which reads the part ID at `0x50000000` and aborts unless it
matches a hardcoded table. Add one entry with the ID you recorded above, declaring
APROM only, and rebuild. **Before building, delete `ISPCON_CFGUEN` from
`numicro_init_isp()`,** which otherwise sets config-write-enable unconditionally. That
one bit is the difference between a firmware experiment and a permanently locked chip.

**Poke the FMC from OpenOCD TCL.** For a one-off restore this needs no rebuild and
keeps every register access visible. Unlock `SYS_WRPROT` with `0x59/0x16/0x88`, set
`ISPCON` to `ISPEN | APUEN | ISPFF` and explicitly *not* `CFGUEN`, then for each word
write `ISPCMD`, `ISPDAT`, `ISPADR`, trigger `ISPTRG`, poll bit 0, and check `ISPCON`
bit 6 for the fail flag. Commands are `0x00` read, `0x21` program, `0x22` page erase.
Slow, tens of minutes for 256 KB, but auditable.

**A pyOCD FLM flash algorithm.** Most work, worth it only if you end up iterating on
firmware heavily.

### Validation ladder

Never erase anything until this passes, and ideally do it on a second unit:

1. Unlock, then read address `0x0` through the FMC and compare with `mdw 0x0`. Agreement
   confirms the FMC base, the unlock keys, the `ISPCON` bits and the trigger protocol,
   all without a single write.
2. Read a few scattered addresses and diff against the dump.
3. Erase one page near the top of flash that the dump shows is already `0xFF`. Read it
   back: still `0xFF`, fail flag clear.
4. Erase a page that holds data, verify it reads `0xFFFFFFFF`, write it back word by
   word, verify.
5. Only then restore in bulk.

## What can permanently kill it

| Action | Recoverable? |
| --- | --- |
| Writing the `CONFIG0` LOCK bit | only by whole-chip erase, which destroys the firmware |
| Disabling the debug port in config | no |
| Chip erase (`ISPCMD 0x26`) without a dump | no |
| Erasing factory trim, unique ID or RF calibration | no, and it may live outside `0x0`-`0x3ffff` |
| Brown-out mid-erase with `CFGUEN` set | can corrupt config, so possibly not |
| Wrong boot-select in `CONFIG0` | yes, looks dead but SWD still answers |
| Programming a page without erasing first | yes, but the write silently produces wrong data |

The standing rule: **never write a register whose semantics you have not read in a
datasheet or extracted from vendor code.** "It is probably the same as the Nuvoton
one" is a good hypothesis and worth nothing at all when the register is `CONFIG0`.

Keep read scripts and write scripts in separate files, invoked separately, so a flash
write procedure is never loaded during a read session.

## Nobody has done this before

Worth knowing before budgeting time. A survey of every public project on this hardware
family found **no full flash dump of a Panchip unit and no custom firmware flashed to
any device in the family**. Two partial hardware results exist, both on the *other*,
two-chip mask architecture (AT32F415 plus SPI flash), so neither transfers:

- One person reached SWD on an AT32F415 mask and found the application read-protected.
  Their words: disabling the protection wipes the application, and they recovered only
  the bootloader. Their annotated test-point photo album has since been deleted.
- One person dumped the 16 MB `PY25Q128HA` SPI content flash of a mask, which holds
  animation data, not MCU firmware.

The useful reading of the first result is as a warning about the *class* of risk.
Artery's read-protection behaviour says nothing about Panchip's, which nobody has
tested. It does mean that if our part turns out to be locked, "unlock it" and "keep the
firmware" are probably mutually exclusive, so the dump has to come first.

## Genuinely open

- The actual part ID at `0x50000000`, needed for any flash driver entry.
- Whether Panchip kept Nuvoton's `0x59/0x16/0x88` unlock keys. Step 1 of the ladder
  answers this without risk.
- Whether the SWD port needs a vendor knock sequence. The signature is distinctive:
  DPIDR reads correctly but every AP access faults. Some Chinese BLE parts do this,
  Telink most notoriously. If you see it, go looking for an unlock rather than
  resoldering.
- Whether our unit's board matches the FCC photographs above.

## Sources

- [PAN1020 datasheet](https://www.panchip.com/static/upload/file/20191011/1570778962386423.pdf),
  for the pin table and the SWD statement.
- [OpenOCD `numicro` flash driver](https://github.com/openocd-org/openocd/blob/master/src/flash/nor/numicro.c)
  and its [Cortex-M0 SRAM loader](https://github.com/openocd-org/openocd/blob/master/contrib/loaders/flash/numicro/numicro_m0.S).
- [Nuvoton AN0001, code protection](https://www.nuvoton.com/export/resource-files/AN0001_NuMicro_Cortex-M_Code_Protection_EN_V1.00.pdf).
- [g3gg0/flipper-swd_probe](https://github.com/g3gg0/flipper-swd_probe), which records
  DPIDR `0x0bb11477` measured on a PAN1020-based product.
- [Aodrulez/blueTag](https://github.com/Aodrulez/blueTag) and
  [szymonh/SWDscan](https://github.com/szymonh/SWDscan), pin scanners, should the pads
  not match.
