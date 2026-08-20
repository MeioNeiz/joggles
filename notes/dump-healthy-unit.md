# Dumping a healthy pair over SWD: the runbook

**Purpose:** read a working unit's flash, read-only, and get the first copy of the
application that actually matches the BLE stack on this hardware. This is the single
highest-value action left in the project, and it is blocked only on preparation and on
Jacob being present to clip onto working hardware.

## Outcome, 2026-08-19: done, and all three predictions confirmed

Run on `GLASSES-12E69E` under Jacob's supervision. Read-only throughout; nothing written.

- **Three wires were enough; connect-under-reset was not needed.** The unit was actively
  rendering "MY BROTHER RAFF" and SWD still came up on the **first attempt** with
  `EK`/`ED`/`G` and no `RST`. The "a running app remaps P4.6/P4.7 and steals the ICE pins"
  claim is *disproven* on this family (`research/hardware-access.md`). The
  connect-under-reset material below is kept as a fallback, not a prerequisite.
- **`CONFIG0 = 0xFFFFFFBF`**, config page byte-identical to unit 1. So `0xFFFFFFBF` is the
  normal shipped value the bootloader writes, and unit 1's config repair changed a correct
  value to the erased `0xFFFFFFFF` rather than restoring a corrupted one.
- **Three 256 KB dumps, byte-identical** (`69c85fa6…`):
  `firmware/dump-12E69E-2026-08-19-{a,b,c}.bin`, `-a` backed up to
  `~/personal/joggles-dumps-backup/`.
- **All three predictions held.** (1) `0x16800` does **not** match the APK plaintext (92%
  differs) and the application runs past `0x26c00` (10,716 bytes at `0x26a24-0x293ff`).
  (2) `ota.check(joggles-v1, {reference: 12E69E dump})` reports the unit's own firmware
  leaves **0** of 23 in-scope callback slots unregistered, while `joggles-v1` leaves 4 (the
  8 August brick). So the healthy firmware registers the four slots (`+0x5c`..`+0x68`) the
  APK image never writes. (3) All 26 of the healthy unit's populated callback pointers
  (`+0x04`..`+0x68`) appear value-for-value in the flash dump's registrar literal pool, a
  116-byte cluster at `abs 0x19438`; `+0x60 = 0x00020805` matches the value the brick
  investigation recorded, so that SRAM capture is definitively this unit. Root cause
  confirmed from four independent directions.
- **Prohibition widened:** a healthy unit does **not** run the APK image, so
  `firmware/joggles-v1.bin` must not be flashed to **any** unit until it is rebuilt on a
  real unit's application, not the APK container.
- **Provenance correction:** `firmware/sram-unit1-2026-08-19.bin` was misattributed. It
  contains `GLASSES-12E69E` twice and no `12C3EF`, and its timestamp (21:31) is after the
  probe had moved from unit 1 to the healthy pair. It is **12E69E's SRAM**, renamed
  `sram-12E69E-2026-08-19.bin`. The three flash dumps and the LDROM taken earlier (20:23,
  20:25) are genuinely unit 1, and every flash-derived conclusion stands.

**Why it matters, in one paragraph.** Track 47
(`research/hardfault-0xd38-2026-08-19.md`) concludes that the application in unit 1's
flash does not match the stack already on the chip: both APK containers skip the exports
that register callback slot `+0x60`, and 7,047 bytes of an older, *larger* factory image
survive un-erased at `abs 0x26c00`, referenced by nothing in the current image. So the
correct firmware for these units **exists only on a working unit** and nowhere in this
repo or the APK. Dumping one gives us that image, a healthy `CONFIG0`, the source bytes to
repair unit 1, and it makes the working unit itself recoverable, which it currently is
not. It also runs a clean test of the whole root-cause theory (see "The prediction").

**This runbook is self-contained.** Provenance is cited but you do not need to open the
cited files to follow it. Everything is read-only; no command here writes flash.

**Do not start without Jacob present.** Clipping onto working hardware is his call, and
the one mistake that destroys a board is his hand on the clip, not a command.

## Which pair

**Use `GLASSES-12E69E`.** *derived*, from the swarm state at 2026-08-19 evening.

| Pair | Use it? | Why |
| --- | --- | --- |
| `GLASSES-12E69E` | **yes, this one** | powered, idle, not held by any session. Nothing breaks if its core is halted |
| `GLASSES-125B37` | **no** | in use over BLE by another session, and currently showing flash-restored content Jacob is looking at. Halting its core kills that BLE connection out from under the other session and the panel observation with it |
| `GLASSES-12C3EF` (unit 1) | **no longer a free rehearsal target** | it was the bricked unit and was **repaired 2026-08-20**, so it is now a working pair and a mistake on it costs what a mistake on any other pair costs. *Corrected 2026-08-20.* `research/aprom-write-2026-08-20.md` |

If `12E69E` will not answer, prefer any other idle, never-connected pair over `125B37`.
Ideally pick one that has never been OTA'd, so its flash is closest to factory.

## The one mistake that destroys a board, and it is identical on healthy hardware

The clip is 6 pins over 5 pads, so it can sit one position out. **Slipping it one way lands
the probe's `GND` on the `VD` pad, shorting the 3.3 V rail to ground through the LDO.**
That is the single misplacement that damages hardware; every other misalignment merely
fails to enumerate and costs nothing. *verified* reasoning,
`research/hardware-access.md`.

Before powering the glasses: clip on, **eyeball pin 1 of the clip against the `RST`
silkscreen**, confirm `VD` (pad 5) has no wire, then switch on. This is the same rule that
governed unit 1; a healthy board is no more forgiving.

## What is different from the dead unit: connect-under-reset

**Disproven 2026-08-19, kept as a fallback.** A running, actively-rendering `GLASSES-12E69E`
kept the ICE pins and SWD came up on three wires the first try, so connect-under-reset was
not needed. The reasoning below stands only for the case, never yet seen, where a healthy
unit does refuse the port. See the Outcome section at the top.

Unit 1 was easy because it hardfaults early and never reconfigures its pins, so the SWD
port stayed up indefinitely with no reset lead. **A healthy unit runs its application, and
`P4.6`/`P4.7` (the ICE clock and data pins) mux to UART1 a few milliseconds after boot.**
Once the running app claims them, the SWD port dies at the physical layer, and the symptom
is indistinguishable from a dead chip. *derived*, `research/hardware-access.md`; the
healthy case has not been run, which is exactly why the working-unit dump has never
happened despite the read being electrically safe.

The answer is **connect-under-reset**: hold the CPU in reset while SWD attaches and halts,
so the application never runs and never remaps the pins. The Raspberry Pi Debug Probe's
3-pin connector carries no reset line (*verified* from `RP-003139-SP-4`), so the reset has
to be driven by hand on a fourth wire.

## Wiring

*verified* wiring for the three signals, `research/hardware-access.md`, "The wiring that
actually worked". The fourth wire (`RST`) is the new part and is *unverified* in use.

| Probe wire | Board pad | Note |
| --- | --- | --- |
| orange | 2 `EK` | SWCLK. Wire by **position not colour**: the probe's order is `SC | GND | SD` |
| black | 4 `G` | ground, the middle probe wire |
| yellow | 3 `ED` | SWDIO |
| **new fourth lead** | **1 `RST`** | a jumper from pad 1 to the **ground node** (probe `GND` / pad 4), broken by a momentary pushbutton or held/lifted by hand |
| nothing | 5 `VD` | **never.** This is the rail that kills the board |

- Probe into the **`D` socket, not `U`.** `U` is the probe's own UART side; plugged there
  the symptom is indistinguishable from a dead target.
- **Power the glasses from their own battery, never from the probe.** A brown-out is only a
  risk during a write, and this session writes nothing, but the habit is cheap.
- Keep leads under ~15 cm. Start slow: `pan1020.cfg` is already at 200 kHz.
- Getting `SC`/`SD` (orange/yellow) the wrong way round is electrically harmless and just
  fails to enumerate. Swap them and retry before concluding the port is dead.

## Rehearse on unit 1 first

*Corrected 2026-08-20: unit 1 is repaired and is a working pair, so this is no longer a
zero-risk rehearsal. The passage below was written when it was expendable.*

Unit 1 was bricked and fully dumped, so the reset technique could be practised on it at zero
risk. Wire the `RST` lead to it, and confirm you can (a) hold the core in reset, (b) attach
and halt, (c) release reset with the core staying halted, and (d) read a word. Only once
that hand-sequence is smooth should the clip move to a healthy pair. Note that unit 1 does
not *need* reset to stay up, so it will not prove the pin-remap theory; it only lets you
rehearse the mechanics.

## The sequence

Steps are ordered cheapest-and-safest first. **Redirect OpenOCD output to a file, never
pipe it:** `mdw` results and OpenOCD's `Info :` stream interleave, and piping to `grep` or
`tail` silently swallows every value, which reads exactly like an intermittent target.
Put `echo` markers between reads. (*verified* lesson, `research/hardware-access.md`.)

### 1. Attach under reset and confirm the port is alive

**Expect the first attach on a running unit to fail, and do not read that as a dead
board.** A healthy unit boots its application, which grabs the SWD pins within
milliseconds, so catching it means winning a race and the race is often lost on the first
try. The steps below are the winning move; "When the port does not come up" is what to do
each time you lose it.

1. Clip on, eyeball pin 1 against `RST`, confirm `VD` is unwired, power on.
2. **Hold `RST` to ground** (press the button, or hold the flying lead to the ground node).
   The CPU is now held in reset and the application is not running.
3. Attach and halt while reset is held, then release reset with the core halted:

        openocd -f research/tools/pan1020.cfg \
          -c "init; halt; echo {--- port up, core halted ---}; \
              mdw 0xE000ED00; shutdown" \
          > /tmp/unit2-probe.txt 2>&1

   Release `RST` a moment after OpenOCD reports the halt. A halted core does not execute,
   so it cannot remap the pins; the port should now stay up for as long as you need.
4. Read `/tmp/unit2-probe.txt`. **`DPIDR 0x0bb11477` and `Cortex-M0 r0p0` mean the port is
   alive.** If it is silent, that is not a verdict on the hardware: **on a running unit the
   first attempt is expected to fail.** Go to "When the port does not come up" below, which
   tells the two causes apart and gives the fix for each. Do not conclude anything from one
   silent attempt.

**Do not proceed past step 1 until the port is stably up with the core halted.** Everything
below assumes it, and a dump on an unstable port wastes the session.

### 2. The go/no-go read: bank CONFIG0 first, before any long operation

**This is one word, it is irreplaceable, and it goes before the dump, not after.** If the
port drops during the ~23-second dump, a `CONFIG0` you already banked is still the first
healthy `CONFIG0` anyone has ever read; a `CONFIG0` you meant to read afterwards is lost
with the session. So the order is fixed and not negotiable: port up, then this single read,
then everything else. Nobody has ever read a working unit's `CONFIG0`.

    openocd -f research/tools/pan1020.cfg \
      -c "init; halt; echo {--- CONFIG0 0x00300000 ---}; mdw 0x00300000; \
          echo {--- LDROM 0x00100000 ---}; mdw 0x00100000; shutdown" \
      > /tmp/unit2-config0.txt 2>&1

Record the `CONFIG0` word. It is one read and it settles a question the config repair on
unit 1 could not: whether `0xFFFFFFBF` is the normal shipped value (which is what track 48
predicts the bootloader writes) or whether a factory unit reads `0xFFFFFFFF`. Pre-register
the reading in "The prediction" below.

### 3. The four diagnostics

    ./research/tools/swd-recon.sh diag > /tmp/unit2-diag.txt 2>&1

This reads `0x00300000` (config), `0x00100000` (LDROM alias), `0x0003dc00` (LDROM in the
main array) and eight words at `0x16800` (the application head). Read-only by
construction.

### 4. Three dumps, compared

`firmware/` is gitignored, so these bytes are the only record; keep a copy outside the
repo the moment you have one. Take three and compare before trusting any of them, because
a flaky rig produces disagreeing reads that look exactly like a device changing under you.

    ./research/tools/swd-recon.sh dump firmware/dump-12E69E-2026-08-19-a.bin
    ./research/tools/swd-recon.sh dump firmware/dump-12E69E-2026-08-19-b.bin
    ./research/tools/swd-recon.sh dump firmware/dump-12E69E-2026-08-19-c.bin
    bun run dumpcheck compare firmware/dump-12E69E-2026-08-19-a.bin \
      firmware/dump-12E69E-2026-08-19-b.bin firmware/dump-12E69E-2026-08-19-c.bin
    cp firmware/dump-12E69E-2026-08-19-a.bin ~/personal/joggles-dumps-backup/

`swd-recon.sh dump` refuses to overwrite an existing file, so the three names must differ.
Each dump is ~23 s at 200 kHz; the halted core will hold the port up throughout.

### 5. Validate, and run the test

    bun run dumpcheck firmware/dump-12E69E-2026-08-19-a.bin \
      --against firmware/TR1906R04-10_OTA.bin

`dumpcheck` diffs the application at `abs 0x16800` against the APK plaintext and reports
the region census. **This is the test of the root-cause theory.** Read the result against
"The prediction" below before drawing any conclusion, and write the actual outcome down
verbatim first.

## The prediction, pre-registered

**Confirmed 2026-08-19 (see the Outcome section at the top), and one premise below was
wrong:** the SRAM capture cited as "unit 1's" is actually the healthy unit's
(`GLASSES-12E69E`) SRAM, misattributed by filename. That makes it *direct* evidence a
healthy unit populates slots `+0x5c`..`+0x68`, which is stronger than the "fossil" framing,
not weaker. The pre-registered text is kept unedited below for the record.

Written **before** the dump, so nobody can rationalise the result afterwards. Track 47's
finding, settled on both the offline disassembly and unit 1's SRAM capture, is that the
unit's real application is a larger, different build from the APK image, and that the APK
image was never the right one for this hardware. Two independent lines already support it:
the app has **two deterministic boot paths** (a cold path that runs the registrar and
faults reading the unregistered callback slot `+0x60`, and a warm path that skips both the
registrar and chip init and runs with no radio and no interrupt handlers installed, which
is why unit 1 was once caught running but not advertising), and a **fossil struct in unit
1's SRAM** written by a larger build that this image contains no code to have produced. The
dump is the direct test.

**The theory is CONFIRMED if all three hold:**

1. **`0x16800` does NOT match the APK plaintext.** `dumpcheck` reports a divergence in the
   application region, where unit 1 matched byte for byte.
2. **The application runs past `0x26c00`.** Unit 2's programmed content extends contiguously
   beyond `abs 0x26a24` (where the APK image ends) as part of one live image, out to around
   `0x28790`, rather than ending at `0x26a24` with an orphaned tail after a gap of `0xFF`.
3. **`0x0`-`0x167ff` is identical between unit 1 and unit 2.** The bootloader and the region
   below the application match; only the application differs.

All three together mean the unit shipped with a larger application that is not in the APK,
and confirm why flashing the APK-derived image bricks these units. The dump is then the
correct firmware and unit 1's repair is mechanical: write unit 2's `0x16800`-`0x293ff`
onto it.

**The claim is falsifiable, and this is exactly what would refute it:**

- **`0x16800` matches the APK plaintext byte for byte**, as unit 1 did. That would mean both
  units run the APK image after all, and the whole "wrong application" account, offline
  disassembly and SRAM fossil included, is wrong and has to be reopened from the start.
  Track 47's expectation is firm that this will not happen; stating it plainly is what makes
  the dump a real test rather than a confirmation exercise.

**Record, do not force, a partial result.** A match at `0x16800` but different content past
`0x26a24`, or the reverse, is data worth writing down exactly rather than rounding to
confirm or refute.

**And the CONFIG0 reading from step 2:**

- `CONFIG0 = 0xFFFFFFBF` confirms track 48: this is the value the bootloader writes on a
  successful update, and unit 1's config repair moved it *away* from the normal value to
  `0xFFFFFFFF` (harmless, but not a restore to factory).
- `CONFIG0 = 0xFFFFFFFF` means factory-erased is the normal state, and the repair restored
  rather than disturbed it.
- Either way this is the first healthy `CONFIG0` anyone has read on this family; record it.

**The SRAM fossil is captured; do not discard it.** The struct that evidences the larger
original build lives in unit 1's SRAM and is readable only while unit 1 keeps power: a full
de-power loses it, because it was never in flash and `SYSRESETREQ` does not clear SRAM. It
is already saved as `firmware/sram-unit1-2026-08-19.bin` (with a backup outside the repo),
so this is a reason not to delete that file, not a reason to hurry. It is independent of the
healthy-unit dump and does not gate it.

## When the port does not come up

**On a running unit this is the expected first outcome, not a fault.** The whole reason
this dump has never been done is that a healthy unit's application claims the SWD pins
within milliseconds of boot, so a silent first attempt means "try again properly", not
"dead board". Nothing here writes anything, so a failed attach leaves the pair exactly as
it was; power-cycle it and it boots normally.

**First, tell the two causes apart. This one distinction decides what to do**, and the
discriminator is whether the DAP enumerates *while `RST` is held to ground*:

| With `RST` held low, does `swd-recon.sh probe` print `DPIDR 0x0bb11477`? | Cause |
| --- | --- |
| **No, nothing, even with `RST` held** | the **rig**, not the app. A core held in reset is not running, so it cannot have claimed the pins. *verified* logic |
| **Yes with `RST` held, then it drops on release or during the read** | the **app** claimed `P4.6`/`P4.7` on boot; the halt lost the race. *derived*, the expected healthy-unit case |

**If it is the rig (no `DPIDR` even in reset), work these three, in order:**

1. **Probe in the `D` socket, not `U`.** `U` is the probe's own UART side and looks exactly
   like a dead target. The single most common silent-port cause.
2. **Clip alignment and contact.** Pin 1 on `RST`, `VD` (pad 5) unwired, then reseat: a
   pogo clip drifted half a pad reads as silence.
3. **Swap `EK` and `ED` (orange and yellow).** Getting `SC`/`SD` the wrong way round is
   electrically harmless and simply fails to enumerate. The cheap one people forget.

**If it is the app (DPIDR fine in reset, drops on run), work the reset window:**

- **Keep `RST` held, let `init; halt` issue first, and release `RST` only once OpenOCD is
  already requesting the halt**, so the halt beats the boot. The margin is milliseconds; a
  steady hand or a momentary button on the `RST`-to-ground lead helps. It is a race, so a
  few tries before it lands is normal, not a sign anything is wrong.
- If enumeration itself is flaky (intermittent `DPIDR` even in reset), lower the clock:
  `adapter speed 100`. That helps a marginal *rig*; it does **not** help the remap race, so
  reach for it only when the DAP will not enumerate cleanly while held in reset.
- For repeatable timing across several pairs, drive `RST` from a spare GPIO instead of by
  hand. Overkill for one unit, worth it for many.

All of the reset-window handling is *unverified* on this family: the healthy-unit attach
has never been run. **Rehearse the release-and-halt on unit 1 first** (see "Rehearse on
unit 1 first") so the hand-timing is muscle memory before it matters on a pair you care
about.

## The fault UART, for context (not part of this read)

You are at the bench with the board open, so it is worth knowing where the debug UART is,
even though **it plays no part in dumping a healthy unit**: the console is silent on a
normal boot and only speaks when the firmware faults. It is the no-probe route to read a
*faulted* unit's exception frame, and it is easy to confuse with the panel's UART, so keep
them straight:

| | Debug console | LED panel |
| --- | --- | --- |
| Peripheral | UART0, base `0x40100000` | UART1, base `0x40101000` |
| TX pin | **P1.3, QFN32 pin 11** | P2.5, pin 23 |
| Carries | the fault banner and eight registers | panel frame data |

115200 8N1, no flow control. Bootloader and application drive it identically, so one tap
reads both. *verified* from firmware bytes through the SDK constants to the datasheet pin
table (`research/ldrom-2026-08-19.md`, "The debug console"), but **never yet observed on
an instrument**, so a first capture is still what proves it.

**P1.3 is not on a labelled pad.** The debug header (`RST EK ED G VD`) carries no UART. The
one lead worth chasing before soldering: the unexplained **`K`** pad in the `V+ G K VD`
group is worth two seconds with a continuity meter to P1.3 (pin 11, the third pin along the
bottom edge of `U2`). Failing that it is a bare 0.5 mm QFN pin, not clippable: a fine-tip
probe or a 34-38 AWG wire tacked to pin 11, adaptor **RX** only, ground to a `G` pad,
adaptor TX and VCC left disconnected, glasses on their own battery. On a healthy unit expect
near silence, then a line such as `READ CON PARAM` when a phone connects; nothing more.

## What is unverified in this runbook

| Claim | Confidence |
| --- | --- |
| the three-signal wiring and the `D`-socket rule | *verified* on unit 1, 2026-08-19 |
| the read commands and that a halted core holds the port up | *verified* on unit 1 |
| connect-under-reset on a healthy unit, and that it beats the pin-remap window | *unverified*; never run on this family |
| that `12E69E` is idle and safe to halt | *derived* from swarm state; confirm it is not in use before clipping on |
| the prediction's three confirm conditions | *derived* from track 47's offline analysis of unit 1's dump |
