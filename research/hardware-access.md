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

## Our own unit, opened

*verified* on 2026-08-08, on the bricked `GLASSES-12C3EF`. First time this project has
had the board in hand rather than reading FCC photographs, so the rows below outrank
anything *derived* elsewhere in this document.

**The board comes out of the front, not the arms.** One PCB shaped like the whole
glasses front, both lenses and the bridge, with the shutter slots cut into it. The
arms hold the charger daughterboard and the LiPo; a thin wire pair runs through the
hinge, so front and arms cannot simply be pulled apart.

| Ref | What | Confidence |
| --- | --- | --- |
| `U2` | the SoC. QFN32, die marking `25170Da`, flanked by `Y1` and `Y2` | *verified* |
| **`Y1`** | **marked `16.000MHz`** | *verified*, see below |
| `Y2` | second crystal, marking unread. Presumably the 32.768 kHz | *derived* |
| `U3` | 16-pin SOIC alone at the nose bridge, with `C12`, `C13`, `D203` | *verified* it exists |
| `U1` | 5-pin SOT-23 with `R8`/`R9`, `C3`, `C4`, `C9`, `C10`, `C16`. An LDO by shape | *derived* |
| `ANT1` | single round pad near the board end, beside a white JST connector and `R5` | *verified* |
| `V+ G K VD` | 4 plated through-holes in a row at one board end, next to `ANT1` | *verified* |

**The 16 MHz crystal is now settled.** `README.md` and `firmware-image-format.md` record
26 MHz, inferred from the constant `0x018cba80` in the firmware tail config. The
"Correction to the 26 MHz crystal" section below argued that constant is the internal
oscillator and PLL reference while the external part is 16 MHz. **The part on our board
is marked `16.000MHz`.** The correction was right; the original entries are wrong.

**`U3` is probably the LED panel driver.** A lone 16-pin SOIC at the bridge, away from
the SoC, matches `CLAUDE.md`'s "the MCU does not drive the LEDs, the panel is a separate
module on UART1 at 115200". First physical support for that architecture, which until
now rested entirely on the firmware sending 74-byte frames at a UART. *derived*: the
package and position fit, the marking has not been read.

**`V+ G K VD` is not the debug header.** Four pads, and the labels read as power rather
than debug. The SWD header is five pads, `RST CLK DAT G VD`, and it is **not on the
component side**: a full photograph of that face shows only the group above, `ANT1`, the
JST connector and two wired pads at the far end. It is on the **LED side**, which is
where FCC Fig. 5 shows it, among the LED packages.

### The debug header: 2.54 mm, five through-holes, LED side

*verified* on our board, 2026-08-08. **Pitch is 2.54 mm / 0.1", so a standard 6-pin
2.54 mm pogo probe clip fits.**

| Property | Value |
| --- | --- |
| Location | **LED side**, on the long top edge, past the antenna notch, above the top LED row |
| Form | five plated through-holes in a line, right at the board edge |
| Pitch | **2.54 mm** |

**Silkscreen, read off our own board: `RST` `EK` `ED` `C` `VD`.** Not the
`RST CLK DAT G VD` this document previously stated, which came from a low-resolution FCC
image. Interpretation, against the sibling `SL-012` header (`GND RST CLK DAT 3V`):

| Pad | Silkscreen | Reading | Confidence |
| --- | --- | --- | --- |
| 1 | `RST` | reset | certain |
| 2 | `EK` | clock or data | *unverified* which |
| 3 | `ED` | data or clock | *unverified* which |
| 4 | `G` | **ground**. Reads as `C` in photographs; `G` on the board in hand | *derived*, high |
| 5 | `VD` | VDD, 3.3 V | certain |

**The ambiguity is harmless and does not need resolving before connecting.** Swapping
SWCLK and SWDIO cannot damage anything; the port simply fails to enumerate. Wire ground
to pad 4, put `SC` and `SD` on pads 2 and 3 either way round, run `dap info`, and swap
them if nothing answers.

**`VD` is the only pin that must never take a wire.** It is the 3.3 V rail, so probe
ground on it shorts the regulator through the LDO. Ground landing on any *signal* pad
merely pulls it low and costs nothing. So the whole safety rule is: **stay off `VD`**.

**Ground at position 4 is also why a 3-way connector cannot be used directly.** The
probe's order is `SC`, `GND`, `SD`, i.e. ground in the middle, so a rigid block would
need the board to put ground *between* clock and data. Ours puts it after both. Loose
wires are required: jumpers, or crimps popped out of the probe's own housing.

**How it was measured, since photographs failed three times.** Scaling from on-board
references gave 2.3 mm against the JST connector, 1.55 mm against the QFN body and
4.0 mm against the LED spacing. That spread is not the references, it is that pixel
estimates on a foreshortened hand-held board are worthless at this scale. Do not trust
photogrammetry for pitch.

What worked was a physical comparison in the hand, against a **USB-A plug**, whose metal
shell is 12.00 mm wide to spec and which everyone already owns:

| Pitch | Span across 5 pads | Fraction of a USB-A shell |
| --- | --- | --- |
| **2.54 mm** | **10.16 mm** | **85%** |
| 2.0 mm | 8.00 mm | 67% |
| 1.27 mm | 5.08 mm | 42% |

Observed: 80-90%. The candidates are far enough apart that an eyeball call separates
them, which a photograph could not. Use this method next time.

**The `V+ G K VD` group is not this header.** Four pads, at the board end beside `ANT1`,
visible from both faces because they are also through-holes. FCC Fig. 5 shows both
groups at once, which is what made them easy to conflate.

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

### Read directly off the FCC internal photos

The internal-photos exhibit is 8 figures and fetches as a PDF:

    https://fccid.io/2AOLNSL-004/Internal-Photos/Internal-Photos-4549066.pdf

**Fig. 5 is the debug header** and settles two things *verified* from the image:

- **They are plated through-holes, not flat pads.** Five gold rings in a row, each with
  its own silkscreen label, `VD` legible at the right end and `RST` at the left. So a
  pogo clip is physically viable and soldering is not forced.
- **The header sits at the top edge of the board**, beside the antenna cutout, with
  nothing tall around it. Comfortably inside a probe clip's 25 mm reach.

**The pitch is still not measured.** Fig. 5 carries no ruler, and the board-level shots
that do (Fig. 2, Fig. 3) are too low-resolution to measure a 10 mm span. *derived*, it
leans 2.54 mm: the board is ~145 mm wide in Fig. 3 and the pad row reads as roughly
10 mm of it, and legible per-pad silkscreen does not fit beside 1.27 mm holes. Confirm
on the physical board before buying a clip. Five pads have four gaps, so 2.54 mm spans
10.2 mm end to end and 1.27 mm spans 5.1 mm; holding the row against any 0.1" header or
a breadboard is more reliable than a ruler on something this small.

Other figures worth knowing: Fig. 4 is the QFN32 SoC with both crystals, Fig. 5 also
shows a separate 4-pad group at the left edge (`V+`, `G`, ..., `VD`) for the charger
daughterboard, Fig. 6 and 7 are that daughterboard with its micro-USB, and Fig. 8 is
the LiPo, a soft pouch cell. Lever nowhere near it when opening the case.

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

Prices confirmed August 2026.

| Probe | Cost | Notes |
| --- | --- | --- |
| **Raspberry Pi Debug Probe** | £11.50 at The Pi Hut, in stock | RP2040 running `debugprobe`, buffered, 3.3 V, cables included. The default choice. Ships micro-USB, JST-SH to JST-SH, JST-SH to male jumper, JST-SH to female header. **No RESET pin**, see below |
| Bare RP2040 board + `blueTag` | ~£4 | Doubles as an SWD pin scanner, then as a CMSIS-DAP adapter |
| Generic CMSIS-DAP / DAPLink clone | ~£5 | Fine, quality varies |
| J-Link EDU | ~£20 | Works via a generic Cortex-M0 device selection. Non-commercial licence |
| **ST-Link clone** | ~£3 | **Avoid.** ST firmware refuses non-ST targets, and OpenOCD's HLA path hides the raw DAP, which is exactly what you need visible here |

**The Raspberry Pi 3-pin debug connector carries no RESET.** *verified* from
`RP-003139-SP-4`, the connector specification: pin 1 `SC` (clock), pin 2 `GND`, pin 3
`SD` (bidirectional data), 1.0 mm pitch JST-SH, host at 3.3 V. So the Debug Probe gives
SWCLK, SWDIO and ground and nothing else, and "connect with reset asserted" needs RST
pulled to ground by hand, with a flying lead or a button. That is enough, because
holding reset only has to survive the moment of attach.

For a **dead** target this does not arise: nothing is running to steal the pins. It
matters again once the unit boots its application, because P4.6 and P4.7 mux to UART1,
I2C0 and SPI, and the port goes dead a few milliseconds after boot if the app claims
them.

### Do not solder for a one-shot repair

The config-page repair in `brick-2026-08-08.md` needs about two minutes of contact:
attach, read, erase one page, read back, reset. Soldering flying leads for that is the
wrong tool, and they would have to come off again before the case closes.

**Adafruit Pogo Pin Probe Clip, 6 pins at 2.54 mm**, about £6 at The Pi Hut. An
alligator clip with six spring-loaded pins in a row, made for exactly this: it presses
into 0.1" pad holes, holds itself, modifies nothing and cannot lift a pad. Five pads in
a row fit a 6-pin clip.

**Confirmed on our own board: five through-holes at 2.54 mm, on the LED side, at the
board edge.** See "The debug header" above. So the standard 6-pin 2.54 mm clip is the
right part, and no soldering is needed for the repair.

**Power the glasses from their own battery.** Wire only SWDIO, SWCLK, GND, and RST if
you can reach it. Probe 3.3 V rails supply a couple of hundred milliamps and the LED
drivers will brown the target out; a brown-out mid-erase is the one failure mode that
corrupts a page. If your probe has a VTREF pin, wire it to target VDD as a *reference*
only. Never power from both the probe and the battery at once.

Keep leads under about 15 cm and start at 100 to 200 kHz. A poor ground return
produces intermittent reads that look exactly like a bad solder joint.

## Connecting the probe to the laptop

The Debug Probe is a USB device. Nothing exotic, and nothing to install on macOS beyond
OpenOCD itself.

| Step | What |
| --- | --- |
| Probe to laptop | the bundled **micro-USB** cable. The probe is bus-powered |
| What the Mac sees | a **CMSIS-DAP** device over USB HID, so no driver and no kext. It also enumerates a USB serial port, which is the probe's UART side and is not used here |
| Probe to glasses | the bundled **JST-SH 3-pin to 0.1" male** lead, then **female-to-female jumpers** to the clip. See below; they are not optional |
| Host software | `brew install open-ocd` (formula is `open-ocd`, binary is `openocd`) |
| Target config | `research/tools/pan1020.cfg`, already written |

The probe ships three leads, not two: JST-SH to JST-SH, JST-SH to 0.1" **female**, and
JST-SH to 0.1" **male**.

### The clip does not plug into the probe, and buying one without jumpers is a wasted order

**The pogo clip terminates in male pins.** Adafruit: "the pogos are then extended up
into a 1x6 0.1" header for everyday socket header cables to plug into". No cables are
included with it.

Even the probe's female lead does not solve it, because the pin orders disagree:

| | Order |
| --- | --- |
| Probe's 3-pin connector | `SC` (clock), `GND`, `SD` (data) |
| Clip pins, mirroring the board | `RST`, `CLK`, `DAT`, `G`, `VD` |

The probe's `GND` must reach the clip's **4th** pin while `SC` and `SD` reach the 2nd and
3rd. A fixed 3-way housing cannot make that mapping at any rotation.

**So: the probe's male lead, plus a pack of female-to-female jumpers**, bridging each
signal individually. That also provides the fourth lead for `RST`, which nothing else
supplies. 100 mm is the right length; the "keep leads under about 15 cm" rule below is
what rules out the 300 mm packs.

The probe's 3-pin connector carries **no RESET**. `RST` gets its own wire, shorted to
ground by hand when needed. `VD` stays unconnected and the glasses run on their battery.

First command, which touches nothing:

    openocd -f research/tools/pan1020.cfg -c "init; dap info; shutdown"

A DPIDR of `0x0bb11477` is the stock Cortex-M0 SW-DP and means the port is alive.

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
