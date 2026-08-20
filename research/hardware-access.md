# Physical access: SWD, pads, probes

**Status: this is the delivery route for firmware, and it has now carried a repair.**
*verified* 2026-08-20: SWD erased and programmed all 150 pages of the application region
on `GLASSES-12C3EF` and brought it back from twelve days dead
(`research/aprom-write-2026-08-20.md`). OTA staging is safe and committing stays barred,
so SWD remains the only way any image reaches a device, and it is the only route to the
things OTA could never do: dump the BLE stack and the bootloader, and revive a unit whose
application no longer brings up BLE. **It has now done the last of those for real.**

*Corrected 2026-08-20: this said SWD was "the only way to repair the bricked
GLASSES-12C3EF", present tense. It did repair it.*
**Scope:** what is on the board, where the debug pads are, what to buy, how to dump,
how to restore.
**Cost:** about £12 for a probe. Everything else is a multimeter and patience.

*Corrected: the status above said SWD was "not needed for firmware work" and that this
document "exists as insurance", on the strength of `research/firmware-flashing.md` showing
that BLE flashing never risks the running application. Staging never did; the commit
handoff bricked a unit on 2026-08-08. The position is now the reverse of what was written.*

## Verdict

| Question | Answer | Confidence |
| --- | --- | --- |
| Is there a usable debug port? | yes, standard ARM SW-DP over SWD. DPIDR `0x0bb11477`, Cortex-M0 r0p0 | ***verified* on our board, 2026-08-19** |
| Are the pads broken out, or must we probe the QFN? | broken out, five labelled pads | *verified* on our board, 2026-08-08 |
| Can we dump 256 KB without vendor tooling? | **yes. Done.** 23 seconds at 200 kHz, three times byte-identical | ***verified* 2026-08-19** |
| Can we write flash back without vendor tooling? | **yes. Done, including the application region.** The config page 2026-08-19, then all 150 pages of APROM on 2026-08-20, which repaired a dead unit; the `numicro` route stays closed. See "Restoring" | ***verified* 2026-08-20** |
| Can the debug port be locked against us? | **no, not on this unit.** 256 KB read back as real content | ***verified* 2026-08-19** |

**The first flash dump of a Panchip unit that exists** was taken on 2026-08-19 from the
bricked `GLASSES-12C3EF`: `firmware/dump-unit1-2026-08-19-{a,b,c}.bin`, gitignored, plus
`firmware/ldrom-unit1-2026-08-19.bin`. It validates against the vendor's own OTA
plaintext byte for byte at `0x16800`, so the dump and the flash map are confirmed by the
same comparison. What it showed about the brick is in `research/brick-2026-08-08.md`,
"What SWD actually found".

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
than debug. The SWD header is five pads, `RST EK ED G VD`, and it is **not on the
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

**Check the alignment before powering the glasses: the clip is 6 pins against 5 pads, so
it can sit one position out, and slipping one way puts the probe's `GND` on `VD`**, which
shorts the 3.3 V rail to ground through the LDO. Every other misalignment merely fails to
connect and is harmless, so this is the single misplacement that damages hardware. Clip
on, eyeball pin 1 against `RST`, then switch on.

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

On the `SL-004` board, *derived* from the photographs. **Superseded by "Our own unit,
opened" above**, which is the board in hand and outranks every row here; kept as the
record of what the FCC exhibit actually shows. *This line previously said our own unit
had not been opened. It was opened on 2026-08-08.*

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
| `SL-004` (ours) | `RST`, `EK`, `ED`, `C`/`G`, `VD`, read off the board in hand |

*Corrected: the `SL-004` row said `RST`, `CLK`, `DAT`, `G`, `VD`. That was read off a
low-resolution FCC image and is wrong. Our board is silkscreened `EK` and `ED`, which are
Panchip's `ICE_CLK` and `ICE_DAT` abbreviated, and pad 4 reads as `C` in photographs but
`G` in the hand. The old row is the reading that puts a probe on the wrong pad, so the
board-in-hand reading in "The debug header: 2.54 mm, five through-holes, LED side" is the
one to wire from.*

### Read directly off the FCC internal photos

The internal-photos exhibit is 8 figures and fetches as a PDF:

    https://fccid.io/2AOLNSL-004/Internal-Photos/Internal-Photos-4549066.pdf

**Fig. 5 is the debug header** and settles two things *verified* from the image:

- **They are plated through-holes, not flat pads.** Five gold rings in a row, each with
  its own silkscreen label, `VD` legible at the right end and `RST` at the left. So a
  pogo clip is physically viable and soldering is not forced.
- **The header sits at the top edge of the board**, beside the antenna cutout, with
  nothing tall around it. Comfortably inside a probe clip's 25 mm reach.

**The pitch is not measurable from any figure. Superseded: it is 2.54 mm**, *verified*
2026-08-08 against a USB-A shell, see "The debug header: 2.54 mm, five through-holes, LED
side" above. Kept as a line rather than deleted because three attempts to scale it from
these photographs returned 2.3 mm, 1.55 mm and 4.0 mm, and that spread is the lesson: do
not trust photogrammetry for pitch.

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

**Settled: the external crystal is 16 MHz.** `Y1` on our own board is marked
`16.000MHz`, *verified* 2026-08-08, so the 26 MHz in `README.md` and
`firmware-image-format.md` is wrong and `0x018cba80` (26,000,000) in the firmware's tail
config is the internal oscillator and PLL reference, exactly as Panchip's SDK sets
`__HIRC` and `__PLL` to 26 MHz while defining the external `__HXT` as 16 MHz. *This
section previously said to treat it as 16 MHz "until someone reads the marking on our own
board" and marked the whole question `unverified` either way. Somebody read it.*

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
| Clip pins, mirroring the board | `RST`, `EK`, `ED`, `G`, `VD`, and a 6th that overhangs |

The probe's `GND` must reach the clip's **4th** pin while `SC` and `SD` reach the 2nd and
3rd. A fixed 3-way housing cannot make that mapping at any rotation.

**So: the probe's male lead, plus a pack of female-to-female jumpers**, bridging each
signal individually. That also provides the fourth lead for `RST`, which nothing else
supplies. 100 mm is the right length; the "keep leads under about 15 cm" rule below is
what rules out the 300 mm packs.

The probe's 3-pin connector carries **no RESET**. `RST` gets its own wire, shorted to
ground by hand when needed. `VD` stays unconnected and the glasses run on their battery.

### The wiring that actually worked

*verified* 2026-08-19, first attempt, on the Raspberry Pi Debug Probe.

| Probe wire | Board pad | |
| --- | --- | --- |
| **orange** | 2 `EK` | |
| **black** | 4 `G` | ground |
| **yellow** | 3 `ED` | |
| nothing | 1 `RST` | not needed on a unit that is not running an application |
| nothing | 5 `VD` | never |

**Do not wire by colour alone, wire by position: the middle wire is ground.** That is
fixed by `RP-003139-SP-4` (`SC | GND | SD`) and holds whatever colours a given cable
batch uses. Orange as `SC` and yellow as `SD` is Raspberry Pi's convention, and it
matched the board's own naming, `EK` for `ICE_CLK` and `ED` for `ICE_DAT`.

**Getting `SC` and `SD` the wrong way round is free.** Two combinations, both
electrically harmless, and the wrong one simply fails to enumerate. Try one, swap if
`dap info` is silent. Nothing about a silent port means a dead chip until both orders
have been tried.

**Use the `D` socket, not `U`.** The probe has two identical 3-pin JST-SH sockets. `D` is
debug, `U` is the probe's UART side and is unrelated. Plugged into `U`, the symptom is
indistinguishable from a dead target.

**No `RST` lead was needed.** The theory says P4.6 and P4.7 mux to UART1 a few
milliseconds after boot, so a live unit can steal the pins. On the bricked unit the
application hardfaults early and never claims them, and the port stayed up indefinitely.
Expect to need `RST` on the healthy unit 2 and not on unit 1.

First command, which touches nothing:

    openocd -f research/tools/pan1020.cfg -c "init; dap info; shutdown"

A DPIDR of `0x0bb11477` is the stock Cortex-M0 SW-DP and means the port is alive.

### The whole procedure, start to finish, as actually run on unit 1

*verified* 2026-08-19. A cold reader can repeat this. Every step below was done and none
surprised us except where noted.

1. Clip the 6-pin 2.54 mm pogo clip onto the LED-side header. **Eyeball pin 1 against the
   `RST` silkscreen before powering the glasses.** The clip is 6 pins over 5 pads, so it
   can sit one position out, and the slip that lands probe `GND` on `VD` is the one mistake
   that damages the board. Every other misalignment merely fails to enumerate.
2. Wire `EK` (pad 2), `ED` (pad 3), `G` (pad 4). Middle probe wire is ground, by position
   not colour. Leave `RST` (pad 1) and `VD` (pad 5) unconnected. Probe in the `D` socket.
3. Power the glasses from their own battery. Never from the probe.
4. `./research/tools/swd-recon.sh probe`. Healthy response: `SWD DPIDR 0x0bb11477` and
   `Cortex-M0 r0p0 processor detected`. Silence is ambiguous between a bad rig and a dead
   chip, so swap `EK`/`ED` and retry before concluding anything.
5. Read-only diagnostics and the dump: `swd-recon.sh diag`, then `swd-recon.sh dump`.
   Details under "Dumping" below.

**A soft reset is not a real reset for this fault.** *verified* 2026-08-19: after the
config repair, a `SYSRESETREQ` (`mww 0xE000ED0C 0x05FA0004`) left the CPU hardfaulting at
the identical `pc`, because boot-select config latches at **power-on reset**, not on a soft
reset. With no `RST` lead wired, the probe cannot drive a hardware reset either. **The only
test that re-latches `CONFIG0` is a physical battery power cycle by hand**, full off for a
couple of seconds then on. Budget for asking a human to do it; the probe cannot.

**Dumping a healthy unit is NOT harder: a running unit does not steal the SWD pins.**
*verified* 2026-08-19 on `GLASSES-12E69E`, which was actively rendering "MY BROTHER RAFF"
to its panel when the probe went on. Three wires (`EK`/`ED`/`G`, no `RST`) and
`swd-recon.sh probe` returned `DPIDR 0x0bb11477` and detected the core on the **first
attempt**; a following session halted it, read `CONFIG0` and took three byte-identical
256 KB dumps with the port stable throughout. **Connect-under-reset was not needed**, so the
fourth `RST` wire is a fallback, not a prerequisite.

*Corrected 2026-08-19: this section previously claimed, *derived* and not yet run, that "a
healthy unit runs its application, and P4.6/P4.7 mux to UART1 a few milliseconds after boot,
so the port can die at the physical layer once the app claims the ICE pins", and that a
`RST` line held low during attach was required to catch one. That claim shaped the whole
plan all evening and it is **disproven**: a running, rendering unit kept the ICE pins and
SWD enumerated on three wires first try. Whether the app ever remaps those pins under some
other condition is unknown, but it does not do so in normal operation on this family. The
`RST` fallback, if a healthy unit ever does refuse the port: a fourth wire from pad 1 to the
probe's black ground wire, held low during attach, released once halted, kept off pad 5
`VD`.*

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

**Take three dumps from cold and compare them before believing any of them.** A flaky rig
produces repeat reads that disagree, and that failure looks exactly like a device changing
underneath you, which is the most expensive way to misread a dump. `swd-recon.sh dump
<out>` each time, then `bun run dumpcheck compare <a> <b> <c>`.

**Done 2026-08-19, with one honest gap: the three dumps were back-to-back, not from
cold.** 262144 bytes in 22.9 s at 200 kHz, 11.2 KiB/s, and all three hashed identically
to `f6028078…`. The byte-exact match against the vendor OTA plaintext is a stronger check
than the repeat comparison anyway, so the rig is proven; but power-cycling between reads
is what the rule asks for and it has not been done.

**`mdw` output disappears behind a pipe.** OpenOCD's command results and its `Info :`
stream interleave badly, and piping to `grep` or `tail` silently swallowed every `mdw`
value in the first three sessions. It reads exactly like an intermittent target. Put
`-c "echo {--- marker ---}"` between reads and redirect to a file rather than piping.
This wasted twenty minutes and is not a hardware problem.

**The LDROM aperture is an alias, so a 256 KB dump already contains it.** A 9216-byte
read at `0x00100000` is byte-identical to `0x0003dc00` in the main dump. *verified*
2026-08-19. The config aperture at `0x00300000` is genuinely separate and still has to be
read with `mdw`.

Then check `mdw 0x00100000` (LDROM) and `mdw 0x00300000` (config) and note whether they
fault.

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
you wanted. *unverified* for this part.

*Corrected 2026-08-20, track 56: this said a locked unit is "effectively a dead end for
extraction". That is true of an **AHB** read and not of an ISP read. Nuvoton states it
plainly, M051 TRM Rev 1.03 p.150: "ISP can read data anywhere regardless of LOCK bit
value." So `ISPCMD 0x00` through the FMC should still return real content on a locked
unit, word by word from a halted core, and that path is already validated here by
`research/tools/fmc-ladder1.sh`. What a locked part does refuse is the erase, via the
late-generation `ISPFF` condition "Page Erase command at LOCK mode with ICE connection";
reads are not in that list. Still *unverified* on this silicon, and one comparison of
`mdw 0x0` against an `ISPCMD 0x00` read settles it. Detail in
`research/numicro-fmc-upstream.md` section 9, and `research/fmc-erase-program.md`
section 7.7.*

## Restoring

Three routes, easiest first.

**OpenOCD's `numicro` driver, adapted. Blocked, see below.** Its register map is already
exactly right: `ISPCON 0x5000c000`, `ISPADR/DAT/CMD/TRG` following,
`SYS_WRPROT 0x50000100`, unlock keys `0x59 0x16 0x88`, and a 512-byte page. The
only thing that fails is `numicro_probe()`, which reads the part ID at `0x50000000` and
aborts unless it matches a hardcoded table.

*Corrected 2026-08-20, track 56: this said "512-byte pages for ARMv6-M", as though the
driver knew this part. It does not. `numicro_get_arm_arch()` picks 512 for any ARMv6-M
core and 2048 for anything else, with no per-part table, and that rule is wrong for at
least NUC126, NUC1262, NUC029xGE and M031 built with `PAGE_SIZE_2048`. Nuvoton's own
OpenOCD fork replaces it with a part-ID list. The reason to believe 512 here is the three
witnesses in `research/fmc-erase-program.md` section 1, not this driver. Two further
things to fix before building it, beyond the `CFGUEN` deletion below: `numicro_erase()`
and `numicro_write()` clear `ISPFF` and then return `ERROR_OK` anyway, so a failed erase
is never reported; and `numicro_init_isp()` writes 1 to the undocumented `0x5000c01c`,
which Nuvoton's own fork skips for parts that have an SPROM, and this part has one.
`research/numicro-fmc-upstream.md` section 3.* Add one entry with the ID you recorded above,
declaring APROM only, and rebuild. **Before building, delete `ISPCON_CFGUEN` from
`numicro_init_isp()`,** which otherwise sets config-write-enable unconditionally. That
one bit is the difference between a firmware experiment and a permanently locked chip.

**The part ID at `0x50000000` reads `0x00000000`.** *verified* 2026-08-19, with the core
halted. So there is no ID to add to the table, and adding a zero entry would match any
part that fails to answer. **This route is closed unless the real `PDID` lives at some
other address**, which nothing has established. Panchip evidently did not keep Nuvoton's
`PDID` register, or did not populate it.

**That leaves the TCL-poke route as the only way to write flash**, which is the next
entry. It is also the better one for a single repair, and its register sequence is
*verified* from the vendor firmware's own code rather than assumed from Nuvoton's:
`research/brick-2026-08-08.md`, end of "Recovery plan".

**Poke the FMC from OpenOCD TCL.** For a one-off restore this needs no rebuild and
keeps every register access visible. Unlock `SYS_WRPROT` with `0x59/0x16/0x88`, set
`ISPCON` to `ISPEN | APUEN | ISPFF` and explicitly *not* `CFGUEN`, then for each word
write `ISPCMD`, `ISPDAT`, `ISPADR`, trigger `ISPTRG`, poll bit 0, and check `ISPCON`
bit 6 for the fail flag. Commands are `0x00` read, `0x21` program, `0x22` page erase.
Slow, tens of minutes for 256 KB, but auditable.

### The FMC write path, driven for the first time, 2026-08-19

**This is the first flash write on any Panchip unit in this family, and it worked.**
*verified* on the bricked unit 1: the config page was erased and reprogrammed through the
FMC registers from OpenOCD TCL, and every word read back as intended. The route above is no
longer *derived* from vendor code, it has been run. The script is
`research/tools/fmc-repair-config.sh` and it is the only file in the repo that writes flash.

The exact sequence that ran, addresses `abs`:

| Step | Register write | Meaning |
| --- | --- | --- |
| unlock | `WRPROT 0x50000100` <- `0x59`, `0x16`, `0x88` | three writes in order; `WRPROT` bit 0 goes 0 -> 1 |
| enable | `ISPCON 0x5000c000` <- `0x51` | `ISPEN` bit 0, `CFGUEN` bit 4, `ISPFF` bit 6. See safety below |
| erase | `ISPCMD 0x5000c00c` <- `0x22`; `ISPADR 0x5000c004` <- `0x00300000`; `ISPTRG 0x5000c010` <- `0x01` | page erase of the config aperture |
| poll | read `ISPTRG` until bit 0 clears | the engine is busy until then |
| verify | read `0x00300000` for 4 words | all four read `0xffffffff` after erase |
| program | `ISPCMD` <- `0x21`; `ISPADR` <- word address; `ISPDAT 0x5000c008` <- value; `ISPTRG` <- `0x01`; poll | once per word restored |

`ISPCMD` encodings that were exercised: `0x00` read, `0x21` program, `0x22` page erase.
`ISPCMD 0x23` is whole-chip erase (vendor `fmc.h`, *corrected 2026-08-20 from `0x26`, which is not a command at all and was OpenOCD's own undocumented guess). Neither appears in any script here; neither must ever be added.
Config words live at `0x300000` (`CONFIG0`), `0x300004`, `0x300008`, `0x30000c`.

**Poll `ISPTRG` after every trigger. This is not optional and it was a real bug.** The
first draft of the repair script fired the erase and the three programs back to back with
no wait. A page erase takes milliseconds, and reading flash while the ISP engine is still
busy can stall the AHB past OpenOCD's timeout and abort the session. An abort **between**
the erase and the reprogram is the dangerous case: it leaves the config page erased with
`CONFIG1`/`CONFIG2`/`CONFIG3` gone, and the script's own precondition check then refuses to
resume because `CONFIG0` no longer reads its expected pre-value. A bounded poll
(`wait_trg`, ~2s ceiling) after each trigger closes that window. *verified*: the poll
machinery was validated read-only first, with an `ISPCMD 0x00` read that returned the same
word as a direct AHB read.

**The safety property: `CFGUEN` only, and what it does and does not protect.** `ISPCON` was
set to `0x51`, deliberately without `APUEN` (bit 3) and without `LDUEN` (bit 5). With those
two bits clear the hardware **refuses every erase and program outside the config page**, so
the application at `0x16800` and the LDROM at `0x3dc00` are physically unreachable for the
whole session even if the script is wrong. What it does not protect against is a bad value
written *to the config page itself*, so the one residual risk is setting a wrong `CONFIG0`.
That risk is bounded too: an erase only drives bits towards 1, and `0xFFFFFFFF` is the
unlocked factory `CONFIG0`, so a brown-out mid-erase cannot set the `LOCK` bit.

**Timing.** A single config-page erase-and-reprogram cycle completed in well under a second
of wall time, dominated by OpenOCD's per-command round trips, not the flash. A full 256 KB
restore by this word-at-a-time route would be tens of minutes, as the estimate above says,
but a config repair is trivially fast.

**A pyOCD FLM flash algorithm.** Most work, worth it only if you end up iterating on
firmware heavily.

### Validation ladder

Never erase anything until this passes, and ideally do it on a second unit:

1. Unlock, then read address `0x0` through the FMC and compare with `mdw 0x0`. Agreement
   confirms the FMC base, the unlock keys, the `ISPCON` bits and the trigger protocol,
   all without a single write. **Passed 2026-08-19** as `fmc-ladder1.sh`; `ISPDAT`
   returned `0x20002648`, matching the AHB read.
2. Read a few scattered addresses and diff against the dump.
3. Erase one page near the top of flash that the dump shows is already `0xFF`. Read it
   back: still `0xFF`, fail flag clear.
4. Erase a page that holds data, verify it reads `0xFFFFFFFF`, write it back word by
   word, verify.
5. Only then restore in bulk.

**Steps 3 and 4 were settled on 2026-08-20**, by the repair rather than by rehearsal:
150 pages were erased and programmed with `APUEN` set, every page read back blank after
its erase and read back again against the donor at the end, and the erase granularity was
tested by a probe that erases one page and reads back the whole of its **predecessor**.
`research/aprom-write-2026-08-20.md`. The ladder below is the reasoning that got there and
is kept for anyone adapting this to another region or another part.

**The config repair deliberately skipped steps 3 and 4**, and this was a considered call,
not an oversight. Both rehearsal steps write APROM, which needs `APUEN`, and enabling
`APUEN` unlocks the one region that must not be lost to a stray write. The config repair
kept `CFGUEN` only and relied on read-back verification instead: it erased the config page,
confirmed `0xffffffff` on all four words, reprogrammed, and confirmed the final state. A
silent no-op would have left the page exactly as found, which is safe. For a bulk APROM
restore the ladder still applies in full.

## What can permanently kill it

| Action | Recoverable? |
| --- | --- |
| Writing the `CONFIG0` LOCK bit | only by whole-chip erase, which destroys the firmware |
| Disabling the debug port in config | no |
| Chip erase (`ISPCMD 0x23`, *corrected from `0x26` 2026-08-20*) without a dump | no |
| Erasing factory trim, unique ID or RF calibration | no, and it may live outside `0x0`-`0x3ffff` |
| Brown-out mid-erase with `CFGUEN` set | can corrupt config, so possibly not |
| Wrong boot-select in `CONFIG0` | yes, looks dead but SWD still answers |
| Programming a page without erasing first | yes, but the write silently produces wrong data |

The standing rule: **never write a register whose semantics you have not read in a
datasheet or extracted from vendor code.** "It is probably the same as the Nuvoton
one" is a good hypothesis and worth nothing at all when the register is `CONFIG0`.

Keep read scripts and write scripts in separate files, invoked separately, so a flash
write procedure is never loaded during a read session.

## Nobody had done this before, and now it is done

**Both firsts are ours, and both are *verified*.** The full 256 KB dump landed
2026-08-19, and on 2026-08-20 the application region was erased and reprogrammed over
SWD, which as far as this survey can tell is **the first APROM write on a Panchip unit in
this family by anyone**. What is still not done is *custom* firmware: what was written
was another unit's own stock application, and `joggles-v1.bin` has never run anywhere.

*Corrected 2026-08-20: the heading read "Nobody has done this before" and the survey
below is still accurate as a survey of prior art. It is no longer a statement about the
present.*

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

- ~~The actual part ID at `0x50000000`, needed for any flash driver entry.~~ **Closed
  2026-08-19 and the answer is unhelpful: it reads `0x00000000`.** Where the real `PDID`
  lives, if anywhere, is the open question that replaces it.
- ~~Whether Panchip kept Nuvoton's `0x59/0x16/0x88` unlock keys.~~ **Closed 2026-08-19:
  they did.** `research/tools/fmc-ladder1.sh` ran and passed: the three keys drove
  `WRPROT` bit 0 from 0 to 1, and an `ISPCMD 0x00` read through the FMC returned
  `0x20002648`, matching the direct AHB read of the same address. That confirmed the FMC
  base `0x5000c000`, the register offsets, the unlock keys and the `ISPTRG` poll protocol
  with no flash write. The keys were then exercised for real in the config repair.
- ~~Whether the SWD port needs a vendor knock sequence.~~ **Closed: it does not.** The
  port enumerated with a stock `cmsis-dap` config and no knock, and full AP memory
  access works.
- ~~Whether our unit's board matches the FCC photographs above.~~ Closed 2026-08-08: it
  does, except the pad silkscreen, which reads `EK`/`ED` and not `CLK`/`DAT`.

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
